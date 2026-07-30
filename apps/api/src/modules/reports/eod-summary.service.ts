import { reportsRepository } from './reports.repository.js';
import { cashRepository } from '../cash/cash.repository.js';
import { fraudRepository } from '../fraud/fraud.repository.js';
import { dayBounds } from '../fraud/rules/fraud-rule.utils.js';
import { manilaDateKey } from '../../lib/manila-time.js';

export interface EodBranchRevenue {
  branchId: string;
  branchName: string;
  revenue: number;
}

export interface EodSummaryPayload {
  evaluationDate: string;
  totalRevenue: number;
  branchRevenue: EodBranchRevenue[];
  transactionCount: number;
  voidCount: number;
  unresolvedCashVarianceCount: number;
  openFraudAlertsCreatedTodayCount: number;
}

/**
 * Assembles the Part 13 EOD summary by reusing existing reports/cash/fraud
 * repository queries — no aggregation SQL of its own. Standalone per
 * Phase 18 Decision 6, not folded into reports.service.ts.
 */
export async function buildEodSummary(evaluationDate: Date): Promise<EodSummaryPayload> {
  const { dayStart, dayEnd } = dayBounds(evaluationDate);
  const filters = { dateFrom: dayStart, dateTo: dayEnd, page: 1, limit: Number.MAX_SAFE_INTEGER };

  const [dailySales, voidCount, unresolvedCashVarianceCount, openFraudAlertsCreatedTodayCount] = await Promise.all([
    reportsRepository.getDailySales(filters),
    reportsRepository.countRows('VOID_REFUND', filters),
    cashRepository.countUnresolvedVariancesInWindow(dayStart, dayEnd),
    fraudRepository.countAlertsCreatedInWindow(dayStart, dayEnd),
  ]);

  const branchRevenue = dailySales.map((row) => ({
    branchId: row.branch_id,
    branchName: row.branch_name,
    revenue: row.gross_sales,
  }));
  const totalRevenue = branchRevenue.reduce((sum, branch) => sum + branch.revenue, 0);
  const transactionCount = dailySales.reduce((sum, row) => sum + row.completed_count, 0);

  return {
    evaluationDate: manilaDateKey(dayStart),
    totalRevenue,
    branchRevenue,
    transactionCount,
    voidCount,
    unresolvedCashVarianceCount,
    openFraudAlertsCreatedTodayCount,
  };
}
