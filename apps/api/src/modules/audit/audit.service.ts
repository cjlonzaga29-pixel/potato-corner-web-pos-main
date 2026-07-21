import type { AuditLogListResponse, AuditLogResponse } from '@potato-corner/shared';
import { auditRepository } from './audit.repository.js';
import type { AuditLogFilters } from './audit.types.js';

interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  actorRole: string;
  branchId: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  previousHash: string;
  currentHash: string;
  createdAt: Date;
  actor?: { id: string; firstName: string; lastName: string; email: string } | null;
  branch?: { id: string; name: string } | null;
}

function toAuditLogResponse(row: AuditLogRow): AuditLogResponse {
  return {
    id: row.id,
    action: row.action,
    entity_type: row.entityType,
    entity_id: row.entityId,
    actor_id: row.actorId,
    actor_role: row.actorRole,
    actor: row.actor
      ? { id: row.actor.id, first_name: row.actor.firstName, last_name: row.actor.lastName, email: row.actor.email }
      : null,
    branch_id: row.branchId,
    branch: row.branch ? { id: row.branch.id, name: row.branch.name } : null,
    before_state: row.beforeState ?? null,
    after_state: row.afterState ?? null,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    previous_hash: row.previousHash,
    current_hash: row.currentHash,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Audit business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through auditRepository.
 */
export const auditService = {
  async listLogs(filters: AuditLogFilters): Promise<AuditLogListResponse> {
    const { logs, total } = await auditRepository.findAll(filters);
    return {
      logs: (logs as AuditLogRow[]).map(toAuditLogResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },
};
