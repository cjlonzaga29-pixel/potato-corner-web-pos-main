import sharp from 'sharp';
import { Prisma, type ProductFlavorSlot, type VariantLifecycleStatus } from '@prisma/client';
import { ROLES, SOCKET_EVENTS, type JwtPayload, type PosReadinessCode, type ProductStatus } from '@potato-corner/shared';
import { productsRepository } from './products.repository.js';
import {
  ProductError,
  type AddFlavorSlotInput,
  type ProductListFilters,
  type ReorderFlavorSlotsInput,
  type UpdateFlavorSlotInput,
} from './products.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { prisma } from '../../lib/prisma.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { notifySuperAdmin, notifyBranch } from '../../lib/notify.js';
import { productCategoriesRepository } from '../product-categories/product-categories.repository.js';
import { productReadinessService } from '../product-readiness/product-readiness.service.js';
import type { ProductVariantReadinessResult, ReadinessIssue, ReadinessIssueCode } from '../product-readiness/product-readiness.types.js';
import { stockAvailabilityService } from '../stock-availability/stock-availability.service.js';
import type { VariantStockResult } from '../stock-availability/stock-availability.types.js';
import { getAccessibleBranchIds, hasBranchAccess } from '../../lib/branch-access.js';
import { hasActiveCatalogAuthorityForProduct } from '../../lib/catalog-authority.js';
import { productCatalogLockId } from '../../lib/pg-lock.js';

type ActorContext = { id: string; role: string };

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  temporarily_unavailable: 'Temporarily Unavailable',
  discontinued: 'Discontinued',
  archived: 'Archived',
};

/**
 * Product lifecycle matrix. Every entry lists exactly the statuses reachable
 * from that status by super_admin. archived's only outgoing transition is
 * back to active — the Restore action (Task 34) — otherwise archived
 * products are read-only (see updateProduct/updateVariant/etc. guards).
 */
const GLOBAL_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  draft: ['active', 'archived'],
  active: ['temporarily_unavailable', 'discontinued', 'archived'],
  temporarily_unavailable: ['active', 'archived'],
  discontinued: ['active', 'archived'],
  archived: ['active'],
};

/**
 * CR-005 Sub-phase 3c — ProductVariant.lifecycleStatus transition matrix,
 * distinct from GLOBAL_TRANSITIONS (Product.status) above. ARCHIVED has no
 * outgoing transitions — terminal, same convention as the product matrix.
 */
const VARIANT_TRANSITIONS: Record<VariantLifecycleStatus, VariantLifecycleStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'ARCHIVED'],
  PENDING_APPROVAL: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: [],
};

const VALID_LIFECYCLE_STATUSES = new Set<VariantLifecycleStatus>(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED']);

function assertVariantTransition(current: VariantLifecycleStatus, next: VariantLifecycleStatus): void {
  const allowed = VARIANT_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new ProductError('VARIANT_INVALID_TRANSITION', `Cannot transition variant from ${current} to ${next}`, 409);
  }
}

/**
 * POS-PERF-P34R — a supervisor may never enable a branch-exclusive
 * product's availability at any branch other than its own
 * exclusiveBranchId. branch_exclusive otherwise has zero ongoing
 * enforcement (it's only read at creation time, see createWithCascade),
 * which — now that supervisor-created products are always
 * branch-exclusive — would let any supervisor with access to another
 * branch quietly spread a product outside the branch its creator scoped
 * it to, via the same branch-availability/publish actions that are
 * otherwise correctly branch-scoped by branchGuard. super_admin is
 * unrestricted, same as every other branch_exclusive-adjacent action.
 *
 * POS-PERF-P37 — the same guard for a multi-branch selection
 * (branchSelectionScoped): such a product may only be enabled at a branch it
 * was created for (has a branch_product_availability row at). Legacy shared
 * products (branchSelectionScoped false) are unaffected.
 */
function assertSupervisorMayEnableAtBranch(
  product: {
    branchExclusive: boolean;
    exclusiveBranchId: string | null;
    branchSelectionScoped?: boolean;
    branchAvailability?: { branchId: string }[];
  },
  branchId: string,
  isAvailable: boolean,
  actor: ActorContext,
): void {
  if (!isAvailable || actor.role !== ROLES.SUPERVISOR) return;
  if (product.branchExclusive && product.exclusiveBranchId !== branchId) {
    throw new ProductError(
      'PRODUCT_BRANCH_EXCLUSIVE',
      'This product is branch-exclusive and cannot be enabled at a different branch',
      403,
    );
  }
  if (product.branchSelectionScoped && !(product.branchAvailability ?? []).some((row) => row.branchId === branchId)) {
    throw new ProductError(
      'PRODUCT_BRANCH_NOT_SELECTED',
      'This product was not created for this branch and cannot be enabled here',
      403,
    );
  }
}

/**
 * POS-PERF-P37 — validates a whole create/publish branch selection before
 * anything is written: every id must be an active branch and, for a
 * supervisor, one of their live active assignments (resolved from the
 * database, never the JWT's branch_ids snapshot). One bad id rejects the
 * entire selection. Returns the branches in the caller's (deduplicated) order.
 */
async function assertBranchSelectionAuthorized(branchIds: string[], actor: ActorContext): Promise<{ id: string; name: string }[]> {
  const activeBranches = await productsRepository.findActiveBranchesByIds(branchIds);
  const activeById = new Map(activeBranches.map((b) => [b.id, b]));
  const invalidIds = branchIds.filter((id) => !activeById.has(id));
  if (invalidIds.length > 0) {
    throw new ProductError('BRANCH_SELECTION_INVALID', 'One or more selected branches do not exist or are inactive', 422, {
      invalid_branch_ids: invalidIds,
    });
  }

  if (actor.role === ROLES.SUPERVISOR) {
    const accessible = await getAccessibleBranchIds({ user_id: actor.id, role: actor.role, branch_ids: [] } as unknown as JwtPayload);
    const deniedIds = accessible === 'all' ? [] : branchIds.filter((id) => !accessible.includes(id));
    if (deniedIds.length > 0) {
      throw new ProductError('BRANCH_ACCESS_DENIED', 'You do not have an active assignment to every selected branch', 403, {
        denied_branch_ids: deniedIds,
      });
    }
  }

  return branchIds.map((id) => activeById.get(id) as { id: string; name: string });
}

/** Every branch this product currently has a branch_product_availability row for — the "branch rooms" a variant lifecycle event is broadcast to. */
async function notifyVariantBranches(productId: string, event: string, payload: unknown): Promise<void> {
  const rows = await productsRepository.findBranchProductAvailability(productId);
  for (const row of rows) {
    notifyBranch(row.branchId, event, payload);
  }
}

/**
 * Task 191 — CR-005 Guarantee 6 gate for approveVariant, re-pointed at the
 * live BOM architecture: checkout deduction (transactions.service.ts
 * resolveCartItems) and the POS readiness gate have both read
 * ProductComponent since Task 100, but this gate still checked the legacy
 * ProductInventory table — which production has zero rows in — so every
 * fully-configured ProductComponent variant failed approval. Delegates to
 * productReadinessService, the same engine checkout uses, via its
 * branch-agnostic BOM-only method (approval is a global gate, not scoped to
 * any one branch, and runs before lifecycleStatus is ACTIVE — see that
 * method's own doc for why the branch-scoped readiness check can't be reused
 * here directly).
 */
async function assertRecipesResolvableSomewhere(productVariantId: string): Promise<void> {
  const readiness = await productReadinessService.evaluateVariantComponentReadiness(productVariantId);
  if (!readiness.ready) {
    throw new ProductError(
      'VARIANT_APPROVAL_BLOCKED_UNRESOLVABLE_INGREDIENT',
      readiness.blockingIssues.map((i) => i.message).join(' ') ||
        'Variant has no valid Recipe/BOM (ProductComponent) configuration — approval blocked until its recipe is complete',
      409,
    );
  }
}

/**
 * Phase 4: a variant's ProductFlavorSlot rows must form a valid, contiguous
 * 1..N slot-index sequence with no duplicates before its slot-based sale
 * flow (transactions.service.ts resolveCartItems) can trust slotIndex as
 * the runtime contract. listVariantFlavorSlots already orders by slotIndex.
 */
function assertFlavorSlotsWellFormed(slots: ProductFlavorSlot[]): void {
  const seen = new Set<number>();
  for (const slot of slots) {
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 0) {
      throw new ProductError('VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS', `Flavor slot has an invalid slotIndex (${slot.slotIndex})`, 409);
    }
    if (seen.has(slot.slotIndex)) {
      throw new ProductError('VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS', `Duplicate slot index ${slot.slotIndex} on this variant`, 409);
    }
    seen.add(slot.slotIndex);
    if (!slot.label || !slot.unit) {
      throw new ProductError('VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS', `Slot ${slot.slotIndex} is missing a label or unit`, 409);
    }
  }
  const expected = Array.from({ length: slots.length }, (_, i) => i);
  const actual = [...seen].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ProductError(
      'VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS',
      `Flavor slots must form a contiguous 0..${slots.length - 1} sequence`,
      409,
    );
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

function toBranchAvailabilityRow(row: {
  branchId: string;
  isAvailable: boolean;
  updatedAt: Date;
  branch: { code: string; name: string; city: string };
}) {
  return {
    branch_id: row.branchId,
    branch_code: row.branch.code,
    branch_name: row.branch.name,
    city: row.branch.city,
    is_available: row.isAvailable,
    updated_at: row.updatedAt.toISOString(),
  };
}

function toVariantResponse(variant: {
  id: string;
  productId: string;
  name: string;
  sizeLabel: string;
  basePrice: { toNumber(): number };
  displayOrder: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  // CR-005 Sub-phase 3c — optional so pre-existing call sites that build a
  // partial variant shape (e.g. tests) don't need updating.
  lifecycleStatus?: VariantLifecycleStatus;
  version?: number;
  lastChangeReason?: string | null;
  createdById?: string | null;
  approvedById?: string | null;
  approvedAt?: Date | null;
  variantFlavors?: {
    flavorId: string;
    pricePremium: { toNumber(): number };
    isAvailable: boolean;
    flavor: { name: string; colorHex: string | null };
  }[];
}) {
  return {
    id: variant.id,
    product_id: variant.productId,
    name: variant.name,
    size_label: variant.sizeLabel,
    base_price: variant.basePrice.toNumber(),
    display_order: variant.displayOrder,
    is_active: variant.isActive,
    lifecycle_status: variant.lifecycleStatus ?? null,
    version: variant.version ?? null,
    last_change_reason: variant.lastChangeReason ?? null,
    created_by_id: variant.createdById ?? null,
    approved_by_id: variant.approvedById ?? null,
    approved_at: variant.approvedAt ? variant.approvedAt.toISOString() : null,
    flavors: (variant.variantFlavors ?? []).map((vf) => ({
      flavor_id: vf.flavorId,
      name: vf.flavor.name,
      color_hex: vf.flavor.colorHex,
      price_premium: vf.pricePremium.toNumber(),
      is_available: vf.isAvailable,
    })),
    created_at: variant.createdAt.toISOString(),
    updated_at: variant.updatedAt.toISOString(),
  };
}

function toProductBase(product: {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  categoryId: string | null;
  // Task 209.6 — optional so pre-existing call sites building a partial
  // product shape (e.g. tests, cascade audit snapshots) don't need updating.
  imagePath?: string | null;
  status: ProductStatus;
  displayOrder: number | null;
  isSeasonal: boolean;
  seasonalStartDate: Date | null;
  seasonalEndDate: Date | null;
  branchExclusive: boolean;
  exclusiveBranchId: string | null;
  exclusiveBranch?: { id: string; name: string } | null;
  productCategory?: { id: string; name: string } | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  // POS-PERF-P36R — optional so pre-existing partial-shape call sites (tests,
  // cascade audit snapshots) don't need updating; a real row always has one.
  version?: number;
  // POS-PERF-P36R5 — optional for the same reason as version: not every
  // partial-shape call site re-selects it, but every real row has the column
  // (NULL unless this product is a fork-to-branch copy).
  forkedFromProductId?: string | null;
  // POS-PERF-P37 — optional for the same reason as forkedFromProductId.
  branchSelectionScoped?: boolean;
}) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    category_id: product.categoryId,
    category_name: product.productCategory?.name ?? null,
    has_image: Boolean(product.imagePath),
    status: product.status,
    status_label: STATUS_LABELS[product.status],
    display_order: product.displayOrder,
    is_seasonal: product.isSeasonal,
    seasonal_start_date: product.seasonalStartDate ? isoDate(product.seasonalStartDate) : null,
    seasonal_end_date: product.seasonalEndDate ? isoDate(product.seasonalEndDate) : null,
    branch_exclusive: product.branchExclusive,
    exclusive_branch_id: product.exclusiveBranchId,
    exclusive_branch_name: product.exclusiveBranch?.name ?? null,
    forked_from_product_id: product.forkedFromProductId ?? null,
    branch_selection_scoped: product.branchSelectionScoped ?? false,
    created_by: product.createdBy,
    created_at: product.createdAt.toISOString(),
    updated_at: product.updatedAt.toISOString(),
    version: product.version ?? 1,
  };
}

