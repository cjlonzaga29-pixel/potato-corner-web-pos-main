import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 21: BullMQ removed — enqueueGenerateExport/enqueueRefreshSnapshot
 * now run processGenerateExport/processRefreshSnapshot directly in-process
 * (fired via lib/job-runner.ts's runFireAndForget; generate_export retried
 * via runWithRetry, refresh_snapshot intentionally not — see the design note
 * at the top of report.queue.ts) instead of dispatching through a BullMQ
 * Worker. job-runner is mocked as a thin wrapper around the real
 * implementation (via importOriginal) so retry/fire-and-forget behavior
 * stays real while still letting us assert on call arguments.
 */
vi.mock('../lib/job-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../lib/job-runner.js');
  return {
    ...actual,
    runWithRetry: vi.fn(actual.runWithRetry),
    runFireAndForget: vi.fn(actual.runFireAndForget),
  };
});
vi.mock('../lib/supabase.js', () => ({ supabaseAdmin: { storage: { from: vi.fn() } } }));
vi.mock('../lib/notify.js', () => ({ notifyUser: vi.fn() }));
vi.mock('../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../modules/reports/reports.columns.js', () => ({
  getReportRows: vi.fn().mockResolvedValue([{ report_date: '2026-07-01' }]),
  REPORT_COLUMNS: { DAILY_SALES: [{ key: 'report_date', header: 'Date' }] },
}));
vi.mock('../modules/reports/reports.repository.js', () => ({ reportsRepository: { saveSnapshot: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ prisma: { branch: { findUnique: vi.fn().mockResolvedValue({ name: 'SM North' }) } } }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const { runWithRetry } = await import('../lib/job-runner.js');
const { supabaseAdmin } = await import('../lib/supabase.js');
const { notifyUser } = await import('../lib/notify.js');
const { recordAuditLog } = await import('../middleware/audit-log.js');
const { getReportRows } = await import('../modules/reports/reports.columns.js');
const { reportsRepository } = await import('../modules/reports/reports.repository.js');
const Sentry = await import('@sentry/node');
const { processGenerateExport, enqueueGenerateExport, enqueueRefreshSnapshot } = await import('./report.queue.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReportRows).mockResolvedValue([{ report_date: '2026-07-01' }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('processGenerateExport — CSV', () => {
  it('generates CSV, uploads to storage, and emits report:export_ready to the requester only', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await processGenerateExport('job-1', {
      reportType: 'DAILY_SALES',
      filters: { page: 1, limit: 100 },
      format: 'csv',
      requesterId: 'user-1',
      branchId: 'b1',
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.csv$/), expect.any(Buffer), {
      contentType: 'text/csv',
      upsert: false,
    });
    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), 86_400);
    expect(notifyUser).toHaveBeenCalledWith('user-1', 'report:export_ready', expect.objectContaining({ download_url: 'https://signed.example/x.csv' }));
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_EXPORTED' }));
  });
});

describe('processGenerateExport — PDF', () => {
  it('generates a PDF buffer, uploads, and emits report:export_ready', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.pdf' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await processGenerateExport('job-2', {
      reportType: 'DAILY_SALES',
      filters: { page: 1, limit: 100 },
      format: 'pdf',
      requesterId: 'user-1',
      branchId: 'b1',
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.pdf$/), expect.any(Buffer), {
      contentType: 'application/pdf',
      upsert: false,
    });
  });
});

describe('enqueueGenerateExport', () => {
  it('returns a job id immediately and runs processGenerateExport in the background, under the Decision 7 retry policy', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    const result = await enqueueGenerateExport({
      reportType: 'DAILY_SALES',
      filters: { page: 1, limit: 100 },
      format: 'csv',
      requesterId: 'user-1',
      branchId: 'b1',
    });

    expect(result.id).toEqual(expect.any(String));
    await vi.waitFor(() => expect(notifyUser).toHaveBeenCalled());
    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
    expect(notifyUser).toHaveBeenCalledWith('user-1', 'report:export_ready', expect.any(Object));
  });

  it('emits report:export_failed to the requester and reports to Sentry only after every retry attempt is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(getReportRows).mockRejectedValue(new Error('upload failed'));

    const result = await enqueueGenerateExport({
      reportType: 'DAILY_SALES',
      filters: { page: 1, limit: 100 },
      format: 'csv',
      requesterId: 'user-1',
      branchId: 'b1',
    });
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await vi.waitFor(() => expect(notifyUser).toHaveBeenCalled());

    expect(getReportRows).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(notifyUser).toHaveBeenCalledWith(
      'user-1',
      'report:export_failed',
      expect.objectContaining({ job_id: result.id, report_type: 'DAILY_SALES', error: 'upload failed', requester_id: 'user-1' }),
    );
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueRefreshSnapshot', () => {
  it('recomputes rows and saves a new snapshot in the background', async () => {
    await enqueueRefreshSnapshot({ reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', filters: { branchId: 'b1', page: 1, limit: 100 } });

    await vi.waitFor(() => expect(reportsRepository.saveSnapshot).toHaveBeenCalled());
    expect(reportsRepository.saveSnapshot).toHaveBeenCalledWith('PRODUCT_PERFORMANCE', 'b1', [{ report_date: '2026-07-01' }], expect.anything());
  });

  it('logs the failure without retrying (matches the old attempts: 1 — no Sentry report, no user notification)', async () => {
    vi.mocked(getReportRows).mockRejectedValue(new Error('db unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await enqueueRefreshSnapshot({ reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', filters: { branchId: 'b1', page: 1, limit: 100 } });

    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(getReportRows).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Report snapshot refresh failed:', expect.any(Error));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
