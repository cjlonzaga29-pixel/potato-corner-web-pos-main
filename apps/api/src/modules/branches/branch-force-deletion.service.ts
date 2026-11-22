import { timingSafeEqual } from 'node:crypto';
import {
  ROLES,
  SOCKET_EVENTS,
  type BranchClosureItemList,
  type ForceDeleteBranchInput,
  type ForceDeletionPlan,
  type ForceDeletionStatus,
} from '@potato-corner/shared';
import { hashField } from '../../lib/encryption.js';
import { prisma } from '../../lib/prisma.js';
import { forgetAccountStatus } from '../../lib/verify-access-token.js';
import { forgetActiveStatus } from '../../middleware/require-active-employee.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getIO } from '../../socket/socket.server.js';
import { SUPER_ADMIN_ROOM, branchRoom, userRoom } from '../../socket/rooms.js';
import { branchesRepository } from './branches.repository.js';
import { BranchError } from './branches.types.js';
import {
  FORCE_ITEM_OUTCOMES,
  ForceDeletionInconsistent,
  branchForceDeletionRepository,
  planHash,
  type ForceItemKind,
  type ForcePlanItem,
} from './branch-force-deletion.repository.js';

/**
 * POS-PERF-P68 — Force Delete Branch (Super Admin only). See the repository
 * header for the two-transaction lifecycle. This layer checks the
 * confirmation (typed name and code, version, the exact plan and an
 * actor-bound token), makes repeats idempotent by operation id, and drives
 * a fenced operation to its end from a request, a status poll or the sweeper.
 */

type Actor = { id: string; role: string };

export const OFFLINE_NOTICE =
  'The server cannot see or delete sales queued on terminals that are offline. After this branch is deleted, a terminal that syncs later is refused, and its queued sales stay on that device, marked refused, for manual reconciliation. They are never assigned to another branch, even one with the same name. Sync every terminal first if you can.';

const EXPLANATIONS: Record<ForceItemKind, string> = {
  open_shift:
    'Open shifts are ended as "terminated". No cash count is invented; each stays uncounted and unreconciled.',
  open_attendance:
    'Open clock-ins are ended administratively. No clock-out time, work time or pay is invented.',
  pending_checkout:
    'Unfinished checkouts with no recorded sale are marked abandoned. A terminal may still hold the sale offline.',
  held_order:
    'Held orders (no payment taken) are removed with the branch. Their contents are kept in the closure record.',
  deduction_job:
    'Sales stay recorded. Stock deductions that never ran are cancelled; refused if any already moved stock.',
  projection_outbox:
    'Stock movements stay recorded. Their pending projections are left "stuck" for manual review.',
  inventory_approval:
    'Pending or returned stock approvals are cancelled without review. No stock changes.',
  stock_balance:
    'Stock on hand or reserved is NOT zeroed, transferred or written off. Each balance is kept in the closure record.',
  draft_payroll_run: 'Draft payroll runs stay drafts. Nothing is finalized; they become read-only.',
  unpaid_payroll_hours:
    'Hours no finalized payroll covers are kept and listed for settlement outside the app.',
};

function forceDeletionToken(
  actorId: string,
  branchId: string,
  version: string,
  hash: string,
): string {
  return hashField(`pos-perf-p68:branch-force-delete:${actorId}:${branchId}:${version}:${hash}`);
}

function tokensMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function assertSuperAdmin(actor: Actor): void {
  if (actor.role !== ROLES.SUPER_ADMIN)
    throw new BranchError('FORBIDDEN', 'Only a Super Admin can force delete a branch', 403);
}

function describe(item: ForcePlanItem): string {
  const s = item.snapshot;
  switch (item.kind) {
    case 'stock_balance':
      return `${String(s.itemName)}: on hand ${String(s.quantityOnHand)}, reserved ${String(s.quantityReserved)}`;
    case 'open_shift':
      return `Shift ${item.sourceId.slice(0, 8)} opened ${String(s.startedAt)}`;
    case 'open_attendance':
      return `Clock-in ${item.sourceId.slice(0, 8)} at ${String(s.clockInServerTime)}`;
    case 'draft_payroll_run':
      return `Draft ${String(s.periodStart).slice(0, 10)} to ${String(s.periodEnd).slice(0, 10)}`;
    default:
      return `${item.sourceTable} ${item.sourceId.slice(0, 8)}`;
  }
}

