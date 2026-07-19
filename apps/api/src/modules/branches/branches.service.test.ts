import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES } from '@potato-corner/shared';
import { branchCodeSchema } from '@potato-corner/shared';

vi.mock('./branches.repository.js', () => ({
  branchesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    getActiveAssignments: vi.fn(),
    findActiveAssignment: vi.fn(),
    assignUser: vi.fn(),
    removeUserAssignment: vi.fn(),
    getUserActiveBranches: vi.fn(),
    findUserById: vi.fn(),
    countActiveShifts: vi.fn(),
    branchStats: vi.fn(),
    generateBranchCode: vi.fn(),
  },
}));

vi.mock('../../lib/id-counter.js', () => ({
  nextCounterValue: vi.fn(),
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../socket/socket.server.js', () => ({
  getIO: vi.fn().mockReturnValue(null),
}));

const { branchesRepository } = await import('./branches.repository.js');
const { branchesService } = await import('./branches.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const ACTOR = { id: 'admin-1', role: ROLES.SUPER_ADMIN };

function fakeDecimal(value: number) {
  return { toNumber: () => value } as unknown as { toNumber(): number };
}

function buildBranch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'branch-1',
    name: 'Main Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal St',
    city: 'Manila',
    gpsLatitude: fakeDecimal(14.5995),
    gpsLongitude: fakeDecimal(120.9842),
    gpsRadiusMeters: 100,
    status: 'active',
    userAssignments: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('branchesService.createBranch', () => {
  it('generates correct code format for different cities', async () => {
    vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-QZN-001');
    vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ city: 'Quezon City', code: 'PC-QZN-001' }) as never);

    await branchesService.createBranch(
      { name: 'QC Branch', address: '456 Commonwealth Ave', city: 'Quezon City', gpsRadiusMeters: 100, status: 'active' },
      ACTOR,
      null,
    );

    expect(branchesRepository.generateBranchCode).toHaveBeenCalledWith('Quezon City');
    expect(branchesRepository.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'PC-QZN-001' }));
  });

  it('with an explicit code validates the PC-[CITY]-[NUM] format via branchCodeSchema', () => {
    expect(branchCodeSchema.safeParse('PC-MNL-001').success).toBe(true);
    expect(branchCodeSchema.safeParse('MNL-001').success).toBe(false);
    expect(branchCodeSchema.safeParse('PC-MNL-1').success).toBe(false);
    expect(branchCodeSchema.safeParse('pc-mnl-001').success).toBe(false);
  });

  it('with a duplicate code throws a conflict error', async () => {
    vi.mocked(branchesRepository.findByCode).mockResolvedValue(buildBranch() as never);

    await expect(
      branchesService.createBranch(
        { name: 'Dup Branch', code: 'PC-MNL-001', address: '789 Taft Ave', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_CODE_CONFLICT', statusCode: 409 });

    expect(branchesRepository.create).not.toHaveBeenCalled();
  });

  it('records a BRANCH_CREATED audit log entry', async () => {
    vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-002');
    vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ code: 'PC-MNL-002' }) as never);

    await branchesService.createBranch(
      { name: 'Branch 2', address: '321 Ayala Ave', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
      ACTOR,
      '127.0.0.1',
    );

    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'BRANCH_CREATED', actorId: ACTOR.id }));
  });
});

describe('branchesRepository.generateBranchCode (real implementation, Postgres counter mocked)', () => {
  it('increments the counter atomically per city prefix and pads to 3 digits', async () => {
    const { nextCounterValue } = await import('../../lib/id-counter.js');
    vi.mocked(nextCounterValue).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const actual = await vi.importActual<typeof import('./branches.repository.js')>('./branches.repository.js');

    const first = await actual.branchesRepository.generateBranchCode('Manila');
    const second = await actual.branchesRepository.generateBranchCode('Manila');

    expect(nextCounterValue).toHaveBeenNthCalledWith(1, 'branch_code_counter:MAN');
    expect(nextCounterValue).toHaveBeenNthCalledWith(2, 'branch_code_counter:MAN');
    expect(first).toBe('PC-MAN-001');
    expect(second).toBe('PC-MAN-002');
  });
});

