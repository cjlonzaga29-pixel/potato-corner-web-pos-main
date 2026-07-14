import { Prisma } from '@prisma/client';
import { ROLES } from '@potato-corner/shared';
import { cashRepository } from './cash.repository.js';
import { CashError, type ApproveVarianceData, type CloseShiftData, type OpenShiftData, type ShiftListFilters } from './cash.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

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
  transactionCount: number;
  shiftNotes: string | null;
  startedAt: Date;
  closedAt: Date | null;
  denominations?: DenominationRow[];
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
    transaction_count: shift.transactionCount,
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

/**
 * cash_sales_total/gcash_sales_total/transaction_count are only persisted
 * at close time — for a still-open shift they'd otherwise read as the
 * created-row defaults (0). Overlays a live, read-only aggregate so the
 * shift dashboard can show a running sales total without waiting for close.
 * Never persisted — closeShift always recomputes and writes its own.
 */
async function withLiveSalesTotals(shift: ShiftRow) {
  if (shift.status !== 'active') return toShiftResponse(shift);
  const sales = await cashRepository.sumTransactionsForShift(shift.id);
  return toShiftResponse({
    ...shift,
    cashSalesTotal: sales.cashSalesTotal,
    gcashSalesTotal: sales.gcashSalesTotal,
    transactionCount: sales.transactionCount,
  });
}

export const cashService = {
  async openShift(data: OpenShiftData, ipAddress: string | null) {
    const existingActive = await cashRepository.findActiveShiftByBranch(data.branchId);
    if (existingActive) {
      throw new CashError('SHIFT_ALREADY_OPEN', 'A shift is already open at this branch', 409);
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

    const shift = (await cashRepository.createShift(data)) as ShiftRow;
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

    return response;
  },

  async getCurrentShift(branchId: string) {
    const shift = (await cashRepository.findActiveShiftByBranch(branchId)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'No active shift for this branch', 404);
    return withLiveSalesTotals(shift);
  },

  async getShiftById(id: string) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    return withLiveSalesTotals(shift);
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
    if (actor.role !== ROLES.SUPER_ADMIN && shift.openedBy !== actor.id) {
      throw new CashError('SHIFT_UNAUTHORIZED_CLOSE', 'Only the supervisor who opened this shift, or a super_admin, may close it', 403);
    }

    const closingCashAmount = data.denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);
    const sales = await cashRepository.sumTransactionsForShift(id);
    const cashSalesTotal = sales.cashSalesTotal;
    const gcashSalesTotal = sales.gcashSalesTotal;
    const expectedClosingCash = new Prisma.Decimal(shift.openingCashAmount.toNumber()).plus(cashSalesTotal);
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

    const updated = (await cashRepository.closeShift(id, data, {
      closingCashAmount,
      expectedClosingCash: expectedClosingCash.toNumber(),
      cashVariance: cashVariance.toNumber(),
      cashSalesTotal: cashSalesTotal.toNumber(),
      gcashSalesTotal: gcashSalesTotal.toNumber(),
      transactionCount: sales.transactionCount,
      status,
      varianceApproved,
      closedBy: actor.id,
    })) as ShiftRow;
    const response = toShiftResponse(updated);

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

    return response;
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
};
