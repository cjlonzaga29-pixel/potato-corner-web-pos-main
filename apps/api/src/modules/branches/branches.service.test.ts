import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ROLES } from '@potato-corner/shared';
import { branchCodeSchema, bulkAssignGcashQrSchema } from '@potato-corner/shared';

vi.mock('./branches.repository.js', () => ({
  branchesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getActiveAssignments: vi.fn(),
    findActiveAssignment: vi.fn(),
    assignUser: vi.fn(),
    removeUserAssignment: vi.fn(),
    getUserActiveBranches: vi.fn(),
    findUserById: vi.fn(),
    countActiveShifts: vi.fn(),
    branchStats: vi.fn(),
    generateBranchCode: vi.fn(),
    findAllAccounts: vi.fn(),
    findAllStatsGrouped: vi.fn(),
    findAllActiveBranchIds: vi.fn(),
  },
}));

vi.mock('../../lib/id-counter.js', () => ({
  nextCounterValue: vi.fn(),
}));

// createBranch wraps branch-create + identity resolution + provisioning in
// prisma.$transaction (CR-005 Sub-phase 3b companion fix); the repositories
// invoked inside that callback are all mocked separately below, so the tx
// client itself is never actually touched — a stand-in object is enough,
// and $transaction just runs the callback immediately with it. Declared via
// vi.hoisted so it's safe to reference from the (hoisted) vi.mock factory.
const { txMock } = vi.hoisted(() => ({ txMock: {} }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(txMock)) },
}));

vi.mock('../product-inventory/product-inventory.repository.js', () => ({
  productInventoryRepository: { findDistinctIngredientIdentities: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../flavors/flavors.repository.js', () => ({
  flavorsRepository: { findDistinctFlavorIngredientIdentities: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../inventory/inventory.service.js', () => ({
  inventoryService: { provisionBranchIngredients: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../socket/socket.server.js', () => ({
  getIO: vi.fn().mockReturnValue(null),
  joinUserToBranchRoom: vi.fn(),
  leaveUserFromBranchRoom: vi.fn(),
}));

vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({
          data: { publicUrl: 'https://cdn.test/branch-gcash-qr/img.webp' },
        })),
      })),
    },
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
  })),
}));

