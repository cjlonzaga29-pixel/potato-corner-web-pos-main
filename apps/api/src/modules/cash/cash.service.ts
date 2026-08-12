import { Prisma } from '@prisma/client';
import { ROLES, SOCKET_EVENTS } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { branchShiftLockId } from '../../lib/pg-lock.js';
import { cashRepository } from './cash.repository.js';
import {
  CashError,
  type ApproveVarianceData,
  type AutoOpenShiftData,
  type CloseShiftData,
  type OpenShiftData,
  type ShiftListFilters,
  type ShiftCloseComputedCounts,
  type ReviewShiftData,
  type PendingReviewFilters,
} from './cash.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';
import { enqueueNotification } from '../../queues/notification.queue.js';
import { attendanceRepository } from '../attendance/attendance.repository.js';

type ActorContext = { id: string; role: string; branchIds?: string[] };

/**
 * Variance tolerance. The architecture doc (Part 9) states the tolerance
 * defaults to zero and is Super-Admin-configurable — there is no settings
 * model yet to back that configurability, so it lives here as the one
 * constant a future settings feature would read from instead.
 */
const DEFAULT_VARIANCE_TOLERANCE = 0;

interface DenominationRow {
  id: string;
  denomination: { toNumber(): number };
  count: number;
  totalValue: { toNumber(): number };
  countType: string;
}

