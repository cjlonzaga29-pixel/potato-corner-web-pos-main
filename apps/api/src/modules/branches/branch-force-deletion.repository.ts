import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { manilaDateKey } from '../../lib/manila-time.js';
import { branchesRepository } from './branches.repository.js';

/**
 * POS-PERF-P68 — Force Delete Branch, data layer.
 *
 * A Force Delete is an orchestrated operation, not a bypass. It runs in two
 * short transactions with nothing external in between:
 *  1. **Fence** (`fence`): stamp `branches.deletion_fenced_at` and create the
 *     durable operation row. The live-branch trigger locks the branch row
 *     FOR SHARE, so this UPDATE waits for every guarded write already in
 *     flight, and every later one is refused (409 BRANCH_DELETION_IN_PROGRESS).
 *     After it commits no sale, stock movement, shift, clock-in, hold or
 *     checkout can be written for the branch, by a request or a worker.
 *  2. **Finalize** (`finalize`): under the operation's row lock, re-read the
 *     plan. Every open item must be one the Super Admin confirmed (new ones
 *     abort the operation and lift the fence). Each item then gets an
 *     explicit, audited outcome and a closure item; nothing is invented:
 *       - open shift -> status 'terminated' (no cash count, not closed);
 *       - open clock-in -> administratively terminated (no clock-out time);
 *       - in-progress checkout -> 'abandoned' once proved uncommitted;
 *       - deduction job -> 'cancelled' once proved unapplied (no movement);
 *       - projection outbox row -> 'stuck' (manual attention, no retries);
 *       - pending/returned approval -> 'CANCELLED' (existing P28R2 terminal state);
 *       - held order, stock balance, draft payroll run, unpaid hours ->
 *         recorded as they are; nothing is zeroed, transferred, finalized
 *         or written off.
 *     Then the P67 removal runs (exclusive branch accounts, configuration,
 *     the branches row). History stays on branch_records.
 * A crash between the two leaves a fenced operation that `finalize` (driven
 * by a retry, a status poll or the startup/interval sweeper) completes.
 */

export type ForceItemKind =
  | 'open_shift'
  | 'open_attendance'
  | 'pending_checkout'
  | 'held_order'
  | 'deduction_job'
  | 'projection_outbox'
  | 'inventory_approval'
  | 'stock_balance'
  | 'draft_payroll_run'
  | 'unpaid_payroll_hours';

export interface ForcePlanItem {
  kind: ForceItemKind;
  sourceTable: string;
  sourceId: string;
  /** Identity of the item as confirmed; stock includes its quantities. */
  key: string;
  snapshot: Record<string, unknown>;
}

/** What each kind ends as, and why. Shown in the dialog and stored on the closure item. */
export const FORCE_ITEM_OUTCOMES: Record<ForceItemKind, { outcome: string; reason: string }> = {
  open_shift: {
    outcome: 'shift_terminated_uncounted',
    reason:
      'Shift ended administratively by Force Delete. No closing cash was counted; it is not closed or reconciled.',
  },
  open_attendance: {
    outcome: 'attendance_terminated_no_clock_out',
    reason:
      'Clock-in ended administratively by Force Delete. No clock-out time was recorded and no work or pay time was added.',
  },
  pending_checkout: {
    outcome: 'checkout_abandoned_not_recorded',
    reason:
      'No sale was recorded on the server for this checkout. The terminal may still hold it in its offline queue.',
  },
  held_order: {
    outcome: 'held_order_removed_snapshot_kept',
    reason:
      'Held order removed with the branch. No payment was taken; its contents are kept in this record.',
  },
  deduction_job: {
    outcome: 'deduction_cancelled_not_applied',
    reason:
      'The sale stays recorded. Its stock deduction was never applied and is cancelled; the stock record below is before it.',
  },
  projection_outbox: {
    outcome: 'projection_left_stuck',
    reason:
      'Stock movement stays recorded. Its read-model projection was not applied and is left stuck for manual review.',
  },
  inventory_approval: {
    outcome: 'approval_cancelled_unreviewed',
    reason: 'Stock approval request cancelled without review. No stock change was applied.',
  },
  stock_balance: {
    outcome: 'stock_unresolved',
    reason:
      'Stock on hand or reserved at deletion. It was not counted, transferred or written off.',
  },
  draft_payroll_run: {
    outcome: 'payroll_draft_retained_unfinalized',
    reason:
      'Draft payroll run kept as a draft. It was not finalized and can no longer be edited in the app.',
  },
  unpaid_payroll_hours: {
    outcome: 'hours_not_in_finalized_payroll',
    reason: 'Worked hours that no finalized payroll run covers. Settle them outside the app.',
  },
};

