import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ROLES, attendanceResponseSchema } from '@potato-corner/shared';

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./attendance.repository.js', () => ({
  attendanceRepository: {
    findBranchAssignment: vi.fn(),
    findBranchAssignmentInBranches: vi.fn(),
    findActiveRecord: vi.fn(),
    findBranchById: vi.fn(),
    findById: vi.fn(),
    clockIn: vi.fn(),
    clockOut: vi.fn(),
    createOverride: vi.fn(),
    softDelete: vi.fn(),
    findByBranch: vi.fn(),
    findByEmployee: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../cash/cash.repository.js', () => ({
  cashRepository: {
    findActiveShift: vi.fn(),
    findActiveShiftByBranch: vi.fn(),
    findShiftById: vi.fn(),
    createAutoShift: vi.fn(),
    closeAutoShift: vi.fn(),
    sumTransactionsForShift: vi.fn(),
    sumTransactionCountsForShift: vi.fn(),
  },
}));

// getAccessibleBranchIds (lib/branch-access.js) resolves Supervisor's scope
// from the database — mocked at the branchesRepository layer so the real
// branch-access logic still runs, same technique as attendance.router.test.ts.
vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { attendanceRepository } = await import('./attendance.repository.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { attendanceService } = await import('./attendance.service.js');

const STAFF = { id: 'employee-1', role: 'staff' };
const SUPERVISOR = { id: 'supervisor-1', role: 'supervisor' };

const IAT_EXP = { iat: 0, exp: 9999999999 };

function staffUser(userId: string, branchId: string) {
  return { user_id: userId, role: ROLES.STAFF, email: null, branch_ids: [branchId], ...IAT_EXP };
}

function branchUser(branchId: string) {
  return { user_id: randomUUID(), role: ROLES.BRANCH, email: 'branch@test.com', branch_ids: [branchId], ...IAT_EXP };
}

function supervisorUser(branchIds: string[] = []) {
  return { user_id: randomUUID(), role: ROLES.SUPERVISOR, email: 'sup@test.com', branch_ids: branchIds, ...IAT_EXP };
}

function superAdminUser() {
  return { user_id: randomUUID(), role: ROLES.SUPER_ADMIN, email: 'admin@test.com', ...IAT_EXP } as const;
}

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

function attendanceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'record-1',
    employeeId: 'employee-1',
    branchId: 'branch-1',
    clockInServerTime: new Date('2026-07-15T08:00:00.000Z'),
    clockInDeviceTime: null,
    clockInGpsLat: decimal(14.5995),
    clockInGpsLng: decimal(120.9842),
    clockInGpsStatus: 'within_radius',
    clockInTimeFlag: false,
    clockOutServerTime: null,
    clockOutDeviceTime: null,
    clockOutGpsLat: null,
    clockOutGpsLng: null,
    breakMinutes: 0,
    actualWorkMinutes: null,
    overtimeMinutes: 0,
    status: 'present',
    correctionReason: null,
    correctedBy: null,
    originalRecordId: null,
    deletedAt: null,
    createdAt: new Date('2026-07-15T08:00:00.000Z'),
    ...overrides,
  };
}

function branchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'branch-1',
    gpsLatitude: decimal(14.5995),
    gpsLongitude: decimal(120.9842),
    gpsRadiusMeters: 100,
    ...overrides,
  };
}

function shiftRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'auto-shift-1',
    branchId: 'branch-1',
    cashierId: 'employee-1',
    openedBy: 'employee-1',
    closedBy: null,
    status: 'active',
    openingCashAmount: decimal(0),
    closingCashAmount: null,
    expectedClosingCash: null,
    cashVariance: null,
    varianceApproved: null,
    varianceExplanation: null,
    varianceApprovedBy: null,
    varianceApprovalReason: null,
    cashSalesTotal: decimal(0),
    gcashSalesTotal: decimal(0),
    mayaSalesTotal: decimal(0),
    otherSalesTotal: decimal(0),
    grossSalesTotal: decimal(0),
    transactionCount: 0,
    shiftNotes: null,
    startedAt: new Date('2026-07-15T08:00:00.000Z'),
    closedAt: null,
    cashSalesCount: 0,
    gcashSalesCount: 0,
    mayaSalesCount: 0,
    otherSalesCount: 0,
    voidedCount: 0,
    refundedCount: 0,
    totalTransactionCount: 0,
    totalDiscountAmount: decimal(0),
    pwdScTransactionCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no open POS shift — most clockOut tests aren't exercising the
  // shift-link guard (§6), only the dedicated auto-close test overrides this.
  vi.mocked(cashRepository.findActiveShift).mockResolvedValue(null);
  // clockIn auto-opens a shift (Phase 4-9) — cashService.autoOpenShift runs
  // for real against this mocked repository. It checks branch-scoped (Task
  // 103: the DB only allows one active shift per branch), so this also
  // needs to default to "none yet" for the create path to run.
  vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
  vi.mocked(cashRepository.createAutoShift).mockResolvedValue(shiftRow() as never);
  vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
    cashSalesTotal: decimal(0),
    gcashSalesTotal: decimal(0),
    mayaSalesTotal: decimal(0),
    otherSalesTotal: decimal(0),
    grossSalesTotal: decimal(0),
    transactionCount: 0,
  } as never);
  vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
    cashSalesCount: 0,
    gcashSalesCount: 0,
    mayaSalesCount: 0,
    otherSalesCount: 0,
    voidedCount: 0,
    refundedCount: 0,
    totalTransactionCount: 0,
    totalDiscountAmount: 0,
    pwdScTransactionCount: 0,
  } as never);
});

