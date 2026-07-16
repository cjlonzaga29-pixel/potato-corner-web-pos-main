import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { cashRepository } from '../../cash/cash.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12 / Part 9: "Variance in >30% of last 10 closing counts — High". Decision #6: "variance" = varianceApproved !== null (outside tolerance, required a decision). */
const WINDOW_SIZE = 10;
const RATIO_THRESHOLD = 0.3;

export const cashVariancePatternRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const cashierIds = await cashRepository.findCashiersWithClosedShifts(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const cashierId of cashierIds) {
      const lastShifts = await cashRepository.findLastNClosedShiftsForCashier(cashierId, context.branchId, WINDOW_SIZE);
      if (lastShifts.length < WINDOW_SIZE) continue;

      const varianceCount = lastShifts.filter((shift) => shift.varianceApproved !== null).length;
      const ratio = varianceCount / lastShifts.length;
      if (ratio <= RATIO_THRESHOLD) continue;

      results.push({
        alertType: 'cash_variance_pattern',
        severity: FRAUD_ALERT_SEVERITY.HIGH,
        branchId: context.branchId,
        employeeId: cashierId,
        evidence: {
          variance_count: varianceCount,
          shifts_checked: lastShifts.length,
          ratio: Number(ratio.toFixed(2)),
          shift_ids: lastShifts.map((shift) => shift.id),
        },
      });
    }
    return results;
  },
};
