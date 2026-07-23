import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn(),
    getShiftSummary: vi.fn(),
    getCashReconciliation: vi.fn(),
    getVoidRefund: vi.fn(),
    getDiscountCompliance: vi.fn(),
    getPaymentMethodMix: vi.fn(),
    getInventoryMovement: vi.fn(),
    getAttendanceSummary: vi.fn(),
    getFraudAlertSummary: vi.fn(),
    getProductPerformance: vi.fn(),
    getFlavorPerformance: vi.fn(),
    getEmployeePerformance: vi.fn(),
    getInventoryValuation: vi.fn(),
    getBranchComparison: vi.fn(),
    getInventoryAnalytics: vi.fn(),
    getLatestSnapshot: vi.fn(),
    saveSnapshot: vi.fn(),
    countRows: vi.fn(),
  },
}));
vi.mock('../../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./reports.columns.js', () => ({
  getReportRows: vi.fn(),
  REPORT_COLUMNS: { DAILY_SALES: [{ key: 'report_date', header: 'Date' }] },
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: { storage: { from: vi.fn() } },
}));
vi.mock('../../queues/report.queue.js', () => ({
  enqueueGenerateExport: vi.fn(),
  enqueueRefreshSnapshot: vi.fn(),
}));

const { reportsRepository } = await import('./reports.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { reportsService } = await import('./reports.service.js');

beforeEach(() => vi.clearAllMocks());

describe('reportsService.getDailySalesReport', () => {
  it('defaults to the last 7 days when no date range is given, then writes REPORT_ACCESSED', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([{ report_date: '2026-07-01' } as never]);

    const result = await reportsService.getDailySalesReport({ page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getDailySales).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: expect.any(Date), dateTo: expect.any(Date) }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_ACCESSED', entityType: 'report', entityId: 'DAILY_SALES', actorId: 'user-1', actorRole: 'supervisor' }),
    );
    expect(result.report_type).toBe('DAILY_SALES');
    expect(result.data).toEqual([{ report_date: '2026-07-01' }]);
    expect(result.total).toBe(1);
  });

  it('respects an explicit date range instead of applying the 7-day default', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([]);
    const dateFrom = new Date('2026-06-01T00:00:00.000Z');
    const dateTo = new Date('2026-06-30T23:59:59.999Z');

    await reportsService.getDailySalesReport({ dateFrom, dateTo, page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getDailySales).toHaveBeenCalledWith(expect.objectContaining({ dateFrom, dateTo }));
  });

  it('paginates the full result set client-side (repository returns unpaginated rows for this type)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ report_date: `2026-07-${String(i + 1).padStart(2, '0')}` }));
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue(rows as never);

    const result = await reportsService.getDailySalesReport({ page: 2, limit: 10 }, 'user-1', 'supervisor');

    expect(result.data).toHaveLength(10);
    expect(result.data[0]).toEqual(rows[10]);
    expect(result.total).toBe(30);
    expect(result.page).toBe(2);
  });
});

describe('reportsService.getPaymentMethodMixReport', () => {
  it('defaults to the last 7 days when no date range is given, then writes REPORT_ACCESSED', async () => {
    vi.mocked(reportsRepository.getPaymentMethodMix).mockResolvedValue([{ payment_method: 'cash', transaction_count: 4, total_amount: 400 }]);

    const result = await reportsService.getPaymentMethodMixReport({ page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getPaymentMethodMix).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: expect.any(Date), dateTo: expect.any(Date) }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_ACCESSED', entityType: 'report', entityId: 'PAYMENT_METHOD_MIX', actorId: 'user-1', actorRole: 'supervisor' }),
    );
    expect(result).toEqual([{ payment_method: 'cash', transaction_count: 4, total_amount: 400 }]);
  });

  it('respects an explicit date range instead of applying the 7-day default', async () => {
    vi.mocked(reportsRepository.getPaymentMethodMix).mockResolvedValue([]);
    const dateFrom = new Date('2026-06-01T00:00:00.000Z');
    const dateTo = new Date('2026-06-30T23:59:59.999Z');

    await reportsService.getPaymentMethodMixReport({ dateFrom, dateTo, page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getPaymentMethodMix).toHaveBeenCalledWith(expect.objectContaining({ dateFrom, dateTo }));
  });
});

