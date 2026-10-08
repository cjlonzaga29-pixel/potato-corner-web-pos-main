import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { MOVEMENT_TYPE, ROLES, SOCKET_EVENTS, type JwtPayload } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { hashToLockId } from '../../lib/pg-lock.js';
import { sha256Hex } from '../../lib/hash.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifyBranch, notifySuperAdmin, notifyUser } from '../../lib/notify.js';
import { hasBranchAccess, getAccessibleBranchIds } from '../../lib/branch-access.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { convertQuantity } from '../product-components/unit-conversion.util.js';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';
import {
  applyAdjustmentInTx,
  applyPhysicalCountLineInTx,
  applyReceivingInTx,
  notifyIfLowStock as notifyUniversalIfLowStock,
  getSignedInventoryProofUrl,
  uploadInventoryProofImage,
} from '../universal-inventory/universal-inventory.service.js';
import { UniversalInventoryError } from '../universal-inventory/universal-inventory.types.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { notifyIfLowStock as notifyLegacyIfLowStock } from '../inventory/inventory.service.js';
import { IngredientError } from '../inventory/inventory.types.js';
import { inventoryApprovalRepository } from './inventory-approval.repository.js';
import { InventoryApprovalError } from './inventory-approval.types.js';
import type {
  CorrectRequestData,
  InventoryApprovalOperation,
  InventoryApprovalTarget,
  ListApprovalFilters,
  SubmitAdjustmentData,
  SubmitPhysicalCountData,
  SubmitReceivingData,
} from './inventory-approval.types.js';

const INVENTORY_PROOF_BUCKET_PREFIX = 'approval-requests';

/** A request row as stored — kept loose (matches the model's own loose-reference convention) rather than importing the generated Prisma type everywhere. */
type RequestRow = Awaited<ReturnType<typeof inventoryApprovalRepository.findById>> extends infer T ? NonNullable<T> : never;

async function assertBranchAccessOrThrow(actor: JwtPayload, branchId: string): Promise<void> {
  if (!(await hasBranchAccess(actor, branchId))) {
    throw new InventoryApprovalError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
  }
}

async function findRequestOrThrow(id: string): Promise<RequestRow> {
  const request = await inventoryApprovalRepository.findById(id);
  if (!request) throw new InventoryApprovalError('REQUEST_NOT_FOUND', 'Approval request not found', 404);
  return request;
}

async function resolveItemLabel(target: InventoryApprovalTarget, inventoryItemId: string | null, legacyIngredientId: string | null) {
  if (target === 'UNIVERSAL_ITEM' && inventoryItemId) {
    const item = await universalInventoryRepository.findItemById(inventoryItemId);
    return { name: item?.name ?? null, unitCode: item?.baseUnit.code ?? null, baseUnitId: item?.baseUnitId ?? null };
  }
  if (target === 'LEGACY_INGREDIENT' && legacyIngredientId) {
    const ingredient = await inventoryRepository.findIngredientById(legacyIngredientId);
    return { name: ingredient?.name ?? null, unitCode: ingredient?.unit ?? null, baseUnitId: null };
  }
  return { name: null, unitCode: null, baseUnitId: null };
}

async function toResponse(request: RequestRow) {
  const [branch, item, users, proofUrl] = await Promise.all([
    branchesRepository.findById(request.branchId),
    resolveItemLabel(request.target as InventoryApprovalTarget, request.inventoryItemId, request.legacyIngredientId),
    universalInventoryRepository.findUsersByIds(
      [request.submittedByUserId, request.reviewedByUserId].filter((id): id is string => id !== null),
    ),
    request.proofKey ? getSignedInventoryProofUrl(request.proofKey) : Promise.resolve(null),
  ]);
  const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

  return {
    id: request.id,
    root_request_id: request.rootRequestId,
    previous_request_id: request.previousRequestId,
    revision_number: request.revisionNumber,
    batch_id: request.batchId,

    target: request.target,
    branch_id: request.branchId,
    branch_name: branch?.name ?? null,
    inventory_item_id: request.inventoryItemId,
    legacy_ingredient_id: request.legacyIngredientId,
    item_name: item.name,
    item_unit_code: item.unitCode,
    operation: request.operation,

    entered_quantity: request.enteredQuantity?.toNumber() ?? null,
    entered_unit_id: request.enteredUnitId,
    total_cost: request.totalCost?.toNumber() ?? null,
    delivery_reference: request.deliveryReference,
    quantity_delta: request.quantityDelta?.toNumber() ?? null,
    counted_quantity: request.countedQuantity?.toNumber() ?? null,
    quantity_on_hand_at_submission: request.quantityOnHandAtSubmission?.toNumber() ?? null,

    reason_code: request.reasonCode,
    notes: request.notes,
    proof_url: proofUrl,

    status: request.status,
    submitted_by_user_id: request.submittedByUserId,
    submitted_by_name: nameById.get(request.submittedByUserId) ?? null,
    submitted_at: request.submittedAt.toISOString(),
    reviewed_by_user_id: request.reviewedByUserId,
    reviewed_by_name: request.reviewedByUserId ? nameById.get(request.reviewedByUserId) ?? null : null,
    reviewed_at: request.reviewedAt?.toISOString() ?? null,
    return_reason: request.returnReason,
    applied_movement_id: request.appliedMovementId,
  };
}