const { branchesRepository } = await import('./branches.repository.js');
const { branchesService } = await import('./branches.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { supabaseAdmin } = await import('../../lib/supabase.js');
const { productInventoryRepository } = await import('../product-inventory/product-inventory.repository.js');
const { flavorsRepository } = await import('../flavors/flavors.repository.js');
const { inventoryService } = await import('../inventory/inventory.service.js');
const { prisma } = await import('../../lib/prisma.js');

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
    vi.mocked(branchesRepository.create).mockResolvedValue(
      buildBranch({ city: 'Quezon City', code: 'PC-QZN-001' }) as never,
    );

    await branchesService.createBranch(
      {
        name: 'QC Branch',
        address: '456 Commonwealth Ave',
        city: 'Quezon City',
        gpsRadiusMeters: 100,
        status: 'active',
      },
      ACTOR,
      null,
    );

    expect(branchesRepository.generateBranchCode).toHaveBeenCalledWith('Quezon City');
    expect(branchesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PC-QZN-001' }),
      txMock,
    );
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
        {
          name: 'Dup Branch',
          code: 'PC-MNL-001',
          address: '789 Taft Ave',
          city: 'Manila',
          gpsRadiusMeters: 100,
          status: 'active',
        },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_CODE_CONFLICT', statusCode: 409 });

    expect(branchesRepository.create).not.toHaveBeenCalled();
  });

  it('records a BRANCH_CREATED audit log entry', async () => {
    vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-002');
    vi.mocked(branchesRepository.create).mockResolvedValue(
      buildBranch({ code: 'PC-MNL-002' }) as never,
    );

    await branchesService.createBranch(
      {
        name: 'Branch 2',
        address: '321 Ayala Ave',
        city: 'Manila',
        gpsRadiusMeters: 100,
        status: 'active',
      },
      ACTOR,
      '127.0.0.1',
    );

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BRANCH_CREATED', actorId: ACTOR.id }),
    );
  });

  it('CR-004: provisions the new branch with a zero-stock ingredient for every distinct master-recipe ingredient identity', async () => {
    vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-003');
    vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-3', code: 'PC-MNL-003' }) as never);
    vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([
      { name: 'Potato', unit: 'g' },
      { name: 'Cooking Oil', unit: 'ml' },
    ]);
    vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

    await branchesService.createBranch(
      { name: 'Branch 3', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
      ACTOR,
      null,
    );

    expect(inventoryService.provisionBranchIngredients).toHaveBeenCalledWith(
      'branch-3',
      [
        { name: 'Potato', unit: 'g', category: 'OTHER' },
        { name: 'Cooking Oil', unit: 'ml', category: 'OTHER' },
      ],
      txMock,
    );
  });

  it('CR-004: skips provisioning entirely when no master recipe ingredients exist yet', async () => {
    vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-004');
    vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-4', code: 'PC-MNL-004' }) as never);
    vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
    vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

    await branchesService.createBranch(
      { name: 'Branch 4', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
      ACTOR,
      null,
    );

    expect(inventoryService.provisionBranchIngredients).not.toHaveBeenCalled();
  });

  describe('CR-005 Sub-phase 3b: recipe + flavor identity union', () => {
    it('unions recipe and flavor identities, deduped by (name, unit)', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-005');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-5', code: 'PC-MNL-005' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([{ name: 'Potato', unit: 'g' }]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([{ name: 'Cheese Powder', unit: 'g' }]);

      await branchesService.createBranch(
        { name: 'Branch 5', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      const call = vi.mocked(inventoryService.provisionBranchIngredients).mock.calls[0];
      const identities = call?.[1];
      expect(identities).toHaveLength(2);
      expect(identities).toEqual(
        expect.arrayContaining([
          { name: 'Potato', unit: 'g', category: 'OTHER' },
          { name: 'Cheese Powder', unit: 'g', category: 'FLAVOR' },
        ]),
      );
    });

    it('FLAVOR wins the category on a (name, unit) collision with a recipe identity', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-006');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-6', code: 'PC-MNL-006' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([{ name: 'Cheese Powder', unit: 'g' }]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([{ name: 'Cheese Powder', unit: 'g' }]);

      await branchesService.createBranch(
        { name: 'Branch 6', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      expect(inventoryService.provisionBranchIngredients).toHaveBeenCalledWith(
        'branch-6',
        [{ name: 'Cheese Powder', unit: 'g', category: 'FLAVOR' }],
        txMock,
      );
    });

    it('with only recipe identities behaves like pre-3b (all category OTHER)', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-007');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-7', code: 'PC-MNL-007' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([{ name: 'Potato', unit: 'g' }]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

      await branchesService.createBranch(
        { name: 'Branch 7', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      expect(inventoryService.provisionBranchIngredients).toHaveBeenCalledWith(
        'branch-7',
        [{ name: 'Potato', unit: 'g', category: 'OTHER' }],
        txMock,
      );
    });

    it('with only flavor identities provisions all of them as category FLAVOR', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-008');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-8', code: 'PC-MNL-008' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([
        { name: 'Sour Cream', unit: 'g' },
        { name: 'BBQ', unit: 'g' },
      ]);

      await branchesService.createBranch(
        { name: 'Branch 8', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      expect(inventoryService.provisionBranchIngredients).toHaveBeenCalledWith(
        'branch-8',
        [
          { name: 'Sour Cream', unit: 'g', category: 'FLAVOR' },
          { name: 'BBQ', unit: 'g', category: 'FLAVOR' },
        ],
        txMock,
      );
    });

    it('with zero recipe and zero flavor identities never calls provisionBranchIngredients', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-009');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-9', code: 'PC-MNL-009' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

      await branchesService.createBranch(
        { name: 'Branch 9', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      expect(inventoryService.provisionBranchIngredients).not.toHaveBeenCalled();
    });

    it('passes the final merged list, not the raw recipe/flavor arrays, to provisionBranchIngredients', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-010');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-10', code: 'PC-MNL-010' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([{ name: 'Potato', unit: 'g' }]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([{ name: 'Cheese Powder', unit: 'g' }]);

      await branchesService.createBranch(
        { name: 'Branch 10', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      const call = vi.mocked(inventoryService.provisionBranchIngredients).mock.calls[0];
      expect(call?.[0]).toBe('branch-10');
      expect(call?.[1]).not.toEqual([{ name: 'Potato', unit: 'g' }]);
      expect(call?.[1]).not.toEqual([{ name: 'Cheese Powder', unit: 'g' }]);
      expect(call?.[1]).toEqual(
        expect.arrayContaining([
          { name: 'Potato', unit: 'g', category: 'OTHER' },
          { name: 'Cheese Powder', unit: 'g', category: 'FLAVOR' },
        ]),
      );
    });
  });

  describe('CR-005 Sub-phase 3b companion: prisma.$transaction wrap', () => {
    it('runs branch create + identity resolution + provisioning inside a single prisma.$transaction call', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-011');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-11', code: 'PC-MNL-011' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

      await branchesService.createBranch(
        { name: 'Branch 11', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
      expect(branchesRepository.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'PC-MNL-011' }), txMock);
      expect(productInventoryRepository.findDistinctIngredientIdentities).toHaveBeenCalledWith(txMock);
      expect(flavorsRepository.findDistinctFlavorIngredientIdentities).toHaveBeenCalledWith(txMock);
    });

    it('a failure inside the transaction (e.g. provisioning throws) rejects createBranch, and no post-commit side effects run', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-012');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-12', code: 'PC-MNL-012' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([{ name: 'Potato', unit: 'g' }]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);
      vi.mocked(inventoryService.provisionBranchIngredients).mockRejectedValueOnce(new Error('provisioning failed'));

      await expect(
        branchesService.createBranch(
          { name: 'Branch 12', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
          ACTOR,
          null,
        ),
      ).rejects.toThrow('provisioning failed');

      // Real prisma.$transaction rolls back on a thrown/rejected callback —
      // this mock doesn't persist anything to roll back, but the audit log
      // and socket emit (both post-commit) must never fire when the
      // transaction itself rejected. DB-level rollback is verified for real
      // against Postgres by the integration suite below.
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it('records the BRANCH_CREATED audit log only after the transaction resolves', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-013');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-13', code: 'PC-MNL-013' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

      await branchesService.createBranch(
        { name: 'Branch 13', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      const txCallOrder = vi.mocked(prisma.$transaction).mock.invocationCallOrder.at(0);
      const auditCallOrder = vi.mocked(recordAuditLog).mock.invocationCallOrder.at(0);
      expect(txCallOrder).toBeDefined();
      expect(auditCallOrder).toBeDefined();
      expect(txCallOrder as number).toBeLessThan(auditCallOrder as number);
    });

    it('emits BRANCH_CREATED over the socket only after the transaction resolves', async () => {
      vi.mocked(branchesRepository.generateBranchCode).mockResolvedValue('PC-MNL-014');
      vi.mocked(branchesRepository.create).mockResolvedValue(buildBranch({ id: 'branch-14', code: 'PC-MNL-014' }) as never);
      vi.mocked(productInventoryRepository.findDistinctIngredientIdentities).mockResolvedValue([]);
      vi.mocked(flavorsRepository.findDistinctFlavorIngredientIdentities).mockResolvedValue([]);

      const emit = vi.fn();
      const io = { to: vi.fn().mockReturnValue({ emit }) };
      const { getIO } = await import('../../socket/socket.server.js');
      vi.mocked(getIO).mockReturnValueOnce(io as never);

      await branchesService.createBranch(
        { name: 'Branch 14', address: '1 EDSA', city: 'Manila', gpsRadiusMeters: 100, status: 'active' },
        ACTOR,
        null,
      );

      const txCallOrder = vi.mocked(prisma.$transaction).mock.invocationCallOrder.at(0);
      const emitCallOrder = emit.mock.invocationCallOrder.at(0);
      expect(txCallOrder).toBeDefined();
      expect(emitCallOrder).toBeDefined();
      expect(txCallOrder as number).toBeLessThan(emitCallOrder as number);
    });
  });
});

describe('branchesRepository.generateBranchCode (real implementation, Postgres counter mocked)', () => {
  it('increments the counter atomically per city prefix and pads to 3 digits', async () => {
    const { nextCounterValue } = await import('../../lib/id-counter.js');
    vi.mocked(nextCounterValue).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const actual = await vi.importActual<typeof import('./branches.repository.js')>(
      './branches.repository.js',
    );

    const first = await actual.branchesRepository.generateBranchCode('Manila');
    const second = await actual.branchesRepository.generateBranchCode('Manila');

    expect(nextCounterValue).toHaveBeenNthCalledWith(1, 'branch_code_counter:MAN');
    expect(nextCounterValue).toHaveBeenNthCalledWith(2, 'branch_code_counter:MAN');
    expect(first).toBe('PC-MAN-001');
    expect(second).toBe('PC-MAN-002');
  });
});

describe('branchesService.getAllBranches', () => {
  // Supervisor is organization-wide over every currently-active branch,
  // resolved from the database (findAllActiveBranchIds) — never the JWT's
  // branch_ids claim, and with no UserBranchAssignment requirement.
  it('for a supervisor returns every currently-active branch, not their JWT branch_ids', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-x', 'branch-y', 'branch-z']);

    const supervisor = {
      user_id: 'sup-1',
      role: ROLES.SUPERVISOR,
      email: 'sup@test.com',
      branch_ids: ['branch-a', 'branch-b'] as string[],
      iat: 0,
      exp: 9999999999,
    };

    await branchesService.getAllBranches(supervisor, { page: 1, limit: 25 });

    expect(branchesRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['branch-x', 'branch-y', 'branch-z'] }),
    );
  });

  it('for a supervisor with zero UserBranchAssignment records, still returns every active branch', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-x']);

    const supervisor = {
      user_id: 'sup-2',
      role: ROLES.SUPERVISOR,
      email: 'sup2@test.com',
      branch_ids: [] as string[],
      iat: 0,
      exp: 9999999999,
    };

    await branchesService.getAllBranches(supervisor, { page: 1, limit: 25 });

    expect(branchesRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ ids: ['branch-x'] }));
  });

  it('when the database genuinely has zero active branches, scopes the supervisor to zero results', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([]);

    const supervisor = {
      user_id: 'sup-3',
      role: ROLES.SUPERVISOR,
      email: 'sup3@test.com',
      branch_ids: [] as string[],
      iat: 0,
      exp: 9999999999,
    };

    await branchesService.getAllBranches(supervisor, { page: 1, limit: 25 });

    expect(branchesRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ ids: [] }));
  });

  it('for a super_admin returns all branches (no ids restriction)', async () => {
    vi.mocked(branchesRepository.findAll).mockResolvedValue({ branches: [], total: 0 });

    const admin = {
      user_id: 'admin-1',
      role: ROLES.SUPER_ADMIN,
      email: 'admin@test.com',
      iat: 0,
      exp: 9999999999,
    } as const;

    await branchesService.getAllBranches(admin, { page: 1, limit: 25 });

    const callArgs = vi.mocked(branchesRepository.findAll).mock.calls[0]?.[0];
    expect(callArgs?.ids).toBeUndefined();
  });
});

describe('branchesService.changeBranchStatus', () => {
  it('to closed with active shifts throws an error', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ status: 'active' }) as never,
    );
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(2);

    await expect(
      branchesService.changeBranchStatus('branch-1', 'closed', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_HAS_ACTIVE_SHIFTS',
      statusCode: 409,
    });

    expect(branchesRepository.update).not.toHaveBeenCalled();
  });

  it('to closed with no active shifts succeeds', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ status: 'active' }) as never,
    );
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(0);
    vi.mocked(branchesRepository.update).mockResolvedValue(
      buildBranch({ status: 'closed' }) as never,
    );

    const result = await branchesService.changeBranchStatus('branch-1', 'closed', ACTOR, null);

    expect(result.status).toBe('closed');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BRANCH_STATUS_CHANGED' }),
    );
  });
});

