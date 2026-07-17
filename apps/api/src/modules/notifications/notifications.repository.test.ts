import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mocks lib/prisma.js directly (same technique as fraud.repository.test.ts)
 * so each repository method's exact where/data shape can be asserted —
 * notifications.repository.ts is the only place in this module allowed to
 * touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { notificationsRepository } = await import('./notifications.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notificationsRepository.create', () => {
  it('creates a Notification row with the given type/payload/recipient/branch', async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'notif-new' } as never);

    const result = await notificationsRepository.create({
      type: 'inventory_deduction_failed',
      payload: { type: 'inventory_deduction_failed', transactionId: 'txn-1', branchId: 'branch-1', error: 'boom' },
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        type: 'inventory_deduction_failed',
        payload: { type: 'inventory_deduction_failed', transactionId: 'txn-1', branchId: 'branch-1', error: 'boom' },
        recipientUserId: 'admin-1',
        branchId: 'branch-1',
      },
    });
    expect(result).toEqual({ id: 'notif-new' });
  });
});

describe('notificationsRepository.findSuperAdminUserIds', () => {
  it('queries active super_admin users, selecting id and email', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);

    const result = await notificationsRepository.findSuperAdminUserIds();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'super_admin', isActive: true },
      select: { id: true, email: true },
    });
    expect(result).toEqual([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }]);
  });
});

describe('notificationsRepository.findBranchSupervisorAndAdminUserIds', () => {
  it('queries active super admins plus supervisors assigned to the given branch', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'supervisor-1' }, { id: 'admin-1' }] as never);

    const result = await notificationsRepository.findBranchSupervisorAndAdminUserIds('branch-1');

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        OR: [{ role: 'super_admin' }, { role: 'supervisor', branchAssignments: { some: { branchId: 'branch-1', removedAt: null } } }],
      },
      select: { id: true },
    });
    expect(result).toEqual([{ id: 'supervisor-1' }, { id: 'admin-1' }]);
  });
});

describe('notificationsRepository.findBranchSupervisorUserIds', () => {
  it('queries active supervisors assigned to the given branch, no super admins', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'supervisor-1' }] as never);

    const result = await notificationsRepository.findBranchSupervisorUserIds('branch-1');

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { isActive: true, role: 'supervisor', branchAssignments: { some: { branchId: 'branch-1', removedAt: null } } },
      select: { id: true },
    });
    expect(result).toEqual([{ id: 'supervisor-1' }]);
  });
});

describe('notificationsRepository.findForRecipient', () => {
  it('queries by recipientUserId, unread first then newest first, with pagination', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ id: 'notif-1' }] as never);
    vi.mocked(prisma.notification.count).mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    const result = await notificationsRepository.findForRecipient('user-1', { page: 1, limit: 25 });

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { recipientUserId: 'user-1' },
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      skip: 0,
      take: 25,
    });
    expect(prisma.notification.count).toHaveBeenNthCalledWith(1, { where: { recipientUserId: 'user-1' } });
    expect(prisma.notification.count).toHaveBeenNthCalledWith(2, { where: { recipientUserId: 'user-1', readAt: null } });
    expect(result).toEqual({ notifications: [{ id: 'notif-1' }], total: 1, unreadCount: 1 });
  });

  it('computes skip/take from page and limit', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
    vi.mocked(prisma.notification.count).mockResolvedValue(0);

    await notificationsRepository.findForRecipient('user-1', { page: 3, limit: 10 });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });
});

describe('notificationsRepository.markRead', () => {
  it('scopes the update to id and recipientUserId, stamping readAt', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 1 });

    const result = await notificationsRepository.markRead('notif-1', 'user-1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'notif-1', recipientUserId: 'user-1' },
      data: { readAt: expect.any(Date) },
    });
    expect(result).toEqual({ count: 1 });
  });

  it('returns count 0 when the notification belongs to a different recipient', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 0 });

    const result = await notificationsRepository.markRead('notif-1', 'other-user');

    expect(result).toEqual({ count: 0 });
  });
});

describe('notificationsRepository.markAllRead', () => {
  it('scopes the update to recipientUserId and unread rows only', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 3 });

    const result = await notificationsRepository.markAllRead('user-1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientUserId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(result).toEqual({ count: 3 });
  });
});