/** Pre-submission snapshot used to detect a stale physical count at approval time — read-only, outside any lock (the lock is re-taken, and the comparison re-checked, inside the approval transaction). */
async function snapshotForPhysicalCount(target: InventoryApprovalTarget, branchId: string, inventoryItemId?: string, legacyIngredientId?: string) {
  if (target === 'UNIVERSAL_ITEM' && inventoryItemId) {
    const stock = await universalInventoryRepository.findStock(branchId, inventoryItemId);
    if (!stock) throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for this branch/item', 404);
    return { quantityOnHand: stock.quantityOnHand.toNumber(), stockVersion: stock.version };
  }
  if (target === 'LEGACY_INGREDIENT' && legacyIngredientId) {
    const [quantityOnHand, movementCount] = await Promise.all([
      inventoryRepository.getCurrentStock(legacyIngredientId),
      inventoryRepository.countMovements(legacyIngredientId),
    ]);
    return { quantityOnHand: quantityOnHand.toNumber(), stockVersion: movementCount };
  }
  throw new InventoryApprovalError('INVALID_TARGET', 'inventory_item_id or legacy_ingredient_id is required', 422);
}

export const inventoryApprovalService = {
  async submitReceiving(data: SubmitReceivingData, actor: JwtPayload) {
    const id = randomUUID();
    await inventoryApprovalRepository.createMany([
      {
        id,
        rootRequestId: id,
        revisionNumber: 1,
        target: data.target,
        branchId: data.branchId,
        inventoryItemId: data.inventoryItemId ?? null,
        legacyIngredientId: data.legacyIngredientId ?? null,
        operation: 'RECEIVING',
        enteredQuantity: data.enteredQuantity,
        enteredUnitId: data.enteredUnitId ?? null,
        totalCost: data.totalCost ?? null,
        deliveryReference: data.deliveryReference ?? null,
        submittedByUserId: actor.user_id,
        notes: data.notes ?? null,
      },
    ]);
    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_SUBMITTED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: { operation: 'RECEIVING', target: data.target },
      ipAddress: null,
    });
    notifySupervisorsPendingReview(data.branchId);
    return toResponse(await findRequestOrThrow(id));
  },

  async submitAdjustment(data: SubmitAdjustmentData, actor: JwtPayload) {
    const id = randomUUID();
    await inventoryApprovalRepository.createMany([
      {
        id,
        rootRequestId: id,
        revisionNumber: 1,
        target: data.target,
        branchId: data.branchId,
        inventoryItemId: data.inventoryItemId ?? null,
        legacyIngredientId: data.legacyIngredientId ?? null,
        operation: 'ADJUSTMENT',
        quantityDelta: data.quantityDelta,
        reasonCode: data.reasonCode,
        notes: data.notes ?? null,
        submittedByUserId: actor.user_id,
      },
    ]);
    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_SUBMITTED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: { operation: 'ADJUSTMENT', target: data.target },
      ipAddress: null,
    });
    notifySupervisorsPendingReview(data.branchId);
    return toResponse(await findRequestOrThrow(id));
  },

  async submitPhysicalCount(data: SubmitPhysicalCountData, actor: JwtPayload) {
    const batchId = randomUUID();
    const rows = [];
    for (const count of data.counts) {
      const snapshot = await snapshotForPhysicalCount(data.target, data.branchId, count.inventoryItemId, count.legacyIngredientId);
      const id = randomUUID();
      rows.push({
        id,
        rootRequestId: id,
        revisionNumber: 1,
        batchId,
        target: data.target,
        branchId: data.branchId,
        inventoryItemId: count.inventoryItemId ?? null,
        legacyIngredientId: count.legacyIngredientId ?? null,
        operation: 'PHYSICAL_COUNT' as InventoryApprovalOperation,
        countedQuantity: count.countedQuantity,
        quantityOnHandAtSubmission: snapshot.quantityOnHand,
        stockVersionAtSubmission: snapshot.stockVersion,
        notes: data.notes ?? null,
        submittedByUserId: actor.user_id,
      });
    }
    await inventoryApprovalRepository.createMany(rows);
    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_SUBMITTED',
      entityType: 'inventory_approval_request',
      entityId: batchId,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: { operation: 'PHYSICAL_COUNT', target: data.target, count: rows.length },
      ipAddress: null,
    });
    notifySupervisorsPendingReview(data.branchId);
    const created = await Promise.all(rows.map((row) => findRequestOrThrow(row.id)));
    return Promise.all(created.map(toResponse));
  },

  async listRequests(actor: JwtPayload, filters: { branchId?: string; status?: 'PENDING' | 'APPROVED' | 'RETURNED'; page: number; limit: number }) {
    const isSubmitterOnly = actor.role === ROLES.BRANCH || actor.role === ROLES.STAFF;
    let branchIds: string[] | 'all' = await getAccessibleBranchIds(actor);
    if (filters.branchId) {
      if (branchIds !== 'all' && !branchIds.includes(filters.branchId)) {
        throw new InventoryApprovalError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
      }
      branchIds = [filters.branchId];
    }

    const requests: RequestRow[] = [];
    let total = 0;
    const scopedBranchIds = branchIds === 'all' ? [undefined] : branchIds;
    for (const branchId of scopedBranchIds) {
      const listFilters: ListApprovalFilters = {
        branchId,
        status: filters.status,
        submittedByUserId: isSubmitterOnly ? actor.user_id : undefined,
        page: filters.page,
        limit: filters.limit,
      };
      const page = await inventoryApprovalRepository.listCurrent(listFilters);
      requests.push(...(page.requests as RequestRow[]));
      total += page.total;
    }
    requests.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
    const page = requests.slice(0, filters.limit);

    return { requests: await Promise.all(page.map(toResponse)), total, page: filters.page, limit: filters.limit };
  },

  async getRequestDetail(id: string, actor: JwtPayload) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    const chain = await inventoryApprovalRepository.findRevisionChain(request.rootRequestId);
    const [detail, revisions] = await Promise.all([toResponse(request), Promise.all((chain as RequestRow[]).map(toResponse))]);
    return { ...detail, revisions };
  },

  async approve(id: string, actor: JwtPayload, ipAddress: string | null) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.submittedByUserId === actor.user_id) {
      throw new InventoryApprovalError('SELF_APPROVAL_DENIED', 'You cannot approve a request you submitted yourself', 403);
    }
    if (request.status !== 'PENDING') {
      throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);
    }

    const movement = await prisma.$transaction(async (tx) => {
      const ok = await inventoryApprovalRepository.markApprovedIfPending(id, request.revisionNumber, actor.user_id, tx);
      if (!ok) throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);

      const applied = await applyApprovedRequest(request, tx);
      await inventoryApprovalRepository.setAppliedMovementId(id, applied.movementId, tx);
      return applied;
    });

    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_APPROVED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      afterState: { movementId: movement.movementId },
      ipAddress,
    });
    notifyBranch(request.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { requestId: id, movementId: movement.movementId });
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { requestId: id, movementId: movement.movementId });
    notifyUser(request.submittedByUserId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { requestId: id, status: 'APPROVED' });
    if (movement.lowStock) await movement.lowStock();

    return toResponse(await findRequestOrThrow(id));
  },

  async returnForCorrection(id: string, reason: string, actor: JwtPayload) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.submittedByUserId === actor.user_id) {
      throw new InventoryApprovalError('SELF_APPROVAL_DENIED', 'You cannot review a request you submitted yourself', 403);
    }
    if (request.status !== 'PENDING') {
      throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);
    }
    const ok = await inventoryApprovalRepository.markReturnedIfPending(id, request.revisionNumber, actor.user_id, reason);
    if (!ok) throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);

    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_RETURNED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      afterState: { reason },
      ipAddress: null,
    });
    notifyUser(request.submittedByUserId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { requestId: id, status: 'RETURNED', reason });

    return toResponse(await findRequestOrThrow(id));
  },

  async correct(id: string, data: CorrectRequestData, actor: JwtPayload) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.status !== 'RETURNED') {
      throw new InventoryApprovalError('NOT_RETURNED', 'Only a returned request can be corrected', 409);
    }

    // PHYSICAL_COUNT's fresh staleness snapshot does its own read (and, via
    // applyApprovedRequest's advisory lock at approval time, its own
    // concurrency protection) — taken outside the lock below so the lock
    // isn't held across it.
    let physicalCountSnapshot: { quantityOnHand: number; stockVersion: number } | null = null;
    if (request.operation === 'PHYSICAL_COUNT') {
      physicalCountSnapshot = await snapshotForPhysicalCount(
        request.target as InventoryApprovalTarget,
        request.branchId,
        request.inventoryItemId ?? undefined,
        request.legacyIngredientId ?? undefined,
      );
    }

    const newId = randomUUID();
    const row: Parameters<typeof inventoryApprovalRepository.createMany>[0][0] = {
      id: newId,
      rootRequestId: request.rootRequestId,
      previousRequestId: request.id,
      revisionNumber: request.revisionNumber + 1,
      batchId: request.batchId,
      target: request.target as InventoryApprovalTarget,
      branchId: request.branchId,
      inventoryItemId: request.inventoryItemId,
      legacyIngredientId: request.legacyIngredientId,
      operation: request.operation as InventoryApprovalOperation,
      enteredQuantity: data.enteredQuantity ?? request.enteredQuantity ?? undefined,
      enteredUnitId: data.enteredUnitId ?? request.enteredUnitId,
      totalCost: data.totalCost ?? request.totalCost ?? undefined,
      deliveryReference: data.deliveryReference ?? request.deliveryReference,
      quantityDelta: data.quantityDelta ?? request.quantityDelta ?? undefined,
      countedQuantity: data.countedQuantity ?? request.countedQuantity ?? undefined,
      reasonCode: data.reasonCode ?? request.reasonCode,
      notes: data.notes ?? request.notes,
      submittedByUserId: actor.user_id,
      quantityOnHandAtSubmission: physicalCountSnapshot?.quantityOnHand,
      stockVersionAtSubmission: physicalCountSnapshot?.stockVersion,
    };

    // Two concurrent corrections of the same RETURNED request (double-click,
    // retried request) would otherwise both pass the status check above and
    // both insert a sibling PENDING revision — two independently-approvable
    // rows pointing at the same previousRequestId, which could both get
    // approved and apply the correction twice. The advisory lock plus a
    // re-check for an existing sibling (both inside the same transaction
    // that inserts the new row) close that window: the loser sees a
    // sibling already there and aborts before inserting its own.
    await prisma.$transaction(async (tx) => {
      const lockId = hashToLockId(sha256Hex(`inventory-approval-correct:${request.id}`));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      if (await inventoryApprovalRepository.hasExistingCorrection(request.id, tx)) {
        throw new InventoryApprovalError('ALREADY_CORRECTED', 'This request has already been corrected', 409);
      }
      await inventoryApprovalRepository.createMany([row], tx);
    });
    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_CORRECTED',
      entityType: 'inventory_approval_request',
      entityId: newId,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      afterState: { previousRequestId: request.id, revisionNumber: row.revisionNumber },
      ipAddress: null,
    });
    notifySupervisorsPendingReview(request.branchId);

    return toResponse(await findRequestOrThrow(newId));
  },

  async attachProof(id: string, file: { buffer: Buffer; originalname: string }, actor: JwtPayload) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.status !== 'PENDING') {
      throw new InventoryApprovalError('NOT_PENDING', 'Proof can only be attached to a pending request', 409);
    }
    const proofKey = await uploadInventoryProofImage(`${INVENTORY_PROOF_BUCKET_PREFIX}/${id}`, file, request.proofKey);
    const updated = await inventoryApprovalRepository.updateProof(id, proofKey, 'gallery_upload');
    return toResponse(updated as RequestRow);
  },
};

