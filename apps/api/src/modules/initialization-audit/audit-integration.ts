import type { InitializationRun } from '@prisma/client';
import { recordAuditLog } from '../../middleware/audit-log.js';

/**
 * CR-009 "Authorization boundary" — every initialization-audit operation
 * (dry-run creation, apply execution, retry, rollback assessment/confirm/
 * execute, and viewing run details) is restricted to the Super Admin role.
 * This is a re-export, not a new authorization check: `adminOnly` (from
 * `../../middleware/authorize.ts`) is already the codebase's one
 * Super-Admin-only Express guard, reused verbatim rather than reinvented.
 */
export { adminOnly as requireSuperAdmin } from '../../middleware/authorize.js';

/**
 * CR-009 "Audit integration" — writes one `AuditLog` row per
 * `InitializationRun` lifecycle transition.
 *
 * `run-lifecycle.service.ts` (R4) is purely the status state machine and
 * deliberately never writes an AuditLog row itself; callers that drive a
 * transition through that service are expected to call this function
 * afterward with the row `transitionRunStatus` (or one of its named
 * wrappers) returned.
 *
 * `action` convention: the target `InitializationRunStatus` value the run
 * just transitioned into (e.g. `'APPLYING'`, `'APPLIED'`, `'APPLY_FAILED'`)
 * — `run.status` after the transition. This is unambiguous and needs no
 * separate naming scheme.
 *
 * `actorId`/`actorRole`: `InitializationRun` has no per-transition actor
 * column — the only durable actor reference on the row is
 * `initiatedBy` (`InitializationRun.initiatedByUser -> User`). Since every
 * initialization-audit operation is Super-Admin-only, `run.initiatedBy` is
 * used as `actorId` and `'super_admin'` as the fixed `actorRole` for every
 * call — the only actor identity the schema durably records for this
 * entity, consistent with the role restriction.
 *
 * Delegates the actual hash-chained write to `recordAuditLog`
 * (`../../middleware/audit-log.ts`) rather than reimplementing the
 * previousHash/currentHash chain — a second, parallel implementation would
 * produce two divergent chains sharing one `AuditLog` table, breaking the
 * tamper-evidence property the chain exists for.
 */
export async function writeInitAuditLogEntry(action: string, run: InitializationRun): Promise<void> {
  await recordAuditLog({
    action,
    entityType: 'InitializationRun',
    entityId: run.id,
    actorId: run.initiatedBy,
    actorRole: 'super_admin',
  });
}