describe('branchesService.deleteBranch', () => {
  it('with active shifts throws BRANCH_HAS_ACTIVE_SHIFTS and never deletes', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(1);

    await expect(
      branchesService.deleteBranch('branch-1', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_HAS_ACTIVE_SHIFTS',
      statusCode: 409,
    });

    expect(branchesRepository.delete).not.toHaveBeenCalled();
  });

  it('with no branch found throws BRANCH_NOT_FOUND', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.deleteBranch('branch-missing', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('with no active shifts deletes and records a BRANCH_DELETED audit entry', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ id: 'branch-9', name: 'Old Branch', code: 'PC-MNL-009' }) as never,
    );
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(0);
    vi.mocked(branchesRepository.delete).mockResolvedValue(undefined as never);

    await branchesService.deleteBranch('branch-9', ACTOR, '127.0.0.1');

    expect(branchesRepository.delete).toHaveBeenCalledWith('branch-9');
    // The audit entry is written AFTER the delete (not before): a failed
    // delete must never leave a phantom BRANCH_DELETED entry for a branch
    // that still exists. branchId is intentionally absent — by the time this
    // fires, the branch row is already gone, and AuditLog.branchId is a real
    // FK, so referencing the now-deleted id would violate the constraint.
    // entityId (not FK-checked) still identifies which branch was deleted.
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BRANCH_DELETED',
        entityType: 'branch',
        entityId: 'branch-9',
        actorId: ACTOR.id,
        beforeState: expect.objectContaining({ name: 'Old Branch', code: 'PC-MNL-009' }),
        ipAddress: '127.0.0.1',
      }),
    );
    expect(recordAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ branchId: expect.anything() }),
    );

    const [deleteOrder] = vi.mocked(branchesRepository.delete).mock.invocationCallOrder;
    const [auditOrder] = vi.mocked(recordAuditLog).mock.invocationCallOrder;
    expect(deleteOrder).toBeDefined();
    expect(auditOrder).toBeDefined();
    expect(deleteOrder as number).toBeLessThan(auditOrder as number);
  });
});

