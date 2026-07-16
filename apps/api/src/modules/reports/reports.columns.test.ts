// apps/api/src/modules/reports/reports.columns.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn().mockResolvedValue([{ report_date: '2026-07-01' }]),
    getShiftSummary: vi.fn().mockResolvedValue([]),
    getCashReconciliation: vi.fn().mockResolvedValue([]),
    getVoidRefund: vi.fn().mockResolvedValue([]),
    getDiscountCompliance: vi.fn().mockResolvedValue([]),
    getInventoryMovement: vi.fn().mockResolvedValue([]),
    getAttendanceSummary: vi.fn().mockResolvedValue([]),
    getFraudAlertSummary: vi.fn().mockResolvedValue([]),
    getProductPerformance: vi.fn().mockResolvedValue([]),
    getFlavorPerformance: vi.fn().mockResolvedValue([]),
    getEmployeePerformance: vi.fn().mockResolvedValue([]),
    getInventoryValuation: vi.fn().mockResolvedValue([]),
    getBranchComparison: vi.fn().mockResolvedValue([]),
  },
}));

const { reportsRepository } = await import('./reports.repository.js');
const { getReportRows, REPORT_COLUMNS } = await import('./reports.columns.js');

beforeEach(() => vi.clearAllMocks());

describe('getReportRows', () => {
  it('dispatches DAILY_SALES to reportsRepository.getDailySales', async () => {
    const rows = await getReportRows('DAILY_SALES', { page: 1, limit: 25 });
    expect(reportsRepository.getDailySales).toHaveBeenCalledWith({ page: 1, limit: 25 });
    expect(rows).toEqual([{ report_date: '2026-07-01' }]);
  });

  it('dispatches BRANCH_COMPARISON to reportsRepository.getBranchComparison', async () => {
    await getReportRows('BRANCH_COMPARISON', { page: 1, limit: 25 });
    expect(reportsRepository.getBranchComparison).toHaveBeenCalled();
  });
});

describe('REPORT_COLUMNS', () => {
  it('defines a non-empty column list for every one of the 13 report types', () => {
    const types = [
      'DAILY_SALES', 'SHIFT_SUMMARY', 'CASH_RECONCILIATION', 'VOID_REFUND', 'DISCOUNT_COMPLIANCE',
      'INVENTORY_MOVEMENT', 'ATTENDANCE_SUMMARY', 'FRAUD_ALERT_SUMMARY', 'PRODUCT_PERFORMANCE',
      'FLAVOR_PERFORMANCE', 'EMPLOYEE_PERFORMANCE', 'INVENTORY_VALUATION', 'BRANCH_COMPARISON',
    ] as const;
    for (const type of types) {
      expect(REPORT_COLUMNS[type].length).toBeGreaterThan(0);
    }
  });
});
