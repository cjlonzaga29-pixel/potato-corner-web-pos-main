import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 21: BullMQ removed — enqueueNotification/enqueueRawNotificationJob
 * now run processNotification directly in-process (fired via
 * lib/job-runner.ts's runFireAndForget, retried via runWithRetry) instead of
 * dispatching through a BullMQ Worker. job-runner is mocked as a thin
 * wrapper around the real implementation (via importOriginal) so
 * retry/fire-and-forget behavior stays real while still letting us assert on
 * call arguments (e.g. the RETRY_DELAYS_MS array). Most of this file calls
 * processNotification directly — deterministic and synchronous — since
 * that's where all the per-job-name recipient/payload logic under test
 * actually lives; only the "enqueueNotification/enqueueRawNotificationJob"
 * describe blocks below exercise the fire-and-forget wiring itself.
 */
vi.mock('../lib/job-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../lib/job-runner.js');
  return {
    ...actual,
    runWithRetry: vi.fn(actual.runWithRetry),
    runFireAndForget: vi.fn(actual.runFireAndForget),
  };
});

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

const { runWithRetry } = await import('../lib/job-runner.js');
const { sendWelcomeEmail, sendFraudAlertEmail, sendLargeAdjustmentApprovalEmail, sendEodSummaryEmail } = await import('../lib/email.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { notificationsRepository } = await import('../modules/notifications/notifications.repository.js');
const { processNotification, enqueueNotification, enqueueRawNotificationJob } = await import('./notification.queue.js');

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() only clears call history, not a mock's configured
  // implementation — reset these back to their happy-path default so a
  // preceding test's mockRejectedValue(...) can't bleed into the next test.
  vi.mocked(sendWelcomeEmail).mockResolvedValue(undefined);
  vi.mocked(sendFraudAlertEmail).mockResolvedValue(undefined);
  vi.mocked(sendLargeAdjustmentApprovalEmail).mockResolvedValue(undefined);
  vi.mocked(sendEodSummaryEmail).mockResolvedValue(undefined);
});

describe('enqueueNotification', () => {
  it('runs processNotification with the type as job name and the payload as job data, under the Decision 7 retry policy', async () => {
    const payload = {
      type: 'cash_variance_flagged' as const,
      shiftId: 'shift-1',
      branchId: 'branch-1',
      expectedAmount: 1000,
      actualAmount: 850,
      variance: -150,
      flaggedBy: 'supervisor-1',
    };
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);

    await enqueueNotification('cash_variance_flagged', payload);
    // enqueueNotification returns before the background job runs (fire-and-forget) — wait for its observable side effect.
    await vi.waitFor(() => expect(notifyBranch).toHaveBeenCalled());

    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'cash:variance_flagged', payload);
  });

  it.each([
    ['fraud_alert_created' as const, { type: 'fraud_alert_created' as const, branchId: 'branch-1', alertId: 'alert-1', severity: 'high' }],
    [
      'eod_summary' as const,
      {
        type: 'eod_summary' as const,
        branchId: 'branch-1',
        businessDate: '2026-07-17',
        totalSales: 15000,
        totalRevenue: 20000,
        transactionCount: 60,
        voidCount: 3,
        unresolvedCashVarianceCount: 1,
        openFraudAlertsCreatedTodayCount: 2,
        branchRevenue: [{ branchId: 'branch-1', branchName: 'Manila', revenue: 15000 }],
      },
    ],
    [
      'void_requested' as const,
      {
        type: 'void_requested' as const,
        branchId: 'branch-1',
        transactionNumber: 'MNL001-20260717-000001',
        requestedByUserId: 'admin-1',
        amount: 250,
        reason: 'customer changed mind',
      },
    ],
  ])('runs processNotification for a %s payload under the Decision 7 retry policy', async (type, payload) => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([]);
    vi.mocked(notificationsRepository.findBranchSupervisorUserIds).mockResolvedValue([]);

    await enqueueNotification(type, payload);
    await vi.waitFor(() => expect(runWithRetry).toHaveBeenCalled());

    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
  });
});

