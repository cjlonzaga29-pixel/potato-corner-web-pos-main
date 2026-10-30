import { ROLES, type JwtPayload, type PromotionEligibleProduct, type PromotionResponse } from '@potato-corner/shared';
import { discountsRepository, fromDateColumn, type ProductForPromotionRow, type PromotionRow } from './discounts.repository.js';
import { DiscountError, type PromotionPricingLine, type PromotionWriteData, type ResolvedLinePromotion } from './discounts.types.js';
import {
  PROMOTABLE_CLASSIFICATIONS,
  NON_PROMOTABLE_STATUSES,
  productIneligibilityReason,
  promotionScheduleState,
  selectPromotionForUnit,
  type PromotionCandidate,
} from './promotion-pricing.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { manilaDateKey } from '../../lib/manila-time.js';

/**
 * POS-PERF-P49 — product-scoped promotions. Discounts business logic. Called
 * by the router after Zod validation; never calls Prisma directly — always
 * goes through discountsRepository.
 *
 * Authority is the supervisor's LIVE branch set (active assignments to active
 * branches, re-read from the database on every call — never the JWT claim).
 * A supervisor may write a promotion only when every one of its branches is
 * in that set; super_admin reads everything but does not write (catalog
 * writes are supervisor-only since POS-PERF-P35).
 */

interface Actor {
  id: string;
  role: JwtPayload['role'];
}

const READ_ONLY_ADMIN_REASON = 'Promotions are managed by branch supervisors.';
const READ_ONLY_FOREIGN_BRANCH_REASON = 'This promotion also covers a branch you do not manage, so only a supervisor of every listed branch can change it.';

