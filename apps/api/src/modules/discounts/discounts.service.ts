import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  ROLES,
  type JwtPayload,
  type ManualDiscountAmountMode,
  type ManualDiscountProductScope,
  type ManualDiscountTypeResponse,
  type PosManualDiscountType,
  type PromotionEligibleProduct,
  type PromotionResponse,
} from '@potato-corner/shared';
import {
  discountsRepository,
  manualDiscountTypesRepository,
  ManualDiscountTypeVersionConflict,
  fromDateColumn,
  type ManualDiscountTypeSettings,
  type ManualDiscountTypeRow,
  type ProductForPromotionRow,
  type PromotionRow,
} from './discounts.repository.js';
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
    application_mode: row.applicationMode,
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
  const reasonFor = (mode: 'automatic' | 'cashier_selected') =>
    productIneligibilityReason(
      {
        classification: row.classification,
        status: row.status,
        variants: row.variants.map((v) => ({ vatableCapAmount: v.vatableCapAmount?.toNumber() ?? null })),
      },
      mode,
    );
  return {
    id: row.id,
    name: row.name,
    classification: row.classification,
    status: row.status,
    branch_ids: row.branchAvailability.map((a) => a.branchId).filter((id) => visibleBranchIds.has(id)),
    ineligible_reason: reasonFor('automatic'),
    cashier_selected_ineligible_reason: reasonFor('cashier_selected'),
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
async function assertProductsEligible(productIds: string[], branchIds: string[], mode: 'automatic' | 'cashier_selected'): Promise<void> {
  const rows = await discountsRepository.findProductsByIds(productIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const problems: { product_id: string; product_name: string | null; reason: string }[] = [];
  for (const productId of productIds) {
    const row = byId.get(productId);
    if (!row) {
      problems.push({ product_id: productId, product_name: null, reason: 'Product not found.' });
      continue;
    }
    const eligible = toEligibleProduct(row, new Set(branchIds));
    const reason = mode === 'automatic' ? eligible.ineligible_reason : eligible.cashier_selected_ineligible_reason;
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
  application_mode?: 'automatic' | 'cashier_selected';
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
    applicationMode: input.application_mode ?? 'automatic',
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
    await assertProductsEligible(data.productIds, data.branchIds, data.applicationMode);

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
    // POS-PERF-P50R — an older (P49) editor sends no mode: keep the stored one.
    const data = { ...toWriteData(input), applicationMode: input.application_mode ?? before.applicationMode };
    await assertBranchesWritable(data.branchIds, live);
    await assertProductsEligible(data.productIds, data.branchIds, data.applicationMode);

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
        before.applicationMode,
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
        applicationMode: 'automatic',
      });
    }
    return result;
  },

  /**
   * POS-PERF-P50R — cashier-selected discounts active now at this branch,
   * each with the unit discount it gives every eligible line (keyed by
   * productVariantId). Same branch binding, schedule, eligibility and
   * pricing rules as automatic promotions, except that Regular products may
   * be named. A line with a VATable cap, or an archived/discontinued
   * product, is never discounted. Used by the POS catalog (display) and by
   * checkout (authoritative, narrowed to the claimed id).
   */
  async resolveSelectableDiscounts(
    branchId: string,
    lines: readonly PromotionPricingLine[],
    options: { promotionId?: string; now?: Date } = {},
  ): Promise<{ promotion: PromotionCandidate; unitDiscounts: Map<string, number> }[]> {
    const promotions = await discountsRepository.findEnabledSelectableDiscounts(branchId, options.promotionId);
    if (promotions.length === 0) return [];
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const products = productIds.length > 0 ? await discountsRepository.findProductClassifications(productIds) : [];
    const sellable = new Set(products.filter((p) => !NON_PROMOTABLE_STATUSES.includes(p.status)).map((p) => p.id));
    const todayKey = manilaDateKey(options.now ?? new Date());
    const result: { promotion: PromotionCandidate; unitDiscounts: Map<string, number> }[] = [];
    for (const row of promotions) {
      const candidate: PromotionCandidate = {
        id: row.id,
        name: row.name,
        discountKind: row.discountKind,
        discountValue: row.discountValue.toNumber(),
        isEnabled: row.isEnabled,
        startsOn: fromDateColumn(row.startsOn),
        endsOn: fromDateColumn(row.endsOn),
        version: row.version,
        createdAt: row.createdAt,
      };
      if (promotionScheduleState(candidate, todayKey) !== 'active') continue;
      const named = new Set(row.products.map((p) => p.productId));
      const unitDiscounts = new Map<string, number>();
      for (const line of lines) {
        if (line.vatableCapAmount !== null || !named.has(line.productId) || !sellable.has(line.productId)) continue;
        const unitDiscount = selectPromotionForUnit([candidate], line.basePrice, todayKey)?.unitDiscount ?? 0;
        if (unitDiscount > 0) unitDiscounts.set(line.productVariantId, unitDiscount);
      }
      result.push({ promotion: candidate, unitDiscounts });
    }
    return result;
  },
};