interface ShiftRow {
  id: string;
  branchId: string;
  cashierId: string;
  openedBy: string;
  closedBy: string | null;
  status: string;
  openingCashAmount: { toNumber(): number };
  closingCashAmount: { toNumber(): number } | null;
  expectedClosingCash: { toNumber(): number } | null;
  cashVariance: { toNumber(): number } | null;
  varianceApproved: boolean | null;
  varianceExplanation: string | null;
  varianceApprovedBy: string | null;
  varianceApprovalReason: string | null;
  cashSalesTotal: { toNumber(): number };
  gcashSalesTotal: { toNumber(): number };
  mayaSalesTotal: { toNumber(): number };
  otherSalesTotal: { toNumber(): number };
  grossSalesTotal: { toNumber(): number };
  transactionCount: number;
  shiftNotes: string | null;
  startedAt: Date;
  closedAt: Date | null;
  denominations?: DenominationRow[];
  cashSalesCount: number;
  gcashSalesCount: number;
  mayaSalesCount: number;
  otherSalesCount: number;
  voidedCount: number;
  refundedCount: number;
  totalTransactionCount: number;
  totalDiscountAmount: { toNumber(): number };
  pwdScTransactionCount: number;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function toShiftResponse(shift: ShiftRow) {
  return {
    id: shift.id,
    branch_id: shift.branchId,
    cashier_id: shift.cashierId,
    opened_by: shift.openedBy,
    closed_by: shift.closedBy,
    status: shift.status,
    opening_cash_amount: shift.openingCashAmount.toNumber(),
    closing_cash_amount: shift.closingCashAmount?.toNumber() ?? null,
    expected_closing_cash: shift.expectedClosingCash?.toNumber() ?? null,
    cash_variance: shift.cashVariance?.toNumber() ?? null,
    variance_approved: shift.varianceApproved,
    variance_explanation: shift.varianceExplanation,
    variance_approved_by: shift.varianceApprovedBy,
    variance_approval_reason: shift.varianceApprovalReason,
    cash_sales_total: shift.cashSalesTotal.toNumber(),
    gcash_sales_total: shift.gcashSalesTotal.toNumber(),
    maya_sales_total: shift.mayaSalesTotal.toNumber(),
    other_sales_total: shift.otherSalesTotal.toNumber(),
    gross_sales_total: shift.grossSalesTotal.toNumber(),
    transaction_count: shift.transactionCount,
    cash_sales_count: shift.cashSalesCount,
    gcash_sales_count: shift.gcashSalesCount,
    maya_sales_count: shift.mayaSalesCount,
    other_sales_count: shift.otherSalesCount,
    voided_count: shift.voidedCount,
    refunded_count: shift.refundedCount,
    total_transaction_count: shift.totalTransactionCount,
    total_discount_amount: shift.totalDiscountAmount.toNumber(),
    pwd_sc_transaction_count: shift.pwdScTransactionCount,
    shift_notes: shift.shiftNotes,
    started_at: shift.startedAt.toISOString(),
    closed_at: shift.closedAt?.toISOString() ?? null,
    denominations: shift.denominations?.map((d) => ({
      id: d.id,
      denomination: d.denomination.toNumber(),
      quantity: d.count,
      subtotal: d.totalValue.toNumber(),
      phase: d.countType,
    })),
  };
}

interface ShiftReviewRow {
  id: string;
  shiftId: string;
  phase: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toShiftReviewResponse(review: ShiftReviewRow) {
  return {
    id: review.id,
    shift_id: review.shiftId,
    phase: review.phase,
    status: review.status,
    reviewed_by: review.reviewedBy,
    reviewed_at: review.reviewedAt?.toISOString() ?? null,
    notes: review.notes,
    created_at: review.createdAt.toISOString(),
    updated_at: review.updatedAt.toISOString(),
  };
}

interface EodSummary {
  cash_sales_total: number;
  gcash_sales_total: number;
  maya_sales_total: number;
  other_sales_total: number;
  gross_sales_total: number;
  total_sales: number;
  cash_sales_count: number;
  gcash_sales_count: number;
  maya_sales_count: number;
  other_sales_count: number;
  total_transaction_count: number;
  voided_count: number;
  refunded_count: number;
  total_discount_amount: number;
  pwd_sc_transaction_count: number;
  expected_cash: number;
  actual_cash: number | null;
  variance: number | null;
  variance_status: 'AUTO_APPROVED' | 'PENDING_REVIEW' | null;
}

/**
 * Builds the EOD summary object shared by POST /:shiftId/close and
 * GET /:shiftId/summary. For an OPEN (active) shift, actual_cash/variance/
 * variance_status are null — no closing count has happened yet, only
 * expected_cash can be computed live. variance_status is derived purely
 * from `status` ('flagged' -> PENDING_REVIEW, else -> AUTO_APPROVED) — see
 * the plan's "resolved ambiguities" note on why a manually-approved/
 * rejected flagged shift also reads as AUTO_APPROVED once resolved.
 *
 * expected_cash for an OPEN shift now subtracts cashRefundsProcessedDuringShift
 * (Task 209.41 Part E) — CASH refunds paid out of this shift's drawer, for
 * sales that belonged to an earlier, already-closed shift. For a
 * closed/flagged shift, expected_cash instead reads the persisted
 * expectedClosingCash column, which cash.service.closeShift already baked
 * this same subtraction into at close time — a closed shift's numbers are
 * frozen and never recomputed here (Part F).
 */
function buildEodSummary(
  shift: ShiftRow,
  counts: ShiftCloseComputedCounts,
  sales: {
    cashSalesTotal: number;
    gcashSalesTotal: number;
    mayaSalesTotal: number;
    otherSalesTotal: number;
    cashRefundsProcessedDuringShift?: number;
  },
): EodSummary {
  const isOpen = shift.status === 'active';
  const grossSalesTotal = sales.cashSalesTotal + sales.gcashSalesTotal + sales.mayaSalesTotal + sales.otherSalesTotal;
  return {
    cash_sales_total: sales.cashSalesTotal,
    gcash_sales_total: sales.gcashSalesTotal,
    maya_sales_total: sales.mayaSalesTotal,
    other_sales_total: sales.otherSalesTotal,
    gross_sales_total: grossSalesTotal,
    total_sales: grossSalesTotal,
    cash_sales_count: counts.cashSalesCount,
    gcash_sales_count: counts.gcashSalesCount,
    maya_sales_count: counts.mayaSalesCount,
    other_sales_count: counts.otherSalesCount,
    total_transaction_count: counts.totalTransactionCount,
    voided_count: counts.voidedCount,
    refunded_count: counts.refundedCount,
    total_discount_amount: counts.totalDiscountAmount,
    pwd_sc_transaction_count: counts.pwdScTransactionCount,
    expected_cash: isOpen
      ? shift.openingCashAmount.toNumber() + sales.cashSalesTotal - (sales.cashRefundsProcessedDuringShift ?? 0)
      : (shift.expectedClosingCash?.toNumber() ?? 0),
    actual_cash: isOpen ? null : (shift.closingCashAmount?.toNumber() ?? null),
    variance: isOpen ? null : (shift.cashVariance?.toNumber() ?? null),
    variance_status: isOpen ? null : shift.status === 'flagged' ? 'PENDING_REVIEW' : 'AUTO_APPROVED',
  };
}

/**
 * cash_sales_total/gcash_sales_total/transaction_count are only persisted
 * at close time — for a still-open shift they'd otherwise read as the
 * created-row defaults (0). Overlays a live, read-only aggregate so the
 * shift dashboard can show a running sales total without waiting for close.
 * Never persisted — closeShift always recomputes and writes its own.
 */
// Task 209.55A — cash_sales_count (and every other close-time-only count:
// gcash/maya/other_sales_count, voided_count, refunded_count,
// total_transaction_count, total_discount_amount, pwd_sc_transaction_count)
// used to stay at the Shift row's DB default (0) for an active shift, even
// though cashSalesTotal/etc. above were already correctly live-overlaid —
// reproduced directly against GET /api/cash/current on a QA shift with real
// completed sales: cash_sales_total=3445 but cash_sales_count=0, while the
// separate GET /:shiftId/summary endpoint (which independently calls
// sumTransactionCountsForShift, see getShiftSummary below) correctly showed
// cash_sales_count=4 for the same shift at the same instant. Every caller of
// this shift object — not just the summary endpoint — must show consistent
// live numbers while the shift is open, so the counts are now overlaid here
// too, the same way the totals already were.
async function withLiveSalesTotals(shift: ShiftRow) {
  if (shift.status !== 'active') return toShiftResponse(shift);
  const [sales, counts] = await Promise.all([
    cashRepository.sumTransactionsForShift(shift.id),
    cashRepository.sumTransactionCountsForShift(shift.id),
  ]);
  return toShiftResponse({
    ...shift,
    cashSalesTotal: sales.cashSalesTotal,
    gcashSalesTotal: sales.gcashSalesTotal,
    mayaSalesTotal: sales.mayaSalesTotal,
    otherSalesTotal: sales.otherSalesTotal,
    grossSalesTotal: sales.grossSalesTotal,
    transactionCount: sales.transactionCount,
    cashSalesCount: counts.cashSalesCount,
    gcashSalesCount: counts.gcashSalesCount,
    mayaSalesCount: counts.mayaSalesCount,
    otherSalesCount: counts.otherSalesCount,
    voidedCount: counts.voidedCount,
    refundedCount: counts.refundedCount,
    totalTransactionCount: counts.totalTransactionCount,
    totalDiscountAmount: new Prisma.Decimal(counts.totalDiscountAmount),
    pwdScTransactionCount: counts.pwdScTransactionCount,
  });
}

export const cashService = {
  async openShift(data: OpenShiftData, ipAddress: string | null) {
    const existingActive = await cashRepository.findActiveShiftByBranch(data.branchId);
    if (existingActive) {
      throw new CashError('SHIFT_ALREADY_OPEN', 'A shift is already open at this branch', 409);
    }

    // Simple Operational Audit §6 — a POS shift can't exist without the
    // cashier having timed in first. Checked against this branch
    // specifically, since a shift is branch-scoped.
    const activeAttendance = await attendanceRepository.findActiveRecord(data.cashierId);
    if (!activeAttendance || activeAttendance.branchId !== data.branchId) {
      throw new CashError('ATTENDANCE_REQUIRED', 'Time in before opening a POS shift.', 409);
    }

    const computedStartingCash = data.denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);
    if (toCents(computedStartingCash) !== toCents(data.startingCash)) {
      throw new CashError(
        'STARTING_CASH_MISMATCH',
        `starting_cash (${data.startingCash}) does not match the sum of denominations (${computedStartingCash})`,
        400,
      );
    }

    const cashier = await cashRepository.findUserById(data.cashierId);
    if (!cashier || !cashier.isActive) {
      throw new CashError('CASHIER_NOT_FOUND', 'Cashier not found or inactive', 404);
    }

    let shift: ShiftRow;
    try {
      shift = (await cashRepository.createShift(data)) as ShiftRow;
    } catch (err) {
      // Belt-and-suspenders for the race between the existingActive check
      // above and this create — two terminals opening at the same branch at
      // the same instant both pass the check, then one loses the
      // `shift_one_open_per_branch` unique index to the other. Mirrors
      // autoOpenShift's P2002 handling, but surfaces the same SHIFT_ALREADY_OPEN
      // domain error the pre-check throws rather than silently substituting
      // the race winner's shift — the loser's drawer count would otherwise be
      // discarded without the caller knowing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new CashError('SHIFT_ALREADY_OPEN', 'A shift is already open at this branch', 409);
      }
      throw err;
    }
    const response = toShiftResponse(shift);

