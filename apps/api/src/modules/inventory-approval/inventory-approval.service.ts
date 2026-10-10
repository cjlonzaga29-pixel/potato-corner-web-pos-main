import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { MOVEMENT_TYPE, ROLES, SOCKET_EVENTS, type JwtPayload } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { hashToLockId, inventoryApprovalRowLockId } from '../../lib/pg-lock.js';
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
  applyWasteInTx,
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
  SubmitWasteData,
} from './inventory-approval.types.js';

const INVENTORY_PROOF_BUCKET_PREFIX = 'approval-requests';

/** A request row as stored — kept loose (matches the model's own loose-reference convention) rather than importing the generated Prisma type everywhere. */
type RequestRow = Awaited<ReturnType<typeof inventoryApprovalRepository.findById>> extends infer T ? NonNullable<T> : never;

async function assertBranchAccessOrThrow(actor: JwtPayload, branchId: string): Promise<void> {
  if (!(await hasBranchAccess(actor, branchId))) {
    throw new InventoryApprovalError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
  }
}

/**
 * POS-PERF-P28R2 kill-switch safety: `MANUAL_INVENTORY_APPROVAL_REQUIRED`
 * controls whether NEW submissions go through this review queue at all
 * (inventory.router.ts / universal-inventory.router.ts). It said nothing,
 * before this change, about what happens to requests already sitting in the
 * queue when that flag is flipped off — approve()/correct() had no
 * awareness of the flag whatsoever, so a request submitted while the gate
 * was on could still be approved or corrected after an operator disabled
 * it, silently re-admitting the exact "two independent write paths can
 * apply the same physical event" risk the flag flip is meant to retire (see
 * docs/runbooks/pos-perf-p28-inventory-approval-rollout.md's rollback
 * scenario). Blocking both actions outright while the flag is off forces
 * reconciliation (resolve-or-cancel every PENDING/RETURNED request) to
 * happen BEFORE disabling the flag, not as an afterthought once it is
 * already off — exactly the sequencing the rollout runbook now documents.
 * cancel() and returnForCorrection() are deliberately NOT gated here: they
 * are how an operator drains the queue during that reconciliation window,
 * and must keep working right up to (and including) the moment the flag
 * flips.
 */
function assertApprovalProcessingEnabledOrThrow(): void {
  if (!config.manualInventoryApprovalRequired) {
    throw new InventoryApprovalError(
      'APPROVAL_PROCESSING_DISABLED',
      'Manual inventory approval processing is currently disabled. This request cannot be approved or corrected — cancel it instead if it is no longer needed.',
      409,
    );
  }
}

/** Decimal (nullable) vs a plain-number candidate value — null/undefined only equal each other. */
function decimalEquals(stored: Prisma.Decimal | null, candidate: number): boolean {
  if (stored === null) return false;
  return stored.toNumber() === candidate;
}

async function findRequestOrThrow(id: string): Promise<RequestRow> {
  const request = await inventoryApprovalRepository.findById(id);
  if (!request) throw new InventoryApprovalError('REQUEST_NOT_FOUND', 'Approval request not found', 404);
  return request;
}

/**
 * POS-PERF-P29R2 — true only for the combination that has carried a
 * mandatory staff-PIN-verification/evidence requirement since P29:
 * RECEIVING/ADJUSTMENT/WASTE submitted against a UNIVERSAL_ITEM (the
 * schemas in universal-inventory.schema.ts's staffPinVerifiedOperationFields
 * enforce this on every NEW submission through /inventory-stock/.../receive|
 * adjust|waste). PHYSICAL_COUNT never carried this requirement. Nor does
 * LEGACY_INGREDIENT for ANY operation — /ingredients/:id/stock-in and
 * /adjust (inventory.router.ts) never resolved a verification_token/
 * evidence_key at all; that system predates P29 entirely and was never
 * upgraded (CR-001 superseded it with UNIVERSAL_ITEM), so an absent
 * responsibleStaffUserId there is the permanent, by-design shape of every
 * legacy-ingredient request, not a legacy gap to flag.
 */
function requestRequiresStaffVerification(request: Pick<RequestRow, 'target' | 'operation'>): boolean {
  if (request.target !== 'UNIVERSAL_ITEM') return false;
  const operation = request.operation as InventoryApprovalOperation;
  return operation === 'RECEIVING' || operation === 'ADJUSTMENT' || operation === 'WASTE';
}