/**
 * POS-PERF-P55 — manual peso discount types (docs/runbooks/pos-perf-p55-manual-discounts-and-proof.md).
 *
 * Branch-scoped: each type belongs to exactly one branch. Supervisors write
 * only for branches in their LIVE assignments (re-read on every request,
 * never the JWT claim); a super_admin reads everything but does not write,
 * same split as promotions. A type that sales reference is never deleted —
 * it is deactivated, and every sale keeps its own frozen snapshot.
 */
const MANUAL_TYPE_CONFLICT_MESSAGE =
  'This discount type was changed by someone else since you opened it. The latest version is shown now — check it, then make your change again.';

function toManualDiscountTypeResponse(row: ManualDiscountTypeRow, canEdit: boolean, branchIds: string[] = row.isActive ? [row.branchId] : []): ManualDiscountTypeResponse {
  return {
    id: row.id,
    branch_id: row.branchId,
    name: row.name,
    apply_to_pos: row.applyToPos,
    require_proof: row.requireProof,
    is_active: row.isActive,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deactivated_at: row.deactivatedAt?.toISOString() ?? null,
    sale_count: row._count.transactions,
    can_edit: canEdit && row.isActive,
    amount_mode: row.amountMode as ManualDiscountAmountMode,
    fixed_amount: row.fixedAmount?.toNumber() ?? null,
    product_scope: row.productScope as ManualDiscountProductScope,
    product_ids: row.products.map((product) => product.productId),
    branch_ids: branchIds,
  };
}

/** The audited view of a type: settings only, no counts or timestamps. */
function manualTypeAuditState(row: ManualDiscountTypeRow) {
  return {
    branch_id: row.branchId,
    name: row.name,
    apply_to_pos: row.applyToPos,
    require_proof: row.requireProof,
    is_active: row.isActive,
    version: row.version,
    amount_mode: row.amountMode,
    fixed_amount: row.fixedAmount?.toNumber() ?? null,
    product_scope: row.productScope,
    product_ids: row.products.map((product) => product.productId),
    group_id: row.groupId,
  };
}

async function requireSupervisorBranch(actor: JwtPayload, branchId: string): Promise<void> {
  if (actor.role !== ROLES.SUPERVISOR) {
    throw new DiscountError('MANUAL_DISCOUNT_TYPE_WRITE_FORBIDDEN', 'Discount types are managed by the supervisors of each branch.', 403);
  }
  const live = await branchesRepository.findAllActiveBranchIds(actor.user_id);
  if (!live.includes(branchId)) {
    throw new DiscountError('BRANCH_ACCESS_DENIED', 'You can only manage discount types for branches you currently supervise.', 403);
  }
  const branch = await manualDiscountTypesRepository.findBranchIsActive(branchId);
  if (!branch || branch.status !== 'active') {
    throw new DiscountError('BRANCH_INACTIVE', 'Discount types can only be managed for an active branch.', 422);
  }
}

function manualTypeNameTaken(name: string): DiscountError {
  return new DiscountError('MANUAL_DISCOUNT_TYPE_NAME_TAKEN', `This branch already has an active discount type named "${name}".`, 409);
}

/**
 * POS-PERF-P57 — a statutory-looking name is allowed and stays an ordinary
 * manual discount: nothing reads the name to choose a calculation (checkout
 * dispatches on discount_type only, and these sales are always 'manual').
 */
async function assertManualTypeNameAllowed(branchId: string, name: string, excludeId?: string): Promise<void> {
  if (await manualDiscountTypesRepository.findActiveByName(branchId, name, excludeId)) throw manualTypeNameTaken(name);
}

/**
 * P55 release fix — the check above is only the friendly fast path: two
 * concurrent saves of one name both pass it. The partial unique index
 * manual_discount_types_branch_active_name_key (branch, lower(name), active
 * rows only) decides; its violation is reported the same way.
 */