    await recordAuditLog({
      action: 'SHIFT_OPENED',
      entityType: 'shift',
      entityId: shift.id,
      actorId: data.openedBy,
      actorRole: data.openedBy === data.cashierId ? 'cashier' : 'supervisor',
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.SHIFT_OPENED, response);
    notifySuperAdmin(SOCKET_EVENTS.SHIFT_OPENED, response);

    return response;
  },

  async getCurrentShift(branchId: string) {
    const shift = (await cashRepository.findActiveShiftByBranch(branchId)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'No active shift for this branch', 404);
    return withLiveSalesTotals(shift);
  },

  /**
   * Cashier-scoped "my current shift" — unlike getCurrentShift (branch-wide,
   * a leftover of the old one-register-at-a-time model), this is the correct
   * lookup once auto-managed shifts let several cashiers each hold their own
   * concurrent active shift at the same branch. Backs the POS Terminal guard
   * and the /branch/shift status page.
   */
  async getMyCurrentShift(cashierId: string, branchId: string) {
    const shift = (await cashRepository.findActiveShift(cashierId, branchId)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'No active shift for this cashier', 404);
    return withLiveSalesTotals(shift);
  },

  /**
   * Auto-managed shift, opened transparently on clock-in (Phase 4-9 shift
   * removal — Architecture doc change) so HoldOrder.shiftId's non-nullable
   * FK stays satisfied without a schema migration, while the cashier never
   * sees an "Open Shift" step. Idempotent: if a shift is already active at
   * this branch (under any cashier), returns it as-is rather than erroring.
   * Branch-scoped, not cashier-scoped: the DB's `shift_one_open_per_branch`
   * partial unique index (migration 20260714120000) only ever allows one
   * active shift per branch, so a per-cashier check here would P2002 the
   * moment a second cashier at the same branch tried to auto-open (Task 103).
   * The catch below is belt-and-suspenders for the remaining race between
   * the check and the create (two terminals auto-opening at the same instant).
   */
  async autoOpenShift(data: AutoOpenShiftData, ipAddress: string | null) {
    const existing = (await cashRepository.findActiveShiftByBranch(data.branchId)) as ShiftRow | null;
    if (existing) return toShiftResponse(existing);

    let shift: ShiftRow;
    try {
      shift = (await cashRepository.createAutoShift(data)) as ShiftRow;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raceWinner = (await cashRepository.findActiveShiftByBranch(data.branchId)) as ShiftRow | null;
        if (raceWinner) return toShiftResponse(raceWinner);
      }
      throw err;
    }
    const response = toShiftResponse(shift);