describe('enqueueRawNotificationJob', () => {
  it('runs processNotification for job names that are not NotificationType values (e.g. employee_welcome), under the Decision 7 retry policy', async () => {
    const data = { toEmail: 'a@b.com', firstName: 'Ana', employeeId: 'emp-1', tempPassword: 'temp123' };

    await enqueueRawNotificationJob('employee_welcome', data);
    await vi.waitFor(() => expect(sendWelcomeEmail).toHaveBeenCalled());

    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
    expect(sendWelcomeEmail).toHaveBeenCalledWith('a@b.com', 'Ana', 'emp-1', 'temp123');
  });

  it('logs (and does not throw) once every retry attempt is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(sendWelcomeEmail).mockRejectedValue(new Error('Resend outage'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const data = { toEmail: 'a@b.com', firstName: 'Ana', employeeId: 'emp-1', tempPassword: 'temp123' };

    await enqueueRawNotificationJob('employee_welcome', data);
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    expect(sendWelcomeEmail).toHaveBeenCalledTimes(3);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Notification job "employee_welcome" failed after 3 attempt(s):', expect.any(Error));

    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('processNotification — employee_welcome', () => {
  it('sends the welcome email unchanged', async () => {
    await processNotification('employee_welcome', { toEmail: 'a@b.com', firstName: 'Ana', employeeId: 'emp-1', tempPassword: 'temp123' });

    expect(sendWelcomeEmail).toHaveBeenCalledWith('a@b.com', 'Ana', 'emp-1', 'temp123');
  });
});

describe('processNotification — low_stock_alert', () => {
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

  it('emits the low-stock socket event to branch and super admin, and persists a low_stock Notification per branch supervisor/admin', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = stockJobData();

    await processNotification('low_stock_alert', data);

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

    await processNotification('low_stock_alert', data);

    expect(notificationsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'critical_stock' }));
  });

  it('persists type out_of_stock when currentStock is zero or below, regardless of severity', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([{ id: 'admin-1' }] as never);
    const data = stockJobData({ currentStock: 0, severity: 'critical' as const });

    await processNotification('low_stock_alert', data);

    expect(notificationsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
  });
});

describe('processNotification — inventory_deduction_failed', () => {
  it('persists a Notification row for every super admin and keeps logging the failure', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }] as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await processNotification('inventory_deduction_failed', { transactionId: 'txn-1', branchId: 'branch-1', error: 'ingredient not found' });

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
    expect(consoleErrorSpy).toHaveBeenCalledWith('Inventory deduction failed for transaction txn-1 (branch branch-1):', 'ingredient not found');

    consoleErrorSpy.mockRestore();
  });
});

