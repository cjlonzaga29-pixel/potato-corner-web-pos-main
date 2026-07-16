import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Employee self-discount frequency — Employee discount applied >2× per shift — Low". Task 1 confirmed DISCOUNT_TYPE.EMPLOYEE === 'employee'. */
const EMPLOYEE_DISCOUNT_THRESHOLD = 2;
const EMPLOYEE_DISCOUNT_TYPE = 'employee';

export const employeeSelfDiscountRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const employeeDiscountIds = shift.transactions
        .filter((t) => t.status === 'completed' && t.discountType === EMPLOYEE_DISCOUNT_TYPE)
        .map((t) => t.id);
      if (employeeDiscountIds.length <= EMPLOYEE_DISCOUNT_THRESHOLD) continue;
      results.push({
        alertType: 'employee_self_discount_frequency',
        severity: FRAUD_ALERT_SEVERITY.LOW,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: {
          shift_id: shift.id,
          employee_discount_count: employeeDiscountIds.length,
          employee_discount_transaction_ids: employeeDiscountIds,
        },
      });
    }
    return results;
  },
};