describe('branchesService.assignSupervisor', () => {
  it('with a non-supervisor user throws an error', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({
      id: 'user-1',
      role: 'staff',
    } as never);

    await expect(
      branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'USER_NOT_SUPERVISOR',
    });

    expect(branchesRepository.assignUser).not.toHaveBeenCalled();
  });

  it('with an already-active assignment is idempotent (no error, no duplicate insert)', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({
      id: 'user-1',
      role: 'supervisor',
    } as never);
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ status: 'active' }) as never,
    );
    const existing = {
      id: 'assignment-1',
      userId: 'user-1',
      branchId: 'branch-1',
      assignedAt: new Date(),
      removedAt: null,
    };
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(existing as never);

    const result = await branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(result).toBe(existing);
    expect(branchesRepository.assignUser).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('creates the assignment and records an audit log when none exists yet', async () => {
    vi.mocked(branchesRepository.findUserById).mockResolvedValue({
      id: 'user-1',
      role: 'supervisor',
    } as never);
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ status: 'active' }) as never,
    );
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(null);
    const created = {
      id: 'assignment-2',
      userId: 'user-1',
      branchId: 'branch-1',
      assignedAt: new Date(),
      removedAt: null,
    };
    vi.mocked(branchesRepository.assignUser).mockResolvedValue(created as never);

    const result = await branchesService.assignSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(result).toBe(created);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUPERVISOR_ASSIGNED' }),
    );
  });
});