function rethrowNameTaken(name: string | undefined) {
  return (error: unknown): never => {
    if (name !== undefined && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw manualTypeNameTaken(name);
    throw error;
  };
}

/** POS-PERF-P57 — a product list naming anything that isn't a current product of these branches is refused whole; nothing is silently dropped. */
async function assertEligibleProducts(productIds: string[], branchIds: string[]): Promise<void> {
  const found = await manualDiscountTypesRepository.findEligibleProductIds(productIds, branchIds);
  if (productIds.some((id) => !found.has(id))) {
    throw new DiscountError('MANUAL_DISCOUNT_PRODUCT_INVALID', 'One of the chosen products is not available at the selected branches. Refresh the list and choose again.', 422);
  }
}

/** What the reader may see of where each row's group is active. */
async function visibleGroupBranches(rows: ManualDiscountTypeRow[], visible: 'all' | string[]): Promise<Map<string, string[]>> {
  const groupIds = [...new Set(rows.map((row) => row.groupId).filter((id): id is string => id !== null))];
  const members = await manualDiscountTypesRepository.findGroupBranches(groupIds);
  const result = new Map<string, string[]>();
  for (const member of members) {
    if (member.groupId === null || (visible !== 'all' && !visible.includes(member.branchId))) continue;
    result.set(member.groupId, [...(result.get(member.groupId) ?? []), member.branchId]);
  }
  return result;
}

async function loadManualTypeForWrite(actor: JwtPayload, typeId: string): Promise<ManualDiscountTypeRow> {
  const before = await manualDiscountTypesRepository.findById(typeId);
  if (!before) throw new DiscountError('MANUAL_DISCOUNT_TYPE_NOT_FOUND', 'Discount type not found', 404);
  // Authority is checked against the type's own stored branch, never a client-sent one.
  await requireSupervisorBranch(actor, before.branchId);
  return before;
}

async function manualTypeConflict(typeId: string): Promise<DiscountError> {
  const current = await manualDiscountTypesRepository.findById(typeId);
  return new DiscountError(
    'MANUAL_DISCOUNT_TYPE_CONFLICT',
    MANUAL_TYPE_CONFLICT_MESSAGE,
    409,
    current ? { current: toManualDiscountTypeResponse(current, true) } : undefined,
  );
}

export const manualDiscountTypesService = {
  async list(actor: JwtPayload, branchId: string | undefined, includeInactive: boolean): Promise<ManualDiscountTypeResponse[]> {
    const respond = async (rows: ManualDiscountTypeRow[], canEdit: boolean, visible: 'all' | string[]) => {
      const groups = await visibleGroupBranches(rows, visible);
      return rows.map((row) => toManualDiscountTypeResponse(row, canEdit, row.groupId ? (groups.get(row.groupId) ?? []) : row.isActive ? [row.branchId] : []));
    };
    if (actor.role === ROLES.SUPER_ADMIN) {
      return respond(await manualDiscountTypesRepository.list(branchId ? [branchId] : 'all', includeInactive), false, 'all');
    }
    const live = await branchesRepository.findAllActiveBranchIds(actor.user_id);
    if (branchId && !live.includes(branchId)) throw new DiscountError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
    const scope = branchId ? [branchId] : live;
    if (scope.length === 0) return [];
    return respond(await manualDiscountTypesRepository.list(scope, includeInactive), actor.role === ROLES.SUPERVISOR, live);
  },

  /**
   * The terminal's offer list — only the caller's resolved branch (the router
   * never trusts a staff/branch-sent id). POS-PERF-P57 — a POS that doesn't
   * declare the capability only knows staff-entered, whole-order discounts, so
   * it is never offered a type it would charge wrongly.
   */
  async listForPos(branchId: string, supportsAmountModes: boolean): Promise<PosManualDiscountType[]> {
    const rows = await manualDiscountTypesRepository.findForPos(branchId);
    return rows
      .filter((row) => supportsAmountModes || (row.amountMode === 'manual' && row.productScope === 'all'))
      .map((row) => ({
        id: row.id,
        name: row.name,
        require_proof: row.requireProof,
        version: row.version,
        amount_mode: row.amountMode as ManualDiscountAmountMode,
        fixed_amount: row.fixedAmount?.toNumber() ?? null,
        product_scope: row.productScope as ManualDiscountProductScope,
        product_ids: row.products.map((product) => product.productId),
      }));
  },

  async create(
    actor: JwtPayload,
    input: {
      branch_id?: string | undefined;
      branch_ids?: string[] | undefined;
      name: string;
      apply_to_pos: boolean;
      require_proof: boolean;
      amount_mode: ManualDiscountAmountMode;
      fixed_amount?: number | null | undefined;
      product_scope: ManualDiscountProductScope;
      product_ids?: string[] | undefined;
    },
    ipAddress: string | null,
  ): Promise<ManualDiscountTypeResponse> {
    const branchIds = [...new Set(input.branch_ids ?? (input.branch_id ? [input.branch_id] : []))];
    await Promise.all(branchIds.map((branchId) => requireSupervisorBranch(actor, branchId)));
    await Promise.all(branchIds.map((branchId) => assertManualTypeNameAllowed(branchId, input.name)));
    const productIds = input.product_scope === 'selected' ? [...new Set(input.product_ids ?? [])] : [];
    await assertEligibleProducts(productIds, branchIds);
    const rows = await manualDiscountTypesRepository
      .createForBranches(
        branchIds,
        {
          name: input.name,
          applyToPos: input.apply_to_pos,
          requireProof: input.require_proof,
          amountMode: input.amount_mode,
          fixedAmount: input.amount_mode === 'fixed' ? (input.fixed_amount ?? null) : null,
          productScope: input.product_scope,
          productIds,
          groupId: branchIds.length > 1 ? randomUUID() : null,
        },
        actor.user_id,
      )
      .catch(rethrowNameTaken(input.name));
    await Promise.all(
      rows.map((row) =>
        recordAuditLog({
          action: 'MANUAL_DISCOUNT_TYPE_CREATED',
          entityType: 'manual_discount_type',
          entityId: row.id,
          actorId: actor.user_id,
          actorRole: actor.role,
          branchId: row.branchId,
          afterState: manualTypeAuditState(row),
          ipAddress,
        }),
      ),
    );
    const first = rows[0];
    // The schema requires at least one branch, so a create always returns a row.
    if (!first) throw new DiscountError('BRANCH_REQUIRED', 'Choose at least one branch', 422);
    return toManualDiscountTypeResponse(first, true, branchIds);
  },

  /**
   * POS-PERF-P57 — without branch_ids this changes the one row (an older web,
   * which only knows one branch). With it the same settings go to every row of
   * the group at branches this supervisor manages; a row at a branch they don't
   * manage is left alone. Branches added get a new row and branches dropped
   * deactivate theirs, in one transaction, and each row's version moves, so any
   * checkout showing the old settings is refused rather than charged.
   */
  async update(
    actor: JwtPayload,
    typeId: string,
    input: {
      name?: string | undefined;
      apply_to_pos?: boolean | undefined;
      require_proof?: boolean | undefined;
      amount_mode?: ManualDiscountAmountMode | undefined;
      fixed_amount?: number | null | undefined;
      product_scope?: ManualDiscountProductScope | undefined;
      product_ids?: string[] | undefined;
      branch_ids?: string[] | undefined;
      expected_version: number;
    },
    ipAddress: string | null,
  ): Promise<ManualDiscountTypeResponse> {
    const before = await loadManualTypeForWrite(actor, typeId);
    if (!before.isActive) throw new DiscountError('MANUAL_DISCOUNT_TYPE_INACTIVE', 'This discount type has been deactivated and can no longer be edited.', 409);
    if (before.version !== input.expected_version) throw await manualTypeConflict(typeId);

    const requested = input.branch_ids ? [...new Set(input.branch_ids)] : null;
    if (requested) await Promise.all(requested.map((branchId) => requireSupervisorBranch(actor, branchId)));
    const live = await branchesRepository.findAllActiveBranchIds(actor.user_id);
    const groupRows = requested && before.groupId ? await manualDiscountTypesRepository.findActiveGroupRows(before.groupId) : [before];
    const managed = groupRows.filter((row) => live.includes(row.branchId));
    const targets = requested ? managed.filter((row) => requested.includes(row.branchId)) : [before];
    const removed = requested ? managed.filter((row) => !requested.includes(row.branchId)) : [];
    const addedBranchIds = requested ? requested.filter((branchId) => !groupRows.some((row) => row.branchId === branchId)) : [];

    const name = input.name ?? before.name;
    if (input.name !== undefined) await Promise.all(targets.map((row) => assertManualTypeNameAllowed(row.branchId, name, row.id)));
    await Promise.all(addedBranchIds.map((branchId) => assertManualTypeNameAllowed(branchId, name)));

    const productIds = input.product_scope === 'all' ? [] : input.product_ids ? [...new Set(input.product_ids)] : undefined;
    await assertEligibleProducts(productIds ?? [], requested ?? [before.branchId]);

    const groupId = before.groupId ?? (addedBranchIds.length > 0 ? randomUUID() : undefined);
    const settings: ManualDiscountTypeSettings = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.apply_to_pos !== undefined ? { applyToPos: input.apply_to_pos } : {}),
      ...(input.require_proof !== undefined ? { requireProof: input.require_proof } : {}),
      ...(input.amount_mode !== undefined ? { amountMode: input.amount_mode, fixedAmount: input.amount_mode === 'fixed' ? (input.fixed_amount ?? null) : null } : {}),
      ...(input.product_scope !== undefined ? { productScope: input.product_scope } : {}),
      ...(productIds !== undefined ? { productIds } : {}),
      ...(groupId !== undefined && before.groupId === null ? { groupId } : {}),
    };
    try {
      await manualDiscountTypesRepository.applySave(
        targets.map((row) => ({ id: row.id, expectedVersion: row.id === before.id ? input.expected_version : row.version })),
        settings,
        addedBranchIds.length > 0
          ? {
              branchIds: addedBranchIds,
              fields: {
                name,
                applyToPos: input.apply_to_pos ?? before.applyToPos,
                requireProof: input.require_proof ?? before.requireProof,
                amountMode: input.amount_mode ?? before.amountMode,
                fixedAmount: input.amount_mode !== undefined ? (input.amount_mode === 'fixed' ? (input.fixed_amount ?? null) : null) : (before.fixedAmount?.toNumber() ?? null),
                productScope: input.product_scope ?? before.productScope,
                productIds: productIds ?? before.products.map((product) => product.productId),
                groupId: groupId ?? null,
              },
            }
          : null,
        removed.map((row) => ({ id: row.id, expectedVersion: row.version })),
        actor.user_id,
      );
    } catch (error) {
      if (error instanceof ManualDiscountTypeVersionConflict) throw await manualTypeConflict(typeId);
      return rethrowNameTaken(name)(error);
    }

    const beforeById = new Map([...groupRows, before].map((row) => [row.id, row]));
    const afterRows = await manualDiscountTypesRepository.findManyByIds([...targets, ...removed].map((row) => row.id));
    const addedRows = groupId ? await manualDiscountTypesRepository.findActiveByGroupAndBranches(groupId, addedBranchIds) : [];
    await Promise.all(
      [...afterRows, ...addedRows].map((row) => {
        const prior = beforeById.get(row.id);
        return recordAuditLog({
          action: !prior ? 'MANUAL_DISCOUNT_TYPE_CREATED' : row.isActive ? 'MANUAL_DISCOUNT_TYPE_UPDATED' : 'MANUAL_DISCOUNT_TYPE_DEACTIVATED',
          entityType: 'manual_discount_type',
          entityId: row.id,
          actorId: actor.user_id,
          actorRole: actor.role,
          branchId: row.branchId,
          ...(prior ? { beforeState: manualTypeAuditState(prior) } : {}),
          afterState: manualTypeAuditState(row),
          ipAddress,
        });
      }),
    );
    const row = afterRows.find((candidate) => candidate.id === typeId);
    if (!row) throw await manualTypeConflict(typeId);
    return toManualDiscountTypeResponse(row, true, requested ?? (row.isActive ? [row.branchId] : []));
  },

  async deactivate(actor: JwtPayload, typeId: string, input: { expected_version: number }, ipAddress: string | null): Promise<ManualDiscountTypeResponse> {
    const before = await loadManualTypeForWrite(actor, typeId);
    if (!before.isActive) throw new DiscountError('MANUAL_DISCOUNT_TYPE_INACTIVE', 'This discount type is already deactivated.', 409);
    if (before.version !== input.expected_version) throw await manualTypeConflict(typeId);
    const row = await manualDiscountTypesRepository.deactivate(typeId, input.expected_version, actor.user_id);
    if (!row) throw await manualTypeConflict(typeId);
    await recordAuditLog({
      action: 'MANUAL_DISCOUNT_TYPE_DEACTIVATED',
      entityType: 'manual_discount_type',
      entityId: row.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: row.branchId,
      beforeState: manualTypeAuditState(before),
      afterState: manualTypeAuditState(row),
      ipAddress,
    });
    return toManualDiscountTypeResponse(row, false);
  },
};
