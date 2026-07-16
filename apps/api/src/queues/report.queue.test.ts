import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn(() => ({ on: vi.fn() })),
}));
vi.mock('bullmq', () => {
  class Queue {
    add = vi.fn().mockResolvedValue({ id: 'job-1' });
  }
  class Worker {
    handler: (job: unknown) => Promise<void>;
    constructor(_name: string, handler: (job: unknown) => Promise<void>) {
      this.handler = handler;
    }
    on = vi.fn();
  }
  return { Queue, Worker };
});
vi.mock('../lib/supabase.js', () => ({ supabaseAdmin: { storage: { from: vi.fn() } } }));
vi.mock('../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));
vi.mock('../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../modules/reports/reports.columns.js', () => ({
  getReportRows: vi.fn().mockResolvedValue([{ report_date: '2026-07-01' }]),
  REPORT_COLUMNS: { DAILY_SALES: [{ key: 'report_date', header: 'Date' }] },
}));
vi.mock('../modules/reports/reports.repository.js', () => ({ reportsRepository: { saveSnapshot: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ prisma: { branch: { findUnique: vi.fn().mockResolvedValue({ name: 'SM North' }) } } }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const { supabaseAdmin } = await import('../lib/supabase.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { recordAuditLog } = await import('../middleware/audit-log.js');
const { reportsRepository } = await import('../modules/reports/reports.repository.js');
const Sentry = await import('@sentry/node');
const { reportWorker } = await import('./report.queue.js');

// Captured immediately after import, before any `beforeEach` runs —
// `reportWorker.on('failed', ...)` is registered once at module-load time,
// and `vi.clearAllMocks()` below wipes accumulated `.mock.calls` (including
// this pre-test-run registration) on every subsequent test, so re-deriving
// this handler from `reportWorker.on.mock.calls` inside a test would always
// find nothing by the time the "failed handler" describe block runs.
const failedHandler = vi.mocked(reportWorker.on).mock.calls.find(([event]) => event === 'failed')?.[1] as
  | ((job: unknown, error: Error) => void)
  | undefined;

beforeEach(() => vi.clearAllMocks());

describe('report worker — generate_export (CSV)', () => {
  it('generates CSV, uploads to storage, and emits report:export_ready', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-1',
      name: 'generate_export',
      data: { reportType: 'DAILY_SALES', filters: { page: 1, limit: 100 }, format: 'csv', requesterId: 'user-1', branchId: 'b1' },
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.csv$/), expect.any(Buffer), { contentType: 'text/csv', upsert: false });
    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), 86_400);
    expect(notifySuperAdmin).toHaveBeenCalledWith('report:export_ready', expect.objectContaining({ download_url: 'https://signed.example/x.csv' }));
    expect(notifyBranch).toHaveBeenCalledWith('b1', 'report:export_ready', expect.anything());
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_EXPORTED' }));
  });
});

describe('report worker — generate_export (PDF)', () => {
  it('generates a PDF buffer, uploads, and emits report:export_ready', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.pdf' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-2',
      name: 'generate_export',
      data: { reportType: 'DAILY_SALES', filters: { page: 1, limit: 100 }, format: 'pdf', requesterId: 'user-1', branchId: 'b1' },
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.pdf$/), expect.any(Buffer), { contentType: 'application/pdf', upsert: false });
  });
});

describe('report worker — refresh_snapshot', () => {
  it('recomputes rows and saves a new snapshot', async () => {
    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-3',
      name: 'refresh_snapshot',
      data: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', filters: { branchId: 'b1', page: 1, limit: 100 } },
    });

    expect(reportsRepository.saveSnapshot).toHaveBeenCalledWith('PRODUCT_PERFORMANCE', 'b1', [{ report_date: '2026-07-01' }], expect.anything());
  });
});

describe('report worker — failed handler', () => {
  it('emits report:export_failed to notifySuperAdmin and notifyBranch after max retries, and reports to Sentry', () => {
    expect(failedHandler).toBeDefined();

    failedHandler?.(
      { id: 'job-4', name: 'generate_export', attemptsMade: 3, opts: { attempts: 3 }, data: { reportType: 'DAILY_SALES', requesterId: 'user-1', branchId: 'b1' } },
      new Error('upload failed'),
    );

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(notifySuperAdmin).toHaveBeenCalledWith('report:export_failed', expect.objectContaining({ job_id: 'job-4', error: 'upload failed' }));
    expect(notifyBranch).toHaveBeenCalledWith('b1', 'report:export_failed', expect.anything());
  });
});