describe('branchesService.removeSupervisor', () => {
  it('sets removedAt correctly and records an audit log', async () => {
    const existing = {
      id: 'assignment-1',
      userId: 'user-1',
      branchId: 'branch-1',
      assignedAt: new Date(),
      removedAt: null,
    };
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(existing as never);
    vi.mocked(branchesRepository.removeUserAssignment).mockResolvedValue({
      ...existing,
      removedAt: new Date(),
    } as never);

    await branchesService.removeSupervisor('user-1', 'branch-1', ACTOR, null);

    expect(branchesRepository.removeUserAssignment).toHaveBeenCalledWith('assignment-1');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUPERVISOR_REMOVED' }),
    );
  });

  it('throws when no active assignment exists', async () => {
    vi.mocked(branchesRepository.findActiveAssignment).mockResolvedValue(null);

    await expect(
      branchesService.removeSupervisor('user-1', 'branch-1', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('branchesService.getAllAccounts', () => {
  const SUPERVISOR = {
    user_id: 'sup-1',
    role: ROLES.SUPERVISOR,
    email: 'sup@test.com',
    branch_ids: ['branch-1'],
    iat: 0,
    exp: 9999999999,
  };
  const SUPER_ADMIN = {
    user_id: 'admin-1',
    role: ROLES.SUPER_ADMIN,
    email: 'admin@test.com',
    iat: 0,
    exp: 9999999999,
  } as const;

  function assignmentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'assignment-1',
      user: {
        id: 'user-1',
        firstName: 'Juan',
        lastName: 'Cruz',
        email: 'juan@test.com',
        role: 'staff',
      },
      branch: { id: 'branch-1', name: 'Main Branch', code: 'PC-MNL-001' },
      ...overrides,
    };
  }

  it('throws BranchError BRANCH_ACCESS_DENIED (403) when the requesting role is not super_admin', async () => {
    await expect(branchesService.getAllAccounts(SUPERVISOR as never)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });

    expect(branchesRepository.findAllAccounts).not.toHaveBeenCalled();
  });

  it('returns a flat array with the expected keys for a super_admin', async () => {
    vi.mocked(branchesRepository.findAllAccounts).mockResolvedValue([assignmentRow()] as never);

    const result = await branchesService.getAllAccounts(SUPER_ADMIN as never);

    expect(result).toEqual([
      {
        assignment_id: 'assignment-1',
        user_id: 'user-1',
        first_name: 'Juan',
        last_name: 'Cruz',
        email: 'juan@test.com',
        role: 'staff',
        branch_id: 'branch-1',
        branch_name: 'Main Branch',
        branch_code: 'PC-MNL-001',
      },
    ]);
  });

  it('delegates entirely to branchesRepository.findAllAccounts, which restricts results to removedAt: null assignments', async () => {
    // getAllAccounts takes no repository filter argument — the removedAt:
    // null clause lives inside branchesRepository.findAllAccounts itself
    // (see branches.repository.ts). This asserts the service calls the
    // repository with no additional arguments, i.e. it never widens the
    // repository's built-in filter.
    vi.mocked(branchesRepository.findAllAccounts).mockResolvedValue([] as never);

    await branchesService.getAllAccounts(SUPER_ADMIN as never);

    expect(branchesRepository.findAllAccounts).toHaveBeenCalledWith();
  });
});

describe('branchesService.getAllBranchStats', () => {
  const SUPERVISOR = {
    user_id: 'sup-1',
    role: ROLES.SUPERVISOR,
    email: 'sup@test.com',
    branch_ids: ['branch-1'],
    iat: 0,
    exp: 9999999999,
  };
  const SUPER_ADMIN = {
    user_id: 'admin-1',
    role: ROLES.SUPER_ADMIN,
    email: 'admin@test.com',
    iat: 0,
    exp: 9999999999,
  } as const;

  function statsRow(overrides: Record<string, unknown> = {}) {
    return {
      branchId: 'branch-1',
      activeShiftsCount: 1,
      activeStaffCount: 2,
      todayRevenue: 500,
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
      todayTransactionCount: 3,
      lowStockIngredientCount: 0,
      ...overrides,
    };
  }

  it('filters results to accessible branches when accessibleBranchIds returns an array (supervisor)', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findAllStatsGrouped).mockResolvedValue([
      statsRow({ branchId: 'branch-1' }),
      statsRow({ branchId: 'branch-2' }),
    ] as never);

    const result = await branchesService.getAllBranchStats(SUPERVISOR as never);

    expect(result).toEqual([statsRow({ branchId: 'branch-1' })]);
  });

  it("returns all stats when accessibleBranchIds returns 'all' (super_admin)", async () => {
    vi.mocked(branchesRepository.findAllStatsGrouped).mockResolvedValue([
      statsRow({ branchId: 'branch-1' }),
      statsRow({ branchId: 'branch-2' }),
    ] as never);

    const result = await branchesService.getAllBranchStats(SUPER_ADMIN as never);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.branchId)).toEqual(['branch-1', 'branch-2']);
  });

  it('with a branchId the requester can access returns a single-branch result via branchStats', async () => {
    vi.mocked(branchesRepository.branchStats).mockResolvedValue({
      activeShiftsCount: 1,
      todayTransactionCount: 3,
      todayRevenue: 500,
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
      activeStaffCount: 2,
      lowStockIngredientCount: 0,
    });

    const result = await branchesService.getAllBranchStats(SUPER_ADMIN as never, 'branch-1');

    expect(branchesRepository.branchStats).toHaveBeenCalledWith('branch-1');
    expect(branchesRepository.findAllStatsGrouped).not.toHaveBeenCalled();
    expect(result).toEqual([statsRow({ branchId: 'branch-1' })]);
  });

  it('with a branchId the requester cannot access throws BRANCH_ACCESS_DENIED (403)', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    await expect(
      branchesService.getAllBranchStats(SUPERVISOR as never, 'branch-2'),
    ).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });

    expect(branchesRepository.branchStats).not.toHaveBeenCalled();
    expect(branchesRepository.findAllStatsGrouped).not.toHaveBeenCalled();
  });

  it('passes through the new financial fields (todayGrossSales, todayVat, todayExpenses, todayNetProfit) unchanged', async () => {
    vi.mocked(branchesRepository.findAllStatsGrouped).mockResolvedValue([
      statsRow({ branchId: 'branch-1' }),
    ] as never);

    const result = await branchesService.getAllBranchStats(SUPER_ADMIN as never);

    expect(result[0]).toMatchObject({
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
    });
  });

  it('filtering by branchId still returns the new financial fields', async () => {
    vi.mocked(branchesRepository.branchStats).mockResolvedValue({
      activeShiftsCount: 1,
      todayTransactionCount: 3,
      todayRevenue: 500,
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
      activeStaffCount: 2,
      lowStockIngredientCount: 0,
    });

    const result = await branchesService.getAllBranchStats(SUPER_ADMIN as never, 'branch-1');

    expect(result[0]).toMatchObject({
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
    });
  });
});

