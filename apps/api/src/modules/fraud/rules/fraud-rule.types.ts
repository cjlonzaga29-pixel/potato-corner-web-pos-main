import type { FraudAlertSeverity } from '@potato-corner/shared';

export interface RuleContext {
  /** null only for a 'global' scope rule (currently just discount_id_reuse). */
  branchId: string | null;
  evaluationDate: Date;
}

export interface DetectionResult {
  alertType: string;
  severity: FraudAlertSeverity;
  branchId: string | null;
  employeeId: string | null;
  evidence: Record<string, unknown>;
}

export interface FraudRule {
  /** 'branch': the detection engine calls evaluate() once per active branch. 'global': called exactly once, with branchId: null. */
  scope: 'branch' | 'global';
  evaluate(context: RuleContext): Promise<DetectionResult[]>;
}
