import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Same technique as fraud.repository.test.ts: mocks lib/prisma.js directly
 * so each repository method's exact where/orderBy/skip/take shape can be
 * asserted — audit.repository.ts is the only place in this module allowed
 * to touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { auditRepository } = await import('./audit.repository.js');

const AUDIT_LOG_INCLUDE = {
  actor: { select: { id: true, firstName: true, lastName: true, email: true } },
  branch: { select: { id: true, name: true } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auditRepository.findAll', () => {
  it('with no filters returns all logs ordered createdAt DESC', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      include: AUDIT_LOG_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 25,
    });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: {} });
  });

  it('filters by action', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ action: 'FRAUD_ALERT_DISMISSED', page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: 'FRAUD_ALERT_DISMISSED' } }),
    );
  });

  it('filters by entityType and entityId', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ entityType: 'fraud_alert', entityId: 'alert-1', page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: 'fraud_alert', entityId: 'alert-1' } }),
    );
  });

  it('filters by actorId and branchId', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ actorId: 'user-1', branchId: 'branch-1', page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actorId: 'user-1', branchId: 'branch-1' } }),
    );
  });

  it('builds a createdAt range when date_from/date_to are provided', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ dateFrom: '2026-07-01', dateTo: '2026-07-14', page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-14T23:59:59.999Z') } },
      }),
    );
  });

  it('computes skip/take from page and limit', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    await auditRepository.findAll({ page: 3, limit: 10 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('returns the logs array and total count', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([{ id: 'log-1' }] as never);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(1);

    const result = await auditRepository.findAll({ page: 1, limit: 25 });

    expect(result).toEqual({ logs: [{ id: 'log-1' }], total: 1 });
  });
});
