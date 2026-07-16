import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Excessive voids — >3 voids in one shift — Medium". */
const VOID_THRESHOLD = 3;

export const excessiveVoidsRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const voidedIds = shift.transactions.filter((t) => t.status === 'voided').map((t) => t.id);
      if (voidedIds.length <= VOID_THRESHOLD) continue;
      results.push({
        alertType: 'excessive_voids',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: { shift_id: shift.id, void_count: voidedIds.length, void_transaction_ids: voidedIds },
      });
    }
    return results;
  },
};
