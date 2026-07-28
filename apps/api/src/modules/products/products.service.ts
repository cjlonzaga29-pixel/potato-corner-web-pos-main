import sharp from 'sharp';
import { Prisma, type ProductFlavorSlot, type VariantLifecycleStatus } from '@prisma/client';
import { ROLES, SOCKET_EVENTS, type JwtPayload, type ProductStatus } from '@potato-corner/shared';
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
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import { productCategoriesRepository } from '../product-categories/product-categories.repository.js';

type ActorContext = { id: string; role: string };

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  temporarily_unavailable: 'Temporarily Unavailable',
  discontinued: 'Discontinued',
  archived: 'Archived',
};

/**
 * Product lifecycle matrix (locked — see this phase's spec). archived has no
 * outgoing transitions: archived products are fully read-only. Every other
 * entry lists exactly the statuses reachable from that status by super_admin.
 */
const GLOBAL_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  draft: ['active', 'archived'],
  active: ['temporarily_unavailable', 'discontinued', 'archived'],
  temporarily_unavailable: ['active', 'archived'],
  discontinued: ['active', 'archived'],
  archived: [],
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

/** Every branch this product currently has a branch_product_availability row for — the "branch rooms" a variant lifecycle event is broadcast to. */
async function notifyVariantBranches(productId: string, event: string, payload: unknown): Promise<void> {
  const rows = await productsRepository.findBranchProductAvailability(productId);
  for (const row of rows) {
    notifyBranch(row.branchId, event, payload);
  }
}

/**
 * CR-005 Guarantee 6 gate for approveVariant: the variant must have at least
 * one ProductInventory mapping — computeDeduction's actual data source —
 * before it can go ACTIVE. Replaces the former Recipe-resolvability check;
 * Product approval no longer depends on Recipe. Uses the branch-agnostic
 * lookup since approval is a global gate, not scoped to any one branch.
 */
async function assertRecipesResolvableSomewhere(productVariantId: string): Promise<void> {
  const hasMapping = await productInventoryRepository.hasAnyActiveMappingForVariant(productVariantId);
  if (!hasMapping) {
    throw new ProductError(
      'VARIANT_APPROVAL_BLOCKED_UNRESOLVABLE_INGREDIENT',
      'Variant has no ProductInventory mapping — approval blocked until at least one ingredient mapping is provisioned',
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
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 1) {
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
  const expected = Array.from({ length: slots.length }, (_, i) => i + 1);
  const actual = [...seen].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ProductError(
      'VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS',
      `Flavor slots must form a contiguous 1..${slots.length} sequence`,
      409,
    );
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extractStoragePath(imageUrl: string): string | null {
  const marker = '/object/public/product-images/';
  const idx = imageUrl.indexOf(marker);
  return idx === -1 ? null : imageUrl.slice(idx + marker.length);
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
  imageUrl: string | null;
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
}) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    category_id: product.categoryId,
    category_name: product.productCategory?.name ?? null,
    image_url: product.imageUrl,
    status: product.status,
    status_label: STATUS_LABELS[product.status],
    display_order: product.displayOrder,
    is_seasonal: product.isSeasonal,
    seasonal_start_date: product.seasonalStartDate ? isoDate(product.seasonalStartDate) : null,
    seasonal_end_date: product.seasonalEndDate ? isoDate(product.seasonalEndDate) : null,
    branch_exclusive: product.branchExclusive,
    exclusive_branch_id: product.exclusiveBranchId,
    exclusive_branch_name: product.exclusiveBranch?.name ?? null,
    created_by: product.createdBy,
    created_at: product.createdAt.toISOString(),
    updated_at: product.updatedAt.toISOString(),
  };
}

type ListRow = Parameters<typeof toProductBase>[0] & {
  _count: { variants: number };
  variants: { isActive: boolean }[];
  branchAvailability: { isAvailable: boolean }[];
};

