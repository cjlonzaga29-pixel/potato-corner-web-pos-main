import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "GCash volume anomaly — significantly above branch average — Medium". Decision #1: >50% above the 30-day branch daily average, by transaction count. */
const ANOMALY_MULTIPLIER = 1.5;
const TRAILING_WINDOW_DAYS = 30;

export const gcashVolumeAnomalyRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const windowStart = new Date(dayEnd.getTime() - TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [todayCounts, windowTotal] = await Promise.all([
      transactionsRepository.findGcashCountsByCashierForDate(context.branchId, dayStart, dayEnd),
      transactionsRepository.countGcashTransactionsForBranchWindow(context.branchId, windowStart, dayEnd),
    ]);

    const branchDailyAverage = windowTotal / TRAILING_WINDOW_DAYS;
    // A branch with no GCash history yet would trivially fail "50% above zero" for its very first transaction — skip rather than false-positive on sparse data.
    if (branchDailyAverage <= 0) return [];

    const threshold = branchDailyAverage * ANOMALY_MULTIPLIER;
    const results: DetectionResult[] = [];
    for (const row of todayCounts) {
      if (row.gcashCount <= threshold) continue;
      results.push({
        alertType: 'gcash_volume_anomaly',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: row.cashierId,
        evidence: {
          gcash_count_today: row.gcashCount,
          branch_daily_average: Number(branchDailyAverage.toFixed(2)),
          threshold: Number(threshold.toFixed(2)),
          window_days: TRAILING_WINDOW_DAYS,
        },
      });
    }
    return results;
  },
};
