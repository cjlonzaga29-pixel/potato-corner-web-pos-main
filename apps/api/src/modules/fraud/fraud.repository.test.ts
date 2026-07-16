import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mocks lib/prisma.js directly (same technique as transactions.repository.test.ts
 * and attendance.repository.test.ts) so each repository method's exact
 * where/data/include/orderBy shape can be asserted — fraud.repository.ts is
 * the only place in this module allowed to touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    fraudAlert: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    branch: {
      findMany: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { fraudRepository } = await import('./fraud.repository.js');

const FRAUD_ALERT_INCLUDE = { branch: { select: { id: true, name: true } } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fraudRepository.findAll', () => {
  it('with no filters returns all alerts ordered createdAt DESC then severity DESC', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({ page: 1, limit: 25 });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith({
      where: {},
      include: FRAUD_ALERT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { severity: 'desc' }],
      skip: 0,
      take: 25,
    });
    expect(prisma.fraudAlert.count).toHaveBeenCalledWith({ where: {} });
  });

  it('filters by status', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({ status: 'open', page: 1, limit: 25 });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'open' } }),
    );
    expect(prisma.fraudAlert.count).toHaveBeenCalledWith({ where: { status: 'open' } });
  });

  it('filters by severity', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({ severity: 'critical', page: 1, limit: 25 });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { severity: 'critical' } }),
    );
  });

  it('filters by branchId', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({ branchId: 'branch-1', page: 1, limit: 25 });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: 'branch-1' } }),
    );
  });

  it('combines branchId/status/severity/alertType filters', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({
      branchId: 'branch-1',
      status: 'investigating',
      severity: 'high',
      alertType: 'void_pattern',
      page: 1,
      limit: 25,
    });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { branchId: 'branch-1', status: 'investigating', severity: 'high', alertType: 'void_pattern' },
      }),
    );
  });

  it('computes skip/take from page and limit', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(0);

    await fraudRepository.findAll({ page: 3, limit: 10 });

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('returns the alerts array and total count', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([{ id: 'alert-1' }] as never);
    vi.mocked(prisma.fraudAlert.count).mockResolvedValue(1);

    const result = await fraudRepository.findAll({ page: 1, limit: 25 });

    expect(result).toEqual({ alerts: [{ id: 'alert-1' }], total: 1 });
  });
});

describe('fraudRepository.findById', () => {
  it('returns null when not found', async () => {
    vi.mocked(prisma.fraudAlert.findUnique).mockResolvedValue(null);

    const result = await fraudRepository.findById('missing');

    expect(prisma.fraudAlert.findUnique).toHaveBeenCalledWith({ where: { id: 'missing' }, include: FRAUD_ALERT_INCLUDE });
    expect(result).toBeNull();
  });

  it('returns the alert with the branch relation included when found', async () => {
    vi.mocked(prisma.fraudAlert.findUnique).mockResolvedValue({ id: 'alert-1', branch: { id: 'branch-1', name: 'Manila' } } as never);

    const result = await fraudRepository.findById('alert-1');

    expect(prisma.fraudAlert.findUnique).toHaveBeenCalledWith({ where: { id: 'alert-1' }, include: FRAUD_ALERT_INCLUDE });
    expect(result).toEqual({ id: 'alert-1', branch: { id: 'branch-1', name: 'Manila' } });
  });
});