    await recordAuditLog({
      action: 'SHIFT_AUTO_OPENED',
      entityType: 'shift',
      entityId: shift.id,
      actorId: data.cashierId,
      actorRole: 'cashier',
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.SHIFT_OPENED, response);
    notifySuperAdmin(SOCKET_EVENTS.SHIFT_OPENED, response);

    return response;
  },

  /**
   * Closes an auto-managed shift at clock-out. No drawer count ever
   * happened, so this never computes a variance or flags for review — it
   * just freezes the same sales/count aggregates the manual close flow
   * would, then marks the shift 'closed'. A no-op (returns null) if the
   * shift is already closed or missing, since clock-out should never fail
   * because of shift bookkeeping.
   */
  async autoCloseShift(id: string, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift || shift.status !== 'active') return null;

    const [sales, counts] = await Promise.all([
      cashRepository.sumTransactionsForShift(id),
      cashRepository.sumTransactionCountsForShift(id),
    ]);

    const updated = (await cashRepository.closeAutoShift(id, {
      cashSalesTotal: sales.cashSalesTotal.toNumber(),
      gcashSalesTotal: sales.gcashSalesTotal.toNumber(),
      mayaSalesTotal: sales.mayaSalesTotal.toNumber(),
      otherSalesTotal: sales.otherSalesTotal.toNumber(),
      grossSalesTotal: sales.grossSalesTotal.toNumber(),
      transactionCount: sales.transactionCount,
      cashSalesCount: counts.cashSalesCount,
      gcashSalesCount: counts.gcashSalesCount,
      mayaSalesCount: counts.mayaSalesCount,
      otherSalesCount: counts.otherSalesCount,
      voidedCount: counts.voidedCount,
      refundedCount: counts.refundedCount,
      totalTransactionCount: counts.totalTransactionCount,
      totalDiscountAmount: counts.totalDiscountAmount,
      pwdScTransactionCount: counts.pwdScTransactionCount,
      closedBy: actor.id,
    })) as ShiftRow;
    const response = toShiftResponse(updated);

