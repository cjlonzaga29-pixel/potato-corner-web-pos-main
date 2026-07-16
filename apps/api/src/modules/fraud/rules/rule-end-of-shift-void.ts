import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "End of shift void — Void submitted in the last 10 minutes of a shift — Low". */
const END_OF_SHIFT_WINDOW_MS = 10 * 60 * 1000;

export const endOfShiftVoidRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      if (!shift.closedAt) continue;
      const closedAtMs = shift.closedAt.getTime();
      for (const txn of shift.transactions) {
        if (txn.status !== 'voided' || !txn.voidedAt) continue;
        const msBeforeClose = closedAtMs - txn.voidedAt.getTime();
        if (msBeforeClose < 0 || msBeforeClose > END_OF_SHIFT_WINDOW_MS) continue;
        results.push({
          alertType: 'end_of_shift_void',
          severity: FRAUD_ALERT_SEVERITY.LOW,
          branchId: context.branchId,
          employeeId: shift.cashierId,
          evidence: {
            shift_id: shift.id,
            transaction_id: txn.id,
            voided_at: txn.voidedAt.toISOString(),
            shift_closed_at: shift.closedAt.toISOString(),
          },
        });
      }
    }
    return results;
  },
};