describe('bulkAssignGcashQrSchema', () => {
  it('rejects non-UUID branchIds', () => {
    expect(bulkAssignGcashQrSchema.safeParse({ branchIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('rejects an empty branchIds array', () => {
    expect(bulkAssignGcashQrSchema.safeParse({ branchIds: [] }).success).toBe(false);
  });

  it('rejects more than 50 branchIds', () => {
    const ids = Array.from({ length: 51 }, () => randomUUID());
    expect(bulkAssignGcashQrSchema.safeParse({ branchIds: ids }).success).toBe(false);
  });

  it('accepts 1-50 valid UUIDs', () => {
    expect(bulkAssignGcashQrSchema.safeParse({ branchIds: [randomUUID()] }).success).toBe(true);
  });
});

describe('branchesService.getBranchById', () => {
  const SUPERVISOR = {
    user_id: 'sup-1',
    role: ROLES.SUPERVISOR,
    email: 'sup@test.com',
    branch_ids: ['branch-1'],
    iat: 0,
    exp: 9999999999,
  };
  const SUPER_ADMIN = {
    user_id: 'admin-1',
    role: ROLES.SUPER_ADMIN,
    email: 'admin@test.com',
    iat: 0,
    exp: 9999999999,
  } as const;

  it('returns the branch when a supervisor requests a branch they have access to', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ id: 'branch-1' }) as never,
    );

    const result = await branchesService.getBranchById('branch-1', SUPERVISOR as never);

    expect(result.id).toBe('branch-1');
  });

  it('throws BRANCH_ACCESS_DENIED (403) when a supervisor requests a branch they cannot access', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    await expect(
      branchesService.getBranchById('branch-2', SUPERVISOR as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });

    expect(branchesRepository.findById).not.toHaveBeenCalled();
  });

  it('throws BRANCH_NOT_FOUND (404) when the branch does not exist', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.getBranchById('branch-1', SUPER_ADMIN as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('for a super_admin does not restrict by branch access', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ id: 'branch-9' }) as never,
    );

    const result = await branchesService.getBranchById('branch-9', SUPER_ADMIN as never);

    expect(result.id).toBe('branch-9');
  });
});