/** Best-effort nudge to the branch's reviewers that something is waiting — never blocks submission. */
function notifySupervisorsPendingReview(branchId: string): void {
  notifyBranch(branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { branchId, pendingReviewUpdated: true });
}

/**
 * Runs inside approve()'s own transaction — the approval-row status flip
 * (already applied by the caller just before this) and the stock write must
 * commit or roll back together, so every branch below reuses the exact
 * primitives receiveStock/adjustStock/submitPhysicalCount (universal) and
 * appendMovement/appendMovementLocked (legacy) already validated with,
 * parameterized to run against this same tx — never a re-implementation.
 */
async function applyApprovedRequest(
  request: RequestRow,
  tx: Prisma.TransactionClient,
): Promise<{ movementId: string; lowStock?: () => Promise<void> }> {
  const target = request.target as InventoryApprovalTarget;

  if (target === 'UNIVERSAL_ITEM') {
    const item = await universalInventoryRepository.findItemById(request.inventoryItemId as string);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);
    const branchId = request.branchId;
    const inventoryItemId = request.inventoryItemId as string;

    if (request.operation === 'RECEIVING') {
      const enteredQuantity = (request.enteredQuantity as Prisma.Decimal).toNumber();
      const enteredUnitId = request.enteredUnitId ?? item.baseUnitId;
      const baseQuantity = await convertQuantity(enteredQuantity, enteredUnitId, item.baseUnitId, item.id);
      const totalCost = request.totalCost ?? null;
      const unitCostPerBaseUnit = totalCost !== null ? totalCost.div(baseQuantity) : null;
      const movement = await applyReceivingInTx(tx, {
        branchId,
        inventoryItemId,
        baseUnitId: item.baseUnitId,
        baseQuantity,
        unitCostPerBaseUnit,
        totalCost,
        deliveryReference: request.deliveryReference ?? undefined,
        notes: request.notes ?? undefined,
        performedByUserId: request.submittedByUserId,
        enteredQuantity,
        enteredUnitId,
        proofKey: request.proofKey ?? undefined,
        proofType: request.proofType ?? undefined,
      });
      return {
        movementId: movement.id,
        lowStock: async () => {
          const stockAfter = await universalInventoryRepository.findStock(branchId, inventoryItemId);
          await notifyUniversalIfLowStock({
            branchId,
            inventoryItemId,
            itemName: item.name,
            quantityAfter: movement.quantityAfter.toNumber(),
            lowStockThreshold: stockAfter?.lowStockThreshold?.toNumber() ?? null,
            criticalThreshold: stockAfter?.criticalThreshold?.toNumber() ?? null,
          });
        },
      };
    }

    if (request.operation === 'ADJUSTMENT') {
      const movement = await applyAdjustmentInTx(tx, {
        branchId,
        inventoryItemId,
        baseUnitId: item.baseUnitId,
        quantityDelta: (request.quantityDelta as Prisma.Decimal).toNumber(),
        reasonCode: request.reasonCode ?? 'count_correction',
        notes: request.notes ?? undefined,
        performedByUserId: request.submittedByUserId,
      });
      return {
        movementId: movement.id,
        lowStock: async () => {
          const stockAfter = await universalInventoryRepository.findStock(branchId, inventoryItemId);
          await notifyUniversalIfLowStock({
            branchId,
            inventoryItemId,
            itemName: item.name,
            quantityAfter: movement.quantityAfter.toNumber(),
            lowStockThreshold: stockAfter?.lowStockThreshold?.toNumber() ?? null,
            criticalThreshold: stockAfter?.criticalThreshold?.toNumber() ?? null,
          });
        },
      };
    }

    // PHYSICAL_COUNT
    const result = await applyPhysicalCountLineInTx(tx, {
      branchId,
      inventoryItemId,
      baseUnitId: item.baseUnitId,
      countedQuantity: (request.countedQuantity as Prisma.Decimal).toNumber(),
      notes: request.notes ?? undefined,
      performedByUserId: request.submittedByUserId,
      expectedStockVersion: request.stockVersionAtSubmission ?? undefined,
    });
    if (!result.movement) {
      // Zero variance — nothing to apply, but the request is still marked approved (there was simply no discrepancy to record).
      return { movementId: request.id };
    }
    return { movementId: result.movement.id };
  }

  // LEGACY_INGREDIENT
  const ingredientId = request.legacyIngredientId as string;
  const ingredient = await inventoryRepository.findIngredientById(ingredientId, tx);
  if (!ingredient) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

  if (request.operation === 'RECEIVING') {
    const movement = await inventoryRepository.appendMovement(
      {
        branchId: ingredient.branchId,
        ingredientId,
        movementType: MOVEMENT_TYPE.STOCK_IN,
        quantityChange: (request.enteredQuantity as Prisma.Decimal).toNumber(),
        notes: request.deliveryReference ? `Supplier ref: ${request.deliveryReference}${request.notes ? ` — ${request.notes}` : ''}` : request.notes ?? undefined,
        recordedBy: request.submittedByUserId,
      },
      tx,
    );
    return {
      movementId: movement.id,
      lowStock: async () =>
        notifyLegacyIfLowStock({
          branchId: ingredient.branchId,
          ingredientId,
          ingredientName: ingredient.name,
          quantityAfter: movement.quantityAfter,
          lowStockThreshold: ingredient.lowStockThreshold,
          criticalThreshold: ingredient.criticalThreshold,
        }),
    };
  }

  if (request.operation === 'ADJUSTMENT') {
    const quantityDelta = (request.quantityDelta as Prisma.Decimal).toNumber();
    const movement = await inventoryRepository.appendMovementLocked(
      {
        branchId: ingredient.branchId,
        ingredientId,
        movementType: MOVEMENT_TYPE.MANUAL_ADJUSTMENT,
        notes: `Reason: ${request.reasonCode}${request.notes ? ` — ${request.notes}` : ''}`,
        recordedBy: request.submittedByUserId,
      },
      (currentStock) => {
        if (quantityDelta < 0 && currentStock.toNumber() + quantityDelta < 0) {
          throw new IngredientError('INSUFFICIENT_STOCK', 'Adjustment would take stock below zero', 409);
        }
        return quantityDelta;
      },
      tx,
    );
    if (!movement) throw new Error('unreachable: adjustment resolve never returns null');
    return {
      movementId: movement.id,
      lowStock: async () =>
        notifyLegacyIfLowStock({
          branchId: ingredient.branchId,
          ingredientId,
          ingredientName: ingredient.name,
          quantityAfter: movement.quantityAfter,
          lowStockThreshold: ingredient.lowStockThreshold,
          criticalThreshold: ingredient.criticalThreshold,
        }),
    };
  }

  // PHYSICAL_COUNT — stale-count guard: re-take the same ledger lock
  // appendMovementLocked below will also take (reentrant within one session/
  // transaction, so taking it again there is a harmless no-op), check the
  // ledger row count hasn't moved since submission, then let
  // appendMovementLocked compute and apply the variance against the
  // freshly-read sum exactly as the pre-approval legacy path always did.
  const lockId = hashToLockId(sha256Hex(ingredientId));
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
  if (request.stockVersionAtSubmission !== null) {
    const currentCount = await inventoryRepository.countMovements(ingredientId, tx);
    if (currentCount !== request.stockVersionAtSubmission) {
      throw new InventoryApprovalError(
        'STALE_PHYSICAL_COUNT',
        'Stock has changed since this count was submitted — a fresh recount is required before it can be approved.',
        409,
      );
    }
  }
  let previousQuantity = 0;
  let variance = 0;
  const countedQuantity = (request.countedQuantity as Prisma.Decimal).toNumber();
  const movement = await inventoryRepository.appendMovementLocked(
    {
      branchId: ingredient.branchId,
      ingredientId,
      movementType: MOVEMENT_TYPE.PHYSICAL_COUNT,
      notes: request.notes ?? undefined,
      recordedBy: request.submittedByUserId,
    },
    (currentStock) => {
      previousQuantity = currentStock.toNumber();
      variance = countedQuantity - previousQuantity;
      return variance === 0 ? null : variance;
    },
    tx,
  );
  if (!movement) return { movementId: request.id };
  return {
    movementId: movement.id,
    lowStock: async () =>
      notifyLegacyIfLowStock({
        branchId: ingredient.branchId,
        ingredientId,
        ingredientName: ingredient.name,
        quantityAfter: movement.quantityAfter,
        lowStockThreshold: ingredient.lowStockThreshold,
        criticalThreshold: ingredient.criticalThreshold,
      }),
  };
}
