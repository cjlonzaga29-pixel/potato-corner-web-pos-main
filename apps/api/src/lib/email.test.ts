import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mirrors the Resend client mock any caller of sendWelcomeEmail already uses
 * — the `Resend` constructor and its `.emails.send` are mocked so no real
 * network call happens; RESEND_API_KEY/config.nodeEnv are toggled per test
 * via vi.resetModules() + dynamic re-import, since email.ts decides whether
 * `resend` is null at module load time.
 */
const sendMock = vi.fn();
sendMock.mockResolvedValue({ data: { id: 'test-email-id' }, error: null });

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

const ORIGINAL_ENV = { ...process.env };

async function importEmailModule(nodeEnv: string, apiKey?: string) {
  vi.resetModules();
  process.env.NODE_ENV = nodeEnv;
  if (apiKey === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = apiKey;
  }
  return import('./email.js');
}

const FRAUD_PAYLOAD = { type: 'fraud_alert_created' as const, branchId: 'branch-1', alertId: 'alert-1', severity: 'high' };
const ADJUSTMENT_PAYLOAD = {
  type: 'large_adjustment_approval_needed' as const,
  branchId: 'branch-1',
  adjustmentId: 'adj-1',
  requestedByUserId: 'supervisor-1',
  amount: 5000,
};
const EOD_PAYLOAD = {
  type: 'eod_summary' as const,
  branchId: 'branch-1',
  businessDate: '2026-07-17',
  totalSales: 15000,
  totalRevenue: 20000,
  transactionCount: 60,
  voidCount: 3,
  unresolvedCashVarianceCount: 1,
  openFraudAlertsCreatedTodayCount: 2,
  branchRevenue: [{ branchId: 'branch-1', branchName: 'Manila', revenue: 20000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendFraudAlertEmail', () => {
  it('logs instead of sending in development when RESEND_API_KEY is absent', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendFraudAlertEmail } = await importEmailModule('development');

    await sendFraudAlertEmail('admin@potatocorner.test', FRAUD_PAYLOAD);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it('throws outside development when RESEND_API_KEY is absent', async () => {
    const { sendFraudAlertEmail } = await importEmailModule('production');

    await expect(sendFraudAlertEmail('admin@potatocorner.test', FRAUD_PAYLOAD)).rejects.toThrow(/RESEND_API_KEY is not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when RESEND_API_KEY is configured', async () => {
    const { sendFraudAlertEmail } = await importEmailModule('production', 're_test_key');

    await sendFraudAlertEmail('admin@potatocorner.test', FRAUD_PAYLOAD);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@potatocorner.test', subject: expect.stringContaining('high') }),
    );
  });
});

describe('sendLargeAdjustmentApprovalEmail', () => {
  it('logs instead of sending in development when RESEND_API_KEY is absent', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendLargeAdjustmentApprovalEmail } = await importEmailModule('development');

    await sendLargeAdjustmentApprovalEmail('admin@potatocorner.test', ADJUSTMENT_PAYLOAD);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it('throws outside development when RESEND_API_KEY is absent', async () => {
    const { sendLargeAdjustmentApprovalEmail } = await importEmailModule('staging');

    await expect(sendLargeAdjustmentApprovalEmail('admin@potatocorner.test', ADJUSTMENT_PAYLOAD)).rejects.toThrow(
      /RESEND_API_KEY is not configured/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when RESEND_API_KEY is configured', async () => {
    const { sendLargeAdjustmentApprovalEmail } = await importEmailModule('production', 're_test_key');

    await sendLargeAdjustmentApprovalEmail('admin@potatocorner.test', ADJUSTMENT_PAYLOAD);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@potatocorner.test', subject: expect.stringContaining('5,000') }),
    );
  });
});

describe('sendEodSummaryEmail', () => {
  it('logs instead of sending in development when RESEND_API_KEY is absent', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendEodSummaryEmail } = await importEmailModule('development');

    await sendEodSummaryEmail('admin@potatocorner.test', EOD_PAYLOAD);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it('throws outside development when RESEND_API_KEY is absent', async () => {
    const { sendEodSummaryEmail } = await importEmailModule('production');

    await expect(sendEodSummaryEmail('admin@potatocorner.test', EOD_PAYLOAD)).rejects.toThrow(/RESEND_API_KEY is not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when RESEND_API_KEY is configured, including per-branch revenue', async () => {
    const { sendEodSummaryEmail } = await importEmailModule('production', 're_test_key');

    await sendEodSummaryEmail('admin@potatocorner.test', EOD_PAYLOAD);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@potatocorner.test',
        subject: expect.stringContaining('2026-07-17'),
        html: expect.stringContaining('Manila'),
      }),
    );
  });
});