function toProductListItem(product: ListRow) {
  return {
    ...toProductBase(product),
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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
  image_url?: string;
  branch_exclusive: boolean;
  exclusive_branch_id?: string;
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
  image_url?: string | null;
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

type SlotOperation = 'ADD_SLOT' | 'UPDATE_SLOT' | 'REMOVE_SLOT' | 'REORDER_SLOTS';

type VariantWithRelations = NonNullable<Awaited<ReturnType<typeof productsRepository.findVariantById>>>;

function toFlavorSlotSnapshot(slot: { id: string; slotIndex: number; label: string; flavorQty: { toNumber(): number }; unit: string; required: boolean }) {
  return {
    id: slot.id,
    slot_index: slot.slotIndex,
    label: slot.label,
    flavor_qty: slot.flavorQty.toNumber(),
    unit: slot.unit,
    required: slot.required,
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
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ProductError('VARIANT_SLOT_EDIT_FORBIDDEN', 'Only super_admin may edit flavor slots on an ACTIVE variant', 403);
    }
    if (!reason || !reason.trim()) {
      throw new ProductError('VARIANT_SLOT_EDIT_REASON_REQUIRED', 'A reason is required to edit flavor slots on an ACTIVE variant', 400);
    }

    result = await prisma.$transaction(async (tx) => {
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
    result = await mutation(prisma, variant);
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

export const productsService = {
  async getAllProducts(_requestingUser: JwtPayload, filters: ProductListFilters) {
    const { products, total } = await productsRepository.findAll(filters);
    return {
      products: products.map((p) => toProductListItem(p as ListRow)),
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

    if (data.branch_exclusive) {
      if (!data.exclusive_branch_id) {
        throw new ProductError('EXCLUSIVE_BRANCH_REQUIRED', 'exclusive_branch_id is required when branch_exclusive is true', 422);
      }
      const branch = await productsRepository.findActiveBranch(data.exclusive_branch_id);
      if (!branch) {
        throw new ProductError('EXCLUSIVE_BRANCH_NOT_FOUND', 'exclusive_branch_id must reference an active branch', 422);
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
        imageUrl: data.image_url,
        branchExclusive: data.branch_exclusive,
        exclusiveBranchId: data.exclusive_branch_id,
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
        branchExclusive: data.branch_exclusive,
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

    const product = await productsRepository.update(productId, {
      name: data.name,
      description: data.description,
      category: data.category,
      categoryId: data.category_id,
      displayOrder: data.display_order,
      isSeasonal: data.is_seasonal,
      seasonalStartDate: data.seasonal_start_date,
      seasonalEndDate: data.seasonal_end_date,
      imageUrl: data.image_url,
    });

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

    if (actor.role === ROLES.SUPER_ADMIN) {
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

    const updated = await productsRepository.updateVariant(variantId, {
      name: data.name,
      sizeLabel: data.size_label,
      basePrice: data.base_price,
      displayOrder: data.display_order,
      isActive: data.is_active,
    });
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

  async uploadProductImage(productId: string, file: { buffer: Buffer; originalname: string }, actor: ActorContext, ipAddress: string | null) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (product.status === 'archived') {
      throw new ProductError('PRODUCT_ARCHIVED', 'Archived products cannot have their image changed', 409);
    }

    const compressed = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const path = `product-images/${productId}/${Date.now()}-${sanitizeFilename(file.originalname)}.webp`;
    const { error } = await supabaseAdmin.storage
      .from('product-images')
      .upload(path, compressed, { contentType: 'image/webp', upsert: true });
    if (error) {
      console.error('Supabase Storage upload failed for product image:', {
        bucket: 'product-images',
        path,
        size: compressed.length,
        error,
      });
      throw new ProductError('IMAGE_UPLOAD_FAILED', 'Failed to upload the product image', 502);
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from('product-images').getPublicUrl(path);

    await productsRepository.updateImage(productId, publicUrl);

    await recordAuditLog({
      action: 'PRODUCT_IMAGE_UPLOADED',
      entityType: 'product',
      entityId: productId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { imageUrl: product.imageUrl },
      afterState: { imageUrl: publicUrl },
      ipAddress,
    });

    return { image_url: publicUrl };
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

  async bulkUpdateBranchProductAvailability(
    productId: string,
    updates: { branch_id: string; is_available: boolean }[],
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    const globallyLocked = product.status === 'discontinued' || product.status === 'archived';
    if (globallyLocked && updates.some((u) => u.is_available)) {
      throw new ProductError(
        'PRODUCT_GLOBALLY_UNAVAILABLE',
        'Cannot enable a globally discontinued or archived product for a branch',
        409,
      );
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
   * Phase 10 POS terminal catalog — a lean, staff-accessible read model
   * distinct from getAllProducts (admin/supervisor only), so the terminal
   * never computes pricing from a client-trusted base_price.
   */
  async getPosCatalog(branchId: string) {
    const [products, disabledFlavorIds] = await Promise.all([
      productsRepository.findCatalogForBranch(branchId),
      productsRepository.findDisabledFlavorIds(branchId),
    ]);
    const disabledFlavors = new Set(disabledFlavorIds);

    const catalogProducts = products.map((product) => {
      const variants = product.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        size_label: variant.sizeLabel,
        price: variant.basePrice.toNumber(),
        vatable_cap_amount: variant.vatableCapAmount?.toNumber() ?? null,
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
            selection_type: assignment.optionGroup.selectionType,
            required: assignment.required ?? assignment.optionGroup.required,
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
        category: product.category,
        image_url: product.imageUrl,
        variants,
      };
    });

    const categories = [...new Set(catalogProducts.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort();

    return { categories, products: catalogProducts };
  },

  async deleteProduct(productId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = await productsRepository.findById(productId);
    if (!existing) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

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

  async deleteVariant(productId: string, variantId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = await productsRepository.findVariantById(variantId);
    if (!existing || existing.productId !== productId) {
      throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
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

  async deleteProductImage(productId: string, actor: ActorContext, ipAddress: string | null) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (!product.imageUrl) throw new ProductError('IMAGE_NOT_FOUND', 'This product has no image to remove', 404);

    const path = extractStoragePath(product.imageUrl);
    if (path) {
      const { error } = await supabaseAdmin.storage.from('product-images').remove([path]);
      if (error) {
        console.error('Supabase Storage removal failed for product image:', { bucket: 'product-images', path, error });
      }
    }

    await productsRepository.clearImage(productId);

    await recordAuditLog({
      action: 'PRODUCT_IMAGE_DELETED',
      entityType: 'product',
      entityId: productId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { imageUrl: product.imageUrl },
      afterState: { imageUrl: null },
      ipAddress,
    });

    return { image_url: null };
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
};
