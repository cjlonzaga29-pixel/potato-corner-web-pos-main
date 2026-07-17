import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const addMock = vi.fn();
const onMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
  Worker: vi.fn().mockImplementation((_name: string, processor: (job: Job) => Promise<void>) => ({
    on: onMock,
    __processor: processor,
  })),
}));

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

vi.mock('../lib/email.js', () => ({
  sendWelcomeEmail: vi.fn(),
}));

vi.mock('../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('../modules/notifications/notifications.repository.js', () => ({
  notificationsRepository: {
    create: vi.fn(),
    findSuperAdminUserIds: vi.fn(),
    findBranchSupervisorAndAdminUserIds: vi.fn(),
  },
}));

const { sendWelcomeEmail } = await import('../lib/email.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { notificationsRepository } = await import('../modules/notifications/notifications.repository.js');
const { notificationWorker, enqueueNotification } = await import('./notification.queue.js');

function processor(): (job: Job) => Promise<void> {
  return (notificationWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueNotification', () => {
  it('enqueues a job named for the type, with the payload as job data and Decision 7 retry options', async () => {
    const payload = {
      type: 'cash_variance_flagged' as const,
      shiftId: 'shift-1',
      branchId: 'branch-1',
      expectedAmount: 1000,
      actualAmount: 850,
      variance: -150,
      flaggedBy: 'supervisor-1',
    };

    await enqueueNotification('cash_variance_flagged', payload);

    expect(addMock).toHaveBeenCalledWith('cash_variance_flagged', payload, { attempts: 3, backoff: { type: 'custom' } });
  });
});

describe('notificationWorker processor — employee_welcome', () => {
  it('sends the welcome email unchanged', async () => {
    await processor()({
      name: 'employee_welcome',
      data: { toEmail: 'a@b.com', firstName: 'Ana', employeeId: 'emp-1', tempPassword: 'temp123' },
    } as Job);

    expect(sendWelcomeEmail).toHaveBeenCalledWith('a@b.com', 'Ana', 'emp-1', 'temp123');
  });
});

describe('notificationWorker processor — low_stock_alert', () => {
  it('emits the low-stock socket event to branch and super admin unchanged', async () => {
    const data = {
      branchId: 'branch-1',
      ingredientId: 'ing-1',
      ingredientName: 'Potato',
      currentStock: 5,
      lowStockThreshold: 10,
      criticalThreshold: 3,
      severity: 'low' as const,
    };

    await processor()({ name: 'low_stock_alert', data } as Job);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'inventory:low_stock', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('inventory:low_stock', data);
  });
});

describe('notificationWorker processor — inventory_deduction_failed', () => {
  it('persists a Notification row for every super admin and keeps logging the failure', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }] as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await processor()({
      name: 'inventory_deduction_failed',
      data: { transactionId: 'txn-1', branchId: 'branch-1', error: 'ingredient not found' },
    } as Job);

    expect(notificationsRepository.findSuperAdminUserIds).toHaveBeenCalled();
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'inventory_deduction_failed',
      payload: { type: 'inventory_deduction_failed', transactionId: 'txn-1', branchId: 'branch-1', error: 'ingredient not found' },
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'inventory_deduction_failed',
      payload: { type: 'inventory_deduction_failed', transactionId: 'txn-1', branchId: 'branch-1', error: 'ingredient not found' },
      recipientUserId: 'admin-2',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Inventory deduction failed for transaction txn-1 (branch branch-1):',
      'ingredient not found',
    );

    consoleErrorSpy.mockRestore();
  });
});

describe('notificationWorker processor — inventory_product_unavailable', () => {
  it('persists a Notification row for branch supervisors and super admins, without re-emitting a socket event', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'supervisor-1' }, { id: 'admin-1' }] as never);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const data = {
      branchId: 'branch-1',
      triggeredByIngredientId: 'ing-1',
      triggeredByIngredientName: 'Potato',
      affectedFlavors: [{ flavorId: 'flavor-1', name: 'Cheese' }],
      affectedProducts: [{ productId: 'prod-1', name: 'Potato Corner Regular' }],
    };

    await processor()({ name: 'inventory_product_unavailable', data } as Job);

    expect(notificationsRepository.findBranchSupervisorAndAdminUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'product_auto_unavailable',
      payload: { type: 'product_auto_unavailable', ...data },
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'product_auto_unavailable',
      payload: { type: 'product_auto_unavailable', ...data },
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledTimes(2);
    // The socket broadcast for this event already happens directly from
    // inventory.queue.ts at cascade time — this handler must not duplicate it.
    expect(notifyBranch).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});
