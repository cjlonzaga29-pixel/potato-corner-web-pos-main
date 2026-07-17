import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./fraud.repository.js', () => ({
  fraudRepository: {
    findActiveBranchIds: vi.fn(),
    createAlert: vi.fn(),
    findRecentOpenAlert: vi.fn(),
    findOpenAlertsByType: vi.fn(),
  },
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./rules/index.js', () => ({
  FRAUD_RULES: [],
}));

const { fraudRepository } = await import('./fraud.repository.js');
const { notifySuperAdmin } = await import('../../lib/notify.js');
const { enqueueNotification } = await import('../../queues/notification.queue.js');
const rulesModule = await import('./rules/index.js');
const { runDetection } = await import('./detection.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  (rulesModule.FRAUD_RULES as unknown[]).length = 0;
});

function branchRule(_alertType: string, results: unknown[]) {
  return { scope: 'branch' as const, evaluate: vi.fn().mockResolvedValue(results) };
}

function globalRule(_alertType: string, results: unknown[]) {
  return { scope: 'global' as const, evaluate: vi.fn().mockResolvedValue(results) };
}

describe('runDetection — branch-scoped rules', () => {
  it('calls a branch-scoped rule once per active branch', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    const rule = branchRule('excessive_voids', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date('2026-07-17T15:00:00.000Z'));

    expect(rule.evaluate).toHaveBeenCalledTimes(2);
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-1', evaluationDate: expect.any(Date) });
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-2', evaluationDate: expect.any(Date) });
  });

  it('uses the caller-provided branchIds instead of querying active branches when given', async () => {
    const rule = branchRule('excessive_voids', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date(), ['branch-9']);

    expect(fraudRepository.findActiveBranchIds).not.toHaveBeenCalled();
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-9', evaluationDate: expect.any(Date) });
  });
});

describe('runDetection — global-scoped rules', () => {
  it('calls a global-scoped rule exactly once with branchId: null, regardless of branch count', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    const rule = globalRule('discount_id_reuse', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date());

    expect(rule.evaluate).toHaveBeenCalledTimes(1);
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: null, evaluationDate: expect.any(Date) });
  });
});

describe('runDetection — alert creation and dedup (standard key)', () => {
  it('creates an alert and emits FRAUD_ALERT_CREATED when no open/investigating duplicate exists', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue(null);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({
      id: 'alert-1', alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1', status: 'open',
      createdAt: new Date('2026-07-17T15:00:00.000Z'),
    } as never);
    const detectionResult = {
      alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1',
      evidence: { shift_id: 'shift-1', void_count: 4 },
    };
    const rule = branchRule('excessive_voids', [detectionResult]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.findRecentOpenAlert).toHaveBeenCalledWith('branch-1', 'user-1', 'excessive_voids');
    expect(fraudRepository.createAlert).toHaveBeenCalledWith(detectionResult);
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:alert_created', expect.objectContaining({ id: 'alert-1', alert_type: 'excessive_voids' }));
    expect(enqueueNotification).toHaveBeenCalledWith('fraud_alert_created', {
      type: 'fraud_alert_created',
      branchId: 'branch-1',
      alertId: 'alert-1',
      severity: 'medium',
    });
    expect(result.alertsCreated).toBe(1);
    expect(result.alertsSkippedDupe).toBe(0);
  });

  it('skips creating an alert when an open/investigating duplicate already exists for the standard key', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue({ id: 'alert-existing' } as never);
    const rule = branchRule('excessive_voids', [
      { alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1', evidence: {} },
    ]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.createAlert).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
    expect(result.alertsCreated).toBe(0);
    expect(result.alertsSkippedDupe).toBe(1);
  });
});

describe('runDetection — alert creation and dedup (discount_id_reuse special-case key)', () => {
  it('creates an alert when no open alert has a matching customer_id_hash', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([]);
    vi.mocked(fraudRepository.findOpenAlertsByType).mockResolvedValue([{ id: 'alert-other', evidence: { customer_id_hash: 'hash-b' } }]);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({
      id: 'alert-2', alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null, status: 'open',
      createdAt: new Date(),
    } as never);
    const detectionResult = {
      alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null,
      evidence: { customer_id_hash: 'hash-a', occurrence_count: 4 },
    };
    const rule = globalRule('discount_id_reuse', [detectionResult]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.findOpenAlertsByType).toHaveBeenCalledWith('discount_id_reuse');
    expect(fraudRepository.findRecentOpenAlert).not.toHaveBeenCalled();
    expect(fraudRepository.createAlert).toHaveBeenCalledWith(detectionResult);
    expect(result.alertsCreated).toBe(1);
    // alert.branchId is null for this rule (Corrections #4) — Notification.branch_id
    // is NOT NULL, so persistence is skipped even though the socket broadcast fires.
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('skips creating an alert when an open alert already has a matching customer_id_hash', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([]);
    vi.mocked(fraudRepository.findOpenAlertsByType).mockResolvedValue([{ id: 'alert-existing', evidence: { customer_id_hash: 'hash-a' } }]);
    const rule = globalRule('discount_id_reuse', [
      { alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null, evidence: { customer_id_hash: 'hash-a' } },
    ]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.createAlert).not.toHaveBeenCalled();
    expect(result.alertsSkippedDupe).toBe(1);
  });
});

describe('runDetection — summary', () => {
  it('returns branchesEvaluated, rulesEvaluated, alertsCreated, alertsSkippedDupe', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue(null);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({ id: 'alert-1', createdAt: new Date() } as never);
    const rule = branchRule('excessive_voids', [{ alertType: 'excessive_voids', severity: 'medium', branchId: null, employeeId: null, evidence: {} }]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(result.branchesEvaluated).toBe(2);
    expect(result.rulesEvaluated).toBe(1);
  });
});