/**
 * True for a PENDING/RETURNED UNIVERSAL_ITEM request whose operation is
 * subject to the mandatory verification policy but which has no
 * responsible-staff attribution recorded — i.e. it was submitted before
 * that policy existed (or before this request's particular submission path
 * enforced it). This is the "old pending request" case task item 4 is
 * about: approve() must refuse these outright rather than silently
 * treating submittedByUserId as a verified Responsible Staff.
 */
function isLegacyUnverifiedRequest(request: RequestRow): boolean {
  return requestRequiresStaffVerification(request) && !request.responsibleStaffUserId;
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
      [request.submittedByUserId, request.reviewedByUserId, request.cancelledByUserId].filter((id): id is string => id !== null),
    ),
    // A single request whose stored proof object can no longer be signed
    // (deleted, bucket hiccup, environment mismatch) must not take down the
    // whole list/detail response for every other request alongside it —
    // fall back to a null proof_url for that one row instead of rejecting.
    request.proofKey ? getSignedInventoryProofUrl(request.proofKey).catch(() => null) : Promise.resolve(null),
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

    responsible_staff_user_id: request.responsibleStaffUserId,
    responsible_staff_name: request.responsibleStaffName,
    pin_verified_at: request.pinVerifiedAt?.toISOString() ?? null,

    status: request.status,
    submitted_by_user_id: request.submittedByUserId,
    submitted_by_name: nameById.get(request.submittedByUserId) ?? null,
    submitted_at: request.submittedAt.toISOString(),
    reviewed_by_user_id: request.reviewedByUserId,
    reviewed_by_name: request.reviewedByUserId ? nameById.get(request.reviewedByUserId) ?? null : null,
    reviewed_at: request.reviewedAt?.toISOString() ?? null,
    return_reason: request.returnReason,
    applied_movement_id: request.appliedMovementId,

    cancelled_by_user_id: request.cancelledByUserId,
    cancelled_by_name: request.cancelledByUserId ? nameById.get(request.cancelledByUserId) ?? null : null,
    cancelled_at: request.cancelledAt?.toISOString() ?? null,
    cancel_reason: request.cancelReason,
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
        responsibleStaffUserId: data.staffPin?.responsibleStaffUserId,
        responsibleStaffName: data.staffPin?.responsibleStaffName,
        pinVerifiedAt: data.staffPin?.pinVerifiedAt,
        proofKey: data.evidence?.proofKey,
        proofType: data.evidence?.proofType,
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
        responsibleStaffUserId: data.staffPin?.responsibleStaffUserId,
        responsibleStaffName: data.staffPin?.responsibleStaffName,
        pinVerifiedAt: data.staffPin?.pinVerifiedAt,
        proofKey: data.evidence?.proofKey,
        proofType: data.evidence?.proofType,
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

  /** POS-PERF-P29 — waste now routes through Pending Review for branch/staff actors, same as receiving/adjustment. For UNIVERSAL_ITEM, staffPin is always supplied by the caller (universal-inventory.router.ts's schema makes verification_token mandatory) — a waste write there always names an accountable staff member. LEGACY_INGREDIENT waste (POS-PERF-P29R3) has no such collection path and omits it, same as legacy receiving/adjustment. */
  async submitWaste(data: SubmitWasteData, actor: JwtPayload) {
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
        operation: 'WASTE',
        enteredQuantity: data.quantity,
        enteredUnitId: data.enteredUnitId ?? null,
        reasonCode: data.reasonCode,
        notes: data.notes ?? null,
        submittedByUserId: actor.user_id,
        responsibleStaffUserId: data.staffPin?.responsibleStaffUserId,
        responsibleStaffName: data.staffPin?.responsibleStaffName,
        pinVerifiedAt: data.staffPin?.pinVerifiedAt,
        proofKey: data.evidence?.proofKey,
        proofType: data.evidence?.proofType,
      },
    ]);
    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_SUBMITTED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: { operation: 'WASTE', target: data.target },
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

  async listRequests(actor: JwtPayload, filters: { branchId?: string; status?: 'PENDING' | 'APPROVED' | 'RETURNED' | 'CANCELLED'; page: number; limit: number }) {
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
    assertApprovalProcessingEnabledOrThrow();
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.submittedByUserId === actor.user_id) {
      throw new InventoryApprovalError('SELF_APPROVAL_DENIED', 'You cannot approve a request you submitted yourself', 403);
    }
    if (request.status !== 'PENDING') {
      throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);
    }
    if (isLegacyUnverifiedRequest(request)) {
      throw new InventoryApprovalError(
        'LEGACY_VERIFICATION_MISSING',
        'This request predates mandatory staff PIN verification/evidence and has no responsible-staff attribution on file — it cannot be approved as-is. Return it for correction to collect a fresh PIN verification and proof, or use the explicit legacy-reconciliation action to approve it without one.',
        409,
      );
    }

    const movement = await approveAndApply(request, actor);
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
    assertApprovalProcessingEnabledOrThrow();
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.status !== 'RETURNED') {
      throw new InventoryApprovalError('NOT_RETURNED', 'Only a returned request can be corrected', 409);
    }
    // POS-PERF-P29R3 — "does a correction need fresh PIN verification/
    // evidence?" Restored to: yes, whenever any PIN-bound field actually
    // changes. A correction that edits the quantity, unit, or reason/notes
    // is a materially different physical event from the one the original
    // responsible-staff PIN verification attested to — carrying that old
    // verification forward onto new numbers would let anyone silently
    // rewrite what a verified staff member is on record as having done.
    // Only a correction that changes nothing PIN-bound (e.g. a notes-only
    // typo fix with notes itself unchanged, or re-submitting identical
    // figures after a Return) may inherit the original revision's
    // responsibleStaffUserId/proof — see the pinBoundFieldChanged check
    // immediately below. A caller that supplies a fresh verification_token/evidence_key
    // (data.staffPin/data.evidence) always wins over inheritance, changed or
    // not. A request that was already legacy-unverified (no
    // responsibleStaffUserId to begin with) stays that way after correction
    // too, and remains subject to the same approve()-time
    // LEGACY_VERIFICATION_MISSING gate.
    if (requestRequiresStaffVerification(request) && !data.staffPin) {
      const quantityField = request.operation === 'ADJUSTMENT' ? 'quantityDelta' : 'enteredQuantity';
      const pinBoundFieldChanged =
        (data.enteredQuantity !== undefined && !decimalEquals(request.enteredQuantity, data.enteredQuantity)) ||
        (data.quantityDelta !== undefined && !decimalEquals(request.quantityDelta, data.quantityDelta)) ||
        (data.enteredUnitId !== undefined && data.enteredUnitId !== request.enteredUnitId) ||
        (data.reasonCode !== undefined && data.reasonCode !== request.reasonCode) ||
        (data.notes !== undefined && data.notes !== request.notes);
      if (pinBoundFieldChanged) {
        throw new InventoryApprovalError(
          'FRESH_VERIFICATION_REQUIRED',
          `Changing ${quantityField === 'quantityDelta' ? 'the adjustment quantity' : 'the quantity'}, unit, reason, or notes on this correction requires a fresh staff PIN verification and evidence — the original verification does not carry forward onto changed figures. Verify again before resubmitting.`,
          422,
        );
      }
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
      responsibleStaffUserId: data.staffPin?.responsibleStaffUserId ?? request.responsibleStaffUserId,
      responsibleStaffName: data.staffPin?.responsibleStaffName ?? request.responsibleStaffName,
      pinVerifiedAt: data.staffPin?.pinVerifiedAt ?? request.pinVerifiedAt,
      proofKey: data.evidence?.proofKey ?? request.proofKey,
      proofType: data.evidence?.proofType ?? request.proofType,
    };

    // Two concurrent corrections of the same RETURNED request (double-click,
    // retried request) would otherwise both pass the status check above and
    // both insert a sibling PENDING revision — two independently-approvable
    // rows pointing at the same previousRequestId, which could both get
    // approved and apply the correction twice. The advisory lock plus a
    // re-check for an existing sibling (both inside the same transaction
    // that inserts the new row) close that window: the loser sees a
    // sibling already there and aborts before inserting its own.
    //
    // POS-PERF-P28R2: this same lock is also where correct() races against
    // cancel() on this exact row — cancel() takes the identical lock
    // (inventoryApprovalRowLockId) before flipping this row to CANCELLED.
    // The status snapshot read at the top of this function (`request`) is
    // taken before either lock is acquired, so it is not enough on its own:
    // re-reading the row fresh, under the lock, is what actually proves
    // nothing cancelled it out from under this correction in the gap
    // between that first read and here.
    await prisma.$transaction(async (tx) => {
      const lockId = inventoryApprovalRowLockId(request.id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      const fresh = await inventoryApprovalRepository.findById(request.id, tx);
      if (!fresh || fresh.status !== 'RETURNED') {
        throw new InventoryApprovalError('NOT_RETURNED', 'Only a returned request can be corrected', 409);
      }
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

  /**
   * Permanent cancellation (POS-PERF-P28R2) — the fix for the rollback gap:
   * "Returned for Correction" alone is not cancellation, because a RETURNED
   * row can always be corrected into a brand-new approvable PENDING
   * revision. cancel() instead retires the request's whole lineage from
   * this point forward: it is only ever reachable from PENDING or RETURNED
   * (never APPROVED — an applied request's stock mutation is never
   * unwound), requires an authorized reviewer with branch access and a
   * non-empty reason (role-gated at the router: adminOrSupervisor, same as
   * approve/return), changes no stock, and is enforced atomically against a
   * concurrent approve()/correct() on the same row via the same
   * inventoryApprovalRowLockId lock correct() itself uses. Repeated
   * cancellation of an already-CANCELLED row is a safe no-op (treated as
   * ALREADY_PROCESSED, matching approve()/returnForCorrection()'s own
   * idempotent-rejection convention) rather than an error that would make a
   * retry unsafe.
   */
  async cancel(id: string, reason: string, actor: JwtPayload, ipAddress: string | null) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);

    const cancelled = await prisma.$transaction(async (tx) => {
      // Same lock correct() takes on this row id — see the comment in
      // correct()'s transaction above for why a plain conditional UPDATE
      // alone (sufficient for cancel-vs-approve/cancel-vs-return, which
      // Postgres already serializes for free on the same row) is not
      // enough here: correct() reacts to this row's status by inserting a
      // *new* sibling row rather than updating this one, so only a shared
      // lock plus a fresh re-read on both sides closes the gap.
      const lockId = inventoryApprovalRowLockId(id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

      const fresh = await inventoryApprovalRepository.findById(id, tx);
      if (!fresh) throw new InventoryApprovalError('REQUEST_NOT_FOUND', 'Approval request not found', 404);
      if (fresh.status === 'CANCELLED') return false; // already cancelled — safe no-op, not an error
      if (fresh.status !== 'PENDING' && fresh.status !== 'RETURNED') {
        throw new InventoryApprovalError(
          'NOT_CANCELLABLE',
          fresh.status === 'APPROVED'
            ? 'An already-approved request cannot be cancelled — its stock movement has already been applied'
            : 'This request has already been reviewed',
          409,
        );
      }
      if (await inventoryApprovalRepository.hasExistingCorrection(id, tx)) {
        throw new InventoryApprovalError(
          'ALREADY_CORRECTED',
          'This request has already been corrected into a newer revision — cancel that revision instead',
          409,
        );
      }

      const ok = await inventoryApprovalRepository.markCancelledIfCancellable(id, fresh.revisionNumber, actor.user_id, reason, tx);
      if (!ok) throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);
      return true;
    });

    if (cancelled) {
      await recordAuditLog({
        action: 'INVENTORY_APPROVAL_CANCELLED',
        entityType: 'inventory_approval_request',
        entityId: id,
        actorId: actor.user_id,
        actorRole: actor.role,
        branchId: request.branchId,
        afterState: { reason },
        ipAddress,
      });
      notifyUser(request.submittedByUserId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, { requestId: id, status: 'CANCELLED', reason });
    }

    return toResponse(await findRequestOrThrow(id));
  },

  /**
   * POS-PERF-P29R3 — RESTORED policy: a reviewer's written justification is
   * never a substitute for the staff PIN verification/evidence the request's
   * operation requires. This action does NOT approve the request and does
   * NOT touch stock — it is purely an administrative acknowledgment ("a
   * supervisor looked at this gap and recorded why") that leaves the request
   * exactly where it was: PENDING, still failing approve()'s
   * LEGACY_VERIFICATION_MISSING gate, still displayed as "Verification/
   * evidence required". The only two ways an old pending request without
   * responsible-staff attribution can actually leave that state are
   * returnForCorrection() → correct() with a genuine fresh PIN verification/
   * evidence pair, or cancel() to retire it permanently. (POS-PERF-P29R2
   * previously let this same action call approveAndApply() and flip the
   * request to APPROVED on a reason string alone — that was the exact
   * "justification stands in for verification" bypass this restores
   * against; see inventory-approval.integration.test.ts's "administrative
   * acknowledgment" tests for the behavior this must NOT regress to.)
   * Refuses to run on a request that already has verification on file (that
   * one goes through the normal approve() path) or whose operation never
   * required it (PHYSICAL_COUNT) — this action exists for exactly one case.
   */
  async reconcileLegacy(id: string, reason: string, actor: JwtPayload, ipAddress: string | null) {
    const request = await findRequestOrThrow(id);
    await assertBranchAccessOrThrow(actor, request.branchId);
    if (request.submittedByUserId === actor.user_id) {
      throw new InventoryApprovalError('SELF_APPROVAL_DENIED', 'You cannot act on a request you submitted yourself', 403);
    }
    if (request.status !== 'PENDING') {
      throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);
    }
    if (!isLegacyUnverifiedRequest(request)) {
      throw new InventoryApprovalError(
        'NOT_LEGACY_UNVERIFIED',
        'This request already has staff PIN verification/evidence on file (or never required it) — approve it through the normal review action instead',
        409,
      );
    }

    await recordAuditLog({
      action: 'INVENTORY_APPROVAL_LEGACY_ACKNOWLEDGED',
      entityType: 'inventory_approval_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      afterState: {
        reason,
        operation: request.operation,
        note: 'Administrative acknowledgment only — no stock applied, request remains PENDING and still requires a fresh staff PIN verification/evidence (via correction) or permanent cancellation.',
      },
      ipAddress,
    });

    // Deliberately no approveAndApply(), no status change, no movement, and
    // no INVENTORY_MOVEMENT_RECORDED notification — nothing about the
    // request's reviewable state changes as a result of this call.
    return toResponse(request);
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

