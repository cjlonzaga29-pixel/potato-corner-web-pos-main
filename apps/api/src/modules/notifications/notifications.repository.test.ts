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
  it('queries active super_admin users, selecting only id', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'admin-1' }] as never);

    const result = await notificationsRepository.findSuperAdminUserIds();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'super_admin', isActive: true },
      select: { id: true },
    });
    expect(result).toEqual([{ id: 'admin-1' }]);
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