describe('branchesService.updateBranch', () => {
  it('throws BRANCH_NOT_FOUND (404) when the branch does not exist', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.updateBranch('branch-1', { name: 'New Name' }, ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });

    expect(branchesRepository.update).not.toHaveBeenCalled();
  });

  it('updates the branch and records an audit log with before/after state', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ name: 'Old Name' }) as never,
    );
    vi.mocked(branchesRepository.update).mockResolvedValue(
      buildBranch({ name: 'New Name' }) as never,
    );

    const result = await branchesService.updateBranch(
      'branch-1',
      { name: 'New Name' },
      ACTOR,
      '127.0.0.1',
    );

    expect(result.name).toBe('New Name');
    expect(branchesRepository.update).toHaveBeenCalledWith('branch-1', { name: 'New Name' });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BRANCH_UPDATED',
        beforeState: expect.objectContaining({ name: 'Old Name' }),
        afterState: expect.objectContaining({ name: 'New Name' }),
      }),
    );
  });
});

describe('branchesService.uploadGcashQr', () => {
  const FILE = { buffer: Buffer.from('fake'), originalname: 'qr.png' };

  it('throws BRANCH_NOT_FOUND (404) when the branch does not exist', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(branchesService.uploadGcashQr('branch-1', FILE)).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('uploads the compressed image to storage and returns the public url/key', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);

    const result = await branchesService.uploadGcashQr('branch-1', FILE);

    expect(result).toEqual({
      url: 'https://cdn.test/branch-gcash-qr/img.webp',
      key: expect.stringContaining('branch-gcash-qr/branch-1/'),
    });
  });

  it('throws QR_UPLOAD_FAILED (502) when storage upload fails', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    vi.mocked(supabaseAdmin.storage.from).mockReturnValueOnce({
      upload: vi.fn().mockResolvedValue({ error: { message: 'storage down' } }),
      getPublicUrl: vi.fn(),
    } as never);

    await expect(branchesService.uploadGcashQr('branch-1', FILE)).rejects.toMatchObject({
      code: 'QR_UPLOAD_FAILED',
      statusCode: 502,
    });
  });
});