describe('fraudRepository.updateStatus', () => {
  it('updates status only when no investigatedBy/dismissalReason are given', async () => {
    vi.mocked(prisma.fraudAlert.update).mockResolvedValue({ id: 'alert-1' } as never);

    await fraudRepository.updateStatus('alert-1', { status: 'investigating' });

    expect(prisma.fraudAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { status: 'investigating' },
      include: FRAUD_ALERT_INCLUDE,
    });
  });

  it('includes investigatedBy when provided', async () => {
    vi.mocked(prisma.fraudAlert.update).mockResolvedValue({ id: 'alert-1' } as never);

    await fraudRepository.updateStatus('alert-1', { status: 'investigating', investigatedBy: 'admin-1' });

    expect(prisma.fraudAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { status: 'investigating', investigatedBy: 'admin-1' },
      include: FRAUD_ALERT_INCLUDE,
    });
  });

  it('includes dismissalReason when provided', async () => {
    vi.mocked(prisma.fraudAlert.update).mockResolvedValue({ id: 'alert-1' } as never);

    await fraudRepository.updateStatus('alert-1', { status: 'dismissed', dismissalReason: 'False positive, verified with cashier' });

    expect(prisma.fraudAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { status: 'dismissed', dismissalReason: 'False positive, verified with cashier' },
      include: FRAUD_ALERT_INCLUDE,
    });
  });
});

describe('fraudRepository.findEmployeeNamesByIds', () => {
  it('returns an empty array without querying when given no ids', async () => {
    const result = await fraudRepository.findEmployeeNamesByIds([]);

    expect(result).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('queries users by id with firstName/lastName selected', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user-1', firstName: 'Juan', lastName: 'Dela Cruz' }] as never);

    const result = await fraudRepository.findEmployeeNamesByIds(['user-1']);

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-1'] } },
      select: { id: true, firstName: true, lastName: true },
    });
    expect(result).toEqual([{ id: 'user-1', firstName: 'Juan', lastName: 'Dela Cruz' }]);
  });
});

describe('fraudRepository.createAlert', () => {
  it('creates a fraud alert with the branch relation included', async () => {
    vi.mocked(prisma.fraudAlert.create).mockResolvedValue({ id: 'alert-new' } as never);

    const result = await fraudRepository.createAlert({
      alertType: 'excessive_voids',
      severity: 'medium',
      branchId: 'branch-1',
      employeeId: 'user-1',
      evidence: { shift_id: 'shift-1', void_count: 4 },
    });

    expect(prisma.fraudAlert.create).toHaveBeenCalledWith({
      data: {
        alertType: 'excessive_voids',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', void_count: 4 },
      },
      include: FRAUD_ALERT_INCLUDE,
    });
    expect(result).toEqual({ id: 'alert-new' });
  });
});

describe('fraudRepository.findRecentOpenAlert', () => {
  it('queries by branchId, employeeId, alertType, and status open/investigating', async () => {
    vi.mocked(prisma.fraudAlert.findFirst).mockResolvedValue(null);

    await fraudRepository.findRecentOpenAlert('branch-1', 'user-1', 'excessive_voids');

    expect(prisma.fraudAlert.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', employeeId: 'user-1', alertType: 'excessive_voids', status: { in: ['open', 'investigating'] } },
    });
  });

  it('returns null when nothing matches', async () => {
    vi.mocked(prisma.fraudAlert.findFirst).mockResolvedValue(null);

    const result = await fraudRepository.findRecentOpenAlert('branch-1', null, 'cash_variance_pattern');

    expect(result).toBeNull();
  });
});

describe('fraudRepository.findOpenAlertsByType', () => {
  it('selects only id and evidence for the given alertType, status open/investigating', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([{ id: 'alert-1', evidence: { customer_id_hash: 'abc' } }] as never);

    const result = await fraudRepository.findOpenAlertsByType('discount_id_reuse');

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith({
      where: { alertType: 'discount_id_reuse', status: { in: ['open', 'investigating'] } },
      select: { id: true, evidence: true },
    });
    expect(result).toEqual([{ id: 'alert-1', evidence: { customer_id_hash: 'abc' } }]);
  });
});

describe('fraudRepository.findActiveBranchIds', () => {
  it('selects only id for active branches', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }] as never);

    const result = await fraudRepository.findActiveBranchIds();

    expect(prisma.branch.findMany).toHaveBeenCalledWith({ where: { status: 'active' }, select: { id: true } });
    expect(result).toEqual([{ id: 'branch-1' }, { id: 'branch-2' }]);
  });
});
