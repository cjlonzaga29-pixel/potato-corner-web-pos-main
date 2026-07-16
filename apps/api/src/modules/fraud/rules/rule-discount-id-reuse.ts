import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Discount ID reuse — same customer ID for statutory discount >3× in 30 days — High". Corrections #4: global-scope, can span branches. */
const WINDOW_DAYS = 30;
const REUSE_THRESHOLD = 3;

interface StatutoryDiscountRow {
  id: string;
  branchId: string;
  discountCustomerIdHash: string | null;
}

export const discountIdReuseRule: FraudRule = {
  scope: 'global',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    const windowEnd = context.evaluationDate;
    const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await transactionsRepository.findStatutoryDiscountsInWindow(windowStart, windowEnd);

    const byHash = new Map<string, StatutoryDiscountRow[]>();
    for (const row of rows) {
      if (!row.discountCustomerIdHash) continue;
      const existing = byHash.get(row.discountCustomerIdHash) ?? [];
      existing.push(row);
      byHash.set(row.discountCustomerIdHash, existing);
    }

    const results: DetectionResult[] = [];
    for (const [hash, transactions] of byHash) {
      if (transactions.length <= REUSE_THRESHOLD) continue;
      results.push({
        alertType: 'discount_id_reuse',
        severity: FRAUD_ALERT_SEVERITY.HIGH,
        branchId: null,
        employeeId: null,
        evidence: {
          customer_id_hash: hash,
          occurrence_count: transactions.length,
          window_days: WINDOW_DAYS,
          transaction_ids: transactions.map((t) => t.id),
          branch_ids: [...new Set(transactions.map((t) => t.branchId))],
        },
      });
    }
    return results;
  },
};
