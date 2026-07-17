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
  sendFraudAlertEmail: vi.fn(),
  sendLargeAdjustmentApprovalEmail: vi.fn(),
  sendEodSummaryEmail: vi.fn(),
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
    findBranchSupervisorUserIds: vi.fn(),
  },
}));

const { sendWelcomeEmail, sendFraudAlertEmail, sendLargeAdjustmentApprovalEmail, sendEodSummaryEmail } = await import('../lib/email.js');
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
  function stockJobData(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      branchId: 'branch-1',
      ingredientId: 'ing-1',
      ingredientName: 'Potato',
      currentStock: 5,
      lowStockThreshold: 10,
      criticalThreshold: 3,
      severity: 'low' as const,
      ...overrides,
    };
  }

  it('emits the low-stock socket event to branch and super admin unchanged, and persists a low_stock Notification per branch supervisor/admin', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = stockJobData();

    await processor()({ name: 'low_stock_alert', data } as Job);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'inventory:low_stock', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('inventory:low_stock', data);
    expect(notificationsRepository.findBranchSupervisorAndAdminUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'low_stock',
      payload: {
        type: 'low_stock',
        branchId: 'branch-1',
        ingredientId: 'ing-1',
        ingredientName: 'Potato',
        currentStock: 5,
        lowStockThreshold: 10,
        criticalThreshold: 3,
      },
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
  });

  it('persists type critical_stock when severity is critical and stock is still above zero', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'admin-1' }] as never);
    const data = stockJobData({ currentStock: 2, severity: 'critical' as const });

    await processor()({ name: 'low_stock_alert', data } as Job);

    expect(notificationsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'critical_stock' }));
  });

  it('persists type out_of_stock when currentStock is zero or below, regardless of severity', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'admin-1' }] as never);
    const data = stockJobData({ currentStock: 0, severity: 'critical' as const });

    await processor()({ name: 'low_stock_alert', data } as Job);

    expect(notificationsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
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

describe('notificationWorker processor — cash_variance_flagged', () => {
  it('emits the socket event and persists a Notification per branch supervisor/admin', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = {
      type: 'cash_variance_flagged' as const,
      shiftId: 'shift-1',
      branchId: 'branch-1',
      expectedAmount: 1000,
      actualAmount: 850,
      variance: -150,
      flaggedBy: 'supervisor-1',
    };

    await processor()({ name: 'cash_variance_flagged', data } as Job);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'cash:variance_flagged', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:variance_flagged', data);
    expect(notificationsRepository.findBranchSupervisorAndAdminUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'cash_variance_flagged',
      payload: data,
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
  });
});

describe('notificationWorker processor — void_requested', () => {
  it('emits the socket event and persists a Notification per branch supervisor only (no super admins)', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = {
      type: 'void_requested' as const,
      branchId: 'branch-1',
      transactionNumber: 'MNL001-20260717-000001',
      requestedByUserId: 'admin-1',
      amount: 250,
      reason: 'customer changed mind',
    };

    await processor()({ name: 'void_requested', data } as Job);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'void:requested', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('void:requested', data);
    expect(notificationsRepository.findBranchSupervisorUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'void_requested',
      payload: data,
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
  });
});

describe('notificationWorker processor — large_adjustment_approval_needed', () => {
  it('emits the socket event to super admins, persists a Notification per super admin, and emails each super admin', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    const data = {
      type: 'large_adjustment_approval_needed' as const,
      branchId: 'branch-1',
      adjustmentId: 'adj-1',
      requestedByUserId: 'supervisor-1',
      amount: 5000,
    };

    await processor()({ name: 'large_adjustment_approval_needed', data } as Job);

    expect(notifySuperAdmin).toHaveBeenCalledWith('notification:large_adjustment_approval_needed', data);
    expect(notificationsRepository.findSuperAdminUserIds).toHaveBeenCalled();
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'large_adjustment_approval_needed',
      payload: data,
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(sendLargeAdjustmentApprovalEmail).toHaveBeenCalledWith('admin-1@potatocorner.test', data);
  });

  it('logs but does not throw when the email send fails, so the job still succeeds', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    vi.mocked(sendLargeAdjustmentApprovalEmail).mockRejectedValue(new Error('Resend outage'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const data = {
      type: 'large_adjustment_approval_needed' as const,
      branchId: 'branch-1',
      adjustmentId: 'adj-1',
      requestedByUserId: 'supervisor-1',
      amount: 5000,
    };

    await expect(processor()({ name: 'large_adjustment_approval_needed', data } as Job)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('notificationWorker processor — fraud_alert_created', () => {
  it('persists a Notification per super admin, emails each super admin, without re-emitting a socket event (already broadcast by detection.service.ts)', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    const data = { type: 'fraud_alert_created' as const, branchId: 'branch-1', alertId: 'alert-1', severity: 'high' };

    await processor()({ name: 'fraud_alert_created', data } as Job);

    expect(notificationsRepository.findSuperAdminUserIds).toHaveBeenCalled();
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'fraud_alert_created',
      payload: data,
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(sendFraudAlertEmail).toHaveBeenCalledWith('admin-1@potatocorner.test', data);
    expect(notifyBranch).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
  });
});

describe('notificationWorker processor — offline_transactions_synced', () => {
  it('emits the socket event to the branch and persists a Notification per branch supervisor only', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = { type: 'offline_transactions_synced' as const, branchId: 'branch-1', syncedCount: 4 };

    await processor()({ name: 'offline_transactions_synced', data } as Job);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'notification:offline_transactions_synced', data);
    expect(notifySuperAdmin).not.toHaveBeenCalled();
    expect(notificationsRepository.findBranchSupervisorUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'offline_transactions_synced',
      payload: data,
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
  });
});

describe('notificationWorker processor — eod_summary', () => {
  it('emits the socket event to super admins, persists a Notification per super admin, and emails each super admin', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    const data = {
      type: 'eod_summary' as const,
      branchId: 'branch-1',
      businessDate: '2026-07-17',
      totalSales: 15000,
      totalRevenue: 20000,
      transactionCount: 60,
      voidCount: 3,
      unresolvedCashVarianceCount: 1,
      openFraudAlertsCreatedTodayCount: 2,
      branchRevenue: [
        { branchId: 'branch-1', branchName: 'Manila', revenue: 15000 },
        { branchId: 'branch-2', branchName: 'Cebu', revenue: 5000 },
      ],
    };

    await processor()({ name: 'eod_summary', data } as Job);

    expect(notifySuperAdmin).toHaveBeenCalledWith('notification:eod_summary', data);
    expect(notificationsRepository.findSuperAdminUserIds).toHaveBeenCalled();
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'eod_summary',
      payload: data,
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(sendEodSummaryEmail).toHaveBeenCalledWith('admin-1@potatocorner.test', data);
  });
});
