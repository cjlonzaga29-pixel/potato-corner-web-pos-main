import { excessiveVoidsRule } from './rule-excessive-voids.js';
import { discountAbuseRule } from './rule-discount-abuse.js';
import { cashVariancePatternRule } from './rule-cash-variance-pattern.js';
import { gcashVolumeAnomalyRule } from './rule-gcash-volume-anomaly.js';
import { discountIdReuseRule } from './rule-discount-id-reuse.js';
import { endOfShiftVoidRule } from './rule-end-of-shift-void.js';
import { employeeSelfDiscountRule } from './rule-employee-self-discount.js';
import type { FraudRule } from './fraud-rule.types.js';

/** All 7 Architecture doc Part 12 detection rules, in the same order as the spec's table. */
export const FRAUD_RULES: FraudRule[] = [
  excessiveVoidsRule,
  discountAbuseRule,
  cashVariancePatternRule,
  gcashVolumeAnomalyRule,
  discountIdReuseRule,
  endOfShiftVoidRule,
  employeeSelfDiscountRule,
];

export type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';
