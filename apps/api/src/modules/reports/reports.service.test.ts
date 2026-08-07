import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn(),
    getDailySalesTransactions: vi.fn(),
    getShiftSummary: vi.fn(),
    getCashReconciliation: vi.fn(),
    getVoidRefund: vi.fn(),
    getVoidRefundForExport: vi.fn(),
    getDiscountCompliance: vi.fn(),
    getPaymentMethodMix: vi.fn(),
    getInventoryMovement: vi.fn(),
    getAttendanceSummary: vi.fn(),
    getFraudAlertSummary: vi.fn(),
    getProductPerformance: vi.fn(),
    getFlavorPerformance: vi.fn(),
    getEmployeePerformance: vi.fn(),
    getInventoryValuation: vi.fn(),
    getInventoryValuationRollup: vi.fn(),
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
  REPORT_COLUMNS: {
    DAILY_SALES: [{ key: 'report_date', header: 'Date' }],
    VOID_REFUND: [
      { key: 'transaction_number', header: 'Receipt #' },
      { key: 'branch_name', header: 'Branch' },
      { key: 'cashier_name', header: 'Cashier' },
      { key: 'status', header: 'Status' },
      { key: 'total_amount', header: 'Amount' },
      { key: 'reason', header: 'Reason' },
      { key: 'actioned_by_name', header: 'Actioned By' },
      { key: 'actioned_at', header: 'Actioned At' },
    ],
    DISCOUNT_COMPLIANCE: [
      { key: 'branch_name', header: 'Branch' },
      { key: 'discount_type', header: 'Discount Type' },
      { key: 'transaction_count', header: 'Transactions' },
      { key: 'total_discount_amount', header: 'Total Discount' },
      { key: 'total_vat_exempt_amount', header: 'VAT Exempt Total' },
    ],
  },
  DAILY_SALES_TRANSACTION_COLUMNS: [
    { key: 'receipt_number', header: 'Receipt #' },
    { key: 'payment_method', header: 'Payment' },
    { key: 'total_amount', header: 'Total' },
    { key: 'vat_amount', header: 'VAT' },
    { key: 'discount_amount', header: 'Discount' },
    { key: 'discount_type', header: 'Discount Type' },
    { key: 'created_at', header: 'Date' },
    { key: 'cashier_name', header: 'Cashier' },
  ],
  DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS: [
    { key: 'receipt_number', header: 'Receipt #' },
    { key: 'created_at', header: 'Date/Time' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'discount_type', header: 'Discount Type' },
    { key: 'discount_amount', header: 'Discount Amount' },
    { key: 'discount_proof_available', header: 'Proof Available' },
  ],
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: { storage: { from: vi.fn() } },
}));
vi.mock('../../queues/report.queue.js', () => ({
  enqueueGenerateExport: vi.fn(),
  enqueueRefreshSnapshot: vi.fn(),
}));
vi.mock('../../lib/reports/pdf.js', () => ({
  generatePdf: vi.fn(),
}));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { branch: { findUnique: vi.fn() } },
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