/** Shared by approve() and reconcileLegacy() — the row-status flip and the stock write commit or roll back together. Callers are responsible for every pre-condition check; this never re-checks status itself beyond the atomic conditional update. */
async function approveAndApply(request: RequestRow, actor: JwtPayload): Promise<{ movementId: string; lowStock?: () => Promise<void> }> {
  return prisma.$transaction(async (tx) => {
    const ok = await inventoryApprovalRepository.markApprovedIfPending(request.id, request.revisionNumber, actor.user_id, tx);
    if (!ok) throw new InventoryApprovalError('ALREADY_PROCESSED', 'This request has already been reviewed', 409);

    const applied = await applyApprovedRequest(request, tx);
    await inventoryApprovalRepository.setAppliedMovementId(request.id, applied.movementId, tx);
    return applied;
  });
}

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
        responsibleStaffName: request.responsibleStaffName ?? undefined,
        pinVerifiedAt: request.pinVerifiedAt ?? undefined,
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
        responsibleStaffName: request.responsibleStaffName ?? undefined,
        pinVerifiedAt: request.pinVerifiedAt ?? undefined,
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

    if (request.operation === 'WASTE') {
      const enteredQuantity = (request.enteredQuantity as Prisma.Decimal).toNumber();
      const enteredUnitId = request.enteredUnitId ?? item.baseUnitId;
      const baseQuantity = await convertQuantity(enteredQuantity, enteredUnitId, item.baseUnitId, item.id);
      const movement = await applyWasteInTx(tx, {
        branchId,
        inventoryItemId,
        baseUnitId: item.baseUnitId,
        baseQuantity,
        reasonCode: request.reasonCode ?? 'other',
        notes: request.notes ?? undefined,
        performedByUserId: request.submittedByUserId,
        responsibleUserId: request.responsibleStaffUserId ?? request.submittedByUserId,
        enteredQuantity,
        enteredUnitId,
        proofKey: request.proofKey ?? undefined,
        proofType: request.proofType ?? undefined,
        responsibleStaffName: request.responsibleStaffName ?? undefined,
        pinVerifiedAt: request.pinVerifiedAt ?? undefined,
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

  if (request.operation === 'WASTE') {
    // POS-PERF-P29R3 — this branch did not exist before: LEGACY_INGREDIENT
    // WASTE requests never reached this function because the legacy
    // /ingredients/:id/waste route never routed through the approval queue
    // at all (see inventory.router.ts's matching fix). Mirrors
    // inventory.service.ts's wasteIngredient exactly, just inside this
    // transaction and recording the request's submittedByUserId as the
    // mover, same as every other branch above.
    const wasteQuantity = (request.enteredQuantity as Prisma.Decimal).toNumber();
    const movement = await inventoryRepository.appendMovementLocked(
      {
        branchId: ingredient.branchId,
        ingredientId,
        movementType: MOVEMENT_TYPE.WASTE,
        notes: `Reason: ${request.reasonCode}${request.notes ? ` — ${request.notes}` : ''}`,
        recordedBy: request.submittedByUserId,
      },
      (currentStock) => {
        if (currentStock.toNumber() - wasteQuantity < 0) {
          throw new IngredientError('INSUFFICIENT_STOCK', 'Waste quantity exceeds current stock', 409);
        }
        return -wasteQuantity;
      },
      tx,
    );
    if (!movement) throw new Error('unreachable: waste resolve never returns null');
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
