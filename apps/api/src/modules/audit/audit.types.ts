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
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}