type ListRow = Parameters<typeof toProductBase>[0] & {
  _count: { variants: number };
  variants: { isActive: boolean }[];
  branchAvailability: { isAvailable: boolean }[];
};

/**
 * Task 209.x perf fix — imageUrl is resolved by the caller via the same
 * batched getSignedProductImageUrls() call getPosCatalog already uses
 * (Task 209.7), instead of each row's caller-facing consumer having to hit
 * GET /:productId/image individually. Live profiling (2026-08-15) showed the
 * admin product list otherwise firing one signed-URL-mint request per
 * product after the list loaded — a serial waterfall costing 0.85-2.5s per
 * product before any image could start downloading.
 */
function toProductListItem(product: ListRow, imageUrl: string | null) {
  return {
    ...toProductBase(product),
    image_url: imageUrl,
    variant_count: product._count.variants,
    active_variant_count: product.variants.filter((v) => v.isActive).length,
    active_branch_count: product.branchAvailability.filter((b) => b.isAvailable).length,
  };
}

type DetailRow = Parameters<typeof toProductBase>[0] & {
  variants: Parameters<typeof toVariantResponse>[0][];
  branchAvailability: Parameters<typeof toBranchAvailabilityRow>[0][];
  creator: { id: string; firstName: string; lastName: string; email: string } | null;
};

function toProductDetailResponse(product: DetailRow) {
  return {
    ...toProductBase(product),
    variant_count: product.variants.length,
    active_variant_count: product.variants.filter((v) => v.isActive).length,
    active_branch_count: product.branchAvailability.filter((b) => b.isAvailable).length,
    variants: product.variants.map(toVariantResponse),
    branch_availability: product.branchAvailability.map(toBranchAvailabilityRow),
    created_by_user: product.creator
      ? {
          id: product.creator.id,
          first_name: product.creator.firstName,
          last_name: product.creator.lastName,
          email: product.creator.email,
        }
      : null,
  };
}

/** Applies to both create (isSeasonal always present) and update (merged against the existing record by the caller). */
function validateSeasonalRules(input: {
  isSeasonal: boolean;
  seasonalStartDate?: string;
  seasonalEndDate?: string;
}): void {
  const hasStart = input.seasonalStartDate !== undefined;
  const hasEnd = input.seasonalEndDate !== undefined;

  if (input.isSeasonal && (!hasStart || !hasEnd)) {
    throw new ProductError('SEASONAL_DATES_REQUIRED', 'Seasonal products require both a start date and an end date', 422);
  }
  if (hasStart !== hasEnd) {
    throw new ProductError('SEASONAL_DATES_INCOMPLETE', 'seasonal_start_date and seasonal_end_date must be provided together', 422);
  }
  if (hasStart && hasEnd && input.seasonalStartDate !== undefined && input.seasonalEndDate !== undefined) {
    if (input.seasonalEndDate < input.seasonalStartDate) {
      throw new ProductError('SEASONAL_DATE_RANGE_INVALID', 'seasonal_end_date must not be before seasonal_start_date', 422);
    }
  }
}

interface CreateProductInput {
  name: string;
  description?: string;
  category?: string;
  category_id?: string;
  status: ProductStatus;
  display_order?: number;
  is_seasonal: boolean;
  seasonal_start_date?: string;
  seasonal_end_date?: string;
  branch_exclusive: boolean;
  exclusive_branch_id?: string;
  branch_ids?: string[];
}

interface UpdateProductInput {
  name?: string;
  description?: string;
  category?: string;
  category_id?: string | null;
  display_order?: number;
  is_seasonal?: boolean;
  seasonal_start_date?: string | null;
  seasonal_end_date?: string | null;
  expected_version?: number;
}

interface ChangeStatusInput {
  status: ProductStatus;
  branch_id?: string;
  reason?: string;
}

interface CreateVariantInput {
  name: string;
  size_label: string;
  base_price: number;
  display_order?: number;
  is_active: boolean;
  // CR-005 Sub-phase 3c — optional, defaults to ACTIVE (schema default,
  // preserves existing behavior for every pre-existing caller).
  lifecycle_status?: VariantLifecycleStatus;
}

interface UpdateVariantInput {
  name?: string;
  size_label?: string;
  base_price?: number;
  display_order?: number;
  is_active?: boolean;
  // POS-PERF-P36 — optional optimistic-concurrency token. The builder sends
  // back the `version` it loaded; omitted by every pre-existing caller
  // (backward compatible — no expected_version means no conflict check).
  expected_version?: number;
}

/** CR-005 Sub-phase 3c — editActiveVariant. lifecycleStatus/version/createdById/approvedById/approvedAt/is_active are system-managed and intentionally excluded. */
interface EditActiveVariantInput {
  name?: string;
  size_label?: string;
  base_price?: number;
  vatable_cap_amount?: number | null;
  display_order?: number;
  kcal?: number | null;
  max_flavors?: number;
}

// --- CR-005 Sub-phase 3d — flavor slot CRUD ---

type SlotOperation = 'ADD_SLOT' | 'UPDATE_SLOT' | 'REMOVE_SLOT' | 'REORDER_SLOTS' | 'ADD_SNACK_OPTION' | 'REMOVE_SNACK_OPTION';

type VariantWithRelations = NonNullable<Awaited<ReturnType<typeof productsRepository.findVariantById>>>;

function toFlavorSlotSnapshot(slot: {
  id: string;
  slotIndex: number;
  label: string;
  flavorQty: { toNumber(): number };
  unit: string;
  required: boolean;
  snackOptions?: { snackProductVariantId: string }[];
}) {
  return {
    id: slot.id,
    slot_index: slot.slotIndex,
    label: slot.label,
    flavor_qty: slot.flavorQty.toNumber(),
    unit: slot.unit,
    required: slot.required,
    // Sorted so snack-option ADD/REMOVE is detected regardless of insertion
    // order — the ACTIVE-governance no-op guard compares this snapshot
    // before/after, not the raw array.
    snack_option_variant_ids: (slot.snackOptions ?? []).map((so) => so.snackProductVariantId).sort(),
  };
}

export function toFlavorSlotResponse(slot: {
  id: string;
  productVariantId: string;
  slotIndex: number;
  label: string;
  flavorQty: { toNumber(): number };
  unit: string;
  required: boolean;
  snackOptions?: { id: string; snackProductVariantId: string; snackProductVariant?: { name: string; sizeLabel: string } }[];
}) {
  return {
    id: slot.id,
    product_variant_id: slot.productVariantId,
    slot_index: slot.slotIndex,
    label: slot.label,
    flavor_qty: slot.flavorQty.toNumber(),
    unit: slot.unit,
    required: slot.required,
    snack_options: (slot.snackOptions ?? []).map((so) => ({
      id: so.id,
      snack_product_variant_id: so.snackProductVariantId,
      snack_variant_name: so.snackProductVariant ? `${so.snackProductVariant.name} (${so.snackProductVariant.sizeLabel})` : null,
    })),
  };
}

/**
 * CR-005 Sub-phase 3d — shared slot-mutation governance, mirroring
 * editActiveVariant's RBAC + version-bump + ChangeLog machinery (Decisions
 * J/K): DRAFT/PENDING_APPROVAL allow supervisor + super_admin with no
 * version bump; ACTIVE requires super_admin + a mandatory reason and wraps
 * the mutation in a transaction that bumps version and writes a ChangeLog
 * snapshot; ARCHIVED rejects every slot change. mutation receives the
 * already-loaded variant so callers (e.g. addFlavorSlot's maxFlavors check)
 * never need a second round trip.
 */