describe('reportsService.getFraudAlertSummaryReport', () => {
  it('calls the repository and writes an audit log the same as any other real-time report', async () => {
    vi.mocked(reportsRepository.getFraudAlertSummary).mockResolvedValue([]);

    await reportsService.getFraudAlertSummaryReport({ page: 1, limit: 25 }, 'admin-1', 'super_admin');

    expect(reportsRepository.getFraudAlertSummary).toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'FRAUD_ALERT_SUMMARY', actorRole: 'super_admin' }));
  });

  it('uses the repository-level total, not the page length, for a DB-paginated type (does not re-slice)', async () => {
    const page = Array.from({ length: 25 }, (_, i) => ({ alert_id: `a-${i}` }));
    vi.mocked(reportsRepository.getFraudAlertSummary).mockResolvedValue(page as never);
    vi.mocked(reportsRepository.countRows).mockResolvedValue(137);

    const result = await reportsService.getFraudAlertSummaryReport({ page: 2, limit: 25 }, 'admin-1', 'super_admin');

    expect(reportsRepository.countRows).toHaveBeenCalledWith('FRAUD_ALERT_SUMMARY', expect.anything());
    expect(result.data).toEqual(page);
    expect(result.total).toBe(137);
    expect(result.total).toBeGreaterThan(result.limit);
  });
});

describe('reportsService.getProductPerformanceReport', () => {
  it('computes fresh and saves a snapshot when none exists yet', async () => {
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue(null);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([{ product_variant_id: 'pv-1' } as never]);

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(reportsRepository.saveSnapshot).toHaveBeenCalledWith('PRODUCT_PERFORMANCE', 'b1', [{ product_variant_id: 'pv-1' }], expect.anything());
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });

  it('returns the snapshot immediately without recomputing when it is fresh (<15 min old)', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue({
      id: 'snap-1', reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', computedAt: fiveMinAgo, payload: [{ product_variant_id: 'pv-1' }], parameters: {},
    } as never);
    const { getReportRows } = await import('./reports.columns.js');

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(getReportRows).not.toHaveBeenCalled();
    expect(reportsRepository.saveSnapshot).not.toHaveBeenCalled();
    expect(result.computed_at).toBe(fiveMinAgo.toISOString());
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });

  it('serves the stale snapshot immediately and enqueues a background refresh when it is >15 min old', async () => {
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue({
      id: 'snap-1', reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', computedAt: twentyMinAgo, payload: [{ product_variant_id: 'pv-1' }], parameters: {},
    } as never);
    const { enqueueRefreshSnapshot } = await import('../../queues/report.queue.js');

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(enqueueRefreshSnapshot).toHaveBeenCalledWith(expect.objectContaining({ reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1' }));
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });
});

describe('reportsService.getBranchComparisonReport', () => {
  it('writes REPORT_ACCESSED for the super-admin-only global report', async () => {
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue(null);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([]);

    await reportsService.getBranchComparisonReport(null, 'admin-1', 'super_admin');

    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'BRANCH_COMPARISON', actorRole: 'super_admin', branchId: null }));
  });
});

describe('reportsService.getInventoryAnalyticsReport', () => {
  it('defaults to a 30d period and delegates to the repository', async () => {
    vi.mocked(reportsRepository.getInventoryAnalytics).mockResolvedValue({ summary: { total_movements: 0 } } as never);

    await reportsService.getInventoryAnalyticsReport({ branchId: 'b1' }, 'user-1', 'supervisor');

    expect(reportsRepository.getInventoryAnalytics).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1', periodDays: 30 }));
  });

  it('writes REPORT_ACCESSED for the requested branch and period', async () => {
    vi.mocked(reportsRepository.getInventoryAnalytics).mockResolvedValue({ summary: { total_movements: 0 } } as never);

    await reportsService.getInventoryAnalyticsReport({ branchId: 'b1', period: '90d' }, 'user-1', 'supervisor');

    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'INVENTORY_ANALYTICS', branchId: 'b1', actorRole: 'supervisor' }));
  });
});

describe('reportsService.requestExport', () => {
  it('CSV sync path: uploads to storage and returns a signed download_url when count < 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(5);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([{ report_date: '2026-07-01' } as never]);
    const { supabaseAdmin } = await import('../../lib/supabase.js');
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/report.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.csv$/), expect.any(Buffer), { contentType: 'text/csv', upsert: false });
    expect(result).toEqual({ download_url: 'https://signed.example/report.csv', expires_at: expect.any(String) });
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_EXPORTED' }));
  });

  it('CSV async path: enqueues a job and returns job_id when count >= 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(15_000);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-1' } as never);

    const result = await reportsService.requestExport('VOID_REFUND', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect(result).toEqual({ job_id: 'job-1', message: expect.any(String), estimated_seconds: 120 });
  });

  it('PDF always enqueues a job, regardless of row count', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(3);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-2' } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'pdf', 'user-1', 'supervisor', 'b1');

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect('job_id' in result && result.job_id).toBe('job-2');
  });

  it('rejects a supervisor exporting a super-admin-only report type with 403', async () => {
    await expect(
      reportsService.requestExport('BRANCH_COMPARISON', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_REPORT_TYPE', statusCode: 403 });
  });
});