describe('attendanceService.clockIn', () => {
  it('creates the record when the employee is assigned to the branch and has no open record', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow() as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow() as never);

    const result = await attendanceService.clockIn(
      { employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 },
      STAFF,
    );

    expect(result.id).toBe('record-1');
    expect(result.clock_in_gps_status).toBe('within_radius');
    expect(attendanceRepository.clockIn).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'employee-1', branchId: 'branch-1', clockInGpsStatus: 'within_radius' }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CLOCKED_IN', entityId: 'record-1' }));
  });

  it('broadcasts ATTENDANCE_CLOCKED_IN to the branch room and Super Admin with a payload matching attendanceResponseSchema', async () => {
    const recordId = randomUUID();
    const employeeId = randomUUID();
    const branchId = randomUUID();
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow({ id: branchId }) as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow({ id: recordId, employeeId, branchId }) as never);

    const result = await attendanceService.clockIn({ employeeId, branchId, gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF);

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'attendance:clocked_in', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('attendance:clocked_in', result);
    expect(attendanceResponseSchema.safeParse(result).success).toBe(true);
  });

  it('marks the clock-in outside_radius when the GPS coordinates are outside the branch geofence', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow({ gpsRadiusMeters: 100 }) as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow({ clockInGpsStatus: 'outside_radius' }) as never);

    await attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 15.5, gpsLng: 121.5 }, STAFF);

    expect(attendanceRepository.clockIn).toHaveBeenCalledWith(expect.objectContaining({ clockInGpsStatus: 'outside_radius' }));
  });

  it('rejects with 403 EMPLOYEE_NOT_ASSIGNED_TO_BRANCH when the employee has no assignment at the branch', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue(null);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_ASSIGNED_TO_BRANCH', statusCode: 403 });
    expect(attendanceRepository.clockIn).not.toHaveBeenCalled();
  });

  it('rejects with 409 ALREADY_CLOCKED_IN when the employee already has an open record', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(attendanceRow() as never);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN', statusCode: 409 });
    expect(attendanceRepository.clockIn).not.toHaveBeenCalled();
  });

  it('rejects with 404 BRANCH_NOT_FOUND when the branch does not exist', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(null);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', statusCode: 404 });
  });
});

describe('attendanceService.clockOut', () => {
  it('auto-closes the employee open POS shift at their attendance branch (§6 attendance-shift link) instead of blocking clock-out', async () => {
    const active = attendanceRow();
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(active as never);
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue(shiftRow() as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow() as never);
    vi.mocked(cashRepository.closeAutoShift).mockResolvedValue(shiftRow({ status: 'closed' }) as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(attendanceRow({ clockOutServerTime: new Date() }) as never);

    await attendanceService.clockOut('employee-1', {}, STAFF);

    expect(cashRepository.findActiveShift).toHaveBeenCalledWith('employee-1', 'branch-1');
    expect(cashRepository.closeAutoShift).toHaveBeenCalledWith('auto-shift-1', expect.objectContaining({ closedBy: STAFF.id }));
    expect(attendanceRepository.clockOut).toHaveBeenCalled();
  });

  it('updates the open record with computed work/overtime minutes', async () => {
    const active = attendanceRow({ clockInServerTime: new Date('2026-07-15T08:00:00.000Z'), breakMinutes: 60 });
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(active as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(
      attendanceRow({ clockOutServerTime: new Date('2026-07-15T17:00:00.000Z'), actualWorkMinutes: 480, breakMinutes: 60 }) as never,
    );

    const result = await attendanceService.clockOut('employee-1', {}, STAFF);

    expect(attendanceRepository.clockOut).toHaveBeenCalledWith(
      'record-1',
      expect.objectContaining({ breakMinutes: 60, clockOutServerTime: expect.any(Date) }),
    );
    expect(result.clock_out_server_time).not.toBeNull();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CLOCKED_OUT' }));
  });

  it('broadcasts ATTENDANCE_CLOCKED_OUT to the branch room and Super Admin with a payload matching attendanceResponseSchema', async () => {
    const recordId = randomUUID();
    const employeeId = randomUUID();
    const branchId = randomUUID();
    const active = attendanceRow({ id: recordId, employeeId, branchId, clockInServerTime: new Date('2026-07-15T08:00:00.000Z'), breakMinutes: 60 });
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(active as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(
      attendanceRow({
        id: recordId,
        employeeId,
        branchId,
        clockOutServerTime: new Date('2026-07-15T17:00:00.000Z'),
        actualWorkMinutes: 480,
        breakMinutes: 60,
      }) as never,
    );

    const result = await attendanceService.clockOut(employeeId, {}, STAFF);

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'attendance:clocked_out', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('attendance:clocked_out', result);
    expect(attendanceResponseSchema.safeParse(result).success).toBe(true);
  });

  it('rejects with 404 RECORD_NOT_FOUND when there is no open record', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);

    await expect(attendanceService.clockOut('employee-1', {}, STAFF)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
      statusCode: 404,
    });
    expect(attendanceRepository.clockOut).not.toHaveBeenCalled();
  });
});