    await recordAuditLog({
      action: 'SHIFT_AUTO_CLOSED',
      entityType: 'shift',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftResponse(shift),
      afterState: response,
      ipAddress,
    });

    notifyBranch(shift.branchId, SOCKET_EVENTS.SHIFT_CLOSED, response);
    notifySuperAdmin(SOCKET_EVENTS.SHIFT_CLOSED, response);

    return response;
  },

  async getShiftById(id: string) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    return withLiveSalesTotals(shift);
  },

  async getShiftSummary(id: string) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);

    if (shift.status === 'active') {
      const [sales, counts, cashRefundsProcessedDuringShift] = await Promise.all([
        cashRepository.sumTransactionsForShift(id),
        cashRepository.sumTransactionCountsForShift(id),
        cashRepository.sumCashRefundsProcessedDuringShift({ id, branchId: shift.branchId, startedAt: shift.startedAt }, new Date()),
      ]);
      return {
        shift: toShiftResponse(shift),
        summary: buildEodSummary(shift, counts, {
          cashSalesTotal: sales.cashSalesTotal.toNumber(),
          gcashSalesTotal: sales.gcashSalesTotal.toNumber(),
          mayaSalesTotal: sales.mayaSalesTotal.toNumber(),
          otherSalesTotal: sales.otherSalesTotal.toNumber(),
          cashRefundsProcessedDuringShift: cashRefundsProcessedDuringShift.toNumber(),
        }),
      };
    }

    const counts: ShiftCloseComputedCounts = {
      cashSalesCount: shift.cashSalesCount,
      gcashSalesCount: shift.gcashSalesCount,
      mayaSalesCount: shift.mayaSalesCount,
      otherSalesCount: shift.otherSalesCount,
      voidedCount: shift.voidedCount,
      refundedCount: shift.refundedCount,
      totalTransactionCount: shift.totalTransactionCount,
      totalDiscountAmount: shift.totalDiscountAmount.toNumber(),
      pwdScTransactionCount: shift.pwdScTransactionCount,
    };
    return {
      shift: toShiftResponse(shift),
      summary: buildEodSummary(shift, counts, {
        cashSalesTotal: shift.cashSalesTotal.toNumber(),
        gcashSalesTotal: shift.gcashSalesTotal.toNumber(),
        mayaSalesTotal: shift.mayaSalesTotal.toNumber(),
        otherSalesTotal: shift.otherSalesTotal.toNumber(),
      }),
    };
  },

  async listShifts(filters: ShiftListFilters) {
    const { shifts, total } = await cashRepository.listShifts(filters);
    return {
      shifts: (shifts as ShiftRow[]).map(toShiftResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async closeShift(id: string, data: CloseShiftData, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    if (shift.status !== 'active') {
      throw new CashError('SHIFT_NOT_OPEN', 'Only an open shift can be closed', 409);
    }
    // Task 209.55B: shift.openedBy is whichever identity was on the request
    // that opened it — for a Branch Account operating through a selected
    // employee (auto-open on clock-in, see attendance.service.clockIn /
    // cash.repository.createAutoShift), that's the employee's id, never the
    // Branch Account's own session id. The branch still operationally owns
    // every shift at its own branch, so a `branch`-role actor may also close
    // any shift whose branchId is in its own JWT-scoped branchIds — a set
    // that always has exactly one entry and is never taken from client
    // input. staff/supervisor keep the unchanged strict id match.
    const isOwner = shift.openedBy === actor.id;
    const isOwningBranch = actor.role === ROLES.BRANCH && !!actor.branchIds?.includes(shift.branchId);
    if (actor.role !== ROLES.SUPER_ADMIN && !isOwner && !isOwningBranch) {
      throw new CashError(
        'SHIFT_UNAUTHORIZED_CLOSE',
        "Only the employee who opened this shift, that shift's branch account, or a super_admin, may close it",
        403,
      );
    }

    const closingCashAmount = data.denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);

    // Sales totals are read and the close is written inside the same
    // transaction (both via `tx`, never the root `prisma` client) so a sale
    // landing between the sum and the write can't leave expectedClosingCash/
    // cashVariance computed from a stale snapshot. The same transaction also
    // takes branchShiftLockId (Task 209.41 Part H) — the identical lock key
    // transactionsService.refundTransaction takes for a CASH refund — so a
    // refund can't observe this shift as active and attribute itself here
    // while this close is simultaneously freezing this shift's totals
    // without that refund's amount, or vice versa.
    // Task 209.55A — closeShift does the same class of work as checkout's
    // createTransaction $transaction (an advisory lock plus several
    // aggregate queries and writes against the same remote pooled Supabase
    // DB, see posTransactionTimeoutMsSchema's doc comment), but was left on
    // Prisma's bare 5000ms interactive-transaction default instead of this
    // codebase's already-configured POS timeout. Reproduced directly: a real
    // close under the QA environment's realistic DB latency threw
    // "Transaction already closed ... 5137 ms passed" and 500'd, even though
    // the underlying work was on track to finish (the identical retry
    // succeeded in 6602ms, still under 30s). refundTransaction/
    // voidTransaction already use these same options for the identical
    // reason — this brings closeShift in line rather than inventing a new
    // timeout value.
    const { updated, sales, counts, expectedClosingCash, cashVariance, status } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${branchShiftLockId(shift.branchId)})`;

      // Re-check status after acquiring the lock (Task 209.52A) — a second
      // concurrent closeShift for this same shift can pass the pre-lock
      // check above and then block on the lock while the first call closes
      // it; without re-reading here (through the SAME tx client) the second
      // call would proceed to double-close and double-write denomination
      // rows once the lock is released.
      const lockedShift = (await cashRepository.findShiftById(id, tx)) as ShiftRow | null;
      if (!lockedShift || lockedShift.status !== 'active') {
        throw new CashError('SHIFT_NOT_OPEN', 'Only an open shift can be closed', 409);
      }

      const [sales, counts, cashRefundsProcessedDuringShift] = await Promise.all([
        cashRepository.sumTransactionsForShift(id, tx),
        cashRepository.sumTransactionCountsForShift(id, tx),
        cashRepository.sumCashRefundsProcessedDuringShift({ id, branchId: shift.branchId, startedAt: shift.startedAt }, new Date(), tx),
      ]);
      const cashSalesTotal = sales.cashSalesTotal;
      const gcashSalesTotal = sales.gcashSalesTotal;
      const mayaSalesTotal = sales.mayaSalesTotal;
      const otherSalesTotal = sales.otherSalesTotal;
      const grossSalesTotal = sales.grossSalesTotal;
      // Task 209.41 Part E — CASH refunds paid out of this shift's drawer
      // for a sale that belonged to an earlier, already-closed shift reduce
      // what's expected in this drawer. See sumCashRefundsProcessedDuringShift
      // for why a same-shift sale+refund does NOT double-subtract here.
      const expectedClosingCash = new Prisma.Decimal(shift.openingCashAmount.toNumber())
        .plus(cashSalesTotal)
        .minus(cashRefundsProcessedDuringShift);
      const cashVariance = new Prisma.Decimal(closingCashAmount).minus(expectedClosingCash);
      const varianceCents = toCents(cashVariance.toNumber());
      const withinTolerance = Math.abs(varianceCents) <= toCents(DEFAULT_VARIANCE_TOLERANCE);

      if (!withinTolerance && !data.varianceExplanation) {
        throw new CashError(
          'VARIANCE_EXPLANATION_REQUIRED',
          'A written explanation (minimum 50 characters) is required when the cash variance is outside tolerance',
          400,
        );
      }

      const status: 'closed' | 'flagged' = withinTolerance ? 'closed' : 'flagged';
      const varianceApproved = withinTolerance ? true : null;

      const updated = (await cashRepository.closeShift(
        id,
        data,
        {
          closingCashAmount,
          expectedClosingCash: expectedClosingCash.toNumber(),
          cashVariance: cashVariance.toNumber(),
          cashSalesTotal: cashSalesTotal.toNumber(),
          gcashSalesTotal: gcashSalesTotal.toNumber(),
          mayaSalesTotal: mayaSalesTotal.toNumber(),
          otherSalesTotal: otherSalesTotal.toNumber(),
          grossSalesTotal: grossSalesTotal.toNumber(),
          transactionCount: sales.transactionCount,
          cashSalesCount: counts.cashSalesCount,
          gcashSalesCount: counts.gcashSalesCount,
          mayaSalesCount: counts.mayaSalesCount,
          otherSalesCount: counts.otherSalesCount,
          voidedCount: counts.voidedCount,
          refundedCount: counts.refundedCount,
          totalTransactionCount: counts.totalTransactionCount,
          totalDiscountAmount: counts.totalDiscountAmount,
          pwdScTransactionCount: counts.pwdScTransactionCount,
          status,
          varianceApproved,
          closedBy: actor.id,
        },
        tx,
      )) as ShiftRow;

      return { updated, sales, counts, expectedClosingCash, cashVariance, status, varianceApproved };
    }, { maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs });

    const response = toShiftResponse(updated);
    const summary = buildEodSummary(updated, counts, {
      cashSalesTotal: sales.cashSalesTotal.toNumber(),
      gcashSalesTotal: sales.gcashSalesTotal.toNumber(),
      mayaSalesTotal: sales.mayaSalesTotal.toNumber(),
      otherSalesTotal: sales.otherSalesTotal.toNumber(),
    });

    await recordAuditLog({
      action: status === 'closed' ? 'SHIFT_CLOSED' : 'SHIFT_FLAGGED_FOR_REVIEW',
      entityType: 'shift',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftResponse(shift),
      afterState: response,
      ipAddress,
    });

    const responseWithSummary = { ...response, summary };
    notifyBranch(shift.branchId, SOCKET_EVENTS.SHIFT_CLOSED, responseWithSummary);
    notifySuperAdmin(SOCKET_EVENTS.SHIFT_CLOSED, responseWithSummary);

    if (status === 'flagged') {
      const variancePayload = {
        shiftId: id,
        branchId: shift.branchId,
        expectedAmount: expectedClosingCash.toNumber(),
        actualAmount: closingCashAmount,
        variance: cashVariance.toNumber(),
        flaggedBy: actor.id,
      };
      notifyBranch(shift.branchId, SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, variancePayload);
      notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, variancePayload);
      await enqueueNotification('cash_variance_flagged', { type: 'cash_variance_flagged', ...variancePayload });
    }

    return responseWithSummary;
  },

  async approveVariance(id: string, data: ApproveVarianceData, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    if (shift.status !== 'flagged') {
      throw new CashError('SHIFT_NOT_PENDING_REVIEW', 'This shift is not pending variance review', 409);
    }

    const updated = (await cashRepository.approveVariance(id, {
      approved: data.approved,
      notes: data.notes,
      approvedBy: actor.id,
    })) as ShiftRow;
    const response = toShiftResponse(updated);

    await recordAuditLog({
      action: data.approved ? 'SHIFT_VARIANCE_APPROVED' : 'SHIFT_VARIANCE_REJECTED',
      entityType: 'shift',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftResponse(shift),
      afterState: response,
      ipAddress,
    });

    if (data.approved) {
      const approvalPayload = {
        shiftId: id,
        branchId: shift.branchId,
        approvedBy: actor.id,
        variance: updated.cashVariance?.toNumber() ?? null,
      };
      notifyBranch(shift.branchId, SOCKET_EVENTS.CASH_VARIANCE_APPROVED, approvalPayload);
      notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_APPROVED, approvalPayload);
    }

    return response;
  },

  async voidShift(id: string, reason: string | undefined, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    if (shift.status !== 'active') {
      throw new CashError('SHIFT_NOT_OPEN', 'Only an open shift can be voided', 409);
    }

    const transactionCount = await cashRepository.countAnyTransactionsForShift(id);
    if (transactionCount > 0) {
      throw new CashError('SHIFT_HAS_TRANSACTIONS', 'A shift with recorded transactions cannot be voided', 409);
    }

    const note = `VOIDED — shift had zero transactions${reason ? `: ${reason}` : ''}`;
    const updated = (await cashRepository.voidShift(id, { voidedBy: actor.id, note })) as ShiftRow;
    const response = toShiftResponse(updated);

    await recordAuditLog({
      action: 'SHIFT_VOIDED',
      entityType: 'shift',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftResponse(shift),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async getShiftReviews(shiftId: string) {
    const shift = (await cashRepository.findShiftById(shiftId)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);

    const reviews = (await cashRepository.listReviewsForShift(shiftId)) as ShiftReviewRow[];
    return reviews.map(toShiftReviewResponse);
  },

  /**
   * Approve/reject the opening or closing count for a shift — distinct from
   * approveVariance above, which only covers the cash variance itself.
   * Closing can't be reviewed before the shift has actually closed (nothing
   * to review yet); opening has no such gate, since it's reviewable as soon
   * as the shift is opened.
   */
  async reviewShift(shiftId: string, phase: 'opening' | 'closing', data: ReviewShiftData, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(shiftId)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);

    if (phase === 'closing' && shift.status === 'active') {
      throw new CashError('SHIFT_NOT_CLOSED_YET', 'Cannot review the closing count before the shift is closed', 409);
    }

    const review = (await cashRepository.findReview(shiftId, phase)) as ShiftReviewRow | null;
    if (!review) throw new CashError('SHIFT_REVIEW_NOT_FOUND', 'Review record not found for this shift and phase', 404);
    if (review.status !== 'pending') {
      throw new CashError('SHIFT_REVIEW_ALREADY_DECIDED', `This ${phase} review has already been ${review.status}`, 409);
    }

    const updated = (await cashRepository.submitReview(shiftId, phase, {
      approved: data.approved,
      notes: data.notes,
      reviewedBy: actor.id,
    })) as ShiftReviewRow;
    const response = toShiftReviewResponse(updated);

    await recordAuditLog({
      action: data.approved ? 'SHIFT_REVIEW_APPROVED' : 'SHIFT_REVIEW_REJECTED',
      entityType: 'shift_review',
      entityId: updated.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftReviewResponse(review),
      afterState: response,
      ipAddress,
    });

    const payload = { shiftId, phase, status: response.status, reviewedBy: actor.id };
    notifyBranch(shift.branchId, SOCKET_EVENTS.SHIFT_REVIEW_UPDATED, payload);
    notifySuperAdmin(SOCKET_EVENTS.SHIFT_REVIEW_UPDATED, payload);

    return response;
  },

  async listPendingReviews(filters: PendingReviewFilters) {
    const { reviews, total } = await cashRepository.listPendingReviews(filters);
    return {
      reviews: reviews.map((review) => ({
        ...toShiftReviewResponse(review as ShiftReviewRow),
        shift: {
          id: review.shift.id,
          branch_id: review.shift.branchId,
          cashier_id: review.shift.cashierId,
          status: review.shift.status,
          started_at: review.shift.startedAt.toISOString(),
          closed_at: review.shift.closedAt?.toISOString() ?? null,
        },
      })),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },
};