describe('processNotification — inventory_product_unavailable', () => {
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

    await processNotification('inventory_product_unavailable', data);

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

describe('processNotification — cash_variance_flagged', () => {
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

    await processNotification('cash_variance_flagged', data);

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

describe('processNotification — void_requested', () => {
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

    await processNotification('void_requested', data);

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

describe('processNotification — large_adjustment_approval_needed', () => {
  it('emits the socket event to the branch and super admins, persists a Notification per branch supervisor + super admin, and emails each', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([
      { id: 'admin-1', email: 'admin-1@potatocorner.test' },
      { id: 'supervisor-1', email: 'supervisor-1@potatocorner.test' },
    ] as never);
    const data = {
      type: 'large_adjustment_approval_needed' as const,
      branchId: 'branch-1',
      adjustmentId: 'adj-1',
      requestedByUserId: 'supervisor-1',
      amount: 5000,
    };

    await processNotification('large_adjustment_approval_needed', data);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'notification:large_adjustment_approval_needed', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('notification:large_adjustment_approval_needed', data);
    expect(notificationsRepository.findBranchSupervisorAndAdminUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'large_adjustment_approval_needed',
      payload: data,
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'large_adjustment_approval_needed',
      payload: data,
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
    expect(sendLargeAdjustmentApprovalEmail).toHaveBeenCalledWith('admin-1@potatocorner.test', data);
    expect(sendLargeAdjustmentApprovalEmail).toHaveBeenCalledWith('supervisor-1@potatocorner.test', data);
  });

  it('logs but does not throw when the email send fails, so the job still succeeds', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([
      { id: 'admin-1', email: 'admin-1@potatocorner.test' },
    ] as never);
    vi.mocked(sendLargeAdjustmentApprovalEmail).mockRejectedValue(new Error('Resend outage'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const data = {
      type: 'large_adjustment_approval_needed' as const,
      branchId: 'branch-1',
      adjustmentId: 'adj-1',
      requestedByUserId: 'supervisor-1',
      amount: 5000,
    };

    await expect(processNotification('large_adjustment_approval_needed', data)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('processNotification — fraud_alert_created', () => {
  it('persists a Notification per super admin, emails each super admin, without re-emitting a socket event (already broadcast by detection.service.ts)', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    const data = { type: 'fraud_alert_created' as const, branchId: 'branch-1', alertId: 'alert-1', severity: 'high' };

    await processNotification('fraud_alert_created', data);

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

  it('logs but does not throw when the email send fails, so the job still resolves', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    vi.mocked(sendFraudAlertEmail).mockRejectedValue(new Error('Resend outage'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const data = { type: 'fraud_alert_created' as const, branchId: 'branch-1', alertId: 'alert-1', severity: 'high' };

    await expect(processNotification('fraud_alert_created', data)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('processNotification — offline_transactions_synced', () => {
  it('emits the socket event to the branch and persists a Notification per branch supervisor only', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorUserIds).mockResolvedValue([{ id: 'supervisor-1' }] as never);
    const data = { type: 'offline_transactions_synced' as const, branchId: 'branch-1', syncedCount: 4 };

    await processNotification('offline_transactions_synced', data);

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

describe('processNotification — branch_offline', () => {
  it('emits the socket event to the branch and super admins, and persists a Notification per branch supervisor/admin', async () => {
    vi.mocked(notificationsRepository.findBranchSupervisorAndAdminUserIds).mockResolvedValue([
      { id: 'supervisor-1' },
      { id: 'admin-1' },
    ] as never);
    const data = { type: 'branch_offline' as const, branchId: 'branch-1', branchName: 'Manila', lastSeenAt: '2026-07-24T00:00:00.000Z' };

    await processNotification('branch_offline', data);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'branch:offline', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('branch:offline', data);
    expect(notificationsRepository.findBranchSupervisorAndAdminUserIds).toHaveBeenCalledWith('branch-1');
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'branch_offline',
      payload: data,
      recipientUserId: 'supervisor-1',
      branchId: 'branch-1',
    });
    expect(notificationsRepository.create).toHaveBeenCalledWith({
      type: 'branch_offline',
      payload: data,
      recipientUserId: 'admin-1',
      branchId: 'branch-1',
    });
  });
});

describe('processNotification — branch_online', () => {
  it('emits the socket event to the branch and super admins, without persisting a Notification row', async () => {
    const data = { type: 'branch_online' as const, branchId: 'branch-1', branchName: 'Manila' };

    await processNotification('branch_online', data);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'branch:online', data);
    expect(notifySuperAdmin).toHaveBeenCalledWith('branch:online', data);
    expect(notificationsRepository.create).not.toHaveBeenCalled();
  });
});

describe('processNotification — eod_summary', () => {
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

    await processNotification('eod_summary', data);

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

  it('logs but does not throw when the email send fails, so the job still resolves', async () => {
    vi.mocked(notificationsRepository.findSuperAdminUserIds).mockResolvedValue([{ id: 'admin-1', email: 'admin-1@potatocorner.test' }] as never);
    vi.mocked(sendEodSummaryEmail).mockRejectedValue(new Error('Resend outage'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    await expect(processNotification('eod_summary', data)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