describe('branchesService.getAllBranches', () => {
  it('for a supervisor returns only their assigned branches', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });

    const supervisor = {
      user_id: 'sup-1',
      role: ROLES.SUPERVISOR,
      email: 'sup@test.com',
      branch_ids: ['branch-a', 'branch-b'] as string[],
      iat: 0,
      exp: 9999999999,
    };

    await branchesService.getAllBranches(supervisor, { page: 1, limit: 25 });

    expect(branchesRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ ids: ['branch-a', 'branch-b'] }));
  });

  it('for a super_admin returns all branches (no ids restriction)', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });

    const admin = { user_id: 'admin-1', role: ROLES.SUPER_ADMIN, email: 'admin@test.com', iat: 0, exp: 9999999999 } as const;

    await branchesService.getAllBranches(admin, { page: 1, limit: 25 });

    const callArgs = vi.mocked(branchesRepository.findAll).mock.calls[0]?.[0];
    expect(callArgs?.ids).toBeUndefined();
  });
});

describe('branchesService.changeBranchStatus', () => {
  it('to closed with active shifts throws an error', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch({ status: 'active' }) as never);
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(2);

    await expect(branchesService.changeBranchStatus('branch-1', 'closed', ACTOR, null)).rejects.toMatchObject({
      code: 'BRANCH_HAS_ACTIVE_SHIFTS',
      statusCode: 409,
    });

    expect(branchesRepository.update).not.toHaveBeenCalled();
  });

  it('to closed with no active shifts succeeds', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch({ status: 'active' }) as never);
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(0);
    vi.mocked(branchesRepository.update).mockResolvedValue(buildBranch({ status: 'closed' }) as never);

    const result = await branchesService.changeBranchStatus('branch-1', 'closed', ACTOR, null);

    expect(result.status).toBe('closed');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'BRANCH_STATUS_CHANGED' }));
  });
});

describe('branchesService.assignSupervisor', () => {
  it('with a non-supervisor user throws an error', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({ id: 'user-1', role: 'staff' } as never);

    await expect(branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null)).rejects.toMatchObject({
      code: 'USER_NOT_SUPERVISOR',
    });

    expect(branchesRepository.assignUser).not.toHaveBeenCalled();
  });

  it('with an already-active assignment is idempotent (no error, no duplicate insert)', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({ id: 'user-1', role: 'supervisor' } as never);
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch({ status: 'active' }) as never);
    const existing = { id: 'assignment-1', userId: 'user-1', branchId: 'branch-1', assignedAt: new Date(), removedAt: null };
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(existing as never);

    const result = await branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(result).toBe(existing);
    expect(branchesRepository.assignUser).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('creates the assignment and records an audit log when none exists yet', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({ id: 'user-1', role: 'supervisor' } as never);
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch({ status: 'active' }) as never);
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(null);
    const created = { id: 'assignment-2', userId: 'user-1', branchId: 'branch-1', assignedAt: new Date(), removedAt: null };
    vi.mocked(branchesRepository.assignUser).mockResolvedValue(created as never);

    const result = await branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(result).toBe(created);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUPERVISOR_ASSIGNED' }));
  });
});

describe('branchesService.removeSupervisor', () => {
  it('sets removedAt correctly and records an audit log', async () => {
    const existing = { id: 'assignment-1', userId: 'user-1', branchId: 'branch-1', assignedAt: new Date(), removedAt: null };
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(existing as never);
    vi.mocked(branchesRepository.removeUserAssignment).mockResolvedValue({ ...existing, removedAt: new Date() } as never);

    await branchesService.removeSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(branchesRepository.removeUserAssignment).toHaveBeenCalledWith('assignment-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUPERVISOR_REMOVED' }));
  });

  it('throws when no active assignment exists', async () => {
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(null);

    await expect(branchesService.removeSupervisor('user-1', 'branch-1', ACTOR, null)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});