function toPromotionResponse(row: PromotionRow, todayKey: string, liveBranchIds: 'all' | string[], actor: Actor): PromotionResponse {
  const branchIds = row.branches.map((b) => b.branchId);
  let readOnlyReason: string | null = null;
  if (actor.role !== ROLES.SUPERVISOR) readOnlyReason = READ_ONLY_ADMIN_REASON;
  else if (liveBranchIds !== 'all' && !branchIds.every((id) => liveBranchIds.includes(id))) readOnlyReason = READ_ONLY_FOREIGN_BRANCH_REASON;
  const startsOn = fromDateColumn(row.startsOn);
  const endsOn = fromDateColumn(row.endsOn);
  return {
    id: row.id,
    name: row.name,
    discount_kind: row.discountKind,
    discount_value: row.discountValue.toNumber(),
    is_enabled: row.isEnabled,
    starts_on: startsOn,
    ends_on: endsOn,
    schedule_state: promotionScheduleState({ isEnabled: row.isEnabled, startsOn, endsOn }, todayKey),
    version: row.version,
    products: row.products
      .map((p) => ({ id: p.product.id, name: p.product.name, classification: p.product.classification }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    branches: row.branches.map((b) => ({ id: b.branch.id, name: b.branch.name })).sort((a, b) => a.name.localeCompare(b.name)),
    can_edit: readOnlyReason === null,
    read_only_reason: readOnlyReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toEligibleProduct(row: ProductForPromotionRow, visibleBranchIds: Set<string>): PromotionEligibleProduct {
  return {
    id: row.id,
    name: row.name,
    classification: row.classification,
    status: row.status,
    branch_ids: row.branchAvailability.map((a) => a.branchId).filter((id) => visibleBranchIds.has(id)),
    ineligible_reason: productIneligibilityReason({
      classification: row.classification,
      status: row.status,
      variants: row.variants.map((v) => ({ vatableCapAmount: v.vatableCapAmount?.toNumber() ?? null })),
    }),
    variants: row.variants.map((v) => ({ id: v.id, name: v.name, base_price: v.basePrice.toNumber(), is_active: v.isActive })),
  };
}

async function requireSupervisorLiveBranches(actor: Actor): Promise<string[]> {
  if (actor.role !== ROLES.SUPERVISOR) {
    throw new DiscountError('PROMOTION_WRITE_FORBIDDEN', READ_ONLY_ADMIN_REASON, 403);
  }
  const live = await branchesRepository.findAllActiveBranchIds(actor.id);
  if (live.length === 0) {
    throw new DiscountError('PROMOTION_WRITE_FORBIDDEN', 'You have no active branch assignment, so you cannot manage promotions.', 403);
  }
  return live;
}

/** Every requested branch must be active and inside the actor's live authority. */
async function assertBranchesWritable(branchIds: string[], live: string[]): Promise<void> {
  const foreign = branchIds.filter((id) => !live.includes(id));
  if (foreign.length > 0) {
    throw new DiscountError('PROMOTION_BRANCH_FORBIDDEN', 'You can only select branches you currently manage.', 403, { branch_ids: foreign });
  }
  const active = new Set(await discountsRepository.findActiveBranchIds(branchIds));
  const inactive = branchIds.filter((id) => !active.has(id));
  if (inactive.length > 0) {
    throw new DiscountError('PROMOTION_BRANCH_INACTIVE', 'Only active branches can be selected.', 422, { branch_ids: inactive });
  }
}

/** Re-validates every selected product server-side; never trusts the editor's list. */
async function assertProductsEligible(productIds: string[], branchIds: string[]): Promise<void> {
  const rows = await discountsRepository.findProductsByIds(productIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const problems: { product_id: string; product_name: string | null; reason: string }[] = [];
  for (const productId of productIds) {
    const row = byId.get(productId);
    if (!row) {
      problems.push({ product_id: productId, product_name: null, reason: 'Product not found.' });
      continue;
    }
    const reason = toEligibleProduct(row, new Set(branchIds)).ineligible_reason;
    if (reason) {
      problems.push({ product_id: productId, product_name: row.name, reason });
      continue;
    }
    if (!row.branchAvailability.some((a) => branchIds.includes(a.branchId))) {
      problems.push({ product_id: productId, product_name: row.name, reason: 'This product is not sold at any of the selected branches.' });
    }
  }
  if (problems.length > 0) {
    throw new DiscountError(
      'PROMOTION_PRODUCT_INELIGIBLE',
      problems.length === 1 && problems[0] ? `${problems[0].product_name ?? 'A product'}: ${problems[0].reason}` : `${problems.length} selected products cannot have this promotion.`,
      422,
      { products: problems },
    );
  }
}

function toWriteData(input: {
  name: string;
  discount_kind: 'percentage' | 'fixed_amount';
  discount_value: number;
  is_enabled: boolean;
  starts_on?: string | null;
  ends_on?: string | null;
  product_ids: string[];
  branch_ids: string[];
}): PromotionWriteData {
  return {
    name: input.name,
    discountKind: input.discount_kind,
    discountValue: input.discount_value,
    isEnabled: input.is_enabled,
    startsOn: input.starts_on ?? null,
    endsOn: input.ends_on ?? null,
    productIds: input.product_ids,
    branchIds: input.branch_ids,
  };
}

/** Existing promotion: the supervisor must manage every branch it already covers. */
function assertCanEditExisting(row: PromotionRow, live: string[]): void {
  if (!row.branches.every((b) => live.includes(b.branchId))) {
    throw new DiscountError('PROMOTION_BRANCH_FORBIDDEN', READ_ONLY_FOREIGN_BRANCH_REASON, 403);
  }
}

const CONFLICT_MESSAGE = 'This promotion was changed by someone else since you opened it. Reload to see the latest version before saving again.';

export const discountsService = {
  async listPromotions(actor: JwtPayload, branchId: string | undefined, now: Date = new Date()): Promise<PromotionResponse[]> {
    const actorRef: Actor = { id: actor.user_id, role: actor.role };
    let scope: 'all' | string[];
    let live: 'all' | string[];
    if (actor.role === ROLES.SUPER_ADMIN) {
      live = 'all';
      scope = branchId ? [branchId] : 'all';
    } else {
      live = await branchesRepository.findAllActiveBranchIds(actor.user_id);
      if (branchId && !live.includes(branchId)) throw new DiscountError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
      scope = branchId ? [branchId] : live;
      if (scope.length === 0) return [];
    }
    const rows = await discountsRepository.listPromotions(scope);
    const todayKey = manilaDateKey(now);
    return rows.map((row) => toPromotionResponse(row, todayKey, live, actorRef));
  },

  /** The editor's product picker: everything configured at the supervisor's live branches, each with why it can't be selected (if so). */
  async listEligibleProducts(actor: JwtPayload): Promise<PromotionEligibleProduct[]> {
    const live = await requireSupervisorLiveBranches({ id: actor.user_id, role: actor.role });
    const rows = await discountsRepository.findProductsAtBranches(live);
    const visible = new Set(live);
    return rows.filter((row) => row.status !== 'archived').map((row) => toEligibleProduct(row, visible));
  },

  async createPromotion(
    actor: JwtPayload,
    input: Parameters<typeof toWriteData>[0],
    ipAddress: string | null,
    now: Date = new Date(),
  ): Promise<PromotionResponse> {
    const actorRef: Actor = { id: actor.user_id, role: actor.role };
    const live = await requireSupervisorLiveBranches(actorRef);
    const data = toWriteData(input);
    await assertBranchesWritable(data.branchIds, live);
    await assertProductsEligible(data.productIds, data.branchIds);

    const row = await discountsRepository.createPromotion(data, actor.user_id);
    const response = toPromotionResponse(row, manilaDateKey(now), live, actorRef);
    await recordAuditLog({
      action: 'PROMOTION_CREATED',
      entityType: 'promotion',
      entityId: row.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });
    return response;
  },

  async updatePromotion(
    actor: JwtPayload,
    promotionId: string,
    input: Parameters<typeof toWriteData>[0] & { expected_version: number },
    ipAddress: string | null,
    now: Date = new Date(),
  ): Promise<PromotionResponse> {
    const actorRef: Actor = { id: actor.user_id, role: actor.role };
    const live = await requireSupervisorLiveBranches(actorRef);
    const before = await discountsRepository.findPromotionById(promotionId);
    if (!before) throw new DiscountError('PROMOTION_NOT_FOUND', 'Promotion not found', 404);
    assertCanEditExisting(before, live);
    const data = toWriteData(input);
    await assertBranchesWritable(data.branchIds, live);
    await assertProductsEligible(data.productIds, data.branchIds);

    const row = await discountsRepository.updatePromotion(promotionId, input.expected_version, data, actor.user_id);
    if (!row) throw new DiscountError('PROMOTION_CONFLICT', CONFLICT_MESSAGE, 409);
    const todayKey = manilaDateKey(now);
    const response = toPromotionResponse(row, todayKey, live, actorRef);
    await recordAuditLog({
      action: 'PROMOTION_UPDATED',
      entityType: 'promotion',
      entityId: row.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      beforeState: toPromotionResponse(before, todayKey, live, actorRef),
      afterState: response,
      ipAddress,
    });
    return response;
  },

  async setPromotionEnabled(
    actor: JwtPayload,
    promotionId: string,
    input: { is_enabled: boolean; expected_version: number },
    ipAddress: string | null,
    now: Date = new Date(),
  ): Promise<PromotionResponse> {
    const actorRef: Actor = { id: actor.user_id, role: actor.role };
    const live = await requireSupervisorLiveBranches(actorRef);
    const before = await discountsRepository.findPromotionById(promotionId);
    if (!before) throw new DiscountError('PROMOTION_NOT_FOUND', 'Promotion not found', 404);
    assertCanEditExisting(before, live);
    if (input.is_enabled) {
      // A product may have been reclassified/archived since this was saved.
      await assertProductsEligible(
        before.products.map((p) => p.productId),
        before.branches.map((b) => b.branchId),
      );
    }
    const row = await discountsRepository.setPromotionEnabled(promotionId, input.expected_version, input.is_enabled, actor.user_id);
    if (!row) throw new DiscountError('PROMOTION_CONFLICT', CONFLICT_MESSAGE, 409);
    const response = toPromotionResponse(row, manilaDateKey(now), live, actorRef);
    await recordAuditLog({
      action: input.is_enabled ? 'PROMOTION_ENABLED' : 'PROMOTION_DISABLED',
      entityType: 'promotion',
      entityId: row.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      beforeState: { is_enabled: before.isEnabled, version: before.version },
      afterState: { is_enabled: row.isEnabled, version: row.version },
      ipAddress,
    });
    return response;
  },

  /**
   * The single server-side resolver, used by the POS catalog (display) and
   * by checkout (authoritative). Bound to the sale's actual branch and each
   * line's actual product/size; re-reads current classification so a
   * product reclassified to Regular (or archived/discontinued) stops
   * discounting immediately. A size with a VATable cap is never discounted.
   * Returns a map keyed by productVariantId.
   */
  async resolvePromotionsForBranch(
    branchId: string,
    lines: readonly PromotionPricingLine[],
    now: Date = new Date(),
  ): Promise<Map<string, ResolvedLinePromotion>> {
    const result = new Map<string, ResolvedLinePromotion>();
    const productIds = [...new Set(lines.map((line) => line.productId))];
    if (productIds.length === 0) return result;

    const [promotions, products] = await Promise.all([
      discountsRepository.findEnabledPromotionsForBranch(branchId, productIds),
      discountsRepository.findProductClassifications(productIds),
    ]);
    if (promotions.length === 0) return result;

    const promotableProductIds = new Set(
      products
        .filter((p) => PROMOTABLE_CLASSIFICATIONS.includes(p.classification) && !NON_PROMOTABLE_STATUSES.includes(p.status))
        .map((p) => p.id),
    );
    const candidatesByProduct = new Map<string, PromotionCandidate[]>();
    for (const promotion of promotions) {
      const candidate: PromotionCandidate = {
        id: promotion.id,
        name: promotion.name,
        discountKind: promotion.discountKind,
        discountValue: promotion.discountValue.toNumber(),
        isEnabled: promotion.isEnabled,
        startsOn: fromDateColumn(promotion.startsOn),
        endsOn: fromDateColumn(promotion.endsOn),
        version: promotion.version,
        createdAt: promotion.createdAt,
      };
      for (const { productId } of promotion.products) {
        const list = candidatesByProduct.get(productId) ?? [];
        list.push(candidate);
        candidatesByProduct.set(productId, list);
      }
    }

    const todayKey = manilaDateKey(now);
    for (const line of lines) {
      if (line.vatableCapAmount !== null || !promotableProductIds.has(line.productId)) continue;
      const selected = selectPromotionForUnit(candidatesByProduct.get(line.productId) ?? [], line.basePrice, todayKey);
      if (!selected) continue;
      result.set(line.productVariantId, {
        promotionId: selected.promotion.id,
        name: selected.promotion.name,
        discountKind: selected.promotion.discountKind,
        discountValue: selected.promotion.discountValue,
        version: selected.promotion.version,
        endsOn: selected.promotion.endsOn,
        unitDiscount: selected.unitDiscount,
      });
    }
    return result;
  },
};
