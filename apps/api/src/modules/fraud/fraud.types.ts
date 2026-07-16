/**
 * Fraud module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */
import type { FraudAlertSeverity, FraudAlertStatus } from '@potato-corner/shared';

/** Mirrors TransactionError/AttendanceError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class FraudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FraudError';
  }
}

export interface FraudAlertFilters {
  branchId?: string;
  status?: FraudAlertStatus;
  severity?: FraudAlertSeverity;
  alertType?: string;
  page: number;
  limit: number;
}

export interface InvestigateAlertData {
  notes?: string;
}

export interface DismissAlertData {
  dismissalReason: string;
}

export interface EscalateAlertData {
  notes?: string;
}

/**
 * Data accepted by fraudRepository.updateStatus. No resolvedAt field: the
 * fraud_alerts table (see prisma/schema.prisma) has no resolved_at column —
 * only id, alert_type, severity, employee_id, branch_id, evidence, status,
 * investigated_by, dismissal_reason, created_at, updated_at. updated_at
 * (Prisma @updatedAt, stamped automatically) is this row's "when did the
 * status last change" timestamp instead; adding a dedicated resolved_at
 * column would need a schema migration, which is out of scope for this
 * workflow-only phase.
 */
export interface UpdateFraudAlertStatusData {
  status: FraudAlertStatus;
  investigatedBy?: string;
  dismissalReason?: string;
}

/** Input shape for fraudRepository.createAlert — one row per detection result the engine produces. */
export interface CreateFraudAlertData {
  alertType: string;
  severity: FraudAlertSeverity;
  branchId: string | null;
  employeeId: string | null;
  evidence: Record<string, unknown>;
}