describe('attendanceService.manualOverride', () => {
  it('creates a correction record and soft-deletes the original', async () => {
    const original = attendanceRow();
    vi.mocked(attendanceRepository.findById).mockResolvedValue(original as never);
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.createOverride).mockResolvedValue(
      attendanceRow({ id: 'record-2', status: 'corrected', correctedBy: 'supervisor-1', originalRecordId: 'record-1' }) as never,
    );
    vi.mocked(attendanceRepository.softDelete).mockResolvedValue(attendanceRow({ deletedAt: new Date() }) as never);

    const result = await attendanceService.manualOverride(
      'record-1',
      { correctionReason: 'Employee clocked in on the wrong device' },
      SUPERVISOR,
    );

    expect(result.id).toBe('record-2');
    expect(result.status).toBe('corrected');
    expect(attendanceRepository.createOverride).toHaveBeenCalledWith(
      expect.objectContaining({ correctedBy: 'supervisor-1', correctionReason: 'Employee clocked in on the wrong device', originalRecordId: 'record-1' }),
    );
    expect(attendanceRepository.softDelete).toHaveBeenCalledWith('record-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CORRECTED' }));
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_ORIGINAL_SOFT_DELETED' }));
  });

  it('rejects with 404 RECORD_NOT_FOUND for an unknown originalRecordId', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(null);

    await expect(
      attendanceService.manualOverride('missing-record', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND', statusCode: 404 });
    expect(attendanceRepository.createOverride).not.toHaveBeenCalled();
  });

  it('rejects with 404 RECORD_NOT_FOUND when the original record is already soft-deleted', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(attendanceRow({ deletedAt: new Date() }) as never);

    await expect(
      attendanceService.manualOverride('record-1', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND', statusCode: 404 });
  });

  it('rejects with 403 BRANCH_ACCESS_DENIED when the supervisor is not assigned to the branch', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(attendanceRow() as never);
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue(null);

    await expect(
      attendanceService.manualOverride('record-1', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    expect(attendanceRepository.createOverride).not.toHaveBeenCalled();
  });
});

/**
 * GET /employee/:employeeId access scoping. The route itself is open to
 * every role (allRoles), so every request's employeeId must be checked
 * against the requester's own scope here, in the service — the router test
 * mocks this service out entirely and only proves the role gate + error
 * mapping, not the scoping decision itself.
 */
describe('attendanceService.getByEmployee', () => {
  const EMPLOYEE_ID = randomUUID();
  const BRANCH_1 = randomUUID();
  const BRANCH_2 = randomUUID();
  const FILTERS = { page: 1, limit: 25 };

  function mockRecords(records: unknown[] = [], total = 0) {
    vi.mocked(attendanceRepository.findByEmployee).mockResolvedValue({ records, total } as never);
  }

  describe('staff', () => {
    it('reads their own attendance → 200', async () => {
      mockRecords();
      const result = await attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, staffUser(EMPLOYEE_ID, BRANCH_1));
      expect(result).toEqual({ records: [], total: 0, page: 1, limit: 25 });
      expect(attendanceRepository.findByEmployee).toHaveBeenCalledWith(EMPLOYEE_ID, FILTERS);
    });

    it('reads another employee → 403 EMPLOYEE_ACCESS_DENIED, no data fetched', async () => {
      const otherEmployeeId = randomUUID();
      await expect(
        attendanceService.getByEmployee(otherEmployeeId, FILTERS, staffUser(EMPLOYEE_ID, BRANCH_1)),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_ACCESS_DENIED', statusCode: 403 });
      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });

    it('reads an employee from another branch → 403 EMPLOYEE_ACCESS_DENIED, no data fetched', async () => {
      const otherEmployeeId = randomUUID();
      await expect(
        attendanceService.getByEmployee(otherEmployeeId, FILTERS, staffUser(EMPLOYEE_ID, BRANCH_2)),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_ACCESS_DENIED', statusCode: 403 });
      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });
  });

  describe('branch', () => {
    it('reads an employee assigned to its active branch → 200', async () => {
      vi.mocked(attendanceRepository.findBranchAssignmentInBranches).mockResolvedValue({ id: 'assignment-1' } as never);
      mockRecords();

      const result = await attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, branchUser(BRANCH_1));

      expect(result).toEqual({ records: [], total: 0, page: 1, limit: 25 });
      expect(attendanceRepository.findBranchAssignmentInBranches).toHaveBeenCalledWith(EMPLOYEE_ID, [BRANCH_1]);
      expect(attendanceRepository.findByEmployee).toHaveBeenCalledWith(EMPLOYEE_ID, FILTERS);
    });

    it('reads an employee assigned to another branch → 403 BRANCH_ACCESS_DENIED, no data fetched', async () => {
      vi.mocked(attendanceRepository.findBranchAssignmentInBranches).mockResolvedValue(null);

      await expect(attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, branchUser(BRANCH_1))).rejects.toMatchObject({
        code: 'BRANCH_ACCESS_DENIED',
        statusCode: 403,
      });
      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });

    it('reads an employee whose only assignment at this branch is inactive (removed) → 403 BRANCH_ACCESS_DENIED', async () => {
      // findBranchAssignmentInBranches already filters removedAt: null at the
      // query layer (attendance.repository.ts), so a removed assignment
      // surfaces here as no match, same as "another branch".
      vi.mocked(attendanceRepository.findBranchAssignmentInBranches).mockResolvedValue(null);

      await expect(attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, branchUser(BRANCH_1))).rejects.toMatchObject({
        code: 'BRANCH_ACCESS_DENIED',
        statusCode: 403,
      });
      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });
  });

  describe('supervisor', () => {
    it('reads an employee in an authorized (active) branch → 200', async () => {
      vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_1, BRANCH_2]);
      vi.mocked(attendanceRepository.findBranchAssignmentInBranches).mockResolvedValue({ id: 'assignment-1' } as never);
      mockRecords();

      const result = await attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, supervisorUser([]));

      expect(result).toEqual({ records: [], total: 0, page: 1, limit: 25 });
      expect(attendanceRepository.findBranchAssignmentInBranches).toHaveBeenCalledWith(EMPLOYEE_ID, [BRANCH_1, BRANCH_2]);
    });

    it('reads an employee outside every authorized branch → 403 BRANCH_ACCESS_DENIED, no data fetched', async () => {
      vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_2]);
      vi.mocked(attendanceRepository.findBranchAssignmentInBranches).mockResolvedValue(null);

      await expect(attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, supervisorUser([]))).rejects.toMatchObject({
        code: 'BRANCH_ACCESS_DENIED',
        statusCode: 403,
      });
      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });
  });

  describe('super_admin', () => {
    it('reads any employee → 200, without a branch-assignment lookup', async () => {
      mockRecords();

      const result = await attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, superAdminUser());

      expect(result).toEqual({ records: [], total: 0, page: 1, limit: 25 });
      expect(attendanceRepository.findBranchAssignmentInBranches).not.toHaveBeenCalled();
      expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
    });
  });

  describe('empty state', () => {
    it('an authorized request with no attendance records returns 200 with records: [] and total: 0', async () => {
      mockRecords([], 0);

      const result = await attendanceService.getByEmployee(EMPLOYEE_ID, FILTERS, staffUser(EMPLOYEE_ID, BRANCH_1));

      expect(result).toEqual({ records: [], total: 0, page: 1, limit: 25 });
    });
  });

  describe('security', () => {
    it('a denied request never reaches the repository, so no GPS/attendance data can be returned in the response', async () => {
      const gpsRecord = attendanceRow({ clockInGpsLat: decimal(14.5995), clockInGpsLng: decimal(120.9842) });
      // Even if the repository *would* return GPS-bearing records, the
      // authorization check must short-circuit before it's ever called.
      mockRecords([gpsRecord], 1);

      await expect(
        attendanceService.getByEmployee(randomUUID(), FILTERS, staffUser(EMPLOYEE_ID, BRANCH_1)),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_ACCESS_DENIED', statusCode: 403 });

      expect(attendanceRepository.findByEmployee).not.toHaveBeenCalled();
    });
  });
});
