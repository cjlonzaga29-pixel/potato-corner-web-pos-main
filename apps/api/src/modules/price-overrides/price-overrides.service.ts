import { ROLES, SOCKET_EVENTS, type JwtPayload } from '@potato-corner/shared';
import { priceOverridesRepository } from './price-overrides.repository.js';
import { PriceOverrideError, type PriceOverrideListFilters } from './price-overrides.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifySuperAdmin, notifyBranch } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

interface OverrideRow {
  id: string;
  branchId: string;
  productVariantId: string;
  requestedPrice: { toNumber(): number };
  status: string;
  requestedBy: string;
  requestReason: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  effectiveFrom: Date | null;
  createdAt: Date;
  updatedAt: Date;
  branch: { id: string; name: string };
  productVariant: { id: string; name: string; basePrice: { toNumber(): number }; product: { name: string } };
  requester: { id: string; firstName: string; lastName: string };
  reviewer: { id: string; firstName: string; lastName: string } | null;
}

function toResponse(row: OverrideRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    branch_name: row.branch.name,
    product_variant_id: row.productVariantId,
    variant_name: row.productVariant.name,
    product_name: row.productVariant.product.name,
    master_price: row.productVariant.basePrice.toNumber(),
    requested_price: row.requestedPrice.toNumber(),
    status: row.status,
    requested_by: row.requestedBy,
    requested_by_name: `${row.requester.firstName} ${row.requester.lastName}`,
    request_reason: row.requestReason,
    reviewed_by: row.reviewedBy,
    reviewed_by_name: row.reviewer ? `${row.reviewer.firstName} ${row.reviewer.lastName}` : null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_notes: row.reviewNotes,
    effective_from: row.effectiveFrom?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreatePriceOverrideInput {
  branch_id: string;
  product_variant_id: string;
  requested_price: number;
  request_reason: string;
}

interface ReviewPriceOverrideInput {
  action: 'approve' | 'reject';
  review_notes?: string;
}

export const priceOverridesService = {
  async submitOverrideRequest(data: CreatePriceOverrideInput, actor: JwtPayload, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPERVISOR) {
      throw new PriceOverrideError('INSUFFICIENT_PERMISSIONS', 'Only supervisors may submit price override requests', 403);
    }
    if (!actor.branch_ids.includes(data.branch_id)) {
      throw new PriceOverrideError('BRANCH_ACCESS_DENIED', 'You may only submit overrides for your own branch', 403);
    }

    const existingPending = await priceOverridesRepository.findPendingForVariant(data.branch_id, data.product_variant_id);
    if (existingPending) {
      throw new PriceOverrideError(
        'PRICE_OVERRIDE_ALREADY_PENDING',
        'There is already a pending price override request for this branch and variant',
        409,
      );
    }

    const created = (await priceOverridesRepository.create(
      {
        branchId: data.branch_id,
        productVariantId: data.product_variant_id,
        requestedPrice: data.requested_price,
        requestReason: data.request_reason,
      },
      actor.user_id,
    )) as OverrideRow;
    const response = toResponse(created);

    await recordAuditLog({
      action: 'PRICE_OVERRIDE_SUBMITTED',
      entityType: 'branch_price_override',
      entityId: created.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    notifySuperAdmin(SOCKET_EVENTS.PRICE_OVERRIDE_SUBMITTED, response);

    return response;
  },

  async listOverrides(actor: JwtPayload, filters: PriceOverrideListFilters) {
    const scoped: PriceOverrideListFilters =
      actor.role === ROLES.SUPERVISOR
        ? { ...filters, branch_id: filters.branch_id && actor.branch_ids.includes(filters.branch_id) ? filters.branch_id : actor.branch_ids[0] }
        : filters;

    const { overrides, total } = await priceOverridesRepository.findAll(scoped);
    return {
      overrides: (overrides as OverrideRow[]).map(toResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async reviewOverride(id: string, data: ReviewPriceOverrideInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await priceOverridesRepository.findById(id)) as OverrideRow | null;
    if (!existing) throw new PriceOverrideError('PRICE_OVERRIDE_NOT_FOUND', 'Price override request not found', 404);
    if (existing.status !== 'pending') {
      throw new PriceOverrideError('PRICE_OVERRIDE_ALREADY_REVIEWED', 'This price override request has already been reviewed', 409);
    }

    const updated = (await priceOverridesRepository.updateStatus(id, {
      status: data.action === 'approve' ? 'approved' : 'rejected',
      reviewedBy: actor.id,
      reviewNotes: data.review_notes,
      effectiveFrom: data.action === 'approve' ? new Date() : undefined,
    })) as OverrideRow;
    const response = toResponse(updated);

    await recordAuditLog({
      action: data.action === 'approve' ? 'PRICE_OVERRIDE_APPROVED' : 'PRICE_OVERRIDE_REJECTED',
      entityType: 'branch_price_override',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: toResponse(existing),
      afterState: response,
      ipAddress,
    });

    notifyBranch(existing.branchId, SOCKET_EVENTS.PRICE_OVERRIDE_REVIEWED, response);

    return response;
  },

  /**
   * POS pricing lookup (exported for Phase 10's transaction service, per
   * this refactor's explicit instruction). Returns the approved branch
   * override price if one is active, else the variant's master base_price —
   * never throws for "no override", that's the expected common case.
   */
  async getActivePriceForBranch(branchId: string, productVariantId: string, masterPrice: number): Promise<number> {
    const active = await priceOverridesRepository.findActiveOverride(branchId, productVariantId);
    return active ? active.requestedPrice.toNumber() : masterPrice;
  },
};
