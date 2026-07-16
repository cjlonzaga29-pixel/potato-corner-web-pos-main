import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Discount abuse — >5 discounted transactions in one shift — Medium". Decision #3: any discountType counts, not just statutory. */
const DISCOUNT_THRESHOLD = 5;

export const discountAbuseRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const discountedIds = shift.transactions
        .filter((t) => t.status === 'completed' && t.discountType !== null)
        .map((t) => t.id);
      if (discountedIds.length <= DISCOUNT_THRESHOLD) continue;
      results.push({
        alertType: 'discount_abuse',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: { shift_id: shift.id, discount_count: discountedIds.length, discount_transaction_ids: discountedIds },
      });
    }
    return results;
  },
};