async function performSlotEditWithActiveGovernance<T>(
  variantId: string,
  reason: string | undefined,
  actor: ActorContext,
  ipAddress: string | null,
  operation: SlotOperation,
  mutation: (tx: Prisma.TransactionClient | typeof prisma, variant: VariantWithRelations) => Promise<T>,
): Promise<T> {
  const variant = await productsRepository.findVariantById(variantId);
  if (!variant) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

  if (variant.lifecycleStatus === 'ARCHIVED') {
    throw new ProductError('VARIANT_ARCHIVED_NO_SLOT_CHANGES', 'Archived variants cannot have their flavor slots changed', 409);
  }

  let result: T;

  if (variant.lifecycleStatus === 'ACTIVE') {
    // POS-PERF-P36R — a brand-new ProductVariant defaults to lifecycleStatus
    // ACTIVE at creation (Prisma schema default; product-readiness.service.ts
    // requires exactly that for "Add to POS" eligibility, so the builder
    // never demotes it to DRAFT). Restricting ACTIVE-variant slot edits to
    // super_admin only — this governance rule's original CR-005 posture,
    // written before branch-team authority existed — made Mix & Max
    // permanently unreachable through the builder: every variant a
    // supervisor creates is ACTIVE from the moment it exists. Extended to
    // match every other P36 mutation's posture: a supervisor with active
    // branch authority over the product may also edit, still gated on the
    // same mandatory reason as super_admin.
    const supervisorHasAuthority = actor.role === ROLES.SUPERVISOR && (await hasActiveCatalogAuthorityForProduct(variant.product, actor.id));
    if (actor.role !== ROLES.SUPER_ADMIN && !supervisorHasAuthority) {
      throw new ProductError(
        'VARIANT_SLOT_EDIT_FORBIDDEN',
        'You may only edit flavor slots on an ACTIVE variant if you are super_admin or a supervisor with active branch authority over this product',
        403,
      );
    }
    if (!reason || !reason.trim()) {
      throw new ProductError('VARIANT_SLOT_EDIT_REASON_REQUIRED', 'A reason is required to edit flavor slots on an ACTIVE variant', 400);
    }

    result = await prisma.$transaction(async (tx) => {
      // POS-PERF-P36R3 — same productCatalogLockId as publishProduct/
      // product-components: a concurrent REMOVE_SLOT/REMOVE_SNACK_OPTION
      // could invalidate a required slot's readiness in the gap between
      // publishProduct's readiness read and its availability write. Taking
      // the lock before reading slotsBefore serializes this mutation against
      // a concurrent publish on the same product.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(variant.productId)})`;
      const slotsBefore = await productsRepository.listVariantFlavorSlots(variantId, tx);
      const mutationResult = await mutation(tx, variant);
      const slotsAfter = await productsRepository.listVariantFlavorSlots(variantId, tx);

      const beforeSnapshot = slotsBefore.map(toFlavorSlotSnapshot);
      const afterSnapshot = slotsAfter.map(toFlavorSlotSnapshot);
      if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) {
        throw new ProductError('VARIANT_SLOT_EDIT_NO_CHANGES', 'No slot changes were made', 400);
      }

      const versionAfter = variant.version + 1;
      await productsRepository.updateVariantLifecycle(variantId, { version: versionAfter, lastChangeReason: reason }, tx);
      await productsRepository.insertVariantChangeLog(
        {
          productVariantId: variantId,
          version: versionAfter,
          changedById: actor.id,
          reason,
          snapshotJson: {
            operation,
            slots_before: beforeSnapshot,
            slots_after: afterSnapshot,
            version_before: variant.version,
            version_after: versionAfter,
            changed_at: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      return mutationResult;
    });
  } else {
    if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPERVISOR) {
      throw new ProductError('VARIANT_SLOT_EDIT_FORBIDDEN', 'Only super_admin or supervisor may edit flavor slots', 403);
    }
    // POS-PERF-P36R — flavor-slot CRUD was missing the same branch-authority
    // check every other variant mutation (updateVariant, product-components)
    // already enforces, leaving a cross-branch gap: a supervisor with no
    // assignment to the product's branch could still add/edit/remove its
    // Mix & Max slots. hasActiveCatalogAuthorityForProduct's "never
    // published -> any active supervisor" fallback still applies, so a
    // brand-new draft variant isn't orphaned before its first publish.
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(variant.product, actor.id))) {
      throw new ProductError(
        'VARIANT_SLOT_EDIT_FORBIDDEN',
        'You may only edit flavor slots on a product an active branch assignment gives you authority over',
        403,
      );
    }
    // POS-PERF-P36R3 — DRAFT/PENDING_APPROVAL slot edits previously ran
    // unlocked (and outside any transaction) against `prisma` directly.
    // Wrapped in a transaction holding productCatalogLockId so this path
    // gets the same publish-vs-mutation serialization as the ACTIVE branch
    // above and product-components' update/delete — a concurrent
    // REMOVE_SNACK_OPTION on a draft variant can no longer land between
    // publishProduct's readiness read and its availability write.
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(variant.productId)})`;
      return mutation(tx, variant);
    });
  }

  notifySuperAdmin(SOCKET_EVENTS.VARIANT_FLAVOR_SLOTS_CHANGED, { variant_id: variantId, operation });
  await notifyVariantBranches(variant.productId, SOCKET_EVENTS.VARIANT_FLAVOR_SLOTS_CHANGED, { variant_id: variantId, operation });

  await recordAuditLog({
    action: `VARIANT_FLAVOR_SLOTS_${operation}`,
    entityType: 'product_flavor_slot',
    entityId: variantId,
    actorId: actor.id,
    actorRole: actor.role,
    afterState: { operation, reason: reason ?? null },
    ipAddress,
  });

  return result;
}

/**
 * Phase B (CR-008) — deterministic collapse of productReadinessService's
 * full blockingIssues list down to the single legacy `readiness_code`
 * existing POS clients already read. Order matters: the first matching code
 * found in blockingIssues wins.
 */
const READINESS_CODE_PRIORITY: { code: ReadinessIssueCode; legacy: PosReadinessCode }[] = [
  { code: 'PRODUCT_INACTIVE', legacy: 'INACTIVE' },
  { code: 'VARIANT_INACTIVE', legacy: 'INACTIVE' },
  { code: 'VARIANT_LIFECYCLE_BLOCKED', legacy: 'INACTIVE' },
  { code: 'BRANCH_NOT_AVAILABLE', legacy: 'NOT_AVAILABLE_IN_BRANCH' },
  { code: 'PRICE_MISSING', legacy: 'PRICE_MISSING' },
  { code: 'RECIPE_MISSING', legacy: 'MISSING_BASE_MAPPING' },
  { code: 'INVALID_COMPONENT', legacy: 'MISSING_BASE_MAPPING' },
  { code: 'INVENTORY_STOCK_MISSING', legacy: 'MISSING_BASE_MAPPING' },
  { code: 'MIX_MAX_SLOT_INCOMPLETE', legacy: 'MIX_MAX_INCOMPLETE' },
  { code: 'MIX_MAX_SNACK_UNAVAILABLE', legacy: 'MIX_MAX_INCOMPLETE' },
  { code: 'FLAVOR_NOT_AVAILABLE_AT_BRANCH', legacy: 'NOT_AVAILABLE_IN_BRANCH' },
];

function pickLegacyReadinessCode(blockingIssues: ReadinessIssue[]) {
  for (const { code, legacy } of READINESS_CODE_PRIORITY) {
    if (blockingIssues.some((issue) => issue.code === code)) return legacy;
  }
  return 'READY' as const;
}

function toReadinessIssueResponse(issue: ReadinessIssue) {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    flavor_name: issue.flavorName ?? null,
  };
}

/** Phase D1 — Admin Readiness panel DTO. Deliberately omits entityId/productVariantId/flavorId: the spec calls for no internal IDs in the admin-facing issue list, only the human-readable message/recommendedAction. */
function toAdminReadinessIssue(issue: ReadinessIssue) {
  return {
    code: issue.code,
    severity: issue.severity,
    entity_type: issue.entityType,
    message: issue.message,
    recommended_action: issue.recommendedAction,
    flavor_name: issue.flavorName ?? null,
  };
}

/** Fallback for a variant the readiness batch didn't return a result for (should not happen — every requested id is echoed back, see evaluateProductVariantReadinessBatch). */
function notReadyLegacyReadiness() {
  return {
    live_ready: false,
    readiness_code: 'INACTIVE' as const,
    missing_flavor_ids: [] as string[],
    readiness_status: 'NOT_READY' as const,
    completion_percentage: 0,
    blocking_issues: [] as ReturnType<typeof toReadinessIssueResponse>[],
    readiness_warnings: [] as ReturnType<typeof toReadinessIssueResponse>[],
  };
}

/** POS-PERF-P24 — stock_status defaults to 'unknown' whenever the stock-availability batch has no entry for this variant (NOT_READY, or no BOM components), never a confirmed 'out_of_stock'. */
function toStockStatusFields(stock: VariantStockResult | undefined) {
  return {
    stock_status: stock?.status ?? 'unknown',
    max_sellable_units: stock?.maxSellableUnits ?? null,
  };
}

function toLegacyReadiness(result: ProductVariantReadinessResult) {
  const missingFlavorIds = result.blockingIssues
    .filter((issue): issue is ReadinessIssue & { flavorId: string } => issue.code === 'FLAVOR_NOT_AVAILABLE_AT_BRANCH' && Boolean(issue.flavorId))
    .map((issue) => issue.flavorId);

  return {
    live_ready: result.sellable,
    readiness_code: pickLegacyReadinessCode(result.blockingIssues),
    missing_flavor_ids: missingFlavorIds,
    readiness_status: result.status,
    completion_percentage: result.completionPercentage,
    blocking_issues: result.blockingIssues.map(toReadinessIssueResponse),
    readiness_warnings: result.warnings.map(toReadinessIssueResponse),
  };
}

// --- Task 209.6 — Product Image Management (Admin Only) ---
// Mirrors expenses.service.ts's receipt-image storage pattern exactly:
// same supabaseAdmin client, same sharp compression shape, same
// short-lived-signed-URL-only read contract. A separate bucket
// ("product-images") keeps this asset class isolated from expense
// receipts/payment proofs/adjustment photos already living in Storage.
const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60;

function productImageKey(productId: string): string {
  return `${PRODUCT_IMAGE_BUCKET}/${productId}/image.webp`;
}

/**
 * Task 209.x perf fix — live profiling (2026-08-15) showed the catalog
 * minting a brand-new signed URL on every fetch even though the underlying
 * object hadn't changed, which defeats the browser's own HTTP cache: the
 * signed URL's token is part of the cache key, so a fresh token on every
 * request means a fresh cache miss on every request. This in-memory cache
 * reuses the same signed URL string across requests within its TTL (so the
 * browser can actually reuse its own cached image bytes), with a safety
 * margin so a URL is never handed out close enough to its real expiry to
 * die mid-render. Invalidated explicitly on upload/delete below — the
 * object path is stable per product (upsert overwrites in place), so a
 * stale cache entry would otherwise keep serving a signed URL for
 * old-but-still-valid-looking content after a replace.
 */
const SIGNED_URL_REUSE_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAtMs: number }>();

function cachedSignedUrl(imagePath: string): string | null {
  const entry = signedUrlCache.get(imagePath);
  if (!entry) return null;
  if (entry.expiresAtMs - SIGNED_URL_REUSE_SAFETY_MARGIN_MS <= Date.now()) return null;
  return entry.url;
}

function rememberSignedUrl(imagePath: string, url: string): void {
  signedUrlCache.set(imagePath, { url, expiresAtMs: Date.now() + PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS * 1000 });
}

function invalidateSignedUrl(imagePath: string): void {
  signedUrlCache.delete(imagePath);
}

/** Test-only escape hatch — the cache is module-level and otherwise persists for the life of the process (including across test cases in the same file). */
export function __resetSignedUrlCacheForTests(): void {
  signedUrlCache.clear();
}

async function getSignedProductImageUrl(imagePath: string): Promise<string> {
  const cached = cachedSignedUrl(imagePath);
  if (cached) return cached;
  const { data, error } = await supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET).createSignedUrl(imagePath, PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS);
  if (error || !data) throw new ProductError('PRODUCT_IMAGE_URL_FAILED', 'Could not generate the product image URL', 500);
  rememberSignedUrl(imagePath, data.signedUrl);
  return data.signedUrl;
}

/**
 * Task 209.7 — POS catalog image resolution. Batches every image-bearing
 * product into a single Storage call (createSignedUrls) instead of minting
 * one signed URL per product, so a catalog of N products costs one Storage
 * round trip regardless of how many have images. Never throws: if signing
 * fails outright or storage is unavailable, callers get an empty map and
 * every product falls back to has_image-with-no-url, which the terminal
 * already renders as a placeholder — a signing outage must not remove
 * products from the catalog.
 *
 * Task 209.x — every path already covered by a live, non-expiring-soon
 * cache entry (see cachedSignedUrl above) is served from that cache instead
 * of being re-signed; only the uncached/expiring subset hits Storage.
 */
async function getSignedProductImageUrls(imagePaths: string[]): Promise<Map<string, string>> {
  if (imagePaths.length === 0) return new Map();

  const result = new Map<string, string>();
  const uncachedPaths: string[] = [];
  for (const path of imagePaths) {
    const cached = cachedSignedUrl(path);
    if (cached) {
      result.set(path, cached);
    } else {
      uncachedPaths.push(path);
    }
  }
  if (uncachedPaths.length === 0) return result;

  try {
    const { data, error } = await supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET).createSignedUrls(uncachedPaths, PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS);
    if (error || !data) return result;
    for (const row of data) {
      if (!row.signedUrl) continue;
      result.set(row.path as string, row.signedUrl as string);
      rememberSignedUrl(row.path as string, row.signedUrl as string);
    }
    return result;
  } catch {
    return result;
  }
}

export const productsService = {
  async getAllProducts(_requestingUser: JwtPayload, filters: ProductListFilters) {
    const { products, total } = await productsRepository.findAll(filters);

    // One batched Storage call for every image-bearing product on this page,
    // instead of the frontend minting one signed URL per product via
    // GET /:productId/image after the list arrives — same pattern
    // getPosCatalog already uses (Task 209.7).
    const imagePaths = products.map((p) => (p as ListRow).imagePath).filter((path): path is string => Boolean(path));
    const signedImageUrlByPath = await getSignedProductImageUrls(imagePaths);

    return {
      products: products.map((p) => {
        const row = p as ListRow;
        const imageUrl = (row.imagePath && signedImageUrlByPath.get(row.imagePath)) || null;
        return toProductListItem(row, imageUrl);
      }),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getProductById(productId: string, _requestingUser: JwtPayload) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    return toProductDetailResponse(product as DetailRow);
  },

  async createProduct(data: CreateProductInput, createdBy: ActorContext, ipAddress: string | null) {
    if (data.status !== 'draft' && data.status !== 'active') {
      throw new ProductError('INVALID_CREATE_STATUS', 'A product can only be created with draft or active status', 422);
    }
    validateSeasonalRules({
      isSeasonal: data.is_seasonal,
      seasonalStartDate: data.seasonal_start_date,
      seasonalEndDate: data.seasonal_end_date,
    });

    // POS-PERF-P34R — a supervisor may only ever create a branch-exclusive
    // product scoped to one of their own branches: a non-exclusive product
    // cascades a branch_product_availability row to every active branch
    // company-wide (see createWithCascade), which would let a supervisor
    // provision catalog state at branches outside their assignment. This is
    // the safe, explicit, narrower rule — super_admin keeps the existing
    // broader (company-wide) creation capability.
    //
    // POS-PERF-P37 — an explicit branch_ids selection is the other accepted
    // supervisor shape. It is never inferred: a request carrying neither is
    // still rejected here, not treated as company-wide availability.
    if (createdBy.role === ROLES.SUPERVISOR && !data.branch_exclusive && !data.branch_ids) {
      throw new ProductError(
        'SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED',
        'As a supervisor, you must create this product scoped to your own branches',
        403,
      );
    }

    let branchExclusive = data.branch_exclusive;
    let exclusiveBranchId = data.exclusive_branch_id;
    let selectedBranchIds: string[] | undefined;
    if (data.branch_ids) {
      // POS-PERF-P37 — the whole (deduplicated) selection is authorized
      // before any write. One branch keeps the existing branch-exclusive
      // shape exactly; two or more share one product configuration.
      const uniqueBranchIds = [...new Set(data.branch_ids)];
      await assertBranchSelectionAuthorized(uniqueBranchIds, createdBy);
      if (uniqueBranchIds.length === 1) {
        branchExclusive = true;
        exclusiveBranchId = uniqueBranchIds[0];
      } else {
        selectedBranchIds = uniqueBranchIds;
      }
    } else if (data.branch_exclusive) {
      if (!data.exclusive_branch_id) {
        throw new ProductError('EXCLUSIVE_BRANCH_REQUIRED', 'exclusive_branch_id is required when branch_exclusive is true', 422);
      }
      const branch = await productsRepository.findActiveBranch(data.exclusive_branch_id);
      if (!branch) {
        throw new ProductError('EXCLUSIVE_BRANCH_NOT_FOUND', 'exclusive_branch_id must reference an active branch', 422);
      }

      // POS-PERF-P34 — a supervisor may only scope a branch-exclusive
      // product to one of their own active branch assignments (checked
      // against the database, never the JWT's stale branch_ids claim — see
      // hasBranchAccess). super_admin is unrestricted and never reaches
      // this branch since the router only lets super_admin/supervisor POST here.
      if (createdBy.role === ROLES.SUPERVISOR) {
        const allowed = await hasBranchAccess(
          { user_id: createdBy.id, role: createdBy.role, branch_ids: [] } as unknown as JwtPayload,
          data.exclusive_branch_id,
        );
        if (!allowed) {
          throw new ProductError('EXCLUSIVE_BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
        }
      }
    }

    if (data.category_id) {
      const category = await productCategoriesRepository.findById(data.category_id);
      if (!category) throw new ProductError('CATEGORY_NOT_FOUND', 'category_id does not reference an existing product category', 422);
    }

    const { product, cascadedBranchIds } = await productsRepository.createWithCascade(
      {
        name: data.name,
        description: data.description,
        category: data.category,
        categoryId: data.category_id,
        status: data.status,
        displayOrder: data.display_order,
        isSeasonal: data.is_seasonal,
        seasonalStartDate: data.seasonal_start_date,
        seasonalEndDate: data.seasonal_end_date,
        branchExclusive,
        exclusiveBranchId,
        selectedBranchIds,
      },
      createdBy.id,
    );

    const response = toProductDetailResponse(product as DetailRow);

    await recordAuditLog({
      action: 'PRODUCT_CREATED',
      entityType: 'product',
      entityId: product.id,
      actorId: createdBy.id,
      actorRole: createdBy.role,
      afterState: response,
      ipAddress,
    });

    // CR-001: creation cascades branch_product_availability atomically
    // (see productsRepository.createWithCascade) — this is a second,
    // separate audit entry describing that cascade's shape.
    await recordAuditLog({
      action: 'PRODUCT_CATALOG_CASCADE',
      entityType: 'product',
      entityId: product.id,
      actorId: createdBy.id,
      actorRole: createdBy.role,
      afterState: {
        branchExclusive,
        branchSelectionScoped: selectedBranchIds !== undefined,
        cascadedToBranchIds: cascadedBranchIds,
        branchCount: cascadedBranchIds.length,
      },
      ipAddress,
    });

    return response;
  },

  async updateProduct(productId: string, data: UpdateProductInput, updatedBy: ActorContext, ipAddress: string | null) {
    const before = await productsRepository.findById(productId);
    if (!before) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (before.status === 'archived') {
      throw new ProductError('PRODUCT_ARCHIVED', 'Archived products are read-only and cannot be updated', 409);
    }
    // POS-PERF-P35 — Admin's write access to the catalog is gone entirely;
    // a supervisor may edit only a product they themselves created, same
    // posture as createVariant/uploadProductImage (POS-PERF-P34R).
    if (updatedBy.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(before, updatedBy.id))) {
      throw new ProductError('PRODUCT_UPDATE_FORBIDDEN', 'You may only edit a product an active branch assignment gives you authority over', 403);
    }
    const mergedIsSeasonal = data.is_seasonal ?? before.isSeasonal;
    const mergedStart =
      data.seasonal_start_date !== undefined
        ? (data.seasonal_start_date ?? undefined)
        : before.seasonalStartDate
          ? isoDate(before.seasonalStartDate)
          : undefined;
    const mergedEnd =
      data.seasonal_end_date !== undefined
        ? (data.seasonal_end_date ?? undefined)
        : before.seasonalEndDate
          ? isoDate(before.seasonalEndDate)
          : undefined;
    validateSeasonalRules({ isSeasonal: mergedIsSeasonal, seasonalStartDate: mergedStart, seasonalEndDate: mergedEnd });

    if (data.category_id) {
      const category = await productCategoriesRepository.findById(data.category_id);
      if (!category) throw new ProductError('CATEGORY_NOT_FOUND', 'category_id does not reference an existing product category', 422);
    }

    // POS-PERF-P36R2 — the compare (expected_version vs. current) and the
    // write must be one atomic statement, not a separate check followed by
    // an unconditional update; see products.repository.ts's `update` for
    // why. `null` here means the version predicate matched zero rows: either
    // someone else's concurrent write already bumped the version, or (rare,
    // already excluded by the `before` lookup above) the row is gone.
    const product = await productsRepository.update(
      productId,
      {
        name: data.name,
        description: data.description,
        category: data.category,
        categoryId: data.category_id,
        displayOrder: data.display_order,
        isSeasonal: data.is_seasonal,
        seasonalStartDate: data.seasonal_start_date,
        seasonalEndDate: data.seasonal_end_date,
      },
      data.expected_version,
    );
    if (!product) {
      throw new ProductError(
        'PRODUCT_CONFLICT',
        'This product was changed by someone else since you loaded it. Reload to see the latest version before saving again.',
        409,
      );
    }

    const response = toProductDetailResponse(product as DetailRow);

    await recordAuditLog({
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: product.id,
      actorId: updatedBy.id,
      actorRole: updatedBy.role,
      beforeState: toProductDetailResponse(before as DetailRow),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async changeProductStatus(
    productId: string,
    data: ChangeStatusInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    // POS-PERF-P35 — global lifecycle transitions (discontinue/archive/
    // restore) move from super_admin to the supervisor who created the
    // product. Router guard is supervisorOnly now (super_admin cannot
    // reach this endpoint at all), but the ownership check still matters:
    // a supervisor who did NOT create this product must fall through to
    // the branch-scoped posture below exactly like `branch` does, never
    // silently inherit admin's old global power over someone else's product.
    if (!data.branch_id && actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(product, actor.id))) {
      throw new ProductError('PRODUCT_STATUS_FORBIDDEN', 'You may only change the lifecycle status of a product an active branch assignment gives you authority over', 403);
    }

    if (!data.branch_id && actor.role === ROLES.SUPERVISOR) {
      const allowed = GLOBAL_TRANSITIONS[product.status] ?? [];
      if (!allowed.includes(data.status)) {
        throw new ProductError(
          'INVALID_STATUS_TRANSITION',
          `Cannot transition a product from ${product.status} to ${data.status}`,
          409,
        );
      }

      const updated = await productsRepository.updateStatus(productId, data.status);

      if (data.status === 'discontinued' || data.status === 'archived') {
        await productsRepository.cascadeBranchAvailabilityOff(productId, actor.id);
        // CR-001: renamed from PRODUCT_STATUS_CASCADE — this is specifically
        // the "product removed/archived from the catalog" cascade the CR asks
        // to be distinguishable in the audit trail from ordinary status changes.
        await recordAuditLog({
          action: 'PRODUCT_CATALOG_REMOVAL_CASCADE',
          entityType: 'product',
          entityId: productId,
          actorId: actor.id,
          actorRole: actor.role,
          afterState: { cascadedTo: 'unavailable', triggeredBy: data.status },
          ipAddress,
        });
      } else if (product.status === 'archived' && data.status === 'active') {
        // Task 34 — Restore. Re-enables branch availability at every active
        // branch, mirroring createWithCascade's default cascade, so restore
        // needs no manual per-branch reconfiguration.
        await productsRepository.cascadeBranchAvailabilityOn(productId, actor.id);
        await recordAuditLog({
          action: 'PRODUCT_CATALOG_RESTORE_CASCADE',
          entityType: 'product',
          entityId: productId,
          actorId: actor.id,
          actorRole: actor.role,
          afterState: { cascadedTo: 'available', triggeredBy: data.status },
          ipAddress,
        });
      }

      await recordAuditLog({
        action: 'PRODUCT_STATUS_CHANGED',
        entityType: 'product',
        entityId: productId,
        actorId: actor.id,
        actorRole: actor.role,
        beforeState: { status: product.status },
        afterState: { status: updated.status, reason: data.reason ?? null },
        ipAddress,
      });

      return toProductDetailResponse(updated as DetailRow);
    }

    if (actor.role === ROLES.SUPERVISOR || actor.role === ROLES.BRANCH) {
      // CR-003: branch is now the operational role that flips its own
      // availability day to day; supervisor keeps the same branch-scoped
      // authority for oversight. branchGuard (router-level) already checked
      // data.branch_id is one this actor may act on.
      if (!data.branch_id) {
        throw new ProductError('BRANCH_ID_REQUIRED', 'branch_id is required for a branch-scoped status change', 422);
      }
      if (data.status !== 'active' && data.status !== 'temporarily_unavailable') {
        throw new ProductError(
          'INSUFFICIENT_PERMISSIONS',
          'Supervisor and branch accounts may only set branch availability to active or temporarily_unavailable',
          403,
        );
      }
      if (product.status === 'discontinued' || product.status === 'archived') {
        throw new ProductError(
          'PRODUCT_GLOBALLY_UNAVAILABLE',
          'This product is globally discontinued or archived and cannot be enabled at branch level',
          403,
        );
      }

      const isAvailable = data.status === 'active';
      assertSupervisorMayEnableAtBranch(product, data.branch_id, isAvailable, actor);
      const row = await productsRepository.upsertBranchProductAvailability(data.branch_id, productId, isAvailable, actor.id);

      await recordAuditLog({
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityType: 'branch_product_availability',
        entityId: row.id,
        actorId: actor.id,
        actorRole: actor.role,
        branchId: data.branch_id,
        afterState: { productId, isAvailable, reason: data.reason ?? null },
        ipAddress,
      });

      return toBranchAvailabilityRow(row);
    }

    throw new ProductError('INSUFFICIENT_PERMISSIONS', 'Only super_admin, supervisor, or branch may change product status', 403);
  },

  async createVariant(productId: string, data: CreateVariantInput, actor: ActorContext, ipAddress: string | null) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (product.status === 'archived') {
      throw new ProductError('PRODUCT_ARCHIVED', 'Archived products cannot receive new variants', 409);
    }
    // POS-PERF-P34R — configuration ownership: a supervisor may add variants
    // only to a product they themselves created, same posture as
    // uploadProductImage above.
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(product, actor.id))) {
      throw new ProductError('VARIANT_CREATE_FORBIDDEN', 'You may only add variants to a product an active branch assignment gives you authority over', 403);
    }

    if (data.lifecycle_status !== undefined && !VALID_LIFECYCLE_STATUSES.has(data.lifecycle_status)) {
      throw new ProductError('INVALID_LIFECYCLE_STATUS', `Invalid lifecycle_status: ${data.lifecycle_status}`, 422);
    }

    const variant = await productsRepository.createVariant(productId, {
      name: data.name,
      sizeLabel: data.size_label,
      basePrice: data.base_price,
      displayOrder: data.display_order,
      isActive: data.is_active,
      lifecycleStatus: data.lifecycle_status,
      createdById: actor.id,
    });
    const response = toVariantResponse({ ...variant, variantFlavors: [] });

    await recordAuditLog({
      action: 'PRODUCT_VARIANT_CREATED',
      entityType: 'product_variant',
      entityId: variant.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- CR-005 Sub-phase 3c — variant lifecycle ---

  async submitVariantForApproval(variantId: string, actor: ActorContext, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPERVISOR) {
      throw new ProductError('VARIANT_SUBMIT_FORBIDDEN', 'Only super_admin or supervisor may submit a variant for approval', 403);
    }

    const existing = await productsRepository.findVariantById(variantId);
    if (!existing) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    assertVariantTransition(existing.lifecycleStatus, 'PENDING_APPROVAL');

    const updated = await productsRepository.updateVariantLifecycle(variantId, { lifecycleStatus: 'PENDING_APPROVAL' });
    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    notifySuperAdmin(SOCKET_EVENTS.VARIANT_SUBMITTED_FOR_APPROVAL, response);

    await recordAuditLog({
      action: 'VARIANT_SUBMITTED_FOR_APPROVAL',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { lifecycleStatus: existing.lifecycleStatus },
      afterState: { lifecycleStatus: updated.lifecycleStatus },
      ipAddress,
    });

    return response;
  },

  async approveVariant(variantId: string, reason: string | undefined, actor: ActorContext, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ProductError('VARIANT_APPROVE_FORBIDDEN', 'Only super_admin may approve a variant', 403);
    }

    const existing = await productsRepository.findVariantById(variantId);
    if (!existing) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    assertVariantTransition(existing.lifecycleStatus, 'ACTIVE');

    const flavorSlots = await productsRepository.listVariantFlavorSlots(variantId);
    if (flavorSlots.length > 0) {
      assertFlavorSlotsWellFormed(flavorSlots);
    }

    await assertRecipesResolvableSomewhere(variantId);

    const updated = await productsRepository.updateVariantLifecycle(variantId, {
      lifecycleStatus: 'ACTIVE',
      approvedById: actor.id,
      approvedAt: new Date(),
      lastChangeReason: reason ?? null,
    });
    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    notifySuperAdmin(SOCKET_EVENTS.VARIANT_APPROVED, response);
    await notifyVariantBranches(existing.productId, SOCKET_EVENTS.VARIANT_APPROVED, response);

    await recordAuditLog({
      action: 'VARIANT_APPROVED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { reason: reason ?? null, gate_passed: true },
      ipAddress,
    });

    return response;
  },

  async rejectVariant(variantId: string, reason: string, actor: ActorContext, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ProductError('VARIANT_REJECT_FORBIDDEN', 'Only super_admin may reject a variant', 403);
    }
    if (!reason || !reason.trim()) {
      throw new ProductError('VARIANT_REJECT_REASON_REQUIRED', 'A reason is required to reject a variant', 400);
    }

    const existing = await productsRepository.findVariantById(variantId);
    if (!existing) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    assertVariantTransition(existing.lifecycleStatus, 'DRAFT');

    const updated = await productsRepository.updateVariantLifecycle(variantId, {
      lifecycleStatus: 'DRAFT',
      lastChangeReason: reason,
    });
    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    notifySuperAdmin(SOCKET_EVENTS.VARIANT_REJECTED, response);
    await notifyVariantBranches(existing.productId, SOCKET_EVENTS.VARIANT_REJECTED, response);

    await recordAuditLog({
      action: 'VARIANT_REJECTED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { reason },
      ipAddress,
    });

    return response;
  },

  async editActiveVariant(
    variantId: string,
    data: EditActiveVariantInput,
    reason: string,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ProductError('VARIANT_EDIT_ACTIVE_FORBIDDEN', 'Only super_admin may edit an active variant', 403);
    }
    if (!reason || !reason.trim()) {
      throw new ProductError('VARIANT_EDIT_REASON_REQUIRED', 'A reason is required to edit an active variant', 400);
    }

    const existing = await productsRepository.findVariantById(variantId);
    if (!existing) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
    if (existing.lifecycleStatus !== 'ACTIVE') {
      throw new ProductError('VARIANT_NOT_ACTIVE', 'Only an ACTIVE variant can be edited this way', 409);
    }

    const currentValues = {
      name: existing.name,
      sizeLabel: existing.sizeLabel,
      basePrice: existing.basePrice.toNumber(),
      vatableCapAmount: existing.vatableCapAmount ? existing.vatableCapAmount.toNumber() : null,
      displayOrder: existing.displayOrder,
      kcal: existing.kcal,
      maxFlavors: existing.maxFlavors,
    };

    const isMutation =
      (data.name !== undefined && data.name !== currentValues.name) ||
      (data.size_label !== undefined && data.size_label !== currentValues.sizeLabel) ||
      (data.base_price !== undefined && data.base_price !== currentValues.basePrice) ||
      (data.vatable_cap_amount !== undefined && data.vatable_cap_amount !== currentValues.vatableCapAmount) ||
      (data.display_order !== undefined && data.display_order !== currentValues.displayOrder) ||
      (data.kcal !== undefined && data.kcal !== currentValues.kcal) ||
      (data.max_flavors !== undefined && data.max_flavors !== currentValues.maxFlavors);

    if (!isMutation) {
      throw new ProductError('VARIANT_EDIT_NO_CHANGES', "No fields differ from the variant's current values", 400);
    }

    const newVersion = existing.version + 1;
    const snapshot = {
      variantId,
      version_before: existing.version,
      fields_before: currentValues,
      reason,
      changed_by: actor.id,
      changed_at: new Date().toISOString(),
    };

    const updated = await prisma.$transaction(async (tx) => {
      const variant = await productsRepository.updateVariantLifecycle(
        variantId,
        {
          name: data.name,
          sizeLabel: data.size_label,
          basePrice: data.base_price,
          vatableCapAmount: data.vatable_cap_amount,
          displayOrder: data.display_order,
          kcal: data.kcal,
          maxFlavors: data.max_flavors,
          version: newVersion,
          lastChangeReason: reason,
        },
        tx,
      );
      await productsRepository.insertVariantChangeLog(
        {
          productVariantId: variantId,
          version: newVersion,
          changedById: actor.id,
          reason,
          snapshotJson: snapshot as Prisma.InputJsonValue,
        },
        tx,
      );
      return variant;
    });

    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    notifySuperAdmin(SOCKET_EVENTS.VARIANT_EDITED, response);
    await notifyVariantBranches(existing.productId, SOCKET_EVENTS.VARIANT_EDITED, response);

    await recordAuditLog({
      action: 'VARIANT_EDITED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { version: newVersion, reason, fields_changed: Object.keys(data) },
      ipAddress,
    });

    return response;
  },

  async archiveVariant(variantId: string, reason: string | undefined, actor: ActorContext, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ProductError('VARIANT_ARCHIVE_FORBIDDEN', 'Only super_admin may archive a variant', 403);
    }

    const existing = await productsRepository.findVariantById(variantId);
    if (!existing) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    assertVariantTransition(existing.lifecycleStatus, 'ARCHIVED');

    const snapshot = {
      variantId,
      version_at_archive: existing.version,
      lifecycle_status_before: existing.lifecycleStatus,
      fields_before: {
        name: existing.name,
        sizeLabel: existing.sizeLabel,
        basePrice: existing.basePrice.toNumber(),
        vatableCapAmount: existing.vatableCapAmount ? existing.vatableCapAmount.toNumber() : null,
        displayOrder: existing.displayOrder,
        kcal: existing.kcal,
        maxFlavors: existing.maxFlavors,
        isActive: existing.isActive,
      },
      reason: reason ?? null,
      archived_by: actor.id,
      archived_at: new Date().toISOString(),
    };

    const updated = await prisma.$transaction(async (tx) => {
      const variant = await productsRepository.updateVariantLifecycle(
        variantId,
        { lifecycleStatus: 'ARCHIVED', lastChangeReason: reason ?? null },
        tx,
      );
      await productsRepository.insertVariantChangeLog(
        {
          productVariantId: variantId,
          version: existing.version,
          changedById: actor.id,
          reason: reason ?? 'archived',
          snapshotJson: snapshot as Prisma.InputJsonValue,
        },
        tx,
      );
      return variant;
    });

    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    notifySuperAdmin(SOCKET_EVENTS.VARIANT_ARCHIVED, response);
    await notifyVariantBranches(existing.productId, SOCKET_EVENTS.VARIANT_ARCHIVED, response);

    await recordAuditLog({
      action: 'VARIANT_ARCHIVED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { reason: reason ?? null },
      ipAddress,
    });

    return response;
  },

  async updateVariant(productId: string, variantId: string, data: UpdateVariantInput, actor: ActorContext, ipAddress: string | null) {
    const existing = await productsRepository.findVariantById(variantId);
    if (!existing || existing.productId !== productId) {
      throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
    }
    if (existing.product.status === 'archived') {
      throw new ProductError('PRODUCT_ARCHIVED', 'Archived products cannot have their variants updated', 409);
    }
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(existing.product, actor.id))) {
      throw new ProductError('VARIANT_UPDATE_FORBIDDEN', 'You may only update variants on a product an active branch assignment gives you authority over', 403);
    }
    // POS-PERF-P36 / P36R2 — explicit conflict instead of a silent
    // last-write-wins overwrite when two supervisors edit the same variant
    // concurrently. The compare and the write are one atomic statement (see
    // products.repository.ts's updateVariant); a null return means the
    // version predicate matched zero rows.
    const updated = await productsRepository.updateVariant(
      variantId,
      {
        name: data.name,
        sizeLabel: data.size_label,
        basePrice: data.base_price,
        displayOrder: data.display_order,
        isActive: data.is_active,
      },
      data.expected_version,
    );
    if (!updated) {
      throw new ProductError(
        'VARIANT_CONFLICT',
        'This variant was changed by someone else since you loaded it. Reload and try again.',
        409,
      );
    }
    const response = toVariantResponse({ ...updated, variantFlavors: existing.variantFlavors });

    await recordAuditLog({
      action: 'PRODUCT_VARIANT_UPDATED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toVariantResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async getBranchAvailabilityMatrix(productId: string, _actor: ActorContext) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    const [branches, rows] = await Promise.all([
      productsRepository.allActiveBranches(),
      productsRepository.findBranchProductAvailability(productId),
    ]);

    const rowsByBranch = new Map(rows.map((row) => [row.branchId, row]));

    return branches.map((branch) => {
      const row = rowsByBranch.get(branch.id);
      return {
        branch_id: branch.id,
        branch_code: branch.code,
        branch_name: branch.name,
        city: branch.city,
        is_available: row?.isAvailable ?? false,
        updated_at: row?.updatedAt.toISOString() ?? null,
      };
    });
  },

  async updateBranchProductAvailability(
    productId: string,
    branchId: string,
    isAvailable: boolean,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    if (isAvailable && (product.status === 'discontinued' || product.status === 'archived')) {
      throw new ProductError(
        'PRODUCT_GLOBALLY_UNAVAILABLE',
        'Cannot enable a globally discontinued or archived product for a branch',
        409,
      );
    }
    assertSupervisorMayEnableAtBranch(product, branchId, isAvailable, actor);

    const row = await productsRepository.upsertBranchProductAvailability(branchId, productId, isAvailable, actor.id);

    await recordAuditLog({
      action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
      entityType: 'branch_product_availability',
      entityId: row.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { productId, isAvailable },
      ipAddress,
    });

    return toBranchAvailabilityRow(row);
  },

  /**
   * POS-PERF-P36R5 — the router's branchGuard only ever extracts a single
   * top-level branch_id (lib/request.ts's extractBranchId), but this
   * route's body is `{ updates: [{ branch_id, is_available }, ...] }` — no
   * top-level branch_id exists for it to find, so branchGuard 400'd
   * BRANCH_ID_REQUIRED for every supervisor caller (its only allowed role —
   * POS-PERF-P35 removed super_admin's catalog write access) before this
   * method ever ran. The route no longer runs branchGuard; authorization for
   * every branch_id in the array happens here instead, checked against the
   * actor's live branch access (same hasBranchAccess query branchGuard
   * itself uses) before any row is touched — one denied branch_id fails the
   * whole batch, not just its own row, since "every active branch admin
   * flips availability for" is the gate, not "intersects any branch".
   */
  async bulkUpdateBranchProductAvailability(
    productId: string,
    updates: { branch_id: string; is_available: boolean }[],
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    if (actor.role !== ROLES.SUPER_ADMIN) {
      const actorPayload = { user_id: actor.id, role: actor.role, branch_ids: [] } as unknown as JwtPayload;
      for (const update of updates) {
        if (!(await hasBranchAccess(actorPayload, update.branch_id))) {
          throw new ProductError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
        }
      }
    }

    const globallyLocked = product.status === 'discontinued' || product.status === 'archived';
    if (globallyLocked && updates.some((u) => u.is_available)) {
      throw new ProductError(
        'PRODUCT_GLOBALLY_UNAVAILABLE',
        'Cannot enable a globally discontinued or archived product for a branch',
        409,
      );
    }
    for (const update of updates) {
      assertSupervisorMayEnableAtBranch(product, update.branch_id, update.is_available, actor);
    }

    const rows = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const update of updates) {
        results.push(
          await productsRepository.upsertBranchProductAvailability(update.branch_id, productId, update.is_available, actor.id, tx),
        );
      }
      return results;
    });

    for (const row of rows) {
      await recordAuditLog({
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityType: 'branch_product_availability',
        entityId: row.id,
        actorId: actor.id,
        actorRole: actor.role,
        branchId: row.branchId,
        afterState: { productId, isAvailable: row.isAvailable },
        ipAddress,
      });
    }

    return { updated_count: rows.length, product_id: productId };
  },

  /**
   * Phase D1 — Admin Readiness panel. branchId === 'all' returns a read-only,
   * per-branch summary (publishing is disabled in that scope by the caller —
   * the router/UI, not this method, enforces that); a specific branchId
   * returns the full detail the readiness tab and the publish gate both use.
   * Every computation is delegated to productReadinessService; this method
   * only maps its result to the wire format and adds the current
   * BranchProductAvailability flag.
   */
  async getProductReadiness(productId: string, branchId: string) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    if (branchId === 'all') {
      const [branches, availabilityRows] = await Promise.all([
        productsRepository.allActiveBranches(),
        productsRepository.findBranchProductAvailability(productId),
      ]);
      const availabilityByBranch = new Map(availabilityRows.map((r) => [r.branchId, r.isAvailable]));

      const results = await Promise.all(
        branches.map(async (branch) => {
          const readiness = await productReadinessService.evaluateProductReadiness({ productId, branchId: branch.id });
          return {
            branch_id: branch.id,
            branch_name: branch.name,
            status: readiness.status,
            sellable: readiness.sellable,
            completion_percentage: readiness.completionPercentage,
            is_published: availabilityByBranch.get(branch.id) ?? false,
            blocking_issue_count: readiness.blockingIssues.length,
            warning_count: readiness.warnings.length,
          };
        }),
      );

      return { scope: 'all_branches' as const, product_id: productId, branches: results };
    }

    const readiness = await productReadinessService.evaluateProductReadiness({ productId, branchId });
    return {
      scope: 'branch' as const,
      product_id: productId,
      branch_id: branchId,
      status: readiness.status,
      sellable: readiness.sellable,
      completion_percentage: readiness.completionPercentage,
      variant_count: readiness.variantCount,
      eligible_variant_count: readiness.eligibleVariantCount,
      ready_variant_count: readiness.readyVariantCount,
      blocking_issues: readiness.blockingIssues.map(toAdminReadinessIssue),
      warnings: readiness.warnings.map(toAdminReadinessIssue),
      variants: readiness.variants.map((v) => ({
        product_variant_id: v.productVariantId,
        variant_name: v.variantName,
        status: v.status,
        sellable: v.sellable,
        completion_percentage: v.completionPercentage,
        recipe_ready: v.recipeReady,
        inventory_mapping_ready: v.inventoryMappingReady,
        blocking_issues: v.blockingIssues.map(toAdminReadinessIssue),
        warnings: v.warnings.map(toAdminReadinessIssue),
      })),
      publish_is_variant_level: false as const,
    };
  },

  /**
   * Publish = enable BranchProductAvailability for this product at one
   * branch, gated by productReadinessService. BRANCH_NOT_AVAILABLE is
   * excluded from the gate: it is precisely the flag this action flips, so
   * gating on it would make every first-time publish permanently blocked.
   * Never auto-creates mappings or fixes anything — a NOT_READY product is
   * simply rejected with its exact blocking issues.
   */
  /**
   * POS-PERF-P36R2 — the readiness evaluation and the availability flip
   * used to be two separate, unlocked steps: evaluate, then
   * updateBranchProductAvailability. A concurrent Recipe/BOM delete (or any
   * other readiness-affecting mutation, see productCatalogLockId's doc)
   * landing in between could publish a product whose configuration was
   * invalidated before the flip committed. Taking this product's advisory
   * lock before evaluating readiness, and holding it through the
   * availability write, serializes publish against every mutation that
   * also takes this lock — proven with a real concurrent-Postgres race in
   * products.publish-safety.integration.test.ts.
   */
  async publishProduct(productId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    const product = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(productId)})`;

      // POS-PERF-P37 — authorization (branch-spread guard) before readiness,
      // so a branch the product may never be enabled at gets 403, not a
      // readiness report for that branch.
      const existing = await productsRepository.findById(productId);
      if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
      if (existing.status === 'discontinued' || existing.status === 'archived') {
        throw new ProductError(
          'PRODUCT_GLOBALLY_UNAVAILABLE',
          'Cannot enable a globally discontinued or archived product for a branch',
          409,
        );
      }
      assertSupervisorMayEnableAtBranch(existing, branchId, true, actor);

      const readiness = await productReadinessService.evaluateProductReadiness({ productId, branchId });
      const gatingBlockers = readiness.blockingIssues.filter((i) => i.code !== 'BRANCH_NOT_AVAILABLE');

      if (readiness.eligibleVariantCount === 0 || gatingBlockers.length > 0) {
        throw new ProductError('PRODUCT_NOT_READY', 'Product is not ready to publish at this branch', 409, {
          blocking_issues: (gatingBlockers.length > 0 ? gatingBlockers : readiness.blockingIssues).map(toAdminReadinessIssue),
        });
      }

      return productsRepository.upsertBranchProductAvailability(branchId, productId, true, actor.id, tx);
    });

    await recordAuditLog({
      action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
      entityType: 'branch_product_availability',
      entityId: product.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { productId, isAvailable: true },
      ipAddress,
    });

    return toBranchAvailabilityRow(product);
  },

  /**
   * POS-PERF-P37 — Review's "Add to POS" across the builder's whole branch
   * selection, all-or-nothing. Under the same advisory lock publishProduct
   * takes, it re-checks the actor's live assignment to every branch,
   * the branch-spread guard, and readiness at each branch — then flips every
   * row in the same transaction. Any failure (one branch not ready, one
   * branch revoked) throws before a single row is written, so the product is
   * never left published at only part of the selection. A retry after
   * success is a no-op upsert of the same unique (branch, product) rows.
   *
   * Readiness, not stock level, is the gate: a branch missing InventoryStock
   * setup for a recipe item (INVENTORY_STOCK_MISSING) blocks publication,
   * while a branch that simply has low or zero stock does not — shortage
   * stays a checkout-time INSUFFICIENT_STOCK outcome, never a
   * configuration error.
   */
  async publishProductToBranches(productId: string, branchIds: string[], actor: ActorContext, ipAddress: string | null) {
    const uniqueBranchIds = [...new Set(branchIds)];

    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(productId)})`;

      const existing = await productsRepository.findById(productId);
      if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
      if (existing.status === 'discontinued' || existing.status === 'archived') {
        throw new ProductError(
          'PRODUCT_GLOBALLY_UNAVAILABLE',
          'Cannot enable a globally discontinued or archived product for a branch',
          409,
        );
      }

      const branches = await assertBranchSelectionAuthorized(uniqueBranchIds, actor);
      for (const branch of branches) {
        assertSupervisorMayEnableAtBranch(existing, branch.id, true, actor);
      }

      const notReady: { branch_id: string; branch_name: string; blocking_issues: ReturnType<typeof toAdminReadinessIssue>[] }[] = [];
      for (const branch of branches) {
        const readiness = await productReadinessService.evaluateProductReadiness({ productId, branchId: branch.id });
        const gatingBlockers = readiness.blockingIssues.filter((i) => i.code !== 'BRANCH_NOT_AVAILABLE');
        if (readiness.eligibleVariantCount === 0 || gatingBlockers.length > 0) {
          notReady.push({
            branch_id: branch.id,
            branch_name: branch.name,
            blocking_issues: (gatingBlockers.length > 0 ? gatingBlockers : readiness.blockingIssues).map(toAdminReadinessIssue),
          });
        }
      }
      if (notReady.length > 0) {
        throw new ProductError(
          'PRODUCT_NOT_READY',
          `Product is not ready to publish at ${notReady.map((b) => b.branch_name).join(', ')}. Nothing was published.`,
          409,
          { branches: notReady, blocking_issues: notReady.flatMap((b) => b.blocking_issues) },
        );
      }

      const written = [];
      for (const branch of branches) {
        written.push(await productsRepository.upsertBranchProductAvailability(branch.id, productId, true, actor.id, tx));
      }
      return written;
    });

    for (const row of rows) {
      await recordAuditLog({
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityType: 'branch_product_availability',
        entityId: row.id,
        actorId: actor.id,
        actorRole: actor.role,
        branchId: row.branchId,
        afterState: { productId, isAvailable: true, publishedBranchIds: uniqueBranchIds },
        ipAddress,
      });
    }

    return { product_id: productId, branches: rows.map(toBranchAvailabilityRow) };
  },

  /** Unpublish = disable BranchProductAvailability only — never deletes configuration, archives variants, or touches ProductInventory. No readiness gate needed to turn something off. */
  async unpublishProduct(productId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    return this.updateBranchProductAvailability(productId, branchId, false, actor, ipAddress);
  },

  /**
   * Phase 10 POS terminal catalog — a lean, staff-accessible read model
   * distinct from getAllProducts (admin/supervisor only), so the terminal
   * never computes pricing from a client-trusted base_price.
   *
   * Phase B (CR-008) — live POS readiness is now delegated to
   * productReadinessService, the single authoritative readiness engine also
   * used elsewhere (see product-readiness.service.ts). One batched call
   * across every variant on this branch avoids N+1, mirroring the batching
   * this function already did for ProductInventory mappings pre-Phase B.
   */
  async getPosCatalog(branchId: string) {
    const [products, disabledFlavorIds] = await Promise.all([
      productsRepository.findCatalogForBranch(branchId),
      productsRepository.findDisabledFlavorIds(branchId),
    ]);
    const disabledFlavors = new Set(disabledFlavorIds);

    const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
    const readinessResults = await productReadinessService.evaluateProductVariantReadinessBatch({ branchId, productVariantIds: variantIds });
    const readinessByVariantId = new Map(readinessResults.map((result) => [result.productVariantId, result]));

    // POS-PERF-P24 — quantity-based stock status, only meaningful for a
    // variant that's already config/BOM-ready (sellable); a NOT_READY
    // variant keeps its existing readiness messaging and gets 'unknown'
    // rather than a stock figure that would be misleading without a recipe.
    //
    // POS-PERF-P24R — each sellable variant's flavors (minus any disabled at
    // this branch) are passed through too, so the stock check covers every
    // configuration a cashier could actually sell, not just the base recipe.
    const sellableVariantIds = new Set(readinessResults.filter((r) => r.sellable).map((r) => r.productVariantId));
    const stockRequests = products.flatMap((product) =>
      product.variants
        .filter((variant) => sellableVariantIds.has(variant.id))
        .map((variant) => ({
          productVariantId: variant.id,
          flavorIds: variant.variantFlavors.filter((vf) => !disabledFlavors.has(vf.flavorId)).map((vf) => vf.flavorId),
        })),
    );
    const stockByVariantId = await stockAvailabilityService.evaluateCatalogStock(branchId, stockRequests);

    // Task 209.7 — one batched Storage call for every image-bearing product
    // on this branch's catalog, instead of an N+1 signed-URL mint per product.
    const imagePaths = products.map((product) => product.imagePath).filter((path): path is string => Boolean(path));
    const signedImageUrlByPath = await getSignedProductImageUrls(imagePaths);

    const catalogProducts = products.map((product) => {
      const variants = product.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        size_label: variant.sizeLabel,
        price: variant.basePrice.toNumber(),
        vatable_cap_amount: variant.vatableCapAmount?.toNumber() ?? null,
        ...(() => {
          const readiness = readinessByVariantId.get(variant.id);
          return readiness ? toLegacyReadiness(readiness) : notReadyLegacyReadiness();
        })(),
        ...toStockStatusFields(stockByVariantId.get(variant.id)),
        flavors: variant.variantFlavors
          .filter((vf) => !disabledFlavors.has(vf.flavorId))
          .map((vf) => ({
            flavor_id: vf.flavorId,
            name: vf.flavor.name,
            color_hex: vf.flavor.colorHex,
            price_premium: vf.pricePremium.toNumber(),
          })),
        option_groups: variant.optionGroupAssignments
          .filter((assignment) => assignment.optionGroup.isActive)
          .map((assignment) => ({
            id: assignment.optionGroup.id,
            name: assignment.optionGroup.name,
            pos_button_label: assignment.optionGroup.posButtonLabel,
            selection_type: assignment.optionGroup.selectionType,
            min_selections: assignment.optionGroup.minSelections,
            max_selections: assignment.optionGroup.maxSelections,
            required: assignment.required ?? assignment.optionGroup.required,
            // Empty allowedOptions means "all options" — fall back to every
            // active option in the assigned group (CR-008 R11/R12).
            options:
              assignment.allowedOptions.length > 0
                ? assignment.allowedOptions
                    .filter((allowed) => allowed.productOption.isActive)
                    .map((allowed) => ({
                      id: allowed.productOption.id,
                      name: allowed.productOption.name,
                      price_adjustment: allowed.productOption.priceAdjustment.toNumber(),
                      sort_order: allowed.productOption.sortOrder,
                      is_active: allowed.productOption.isActive,
                    }))
                : assignment.optionGroup.options.map((option) => ({
                    id: option.id,
                    name: option.name,
                    price_adjustment: option.priceAdjustment.toNumber(),
                    sort_order: option.sortOrder,
                    is_active: option.isActive,
                  })),
          })),
        flavor_slots: variant.flavorSlots
          .slice()
          .sort((a, b) => a.slotIndex - b.slotIndex)
          .map((slot) => ({
            slot_index: slot.slotIndex,
            label: slot.label,
            required: slot.required,
            snack_options: slot.snackOptions
              .map((so) => so.snackProductVariant)
              .filter(
                (sv) => sv.isActive && sv.product.status === 'active' && sv.product.branchAvailability[0]?.isAvailable === true,
              )
              .map((sv) => ({
                product_variant_id: sv.id,
                product_name: sv.product.name,
                variant_name: sv.name,
                flavors: sv.variantFlavors
                  .filter((vf) => !disabledFlavors.has(vf.flavorId))
                  .map((vf) => ({
                    flavor_id: vf.flavorId,
                    name: vf.flavor.name,
                    color_hex: vf.flavor.colorHex,
                    price_premium: vf.pricePremium.toNumber(),
                  })),
              }))
              .sort((a, b) => a.product_name.localeCompare(b.product_name) || a.variant_name.localeCompare(b.variant_name)),
          })),
      }));
      return {
        id: product.id,
        name: product.name,
        // CR-008: canonical ProductCategory (via categoryId) takes priority
        // over the legacy free-text `category` column once it's active;
        // falls back to the legacy value for products never migrated to it.
        category: product.productCategory?.isActive ? product.productCategory.name : product.category,
        has_image: Boolean(product.imagePath),
        image_url: (product.imagePath && signedImageUrlByPath.get(product.imagePath)) || null,
        variants,
      };
    });

    const categories = [...new Set(catalogProducts.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort();

    return { categories, products: catalogProducts };
  },

  /**
   * POS-PERF-P24 — cart-wide stock pre-check fired at discrete cashier
   * checkpoints (Add-ons/Mix & Max confirm, cart quantity increase), never
   * per keystroke or per product-card render. Read-only; the atomic
   * reservation at checkout (transactions.service.ts) remains the final guard.
   */
  async checkCartAvailability(
    branchId: string,
    lines: { productVariantId: string; flavorId?: string | null; selectedFlavors?: { slotIndex: number; snackProductVariantId: string; flavorId: string }[]; quantity: number }[],
  ) {
    return stockAvailabilityService.evaluateCartAvailability(branchId, lines);
  },

  async deleteProduct(productId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = await productsRepository.findById(productId);
    if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    // POS-PERF-P35 — see updateProduct's ownership check above.
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(existing, actor.id))) {
      throw new ProductError('PRODUCT_DELETE_FORBIDDEN', 'You may only delete a product an active branch assignment gives you authority over', 403);
    }

    try {
      await productsRepository.deleteProductCascade(
        productId,
        existing.variants.map((v) => v.id),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ProductError(
          'PRODUCT_HAS_DEPENDENCIES',
          'Cannot delete: product has associated transactions. Change status to Archived instead.',
          409,
        );
      }
      throw error;
    }

    await recordAuditLog({
      action: 'PRODUCT_DELETED',
      entityType: 'product',
      entityId: productId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toProductDetailResponse(existing as DetailRow),
      ipAddress,
    });
  },

  /**
   * POS-PERF-P36R4 — scoped copy path for a supervisor who controls only
   * some of a shared product's branches: hasActiveCatalogAuthorityForProduct
   * now requires authority over every branch the product is configured at
   * (catalog-authority.ts), so such a supervisor can no longer edit the
   * shared rows in place (that would silently change branches they don't
   * control). This creates a branch-exclusive copy, scoped to one branch
   * they DO control, that they fully own and can edit independently —
   * the source product and every other branch it sells at are untouched.
   */
  async forkProductForBranch(productId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    const source = await productsRepository.findById(productId);
    if (!source) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    if (source.branchExclusive) {
      throw new ProductError('PRODUCT_ALREADY_BRANCH_EXCLUSIVE', 'This product is already branch-exclusive and does not need to be forked', 409);
    }

    if (!source.branchAvailability.some((a) => a.branchId === branchId)) {
      throw new ProductError('BRANCH_NOT_CONFIGURED_FOR_PRODUCT', 'This branch is not one this product is configured at', 422);
    }

    // Router-level branchGuard already confirmed the actor has active
    // authority over branchId specifically (hasBranchAccess) — no further
    // authority check is needed: forking is deliberately scoped to the ONE
    // branch the actor controls, not the product's full branch set.
    const existingFork = await productsRepository.findForkCopy(productId, branchId);
    if (existingFork) {
      return toProductDetailResponse(existingFork as DetailRow);
    }

    let forked;
    try {
      forked = await productsRepository.forkProductCascade(productId, branchId, actor.id);
    } catch (error) {
      // Concurrent fork request for the same (productId, branchId) pair won
      // the race first — the unique index on (forkedFromProductId,
      // exclusiveBranchId) rejected this one. Return the winner's row
      // instead of a duplicate or an error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await productsRepository.findForkCopy(productId, branchId);
        if (winner) return toProductDetailResponse(winner as DetailRow);
      }
      throw error;
    }
    if (!forked) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    const response = toProductDetailResponse(forked as DetailRow);

    await recordAuditLog({
      action: 'PRODUCT_FORKED_FOR_BRANCH',
      entityType: 'product',
      entityId: forked.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { forkedFromProductId: productId, branchId },
      ipAddress,
    });

    return response;
  },

  /**
   * POS-PERF-P36R5 — explicit replacement. A branch copy made by
   * forkProductForBranch starts draft/unavailable (createWithCascade's
   * default never runs for a fork — forkProductCascade inserts
   * BranchProductAvailability with isAvailable: false explicitly) so its
   * mere existence never hides the source or adds a second sellable entry.
   * This is the one action that flips that: the supervisor explicitly
   * chooses to make their edited copy the sellable product at their branch,
   * replacing the source there (and only there — every other branch the
   * source sells at is untouched).
   *
   * Validates the copy's own readiness at its branch first (same gate
   * publishProduct uses) — a not-ready copy is rejected with its blocking
   * issues and NEITHER row is touched. The two availability flips (copy on,
   * source off) happen inside one transaction holding both products'
   * productCatalogLockId (locked in a fixed sorted order to avoid a
   * deadlock against a concurrent replace/publish touching the same pair in
   * the opposite order) — a crash or thrown error between them rolls back
   * atomically, so cancellation/failure can never leave both or neither
   * available. Existing carts referencing the source are safe with no new
   * code: transactions.service.ts's checkout path already re-evaluates
   * sellable/readiness per cart line at checkout time (not from whatever the
   * cart was built against), so a stale cart line against the now-disabled
   * source fails checkout with PRODUCT_UNAVAILABLE instead of silently
   * selling against disabled availability. Historical sales/pending
   * deductions keep referencing the source product's original id/variant
   * ids untouched — this only ever writes BranchProductAvailability.
   */
  async replaceSharedProductAtBranch(copyProductId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    const copy = await productsRepository.findById(copyProductId);
    if (!copy) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    if (!copy.branchExclusive || !copy.exclusiveBranchId || !copy.forkedFromProductId) {
      throw new ProductError(
        'PRODUCT_NOT_A_BRANCH_COPY',
        'Only a branch copy created via fork-to-branch can replace its source',
        422,
      );
    }
    // branchGuard (router) already confirmed the actor has active authority
    // over branch_id; this confirms branch_id is actually the copy's own
    // branch, not a different branch the actor also happens to control —
    // the copy can only ever replace the source at the one branch it was
    // forked for.
    if (copy.exclusiveBranchId !== branchId) {
      throw new ProductError('BRANCH_MISMATCH', 'This branch copy was not forked for the given branch_id', 422);
    }

    const source = await productsRepository.findById(copy.forkedFromProductId);
    if (!source) throw new ProductError('PRODUCT_NOT_FOUND', 'Source product not found', 404);

    const firstId = source.id < copy.id ? source.id : copy.id;
    const secondId = source.id < copy.id ? copy.id : source.id;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(firstId)})`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(secondId)})`;

      const readiness = await productReadinessService.evaluateProductReadiness({ productId: copy.id, branchId });
      const gatingBlockers = readiness.blockingIssues.filter((i) => i.code !== 'BRANCH_NOT_AVAILABLE');
      if (readiness.eligibleVariantCount === 0 || gatingBlockers.length > 0) {
        throw new ProductError('PRODUCT_NOT_READY', 'The branch copy is not ready to replace the source product at this branch', 409, {
          blocking_issues: (gatingBlockers.length > 0 ? gatingBlockers : readiness.blockingIssues).map(toAdminReadinessIssue),
        });
      }

      const copyAvailability = await productsRepository.upsertBranchProductAvailability(branchId, copy.id, true, actor.id, tx);
      const sourceAvailability = await productsRepository.upsertBranchProductAvailability(branchId, source.id, false, actor.id, tx);
      return { copyAvailability, sourceAvailability };
    });

    await recordAuditLog({
      action: 'PRODUCT_REPLACED_AT_BRANCH',
      entityType: 'product',
      entityId: copy.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      beforeState: { sourceProductId: source.id, sourceAvailableAtBranch: true, copyAvailableAtBranch: false },
      afterState: { sourceProductId: source.id, sourceAvailableAtBranch: false, copyProductId: copy.id, copyAvailableAtBranch: true },
      ipAddress,
    });

    return {
      copy: toBranchAvailabilityRow(result.copyAvailability),
      source: toBranchAvailabilityRow(result.sourceAvailability),
    };
  },

  async deleteVariant(productId: string, variantId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = await productsRepository.findVariantById(variantId);
    if (!existing || existing.productId !== productId) {
      throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
    }
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(existing.product, actor.id))) {
      throw new ProductError('VARIANT_DELETE_FORBIDDEN', 'You may only delete variants on a product an active branch assignment gives you authority over', 403);
    }

    try {
      await productsRepository.deleteVariantCascade(variantId);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ProductError(
          'VARIANT_HAS_DEPENDENCIES',
          'Cannot delete: variant has associated transactions. Change status to Archived instead.',
          409,
        );
      }
      throw error;
    }

    await recordAuditLog({
      action: 'PRODUCT_VARIANT_DELETED',
      entityType: 'product_variant',
      entityId: variantId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toVariantResponse(existing),
      ipAddress,
    });
  },

  // --- CR-005 Sub-phase 3d — flavor slot CRUD ---

  async addFlavorSlot(
    variantId: string,
    data: AddFlavorSlotInput,
    reason: string | undefined,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<ProductFlavorSlot> {
    return performSlotEditWithActiveGovernance(variantId, reason, actor, ipAddress, 'ADD_SLOT', async (tx, variant) => {
      if (variant.maxFlavors === 0) {
        throw new ProductError('VARIANT_DOES_NOT_ACCEPT_FLAVORS', 'This variant does not accept flavor slots (maxFlavors is 0)', 400);
      }

      const currentCount = await productsRepository.countVariantFlavorSlots(variantId, tx);
      if (currentCount >= variant.maxFlavors) {
        throw new ProductError(
          'VARIANT_MAX_FLAVORS_EXCEEDED',
          `Variant allows maximum ${variant.maxFlavors} flavor slots; use editActiveVariant to raise maxFlavors first.`,
          409,
        );
      }

      if (!(data.flavorQty > 0)) {
        throw new ProductError('VARIANT_SLOT_INVALID_QUANTITY', 'flavorQty must be greater than 0', 400);
      }
      if (!data.unit || !data.unit.trim()) {
        throw new ProductError('VARIANT_SLOT_INVALID_UNIT', 'unit must be a non-empty string', 400);
      }

      return productsRepository.insertFlavorSlot(
        {
          productVariantId: variantId,
          slotIndex: currentCount,
          label: data.label,
          flavorQty: new Prisma.Decimal(data.flavorQty),
          unit: data.unit,
          required: data.required ?? true,
        },
        tx,
      );
    });
  },

  async updateFlavorSlot(
    slotId: string,
    data: UpdateFlavorSlotInput,
    reason: string | undefined,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<ProductFlavorSlot> {
    const slot = await productsRepository.findFlavorSlotById(slotId);
    if (!slot) throw new ProductError('VARIANT_SLOT_NOT_FOUND', 'Flavor slot not found', 404);

    return performSlotEditWithActiveGovernance(slot.productVariantId, reason, actor, ipAddress, 'UPDATE_SLOT', async (tx) => {
      const current = await productsRepository.findFlavorSlotById(slotId, tx);
      if (!current) throw new ProductError('VARIANT_SLOT_NOT_FOUND', 'Flavor slot not found', 404);

      const isMutation =
        (data.label !== undefined && data.label !== current.label) ||
        (data.flavorQty !== undefined && data.flavorQty !== current.flavorQty.toNumber()) ||
        (data.unit !== undefined && data.unit !== current.unit) ||
        (data.required !== undefined && data.required !== current.required);

      if (!isMutation) {
        throw new ProductError('VARIANT_SLOT_EDIT_NO_CHANGES', "No fields differ from the slot's current values", 400);
      }
      if (data.flavorQty !== undefined && !(data.flavorQty > 0)) {
        throw new ProductError('VARIANT_SLOT_INVALID_QUANTITY', 'flavorQty must be greater than 0', 400);
      }
      if (data.unit !== undefined && !data.unit.trim()) {
        throw new ProductError('VARIANT_SLOT_INVALID_UNIT', 'unit must be a non-empty string', 400);
      }

      return productsRepository.updateFlavorSlot(
        slotId,
        {
          label: data.label,
          flavorQty: data.flavorQty !== undefined ? new Prisma.Decimal(data.flavorQty) : undefined,
          unit: data.unit,
          required: data.required,
        },
        tx,
      );
    });
  },

  async removeFlavorSlot(slotId: string, reason: string | undefined, actor: ActorContext, ipAddress: string | null): Promise<void> {
    const slot = await productsRepository.findFlavorSlotById(slotId);
    if (!slot) throw new ProductError('VARIANT_SLOT_NOT_FOUND', 'Flavor slot not found', 404);

    await performSlotEditWithActiveGovernance(slot.productVariantId, reason, actor, ipAddress, 'REMOVE_SLOT', async (tx) => {
      await productsRepository.deleteFlavorSlot(slotId, tx);
      await productsRepository.shiftFlavorSlotIndicesDown(slot.productVariantId, slot.slotIndex, tx);
    });
  },

  async reorderFlavorSlots(
    variantId: string,
    data: ReorderFlavorSlotsInput,
    reason: string | undefined,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<ProductFlavorSlot[]> {
    return performSlotEditWithActiveGovernance(variantId, reason, actor, ipAddress, 'REORDER_SLOTS', async (tx) => {
      const currentSlots = await productsRepository.listVariantFlavorSlots(variantId, tx);

      if (data.slotIds.length !== currentSlots.length) {
        throw new ProductError('VARIANT_SLOT_REORDER_LENGTH_MISMATCH', 'slotIds must include every current slot exactly once', 400);
      }

      const currentIds = new Set(currentSlots.map((s) => s.id));
      const seen = new Set<string>();
      for (const id of data.slotIds) {
        if (!currentIds.has(id)) {
          throw new ProductError('VARIANT_SLOT_REORDER_INVALID_ID', `Slot ${id} does not belong to this variant`, 400);
        }
        if (seen.has(id)) {
          throw new ProductError('VARIANT_SLOT_REORDER_DUPLICATE_ID', `Slot ${id} appears more than once in slotIds`, 400);
        }
        seen.add(id);
      }

      await productsRepository.rewriteFlavorSlotOrder(variantId, data.slotIds, tx);

      return productsRepository.listVariantFlavorSlots(variantId, tx);
    });
  },

  async listFlavorSlots(variantId: string, _actor: ActorContext): Promise<ProductFlavorSlot[]> {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    return productsRepository.listVariantFlavorSlots(variantId);
  },

  /**
   * POS-PERF-P36R — ProductFlavorSlotSnackOption CRUD. snackProductVariantId
   * must reference a real, active ProductVariant (the "snack" sold into this
   * slot, e.g. Fries Regular) — never the Mix & Max variant itself, since
   * inventory deduction resolves against the snack variant's own recipe
   * (product-inventory.service.ts's computeDeductionForSlots), not the
   * parent slot's.
   */
  async addSnackOption(
    slotId: string,
    data: { snackProductVariantId: string },
    reason: string | undefined,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const slot = await productsRepository.findFlavorSlotById(slotId);
    if (!slot) throw new ProductError('VARIANT_SLOT_NOT_FOUND', 'Flavor slot not found', 404);

    const snackVariant = await productsRepository.findVariantById(data.snackProductVariantId);
    if (!snackVariant) throw new ProductError('VARIANT_NOT_FOUND', 'snackProductVariantId does not reference an existing variant', 404);
    if (snackVariant.id === slot.productVariantId) {
      throw new ProductError('SNACK_OPTION_SELF_REFERENCE', 'A Mix & Max variant cannot be its own snack option', 400);
    }
    if (!snackVariant.isActive) {
      throw new ProductError('SNACK_OPTION_VARIANT_INACTIVE', 'snackProductVariantId must reference an active variant', 400);
    }

    return performSlotEditWithActiveGovernance(slot.productVariantId, reason, actor, ipAddress, 'ADD_SNACK_OPTION', async (tx) => {
      const existing = await tx.productFlavorSlotSnackOption.findUnique({
        where: { flavorSlotId_snackProductVariantId: { flavorSlotId: slotId, snackProductVariantId: data.snackProductVariantId } },
      });
      if (existing) throw new ProductError('SNACK_OPTION_ALREADY_EXISTS', 'This variant is already a snack option for this slot', 409);

      return productsRepository.insertSnackOption({ flavorSlotId: slotId, snackProductVariantId: data.snackProductVariantId }, tx);
    });
  },

  async removeSnackOption(slotId: string, snackOptionId: string, reason: string | undefined, actor: ActorContext, ipAddress: string | null) {
    const option = await productsRepository.findSnackOptionById(snackOptionId);
    if (!option || option.flavorSlotId !== slotId) throw new ProductError('SNACK_OPTION_NOT_FOUND', 'Snack option not found', 404);

    const slot = await productsRepository.findFlavorSlotById(slotId);
    if (!slot) throw new ProductError('VARIANT_SLOT_NOT_FOUND', 'Flavor slot not found', 404);

    await performSlotEditWithActiveGovernance(slot.productVariantId, reason, actor, ipAddress, 'REMOVE_SNACK_OPTION', async (tx) => {
      await productsRepository.deleteSnackOption(snackOptionId, tx);
    });
  },

  // --- Task 209.6 — Product Image Management (Admin Only) ---
  // Deliberately isolated from every other product mutation: no shared
  // transaction, no cascade, and the repository call is a single-column
  // update — Variants, Recipes, ProductComponent, Inventory, Pricing, and
  // Sales rows are never touched by any method below.

  /** Read access mirrors GET /:productId (adminSupervisorOrBranch at the router) — Supervisor/Branch may view, only Admin may write (see upload/delete below). */
  async getProductImage(productId: string): Promise<{ image_url: string | null }> {
    const product = await productsRepository.findImagePath(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    return { image_url: product.imagePath ? await getSignedProductImageUrl(product.imagePath) : null };
  },

  async uploadProductImage(
    productId: string,
    file: { buffer: Buffer; originalname: string },
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<{ image_url: string | null }> {
    const existing = await productsRepository.findImagePath(productId);
    if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    // POS-PERF-P34 — product creation (and its image step) opened up to
    // Supervisor, but image management for the broader catalog stays
    // super_admin-only: a supervisor may only set/replace the image on a
    // product they themselves created, not edit an arbitrary existing one.
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(existing, actor.id))) {
      throw new ProductError('PRODUCT_IMAGE_FORBIDDEN', 'You may only upload an image for a product an active branch assignment gives you authority over', 403);
    }

    const compressed = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const imagePath = productImageKey(productId);
    const { error } = await supabaseAdmin.storage
      .from(PRODUCT_IMAGE_BUCKET)
      // cacheControl matches PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS — Storage
      // sets this as the object's Cache-Control response header, so the
      // browser can cache the actual image bytes for as long as a reused
      // signed URL (see signedUrlCache above) stays valid.
      .upload(imagePath, compressed, { contentType: 'image/webp', upsert: true, cacheControl: String(PRODUCT_IMAGE_SIGNED_URL_TTL_SECONDS) });
    if (error) {
      throw new ProductError('PRODUCT_IMAGE_UPLOAD_FAILED', 'Failed to upload the product image', 502);
    }
    // The path is stable per product (upsert overwrites in place) — a cache
    // entry from before this upload would otherwise keep handing out a
    // still-technically-valid signed URL whose underlying bytes just changed.
    invalidateSignedUrl(imagePath);

    await productsRepository.updateImagePath(productId, imagePath);
    const response = { image_url: await getSignedProductImageUrl(imagePath) };

    await recordAuditLog({
      action: existing.imagePath ? 'PRODUCT_IMAGE_REPLACED' : 'PRODUCT_IMAGE_UPLOADED',
      entityType: 'product',
      entityId: productId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { image_path: existing.imagePath },
      afterState: { image_path: imagePath },
      ipAddress,
    });

    return response;
  },

  async deleteProductImage(productId: string, actor: ActorContext, ipAddress: string | null): Promise<{ image_url: null }> {
    const existing = await productsRepository.findImagePath(productId);
    if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (!existing.imagePath) throw new ProductError('NO_PRODUCT_IMAGE', 'This product has no image to delete', 404);
    // POS-PERF-P35 — see updateProduct's ownership check above.
    if (actor.role === ROLES.SUPERVISOR && !(await hasActiveCatalogAuthorityForProduct(existing, actor.id))) {
      throw new ProductError('PRODUCT_IMAGE_FORBIDDEN', 'You may only delete the image for a product an active branch assignment gives you authority over', 403);
    }

    const { error } = await supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET).remove([existing.imagePath]);
    if (error) {
      throw new ProductError('PRODUCT_IMAGE_DELETE_FAILED', 'Failed to delete the product image', 502);
    }
    invalidateSignedUrl(existing.imagePath);

    await productsRepository.updateImagePath(productId, null);

    await recordAuditLog({
      action: 'PRODUCT_IMAGE_DELETED',
      entityType: 'product',
      entityId: productId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { image_path: existing.imagePath },
      afterState: { image_path: null },
      ipAddress,
    });

    return { image_url: null };
  },
};