function toStatus(
  op: {
    id: string;
    branchId: string;
    status: string;
    step: string | null;
    abortReason: string | null;
    lastError: string | null;
    createdAt: Date;
    completedAt: Date | null;
  },
  closureItemCount: number,
): ForceDeletionStatus {
  return {
    operation_id: op.id,
    branch_id: op.branchId,
    status: op.status as ForceDeletionStatus['status'],
    step: op.step,
    abort_reason: op.abortReason,
    last_error: op.lastError,
    closure_item_count: closureItemCount,
    created_at: op.createdAt.toISOString(),
    completed_at: op.completedAt?.toISOString() ?? null,
  };
}

async function currentStatus(operationId: string): Promise<ForceDeletionStatus> {
  const op = await branchForceDeletionRepository.findOperation(operationId);
  if (!op)
    throw new BranchError('FORCE_DELETION_NOT_FOUND', 'Force delete operation not found', 404);
  return toStatus(op, await branchForceDeletionRepository.countClosureItems(operationId));
}

export const branchForceDeletionService = {
  /** What a Force Delete would do now, and the confirmation bound to exactly this plan. */
  async getPlan(branchId: string, actor: Actor): Promise<ForceDeletionPlan> {
    assertSuperAdmin(actor);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    const [items, historyRetained, removed, inProgress] = await Promise.all([
      branchForceDeletionRepository.findPlan(branchId),
      branchesRepository.countRetainedHistory(branchId),
      branchesRepository.countRemovedWithBranch(branchId),
      branchForceDeletionRepository.findFencedOperationForBranch(branchId),
    ]);
    const keys = items.map((item) => item.key).sort();
    const hash = planHash(keys);
    const version = branch.updatedAt.toISOString();
    const groups = (Object.keys(FORCE_ITEM_OUTCOMES) as ForceItemKind[])
      .map((kind) => {
        const ofKind = items.filter((item) => item.kind === kind);
        return {
          kind,
          count: ofKind.length,
          outcome: FORCE_ITEM_OUTCOMES[kind].outcome,
          explanation: EXPLANATIONS[kind],
          examples: ofKind.slice(0, 20).map(describe),
        };
      })
      .filter((group) => group.count > 0);
    return {
      branch_id: branchId,
      in_progress_operation_id: inProgress?.id ?? null,
      groups,
      history_retained: historyRetained,
      removed,
      offline_notice: OFFLINE_NOTICE,
      confirmation: {
        name: branch.name,
        code: branch.code,
        version,
        plan_keys: keys,
        plan_hash: hash,
        confirmation_token: forceDeletionToken(actor.id, branchId, version, hash),
      },
    };
  },

  async forceDelete(
    branchId: string,
    actor: Actor,
    ipAddress: string | null,
    input: ForceDeleteBranchInput,
  ): Promise<ForceDeletionStatus> {
    assertSuperAdmin(actor);

    // Idempotency: a repeat with the same operation id reports (and, if
    // needed, finishes) that operation. It can never act on another branch.
    const existing = await branchForceDeletionRepository.findOperation(input.operation_id);
    if (existing) {
      if (existing.branchId !== branchId || existing.actorId !== actor.id) {
        throw new BranchError(
          'FORCE_DELETION_OPERATION_CONFLICT',
          'This operation id belongs to a different branch or person.',
          409,
        );
      }
      return branchForceDeletionService.advance(existing.id, ipAddress);
    }

    const branch = await branchesRepository.findById(branchId);
    if (!branch) {
      const record = await branchesRepository.findRecordById(branchId);
      if (record?.deletedAt) {
        return {
          operation_id: null,
          branch_id: branchId,
          status: 'already_deleted',
          step: null,
          abort_reason: null,
          last_error: null,
          closure_item_count: 0,
          created_at: null,
          completed_at: null,
        };
      }
      throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    }

    if (
      normalizeName(input.confirm_name) !== normalizeName(branch.name) ||
      input.confirm_code.trim() !== branch.code
    ) {
      throw new BranchError(
        'DELETE_CONFIRMATION_MISMATCH',
        `Type the branch name (${branch.name}) and code (${branch.code}) exactly as shown to confirm.`,
        400,
      );
    }
    const keys = [...input.plan_keys].sort();
    const hash = planHash(keys);
    if (
      hash !== input.plan_hash ||
      !tokensMatch(
        forceDeletionToken(actor.id, branchId, input.version, hash),
        input.confirmation_token,
      )
    ) {
      throw new BranchError(
        'DELETE_CONFIRMATION_INVALID',
        'This confirmation was not issued to you for this branch and plan. Open Force Delete again.',
        403,
      );
    }
    const version = new Date(input.version);
    if (version.getTime() !== branch.updatedAt.getTime()) {
      throw new BranchError(
        'BRANCH_CHANGED',
        'This branch changed after the dialog opened. Review the details and confirm again.',
        409,
      );
    }
    if (branch.deletionFencedAt) {
      throw new BranchError(
        'FORCE_DELETION_IN_PROGRESS',
        'A Force Delete of this branch is already in progress.',
        409,
        { operation_id: branch.deletionOperationId },
      );
    }

    // Before fencing: open work the Super Admin did not confirm stops here, unchanged.
    const confirmed = new Set(keys);
    const unexpected = (await branchForceDeletionRepository.findPlan(branchId)).filter(
      (item) => !confirmed.has(item.key),
    );
    if (unexpected.length > 0) {
      throw new BranchError(
        'FORCE_DELETION_PLAN_CHANGED',
        `Open work at this branch changed after the dialog opened (${unexpected.length} new or changed item(s)). Nothing was changed. Review it and confirm again.`,
        409,
      );
    }

    const fenced = await branchForceDeletionRepository.fence({
      operationId: input.operation_id,
      branchId,
      actorId: actor.id,
      expectedVersion: version,
      planKeys: keys,
      planHashValue: hash,
    });
    if (fenced === 'changed')
      throw new BranchError(
        'BRANCH_CHANGED',
        'This branch changed after the dialog opened. Review the details and confirm again.',
        409,
      );
    if (fenced === 'in_progress') {
      const other = await branchForceDeletionRepository.findFencedOperationForBranch(branchId);
      throw new BranchError(
        'FORCE_DELETION_IN_PROGRESS',
        'A Force Delete of this branch is already in progress.',
        409,
        { operation_id: other?.id ?? null },
      );
    }
    await recordAuditLog({
      action: 'BRANCH_FORCE_DELETION_STARTED',
      entityType: 'branch',
      entityId: branchId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { operation_id: input.operation_id, plan_hash: hash, plan_items: keys.length },
      ipAddress,
    });
    return branchForceDeletionService.advance(input.operation_id, ipAddress);
  },

  /**
   * Drives a fenced operation to its end. Safe to call any number of times
   * from anywhere; the operation row lock serializes callers.
   */
  async advance(operationId: string, ipAddress: string | null): Promise<ForceDeletionStatus> {
    const op = await branchForceDeletionRepository.findOperation(operationId);
    if (!op)
      throw new BranchError('FORCE_DELETION_NOT_FOUND', 'Force delete operation not found', 404);
    if (op.status !== 'fenced') return currentStatus(operationId);

    let result: Awaited<ReturnType<typeof branchForceDeletionRepository.finalize>>;
    try {
      result = await branchForceDeletionRepository.finalize(operationId);
    } catch (error) {
      // Stays fenced and recoverable; never reported as complete.
      const message =
        error instanceof ForceDeletionInconsistent
          ? error.message
          : 'Unexpected error while finishing; it will be retried.';
      if (!(error instanceof ForceDeletionInconsistent))
        console.error('Force delete finalize failed:', error);
      await branchForceDeletionRepository.recordError(operationId, message);
      return currentStatus(operationId);
    }

    if (result.outcome === 'aborted') {
      await recordAuditLog({
        action: 'BRANCH_FORCE_DELETION_ABORTED',
        entityType: 'branch',
        entityId: op.branchId,
        actorId: op.actorId,
        actorRole: ROLES.SUPER_ADMIN,
        branchId: op.branchId,
        afterState: {
          operation_id: operationId,
          reason: result.reason,
          unexpected: result.unexpected.slice(0, 50),
        },
        ipAddress,
      });
    }
    if (result.outcome === 'completed') {
      try {
        for (const userId of result.branchAccountIds) {
          forgetAccountStatus(userId);
          forgetActiveStatus(userId);
        }
        const io = getIO();
        if (io) {
          for (const userId of result.branchAccountIds) {
            io.to(userRoom(userId)).emit(SOCKET_EVENTS.EMPLOYEE_SESSION_REVOKED, {
              employeeId: userId,
              status: 'deleted',
            });
            void io.in(userRoom(userId)).disconnectSockets(true);
          }
          io.in(branchRoom(result.branchId)).socketsLeave(branchRoom(result.branchId));
          io.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_DELETED, { branchId: result.branchId });
        }
      } catch (error) {
        console.error('Post-deletion session cleanup failed (branch already deleted):', error);
      }
      const byKind: Record<string, number> = {};
      for (const item of result.items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
      await recordAuditLog({
        action: 'BRANCH_FORCE_DELETED',
        entityType: 'branch',
        entityId: result.branchId,
        actorId: result.actorId,
        actorRole: ROLES.SUPER_ADMIN,
        branchId: result.branchId,
        afterState: {
          operation_id: operationId,
          deleted: true,
          closure_items: byKind,
          removed: result.removed,
          branch_accounts_deleted: result.branchAccountIds,
        },
        ipAddress,
      });
    }
    return currentStatus(operationId);
  },

  async getStatus(
    operationId: string,
    actor: Actor,
    ipAddress: string | null,
  ): Promise<ForceDeletionStatus> {
    assertSuperAdmin(actor);
    return branchForceDeletionService.advance(operationId, ipAddress);
  },

  /** Lifts the fence of an operation that has not finished. Nothing else changes. */
  async abort(
    operationId: string,
    actor: Actor,
    ipAddress: string | null,
  ): Promise<ForceDeletionStatus> {
    assertSuperAdmin(actor);
    const op = await branchForceDeletionRepository.findOperation(operationId);
    if (!op)
      throw new BranchError('FORCE_DELETION_NOT_FOUND', 'Force delete operation not found', 404);
    if (op.status === 'fenced') {
      const aborted = await prisma.$transaction(async (tx) => {
        const claimed = await tx.branchDeletionOperation.updateMany({
          where: { id: operationId, status: 'fenced' },
          data: { step: 'aborting' },
        });
        if (claimed.count === 0) return false;
        await branchForceDeletionRepository.abort(
          operationId,
          'Stopped by a Super Admin before it finished. Nothing was deleted.',
          tx,
        );
        return true;
      });
      if (aborted) {
        await recordAuditLog({
          action: 'BRANCH_FORCE_DELETION_ABORTED',
          entityType: 'branch',
          entityId: op.branchId,
          actorId: actor.id,
          actorRole: actor.role,
          branchId: op.branchId,
          afterState: { operation_id: operationId, reason: 'stopped_by_super_admin' },
          ipAddress,
        });
      }
    }
    return currentStatus(operationId);
  },

  async listClosureItems(
    actor: Actor,
    filters: { branchId?: string; reconciled?: boolean; page: number; limit: number },
  ): Promise<BranchClosureItemList> {
    assertSuperAdmin(actor);
    const [rows, total] = await branchForceDeletionRepository.listClosureItems(filters);
    const name = (person: { firstName: string; lastName: string } | null) =>
      person ? `${person.firstName} ${person.lastName}`.trim() : null;
    return {
      items: rows.map((row) => ({
        id: row.id,
        operation_id: row.operationId,
        branch_id: row.branchId,
        branch_name: row.branch.name,
        branch_code: row.branch.code,
        kind: row.kind,
        source_table: row.sourceTable,
        source_id: row.sourceId,
        outcome: row.outcome,
        reason: row.reason,
        snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
        recorded_by_name: name(row.recorder) ?? 'Unknown',
        recorded_at: row.recordedAt.toISOString(),
        reconciled_at: row.reconciledAt?.toISOString() ?? null,
        reconciled_by_name: name(row.reconciler),
        reconciliation_note: row.reconciliationNote,
      })),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async reconcileClosureItem(
    itemId: string,
    actor: Actor,
    note: string,
    ipAddress: string | null,
  ): Promise<{ reconciled: true }> {
    assertSuperAdmin(actor);
    const outcome = await branchForceDeletionRepository.reconcile(itemId, actor.id, note);
    if (outcome === 'not_found')
      throw new BranchError('CLOSURE_ITEM_NOT_FOUND', 'Closure item not found', 404);
    if (outcome === 'already')
      throw new BranchError(
        'CLOSURE_ITEM_ALREADY_RECONCILED',
        'This item was already reconciled.',
        409,
      );
    await recordAuditLog({
      action: 'BRANCH_CLOSURE_ITEM_RECONCILED',
      entityType: 'branch_closure_item',
      entityId: itemId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { note },
      ipAddress,
    });
    return { reconciled: true };
  },
};

/**
 * Resumes fenced operations after a crash or restart, and finishes any a
 * request left behind. Durable: all state is in branch_deletion_operations.
 */
export function startForceDeletionSweeper(intervalMs = 30_000): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const { id } of await branchForceDeletionRepository.listFencedOperationIds()) {
        await branchForceDeletionService.advance(id, null);
      }
    } catch (error) {
      console.error('Force delete sweeper failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