const json = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export function planHash(keys: readonly string[]): string {
  return createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex');
}

type Client = Prisma.TransactionClient | typeof prisma;

export const branchForceDeletionRepository = {
  /** Every open item a Force Delete would resolve, with exact ids. History is never listed. */
  async findPlan(branchId: string, client: Client = prisma): Promise<ForcePlanItem[]> {
    const [shifts, attendance, checkouts, holds, jobs, outbox, approvals, stock, drafts, unpaid] =
      await Promise.all([
        client.shift.findMany({
          where: { branchId, status: 'active' },
          select: {
            id: true,
            cashierId: true,
            startedAt: true,
            openingCashAmount: true,
            cashSalesTotal: true,
            grossSalesTotal: true,
            transactionCount: true,
          },
        }),
        client.attendanceRecord.findMany({
          where: {
            branchId,
            clockOutServerTime: null,
            deletedAt: null,
            administrativelyTerminatedAt: null,
          },
          select: { id: true, employeeId: true, clockInServerTime: true },
        }),
        client.checkoutAttempt.findMany({
          where: { branchId, status: 'in_progress' },
          select: {
            idempotencyKey: true,
            cashierId: true,
            createdAt: true,
            leaseExpiresAt: true,
            transactionId: true,
          },
        }),
        client.holdOrder.findMany({
          where: { branchId, status: 'held' },
          include: { items: true },
        }),
        client.inventoryDeductionJob.findMany({
          where: { branchId, status: { in: ['pending', 'processing', 'failed'] } },
          select: {
            id: true,
            transactionId: true,
            status: true,
            attempts: true,
            lastError: true,
            createdAt: true,
          },
        }),
        client.inventoryProjectionOutbox.findMany({
          where: {
            status: { in: ['pending', 'processing', 'deferred', 'stuck'] },
            movement: { branchId },
          },
          select: { id: true, movementId: true, status: true, attempts: true, lastError: true },
        }),
        client.inventoryApprovalRequest.findMany({
          where: { branchId, status: { in: ['PENDING', 'RETURNED'] } },
          select: { id: true, status: true, submittedByUserId: true, createdAt: true },
        }),
        client.inventoryStock.findMany({
          where: {
            branchId,
            OR: [{ quantityOnHand: { not: 0 } }, { quantityReserved: { not: 0 } }],
          },
          select: {
            id: true,
            inventoryItemId: true,
            quantityOnHand: true,
            quantityReserved: true,
            inventoryItem: { select: { name: true } },
          },
        }),
        client.payrollRun.findMany({
          where: { branchId, status: 'draft' },
          select: { id: true, periodStart: true, periodEnd: true, createdAt: true },
        }),
        branchForceDeletionRepository.findUnpaidPayrollAttendance(branchId, client),
      ]);
    const items: ForcePlanItem[] = [];
    const add = (
      kind: ForceItemKind,
      sourceTable: string,
      sourceId: string,
      snapshot: unknown,
      keySuffix = '',
    ) =>
      items.push({
        kind,
        sourceTable,
        sourceId,
        key: `${kind}:${sourceId}${keySuffix}`,
        snapshot: json(snapshot),
      });
    for (const row of shifts) add('open_shift', 'shifts', row.id, row);
    for (const row of attendance) add('open_attendance', 'attendance_records', row.id, row);
    for (const row of checkouts)
      add('pending_checkout', 'checkout_attempts', row.idempotencyKey, row);
    for (const row of holds) add('held_order', 'hold_orders', row.id, row);
    for (const row of jobs) add('deduction_job', 'inventory_deduction_jobs', row.id, row);
    for (const row of outbox) add('projection_outbox', 'inventory_projection_outbox', row.id, row);
    for (const row of approvals)
      add('inventory_approval', 'inventory_approval_requests', row.id, row);
    for (const row of stock) {
      add(
        'stock_balance',
        'inventory_stocks',
        row.id,
        { ...row, itemName: row.inventoryItem.name, inventoryItem: undefined },
        `:${row.quantityOnHand.toString()}:${row.quantityReserved.toString()}`,
      );
    }
    for (const row of drafts) add('draft_payroll_run', 'payroll_runs', row.id, row);
    for (const row of unpaid) add('unpaid_payroll_hours', 'attendance_records', row.id, row);
    return items;
  },

  /** The P66/P67 unpaid-hours rule, returning the exact attendance rows. */
  async findUnpaidPayrollAttendance(branchId: string, client: Client = prisma) {
    const count = await branchesRepository.countUnpaidPayrollAttendance(branchId, client);
    if (count === 0) return [];
    const firstPolicy = await client.payrollPolicy.findFirst({
      where: { branchId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!firstPolicy) return [];
    const [records, runs] = await Promise.all([
      client.attendanceRecord.findMany({
        where: {
          branchId,
          deletedAt: null,
          clockOutServerTime: { not: null },
          clockInServerTime: { gte: firstPolicy.createdAt },
        },
        select: {
          id: true,
          employeeId: true,
          clockInServerTime: true,
          clockOutServerTime: true,
          actualWorkMinutes: true,
        },
      }),
      client.payrollRun.findMany({
        where: { branchId, status: 'finalized' },
        select: { periodStart: true, periodEnd: true },
      }),
    ]);
    const isoDate = (value: Date) => value.toISOString().slice(0, 10);
    return records.filter((record) => {
      const day = manilaDateKey(record.clockInServerTime);
      return !runs.some((run) => isoDate(run.periodStart) <= day && day <= isoDate(run.periodEnd));
    });
  },

  findOperation(operationId: string) {
    return prisma.branchDeletionOperation.findUnique({ where: { id: operationId } });
  },

  findFencedOperationForBranch(branchId: string) {
    return prisma.branchDeletionOperation.findFirst({ where: { branchId, status: 'fenced' } });
  },

  listFencedOperationIds() {
    return prisma.branchDeletionOperation.findMany({
      where: { status: 'fenced' },
      select: { id: true },
    });
  },

  countClosureItems(operationId: string) {
    return prisma.branchClosureItem.count({ where: { operationId } });
  },

  /**
   * Transaction 1. Version-bound: a branch edited since the plan was shown
   * is not fenced ('changed'). The UPDATE waits for in-flight guarded writes.
   */
  async fence(params: {
    operationId: string;
    branchId: string;
    actorId: string;
    expectedVersion: Date;
    planKeys: string[];
    planHashValue: string;
  }): Promise<'fenced' | 'changed' | 'in_progress'> {
    return prisma.$transaction(
      async (tx) => {
        const fenced = await tx.branch.updateMany({
          where: { id: params.branchId, updatedAt: params.expectedVersion, deletionFencedAt: null },
          data: { deletionFencedAt: new Date(), deletionOperationId: params.operationId },
        });
        if (fenced.count === 0) {
          const branch = await tx.branch.findUnique({
            where: { id: params.branchId },
            select: { deletionFencedAt: true },
          });
          return branch?.deletionFencedAt ? ('in_progress' as const) : ('changed' as const);
        }
        await tx.branchDeletionOperation.create({
          data: {
            id: params.operationId,
            branchId: params.branchId,
            mode: 'force',
            status: 'fenced',
            actorId: params.actorId,
            plan: params.planKeys,
            planHash: params.planHashValue,
            step: 'fenced',
          },
        });
        return 'fenced' as const;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  },

  /** Lifts the fence and ends the operation as aborted. Used when the plan grew, or on an explicit abort. */
  async abort(operationId: string, reason: string, tx: Prisma.TransactionClient): Promise<void> {
    const op = await tx.branchDeletionOperation.findUnique({
      where: { id: operationId },
      select: { branchId: true },
    });
    if (!op) return;
    await tx.branch.updateMany({
      where: { id: op.branchId, deletionOperationId: operationId },
      data: { deletionFencedAt: null, deletionOperationId: null },
    });
    await tx.branchDeletionOperation.update({
      where: { id: operationId },
      data: { status: 'aborted', step: 'aborted', abortReason: reason },
    });
  },

  async recordError(operationId: string, message: string): Promise<void> {
    await prisma.branchDeletionOperation.updateMany({
      where: { id: operationId, status: 'fenced' },
      data: { lastError: message.slice(0, 500), step: 'retry_pending' },
    });
  },

  /**
   * Transaction 2. Returns the outcome; 'aborted' and 'completed' commit,
   * an inconsistency throws ForceDeletionInconsistent so the caller can
   * record it while the fence stays (recoverable, never reported complete).
   */
  async finalize(
    operationId: string,
  ): Promise<
    | { outcome: 'not_fenced'; status: string }
    | { outcome: 'aborted'; reason: string; unexpected: string[] }
    | {
        outcome: 'completed';
        branchId: string;
        actorId: string;
        branchAccountIds: string[];
        removed: Record<string, number>;
        items: ForcePlanItem[];
      }
  > {
    return prisma.$transaction(
      async (tx) => {
        // Row lock on the operation: concurrent drivers (retry, poll, sweeper) serialize here.
        const claimed = await tx.branchDeletionOperation.updateMany({
          where: { id: operationId, status: 'fenced' },
          data: { step: 'finalizing' },
        });
        const op = await tx.branchDeletionOperation.findUnique({ where: { id: operationId } });
        if (!op) throw new ForceDeletionInconsistent('Operation not found');
        if (claimed.count === 0) return { outcome: 'not_fenced' as const, status: op.status };

        const branch = await tx.branch.findUnique({
          where: { id: op.branchId },
          select: { deletionOperationId: true },
        });
        if (!branch || branch.deletionOperationId !== operationId) {
          throw new ForceDeletionInconsistent(
            'The branch is missing or is not fenced by this operation',
          );
        }

        const confirmed = new Set(Array.isArray(op.plan) ? (op.plan as string[]) : []);
        const items = await branchForceDeletionRepository.findPlan(op.branchId, tx);
        const unexpected = items.filter((item) => !confirmed.has(item.key)).map((item) => item.key);
        if (unexpected.length > 0) {
          const reason = `Open work changed after confirmation (${unexpected.length} new or changed item(s)). Nothing was deleted; review the branch and confirm again.`;
          await branchForceDeletionRepository.abort(operationId, reason, tx);
          return { outcome: 'aborted' as const, reason, unexpected };
        }

        const now = new Date();
        const actorId = op.actorId;
        for (const item of items) {
          await resolveItem(tx, item, { operationId, actorId, now });
          const { outcome, reason } = FORCE_ITEM_OUTCOMES[item.kind];
          await tx.branchClosureItem.create({
            data: {
              operationId,
              branchId: op.branchId,
              kind: item.kind,
              sourceTable: item.sourceTable,
              sourceId: item.sourceId,
              outcome,
              reason,
              snapshot: item.snapshot as Prisma.InputJsonValue,
              recordedBy: actorId,
              recordedAt: now,
            },
          });
        }

        const { branchAccountIds, removed } = await branchesRepository.removeOperationalBranch(
          op.branchId,
          actorId,
          tx,
        );
        await tx.branchDeletionOperation.update({
          where: { id: operationId },
          data: { status: 'completed', step: 'completed', completedAt: now, lastError: null },
        });
        return {
          outcome: 'completed' as const,
          branchId: op.branchId,
          actorId,
          branchAccountIds,
          removed,
          items,
        };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  },

  listClosureItems(filters: {
    branchId?: string;
    reconciled?: boolean;
    page: number;
    limit: number;
  }) {
    const where: Prisma.BranchClosureItemWhereInput = {
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(filters.reconciled !== undefined && {
        reconciledAt: filters.reconciled ? { not: null } : null,
      }),
    };
    return prisma.$transaction([
      prisma.branchClosureItem.findMany({
        where,
        orderBy: [{ recordedAt: 'desc' }, { kind: 'asc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        include: {
          branch: { select: { name: true, code: true, deletedAt: true } },
          recorder: { select: { firstName: true, lastName: true } },
          reconciler: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.branchClosureItem.count({ where }),
    ]);
  },

  /** Sets the reconciliation fields once. The trigger refuses any other change. */
  async reconcile(
    itemId: string,
    actorId: string,
    note: string,
  ): Promise<'reconciled' | 'already' | 'not_found'> {
    const updated = await prisma.branchClosureItem.updateMany({
      where: { id: itemId, reconciledAt: null },
      data: { reconciledAt: new Date(), reconciledBy: actorId, reconciliationNote: note },
    });
    if (updated.count === 1) return 'reconciled';
    const exists = await prisma.branchClosureItem.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    return exists ? 'already' : 'not_found';
  },
};

/** One item's explicit outcome. Every write is a compare-and-swap on the state the plan saw. */
async function resolveItem(
  tx: Prisma.TransactionClient,
  item: ForcePlanItem,
  ctx: { operationId: string; actorId: string; now: Date },
): Promise<void> {
  const expectOne = (count: number) => {
    if (count !== 1)
      throw new ForceDeletionInconsistent(
        `${item.kind} ${item.sourceId} changed while it was being resolved`,
      );
  };
  switch (item.kind) {
    case 'open_shift':
      expectOne(
        (
          await tx.shift.updateMany({
            where: { id: item.sourceId, status: 'active' },
            data: {
              status: 'terminated',
              terminatedAt: ctx.now,
              terminationOperationId: ctx.operationId,
            },
          })
        ).count,
      );
      return;
    case 'open_attendance':
      expectOne(
        (
          await tx.attendanceRecord.updateMany({
            where: {
              id: item.sourceId,
              clockOutServerTime: null,
              administrativelyTerminatedAt: null,
            },
            data: {
              administrativelyTerminatedAt: ctx.now,
              terminationOperationId: ctx.operationId,
            },
          })
        ).count,
      );
      return;
    case 'pending_checkout': {
      // Proof it never committed: no linked sale. After the fence no sale
      // can be inserted for this branch, so the outcome is final.
      const attempt = await tx.checkoutAttempt.findUnique({
        where: { idempotencyKey: item.sourceId },
        select: { transactionId: true },
      });
      if (attempt?.transactionId)
        throw new ForceDeletionInconsistent(
          `Checkout ${item.sourceId} is linked to a recorded sale but still in progress`,
        );
      expectOne(
        (
          await tx.checkoutAttempt.updateMany({
            where: { idempotencyKey: item.sourceId, status: 'in_progress' },
            data: { status: 'abandoned' },
          })
        ).count,
      );
      return;
    }
    case 'deduction_job': {
      // Proof it was never applied: no stock movement references its sale.
      const transactionId = String(item.snapshot.transactionId);
      const applied = await tx.inventoryStockMovement.count({
        where: { referenceType: 'transaction', referenceId: transactionId },
      });
      if (applied > 0) {
        throw new ForceDeletionInconsistent(
          `Deduction job ${item.sourceId} has stock movements for its sale but is not completed; reconcile it first`,
        );
      }
      // Clearing claimToken makes a worker's later compare-and-swap fail;
      // the fence already refuses its stock writes.
      expectOne(
        (
          await tx.inventoryDeductionJob.updateMany({
            where: { id: item.sourceId, status: { in: ['pending', 'processing', 'failed'] } },
            data: {
              status: 'cancelled',
              claimToken: null,
              lockedAt: null,
              lastError: 'POS-PERF-P68 Force Delete: not applied',
            },
          })
        ).count,
      );
      return;
    }
    case 'projection_outbox':
      expectOne(
        (
          await tx.inventoryProjectionOutbox.updateMany({
            where: {
              id: item.sourceId,
              status: { in: ['pending', 'processing', 'deferred', 'stuck'] },
            },
            data: {
              status: 'stuck',
              claimToken: null,
              lockedAt: null,
              lastError: 'POS-PERF-P68 Force Delete: branch deleted',
            },
          })
        ).count,
      );
      return;
    case 'inventory_approval':
      expectOne(
        (
          await tx.inventoryApprovalRequest.updateMany({
            where: { id: item.sourceId, status: { in: ['PENDING', 'RETURNED'] } },
            data: {
              status: 'CANCELLED',
              cancelledAt: ctx.now,
              cancelledByUserId: ctx.actorId,
              cancelReason: 'Branch force-deleted (POS-PERF-P68)',
            },
          })
        ).count,
      );
      return;
    // Recorded as they are; removed with the branch (held orders, stock rows)
    // or kept untouched in history (draft runs, attendance).
    case 'held_order':
    case 'stock_balance':
    case 'draft_payroll_run':
    case 'unpaid_payroll_hours':
      return;
  }
}

export class ForceDeletionInconsistent extends Error {}