describe('reportsService.getInventoryValuationRollupReport', () => {
  it('computes fresh from the repository every call (no snapshot cache) and writes REPORT_ACCESSED', async () => {
    const rollup = {
      generated_at: '2026-07-29T00:00:00.000Z',
      branches: [{ branch_id: 'b1', branch_name: 'SM North' }],
      summary: { total_inventory_value: 40 },
    };
    vi.mocked(reportsRepository.getInventoryValuationRollup).mockResolvedValue(rollup as never);

    const result = await reportsService.getInventoryValuationRollupReport('admin-1', 'super_admin');

    expect(reportsRepository.getInventoryValuationRollup).toHaveBeenCalledWith();
    expect(reportsRepository.getLatestSnapshot).not.toHaveBeenCalled();
    expect(reportsRepository.saveSnapshot).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_ACCESSED', entityType: 'report', entityId: 'ADMIN_INVENTORY_VALUATION_ROLLUP', actorId: 'admin-1', actorRole: 'super_admin', branchId: null }),
    );
    expect(result).toEqual(rollup);
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
  it('CSV sync path: builds an in-memory buffer and returns it directly when count < 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(5);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([{ report_date: '2026-07-01' } as never]);
    const { supabaseAdmin } = await import('../../lib/supabase.js');

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'csv', 'admin-1', 'super_admin', 'b1');

    expect(result).toEqual({
      kind: 'file',
      buffer: expect.any(Buffer),
      filename: expect.stringMatching(/\.csv$/),
      contentType: 'text/csv',
    });
    expect(reportsRepository.getDailySalesTransactions).not.toHaveBeenCalled();
    expect(supabaseAdmin.storage.from).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 1 }) }),
    );
  });

  it('Supervisor/Branch Daily Sales tab CSV export: renders one row per completed transaction (matching the on-screen tab and the PDF export), not the aggregated per-day/branch summary the Admin CSV export uses', async () => {
    const rows = [
      { receipt_number: 'MNL001-20260801-000001', payment_method: 'cash', total_amount: 150, vat_amount: 16.07, discount_amount: 0, discount_type: null, created_at: '2026-08-01T10:00:00.000Z', cashier_name: 'Juan Dela Cruz' },
      { receipt_number: 'MNL001-20260801-000002', payment_method: 'gcash', total_amount: 200, vat_amount: 21.43, discount_amount: 0, discount_type: null, created_at: '2026-08-01T11:00:00.000Z', cashier_name: 'Juan Dela Cruz' },
    ];
    vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(rows as never);
    const { getReportRows } = await import('./reports.columns.js');

    const result = await reportsService.requestExport('DAILY_SALES', { branchId: 'b1', page: 1, limit: 100 }, 'csv', 'user-1', 'supervisor', 'b1');

    expect(reportsRepository.getDailySalesTransactions).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
    expect(reportsRepository.getDailySales).not.toHaveBeenCalled();
    expect(reportsRepository.countRows).not.toHaveBeenCalled();
    expect(getReportRows).not.toHaveBeenCalled();
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') throw new Error('expected file result');
    expect(result.contentType).toBe('text/csv');
    expect(result.filename).toMatch(/\.csv$/);
    const csv = result.buffer.toString('utf-8');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 transaction rows, matching the screen's row count
    expect(lines[0]).toBe('Receipt #,Payment,Total,VAT,Discount,Discount Type,Date,Cashier');
    expect(lines[1]).toBe('MNL001-20260801-000001,cash,150,16.07,0,,2026-08-01T10:00:00.000Z,Juan Dela Cruz');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 2 }) }),
    );
  });

  it('PDF sync path (super admin, Admin Daily Sales report): looks up the branch name and builds an in-memory buffer when count < 2,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(3);
    const { getReportRows } = await import('./reports.columns.js');
    const rows = [{ report_date: '2026-07-01' }, { report_date: '2026-07-02' }, { report_date: '2026-07-03' }];
    vi.mocked(getReportRows).mockResolvedValue(rows as never);
    const { generatePdf } = await import('../../lib/reports/pdf.js');
    const pdfBuffer = Buffer.from('%PDF-1.4 fake');
    vi.mocked(generatePdf).mockResolvedValue(pdfBuffer);
    const { prisma } = await import('../../lib/prisma.js');
    vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'pdf', 'admin-1', 'super_admin', 'b1');

    expect(result).toEqual({ kind: 'file', buffer: pdfBuffer, filename: expect.stringMatching(/\.pdf$/), contentType: 'application/pdf' });
    expect(prisma.branch.findUnique).toHaveBeenCalledWith({ where: { id: 'b1' }, select: { name: true } });
    expect(generatePdf).toHaveBeenCalledWith(
      'DAILY_SALES',
      expect.any(Object),
      rows,
      expect.anything(),
      'SM North',
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 3 }) }),
    );
  });

  it('Supervisor/Branch Daily Sales tab PDF export: renders one row per completed transaction (matching the on-screen tab), not the aggregated per-day/branch summary the Admin report and CSV export use', async () => {
    const rows = [
      { receipt_number: 'MNL001-20260801-000001', payment_method: 'cash', total_amount: 150, vat_amount: 16.07, discount_amount: 0, discount_type: null, created_at: '2026-08-01T10:00:00.000Z', cashier_name: 'Juan Dela Cruz' },
    ];
    vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(rows as never);
    const { getReportRows } = await import('./reports.columns.js');
    const { generatePdf } = await import('../../lib/reports/pdf.js');
    const pdfBuffer = Buffer.from('%PDF-1.4 fake');
    vi.mocked(generatePdf).mockResolvedValue(pdfBuffer);
    const { prisma } = await import('../../lib/prisma.js');
    vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { branchId: 'b1', page: 1, limit: 100 }, 'pdf', 'user-1', 'supervisor', 'b1');

    expect(reportsRepository.getDailySalesTransactions).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
    expect(reportsRepository.countRows).not.toHaveBeenCalled();
    expect(getReportRows).not.toHaveBeenCalled();
    expect(generatePdf).toHaveBeenCalledWith('DAILY_SALES', expect.any(Object), rows, expect.anything(), 'SM North');
    expect(result).toEqual({ kind: 'file', buffer: pdfBuffer, filename: expect.stringMatching(/\.pdf$/), contentType: 'application/pdf' });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 1 }) }),
    );
  });

  it('CSV async path: enqueues a job and returns job_id when count >= 10,000', async () => {
    // Uses super_admin: Supervisor DISCOUNT_COMPLIANCE CSV is now redirected to the
    // transaction-level getDailySalesTransactions path (always synchronous, like the
    // PDF/DAILY_SALES/VOID_REFUND redirects), so only the admin aggregate path still
    // exercises the async job threshold this test targets.
    vi.mocked(reportsRepository.countRows).mockResolvedValue(15_000);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-1' } as never);

    const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { page: 1, limit: 25 }, 'csv', 'admin-1', 'super_admin', null);

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect(result).toEqual({ kind: 'job', job_id: 'job-1', message: expect.any(String), estimated_seconds: 120 });
  });

  describe('Supervisor/Branch Discount Compliance tab CSV/PDF export (getDailySalesTransactions redirect)', () => {
    const transactionRows = [
      { receipt_number: 'MNL001-20260801-000001', payment_method: 'cash', total_amount: 150, vat_amount: 16.07, discount_amount: 30, discount_type: 'pwd', created_at: '2026-08-01T10:00:00.000Z', cashier_name: 'Juan Dela Cruz' },
      { receipt_number: 'MNL001-20260801-000002', payment_method: 'gcash', total_amount: 200, vat_amount: 21.43, discount_amount: 0, discount_type: null, created_at: '2026-08-01T11:00:00.000Z', cashier_name: 'Juan Dela Cruz' },
      { receipt_number: 'MNL001-20260801-000003', payment_method: 'cash', total_amount: 180, vat_amount: 19.29, discount_amount: 36, discount_type: 'senior_citizen', created_at: '2026-08-01T12:00:00.000Z', cashier_name: 'Maria Santos' },
    ];

    it('renders one row per discounted transaction (matching the on-screen tab), not the branch+discount_type aggregate the Admin report and CSV export use', async () => {
      vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(transactionRows as never);
      const { getReportRows } = await import('./reports.columns.js');
      const { generatePdf } = await import('../../lib/reports/pdf.js');
      const pdfBuffer = Buffer.from('%PDF-1.4 fake');
      vi.mocked(generatePdf).mockResolvedValue(pdfBuffer);
      const { prisma } = await import('../../lib/prisma.js');
      vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

      const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 100 }, 'pdf', 'user-1', 'supervisor', 'b1');

      expect(reportsRepository.getDailySalesTransactions).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
      expect(reportsRepository.getDiscountCompliance).not.toHaveBeenCalled();
      expect(reportsRepository.countRows).not.toHaveBeenCalled();
      expect(getReportRows).not.toHaveBeenCalled();
      const expectedRows = [transactionRows[0], transactionRows[2]];
      expect(generatePdf).toHaveBeenCalledWith('DISCOUNT_COMPLIANCE', expect.any(Object), expectedRows, expect.anything(), 'SM North');
      expect(result).toEqual({ kind: 'file', buffer: pdfBuffer, filename: expect.stringMatching(/\.pdf$/), contentType: 'application/pdf' });
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 2 }) }),
      );
    });

    it('leaves the Admin (super_admin) PDF export on the generic aggregate path untouched', async () => {
      vi.mocked(reportsRepository.countRows).mockResolvedValue(2);
      const { getReportRows } = await import('./reports.columns.js');
      const aggregateRows = [{ branch_name: 'SM North', discount_type: 'pwd', transaction_count: 1, total_discount_amount: 30, total_vat_exempt_amount: 5 }];
      vi.mocked(getReportRows).mockResolvedValue(aggregateRows as never);
      const { generatePdf } = await import('../../lib/reports/pdf.js');
      vi.mocked(generatePdf).mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
      const { prisma } = await import('../../lib/prisma.js');
      vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

      await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 25 }, 'pdf', 'admin-1', 'super_admin', 'b1');

      expect(reportsRepository.getDailySalesTransactions).not.toHaveBeenCalled();
      expect(getReportRows).toHaveBeenCalled();
      expect(generatePdf).toHaveBeenCalledWith('DISCOUNT_COMPLIANCE', expect.any(Object), aggregateRows, expect.anything(), 'SM North');
    });

    it('leaves the Admin (super_admin) CSV export on the generic aggregate path untouched', async () => {
      vi.mocked(reportsRepository.countRows).mockResolvedValue(1);
      const { getReportRows } = await import('./reports.columns.js');
      const aggregateRows = [{ branch_name: 'SM North', discount_type: 'pwd', transaction_count: 1, total_discount_amount: 30, total_vat_exempt_amount: 5 }];
      vi.mocked(getReportRows).mockResolvedValue(aggregateRows as never);

      const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 25 }, 'csv', 'admin-1', 'super_admin', 'b1');

      expect(reportsRepository.getDailySalesTransactions).not.toHaveBeenCalled();
      expect(reportsRepository.getDiscountCompliance).not.toHaveBeenCalled();
      expect(getReportRows).toHaveBeenCalled();
      expect(result.kind).toBe('file');
      if (result.kind !== 'file') throw new Error('expected file result');
      expect(result.contentType).toBe('text/csv');
      expect(result.buffer.toString('utf-8')).toContain('Total Discount');
    });

    it('Supervisor CSV export uses getDailySalesTransactions filtered to discount_type !== null, not the generic getDiscountCompliance/getReportRows aggregate', async () => {
      vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(transactionRows as never);
      const { getReportRows } = await import('./reports.columns.js');

      const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 100 }, 'csv', 'user-1', 'supervisor', 'b1');

      expect(reportsRepository.getDailySalesTransactions).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
      expect(reportsRepository.getDiscountCompliance).not.toHaveBeenCalled();
      expect(reportsRepository.countRows).not.toHaveBeenCalled();
      expect(getReportRows).not.toHaveBeenCalled();
      expect(result.kind).toBe('file');
      if (result.kind !== 'file') throw new Error('expected file result');
      expect(result.contentType).toBe('text/csv');
      expect(result.filename).toMatch(/\.csv$/);
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'REPORT_EXPORTED', afterState: expect.objectContaining({ async: false, rowCount: 2 }) }),
      );
    });

    it('Supervisor CSV preserves transaction row order and excludes rows with discount_type === null, matching the on-screen tab and PDF export', async () => {
      vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(transactionRows as never);

      const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 100 }, 'csv', 'user-1', 'supervisor', 'b1');

      if (result.kind !== 'file') throw new Error('expected file result');
      const lines = result.buffer.toString('utf-8').trim().split('\n');
      expect(lines).toHaveLength(3); // header + 2 discounted rows (the discount_type === null row is excluded), in original order
      expect(lines[0]).toContain('Receipt #');
      expect(lines[0]).toContain('Cashier');
      expect(lines[1]).toContain('MNL001-20260801-000001');
      expect(lines[1]).toContain('pwd');
      expect(lines[2]).toContain('MNL001-20260801-000003');
      expect(lines[2]).toContain('senior_citizen');
      expect(result.buffer.toString('utf-8')).not.toContain('MNL001-20260801-000002');
    });

    it('forwards branch and date-range filters to getDailySalesTransactions for the Supervisor CSV export', async () => {
      vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue([] as never);
      const dateFrom = new Date('2026-07-01T00:00:00.000Z');
      const dateTo = new Date('2026-07-31T23:59:59.999Z');

      await reportsService.requestExport(
        'DISCOUNT_COMPLIANCE',
        { branchId: 'b1', dateFrom, dateTo, page: 1, limit: 25 },
        'csv',
        'user-1',
        'supervisor',
        'b1',
      );

      expect(reportsRepository.getDailySalesTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'b1', dateFrom, dateTo }),
      );
    });

    it('Supervisor PDF export path remains unchanged by the CSV fix', async () => {
      vi.mocked(reportsRepository.getDailySalesTransactions).mockResolvedValue(transactionRows as never);
      const { generatePdf } = await import('../../lib/reports/pdf.js');
      const pdfBuffer = Buffer.from('%PDF-1.4 fake');
      vi.mocked(generatePdf).mockResolvedValue(pdfBuffer);
      const { prisma } = await import('../../lib/prisma.js');
      vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

      const result = await reportsService.requestExport('DISCOUNT_COMPLIANCE', { branchId: 'b1', page: 1, limit: 100 }, 'pdf', 'user-1', 'supervisor', 'b1');

      const expectedRows = [transactionRows[0], transactionRows[2]];
      expect(generatePdf).toHaveBeenCalledWith('DISCOUNT_COMPLIANCE', expect.any(Object), expectedRows, expect.anything(), 'SM North');
      expect(result).toEqual({ kind: 'file', buffer: pdfBuffer, filename: expect.stringMatching(/\.pdf$/), contentType: 'application/pdf' });
    });
  });

  describe('Supervisor/Branch Void/Refund tab export (getVoidRefundForExport redirect)', () => {
    const voidRefundRows = [
      { transaction_id: 't1', transaction_number: 'MNL001-20260801-000001', branch_name: 'SM North', cashier_name: 'Juan Dela Cruz', status: 'voided', total_amount: 150, reason: 'customer changed mind', actioned_by_name: 'Maria Santos', actioned_at: '2026-08-01T10:05:00.000Z' },
      { transaction_id: 't2', transaction_number: 'MNL001-20260801-000002', branch_name: 'SM North', cashier_name: 'Juan Dela Cruz', status: 'refunded', total_amount: 200, reason: 'wrong item', actioned_by_name: 'Maria Santos', actioned_at: '2026-08-01T11:00:00.000Z' },
    ];

    it('routes Supervisor VOID_REFUND CSV export through getVoidRefundForExport, not the generic getReportRows/countRows path', async () => {
      vi.mocked(reportsRepository.getVoidRefundForExport).mockResolvedValue(voidRefundRows as never);
      const { getReportRows } = await import('./reports.columns.js');

      const result = await reportsService.requestExport('VOID_REFUND', { branchId: 'b1', page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

      expect(reportsRepository.getVoidRefundForExport).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
      expect(reportsRepository.countRows).not.toHaveBeenCalled();
      expect(getReportRows).not.toHaveBeenCalled();
      expect(reportsRepository.getVoidRefund).not.toHaveBeenCalled();
      expect(result.kind).toBe('file');
      if (result.kind !== 'file') throw new Error('expected file result');
      expect(result.contentType).toBe('text/csv');
      expect(result.filename).toMatch(/\.csv$/);
    });

    it('CSV preserves the voided-then-refunded ordering and contains the exact rows getVoidRefundForExport returned', async () => {
      vi.mocked(reportsRepository.getVoidRefundForExport).mockResolvedValue(voidRefundRows as never);

      const result = await reportsService.requestExport('VOID_REFUND', { branchId: 'b1', page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

      if (result.kind !== 'file') throw new Error('expected file result');
      const lines = result.buffer.toString('utf-8').split('\n');
      expect(lines).toHaveLength(3); // header + voided row + refunded row, in that order
      expect(lines[1]).toContain('MNL001-20260801-000001');
      expect(lines[1]).toContain('voided');
      expect(lines[2]).toContain('MNL001-20260801-000002');
      expect(lines[2]).toContain('refunded');
    });

    it('forwards branch and date-range filters to getVoidRefundForExport', async () => {
      vi.mocked(reportsRepository.getVoidRefundForExport).mockResolvedValue([] as never);
      const dateFrom = new Date('2026-07-01T00:00:00.000Z');
      const dateTo = new Date('2026-07-31T23:59:59.999Z');

      await reportsService.requestExport(
        'VOID_REFUND',
        { branchId: 'b1', dateFrom, dateTo, page: 1, limit: 25 },
        'csv',
        'user-1',
        'supervisor',
        'b1',
      );

      expect(reportsRepository.getVoidRefundForExport).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'b1', dateFrom, dateTo }),
      );
    });

    it('Supervisor VOID_REFUND PDF export path is unchanged by the CSV fix', async () => {
      vi.mocked(reportsRepository.getVoidRefundForExport).mockResolvedValue(voidRefundRows as never);
      const { generatePdf } = await import('../../lib/reports/pdf.js');
      const pdfBuffer = Buffer.from('%PDF-1.4 fake');
      vi.mocked(generatePdf).mockResolvedValue(pdfBuffer);
      const { prisma } = await import('../../lib/prisma.js');
      vi.mocked(prisma.branch.findUnique).mockResolvedValue({ name: 'SM North' } as never);

      const result = await reportsService.requestExport('VOID_REFUND', { branchId: 'b1', page: 1, limit: 25 }, 'pdf', 'user-1', 'supervisor', 'b1');

      expect(reportsRepository.getVoidRefundForExport).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
      expect(generatePdf).toHaveBeenCalledWith('VOID_REFUND', expect.any(Object), voidRefundRows, expect.anything(), 'SM North');
      expect(result).toEqual({ kind: 'file', buffer: pdfBuffer, filename: expect.stringMatching(/\.pdf$/), contentType: 'application/pdf' });
    });

    it('Super Admin VOID_REFUND CSV export stays on the generic getReportRows/countRows path, not getVoidRefundForExport', async () => {
      vi.mocked(reportsRepository.countRows).mockResolvedValue(2);
      const { getReportRows } = await import('./reports.columns.js');
      const genericRows = [{ transaction_number: 'ADMIN-ROW-1' }];
      vi.mocked(getReportRows).mockResolvedValue(genericRows as never);

      const result = await reportsService.requestExport('VOID_REFUND', { page: 1, limit: 25 }, 'csv', 'admin-1', 'super_admin', null);

      expect(reportsRepository.getVoidRefundForExport).not.toHaveBeenCalled();
      expect(getReportRows).toHaveBeenCalledWith('VOID_REFUND', expect.objectContaining({ page: 1 }));
      expect(result.kind).toBe('file');
      if (result.kind !== 'file') throw new Error('expected file result');
      expect(result.contentType).toBe('text/csv');
    });
  });

  it('PDF async path (super admin): enqueues a job when count >= 2,000, even below the CSV threshold of 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(2_500);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-2' } as never);
    const { generatePdf } = await import('../../lib/reports/pdf.js');

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'pdf', 'admin-1', 'super_admin', 'b1');

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect(generatePdf).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'job', job_id: 'job-2', message: expect.any(String), estimated_seconds: 30 });
  });

  it('rejects a supervisor exporting a super-admin-only report type with 403', async () => {
    await expect(
      reportsService.requestExport('BRANCH_COMPARISON', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_REPORT_TYPE', statusCode: 403 });
  });
});
