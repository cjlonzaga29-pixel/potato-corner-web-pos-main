/**
 * Audit module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */
export interface AuditLogFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  /** Client-supplied single-branch filter (query param `branch_id`). */
  branchId?: string;
  /**
   * CR-003: server-computed branch scope — undefined means "no restriction"
   * (super_admin with no explicit branch_id filter); otherwise the query is
   * restricted to exactly this set. Always set by auditService.listLogs
   * before reaching the repository; never trust a client-supplied value here.
   */
  branchIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

/** Mirrors employees.types.ts's EmployeeError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class AuditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}
