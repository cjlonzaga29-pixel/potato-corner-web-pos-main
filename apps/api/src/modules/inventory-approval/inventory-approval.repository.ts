import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { ImageProofType } from '@potato-corner/shared';
import type { InventoryApprovalOperation, InventoryApprovalTarget, ListApprovalFilters } from './inventory-approval.types.js';

export interface CreateApprovalRequestInput {
  id: string;
  rootRequestId: string;
  previousRequestId?: string | null;
  revisionNumber: number;
  batchId?: string | null;
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string | null;
  legacyIngredientId?: string | null;
  operation: InventoryApprovalOperation;
  enteredQuantity?: Prisma.Decimal | number | null;
  enteredUnitId?: string | null;
  totalCost?: Prisma.Decimal | number | null;
  deliveryReference?: string | null;
  quantityDelta?: Prisma.Decimal | number | null;
  countedQuantity?: Prisma.Decimal | number | null;
  quantityOnHandAtSubmission?: Prisma.Decimal | number | null;
  stockVersionAtSubmission?: number | null;
  reasonCode?: string | null;
  notes?: string | null;
  submittedByUserId: string;
}

export const inventoryApprovalRepository = {
  createMany(inputs: CreateApprovalRequestInput[], tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).inventoryApprovalRequest.createMany({
      data: inputs.map((input) => ({
        id: input.id,
        rootRequestId: input.rootRequestId,
        previousRequestId: input.previousRequestId ?? null,
        revisionNumber: input.revisionNumber,
        batchId: input.batchId ?? null,
        target: input.target,
        branchId: input.branchId,
        inventoryItemId: input.inventoryItemId ?? null,
        legacyIngredientId: input.legacyIngredientId ?? null,
        operation: input.operation,
        enteredQuantity: input.enteredQuantity ?? null,
        enteredUnitId: input.enteredUnitId ?? null,
        totalCost: input.totalCost ?? null,
        deliveryReference: input.deliveryReference ?? null,
        quantityDelta: input.quantityDelta ?? null,
        countedQuantity: input.countedQuantity ?? null,
        quantityOnHandAtSubmission: input.quantityOnHandAtSubmission ?? null,
        stockVersionAtSubmission: input.stockVersionAtSubmission ?? null,
        reasonCode: input.reasonCode ?? null,
        notes: input.notes ?? null,
        submittedByUserId: input.submittedByUserId,
      })),
    });
  },

  findById(id: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).inventoryApprovalRequest.findUnique({ where: { id } });
  },

  findRevisionChain(rootRequestId: string) {
    return prisma.inventoryApprovalRequest.findMany({ where: { rootRequestId }, orderBy: { revisionNumber: 'asc' } });
  },

  /**
   * "Current" rows for the review queue: PENDING/APPROVED are always the
   * latest revision by construction (a correction only ever starts from a
   * RETURNED row and leaves it RETURNED forever), so no dedupe is needed for
   * those two statuses. RETURNED needs one extra step — a corrected chain
   * leaves its earlier RETURNED revisions in the table too, so this excludes
   * any row that something else's previousRequestId already points at.
   */
  async listCurrent(filters: ListApprovalFilters) {
    const where: Prisma.InventoryApprovalRequestWhereInput = {
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.submittedByUserId ? { submittedByUserId: filters.submittedByUserId } : {}),
    };

    if (filters.status === 'RETURNED' || filters.status === 'CANCELLED') {
      // Same "exclude anything something else's previousRequestId already
      // points at" dedupe as RETURNED: by construction (see cancel()'s
      // hasExistingCorrection re-check under its lock) a CANCELLED row can
      // never itself have been superseded afterward, but applying the same
      // filter defensively costs nothing and keeps this branch symmetric
      // with RETURNED rather than relying on that invariant alone.
      const superseded = await prisma.inventoryApprovalRequest.findMany({
        where: { previousRequestId: { not: null } },
        select: { previousRequestId: true },
      });
      const supersededIds = superseded.map((r) => r.previousRequestId as string);
      where.id = { notIn: supersededIds };
    }

    const [requests, total] = await Promise.all([
      prisma.inventoryApprovalRequest.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.inventoryApprovalRequest.count({ where }),
    ]);
    return { requests, total };
  },

  /** Exactly-once approval mutex: only the caller that wins this row's UPDATE lock sees count === 1; a concurrent/retried/stale-revision approval sees 0 and must not apply anything. */
  async markApprovedIfPending(
    id: string,
    revisionNumber: number,
    reviewedByUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.inventoryApprovalRequest.updateMany({
      where: { id, revisionNumber, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedByUserId, reviewedAt: new Date() },
    });
    return count === 1;
  },

  setAppliedMovementId(id: string, appliedMovementId: string, tx: Prisma.TransactionClient) {
    return tx.inventoryApprovalRequest.update({ where: { id }, data: { appliedMovementId } });
  },

  /** Whether a correction has already been filed against this (RETURNED) request — see correct()'s advisory-lock guard against two concurrent corrections both succeeding. */
  async hasExistingCorrection(previousRequestId: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const existing = await tx.inventoryApprovalRequest.findFirst({ where: { previousRequestId }, select: { id: true } });
    return existing !== null;
  },

  async markReturnedIfPending(id: string, revisionNumber: number, reviewedByUserId: string, returnReason: string): Promise<boolean> {
    const { count } = await prisma.inventoryApprovalRequest.updateMany({
      where: { id, revisionNumber, status: 'PENDING' },
      data: { status: 'RETURNED', reviewedByUserId, reviewedAt: new Date(), returnReason },
    });
    return count === 1;
  },

  /**
   * Permanent cancellation (POS-PERF-P28R2). Only ever reachable from
   * PENDING or RETURNED — never APPROVED (an applied request's stock
   * mutation already committed and this never touches it) and never an
   * already-CANCELLED row (repeated cancellation must be a safe no-op, not
   * a second write). The caller (service.ts#cancel) runs this inside the
   * same advisory-locked transaction it uses to re-check hasExistingCorrection
   * for this row, so this conditional UPDATE's own WHERE guard is really
   * only the second line of defense against a concurrent approve()/
   * returnForCorrection() on this exact row — those two races are already
   * closed "for free" by Postgres serializing two UPDATEs against the same
   * row, exactly like markApprovedIfPending vs markReturnedIfPending today.
   */
  async markCancelledIfCancellable(
    id: string,
    revisionNumber: number,
    cancelledByUserId: string,
    cancelReason: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.inventoryApprovalRequest.updateMany({
      where: { id, revisionNumber, status: { in: ['PENDING', 'RETURNED'] } },
      data: { status: 'CANCELLED', cancelledByUserId, cancelledAt: new Date(), cancelReason },
    });
    return count === 1;
  },

  updateProof(id: string, proofKey: string, proofType: ImageProofType) {
    return prisma.inventoryApprovalRequest.update({ where: { id }, data: { proofKey, proofType } });
  },
};