describe('branchesService.getAssignments', () => {
  const SUPERVISOR = {
    user_id: 'sup-1',
    role: ROLES.SUPERVISOR,
    email: 'sup@test.com',
    branch_ids: ['branch-1'],
    iat: 0,
    exp: 9999999999,
  };

  it('throws BRANCH_ACCESS_DENIED (403) when the requester cannot access the branch', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    await expect(
      branchesService.getAssignments('branch-2', SUPERVISOR as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });

    expect(branchesRepository.findById).not.toHaveBeenCalled();
  });

  it('throws BRANCH_NOT_FOUND (404) when the branch does not exist', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.getAssignments('branch-1', SUPERVISOR as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('returns mapped assignment rows for a branch the requester can access', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    vi.mocked(branchesRepository.getActiveAssignments).mockResolvedValue([
      {
        id: 'assignment-1',
        userId: 'user-1',
        branchId: 'branch-1',
        assignedAt: new Date('2026-01-02T00:00:00.000Z'),
        user: {
          id: 'user-1',
          firstName: 'Juan',
          lastName: 'Cruz',
          email: 'juan@test.com',
          role: 'supervisor',
        },
      },
    ] as never);

    const result = await branchesService.getAssignments('branch-1', SUPERVISOR as never);

    expect(result).toEqual([
      {
        id: 'assignment-1',
        userId: 'user-1',
        branchId: 'branch-1',
        firstName: 'Juan',
        lastName: 'Cruz',
        email: 'juan@test.com',
        role: 'supervisor',
        assignedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('branchesService.getBranchStats (single branch)', () => {
  const SUPERVISOR = {
    user_id: 'sup-1',
    role: ROLES.SUPERVISOR,
    email: 'sup@test.com',
    branch_ids: ['branch-1'],
    iat: 0,
    exp: 9999999999,
  };

  it('throws BRANCH_ACCESS_DENIED (403) when the requester cannot access the branch', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    await expect(
      branchesService.getBranchStats('branch-2', SUPERVISOR as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });

    expect(branchesRepository.branchStats).not.toHaveBeenCalled();
  });

  it('throws BRANCH_NOT_FOUND (404) when the branch does not exist', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.getBranchStats('branch-1', SUPERVISOR as never),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });

    expect(branchesRepository.branchStats).not.toHaveBeenCalled();
  });

  it('returns the repository stats directly for a branch the requester can access', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    const stats = {
      activeShiftsCount: 1,
      todayTransactionCount: 3,
      todayRevenue: 500,
      todayGrossSales: 500,
      todayVat: 53.57,
      todayExpenses: 100,
      todayNetProfit: 346.43,
      activeStaffCount: 2,
      lowStockIngredientCount: 0,
    };
    vi.mocked(branchesRepository.branchStats).mockResolvedValue(stats);

    const result = await branchesService.getBranchStats('branch-1', SUPERVISOR as never);

    expect(result).toEqual(stats);
  });
});

describe('branchesService.bulkAssignGcashQr', () => {
  const FILE = { buffer: Buffer.from('fake'), originalname: 'qr.png' };

  it('uploads to multiple branches successfully', async () => {
    vi.mocked(branchesRepository.findByIds).mockResolvedValue([
      buildBranch({ id: 'branch-1' }),
      buildBranch({ id: 'branch-2' }),
    ] as never);
    vi.mocked(branchesRepository.update).mockResolvedValue(buildBranch() as never);

    const result = await branchesService.bulkAssignGcashQr(
      ['branch-1', 'branch-2'],
      FILE,
      ACTOR,
      null,
    );

    expect(result.successful).toEqual([
      { branchId: 'branch-1', gcashQrUrl: 'https://cdn.test/branch-gcash-qr/img.webp' },
      { branchId: 'branch-2', gcashQrUrl: 'https://cdn.test/branch-gcash-qr/img.webp' },
    ]);
    expect(result.failed).toEqual([]);
    expect(branchesRepository.update).toHaveBeenCalledTimes(2);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BULK_GCASH_QR_ASSIGN' }),
    );
  });

  it('returns partial success when one branch fails', async () => {
    vi.mocked(branchesRepository.findByIds).mockResolvedValue([
      buildBranch({ id: 'branch-1' }),
      buildBranch({ id: 'branch-2' }),
    ] as never);
    vi.mocked(branchesRepository.update)
      .mockResolvedValueOnce(buildBranch() as never)
      .mockRejectedValueOnce(new Error('DB update failed'));

    const result = await branchesService.bulkAssignGcashQr(
      ['branch-1', 'branch-2'],
      FILE,
      ACTOR,
      null,
    );

    expect(result.successful).toEqual([
      { branchId: 'branch-1', gcashQrUrl: 'https://cdn.test/branch-gcash-qr/img.webp' },
    ]);
    expect(result.failed).toEqual([{ branchId: 'branch-2', error: 'DB update failed' }]);
  });

  it('rejects if any branch does not exist', async () => {
    vi.mocked(branchesRepository.findByIds).mockResolvedValue([
      buildBranch({ id: 'branch-1' }),
    ] as never);

    await expect(
      branchesService.bulkAssignGcashQr(['branch-1', 'branch-missing'], FILE, ACTOR, null),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', statusCode: 404 });

    expect(branchesRepository.update).not.toHaveBeenCalled();
  });

  it('surfaces a storage upload failure as a per-branch failure, not a thrown error', async () => {
    vi.mocked(branchesRepository.findByIds).mockResolvedValue([
      buildBranch({ id: 'branch-1' }),
    ] as never);
    vi.mocked(supabaseAdmin.storage.from).mockReturnValueOnce({
      upload: vi.fn().mockResolvedValue({ error: { message: 'storage down' } }),
      getPublicUrl: vi.fn(),
    } as never);

    const result = await branchesService.bulkAssignGcashQr(['branch-1'], FILE, ACTOR, null);

    expect(result.successful).toEqual([]);
    expect(result.failed).toEqual([
      { branchId: 'branch-1', error: 'Failed to upload the GCash QR image' },
    ]);
    expect(branchesRepository.update).not.toHaveBeenCalled();
  });
});
