import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { ROLES, type JwtPayload, type ProductStatus } from '@potato-corner/shared';
import { productsRepository } from './products.repository.js';
import { ProductError, type ProductListFilters } from './products.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { priceOverridesService } from '../price-overrides/price-overrides.service.js';

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
  imageUrl: string | null;
  status: ProductStatus;
  displayOrder: number | null;
  isSeasonal: boolean;
  seasonalStartDate: Date | null;
  seasonalEndDate: Date | null;
  branchExclusive: boolean;
  exclusiveBranchId: string | null;
  exclusiveBranch?: { id: string; name: string } | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
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
}

interface UpdateVariantInput {
  name?: string;
  size_label?: string;
  base_price?: number;
  display_order?: number;
  is_active?: boolean;
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

    const { product, cascadedBranchIds } = await productsRepository.createWithCascade(
      {
        name: data.name,
        description: data.description,
        category: data.category,
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

    const product = await productsRepository.update(productId, {
      name: data.name,
      description: data.description,
      category: data.category,
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

    if (actor.role === ROLES.SUPERVISOR) {
      if (!data.branch_id) {
        throw new ProductError('BRANCH_ID_REQUIRED', 'branch_id is required for a branch-scoped status change', 422);
      }
      if (data.status !== 'active' && data.status !== 'temporarily_unavailable') {
        throw new ProductError(
          'INSUFFICIENT_PERMISSIONS',
          'Supervisors may only set branch availability to active or temporarily_unavailable',
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

    throw new ProductError('INSUFFICIENT_PERMISSIONS', 'Only super_admin or supervisor may change product status', 403);
  },

  async createVariant(productId: string, data: CreateVariantInput, actor: ActorContext, ipAddress: string | null) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (product.status === 'archived') {
      throw new ProductError('PRODUCT_ARCHIVED', 'Archived products cannot receive new variants', 409);
    }

    const variant = await productsRepository.createVariant(productId, {
      name: data.name,
      sizeLabel: data.size_label,
      basePrice: data.base_price,
      displayOrder: data.display_order,
      isActive: data.is_active,
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

  /**
   * Phase 10 POS terminal catalog — a lean, staff-accessible read model
   * distinct from getAllProducts (admin/supervisor only). Effective price is
   * resolved server-side via priceOverridesService so the terminal never
   * computes pricing from a client-trusted base_price.
   */
  async getPosCatalog(branchId: string) {
    const [products, disabledFlavorIds] = await Promise.all([
      productsRepository.findCatalogForBranch(branchId),
      productsRepository.findDisabledFlavorIds(branchId),
    ]);
    const disabledFlavors = new Set(disabledFlavorIds);

    const catalogProducts = await Promise.all(
      products.map(async (product) => {
        const variants = await Promise.all(
          product.variants.map(async (variant) => {
            const price = await priceOverridesService.getActivePriceForBranch(branchId, variant.id, variant.basePrice.toNumber());
            return {
              id: variant.id,
              name: variant.name,
              size_label: variant.sizeLabel,
              price,
              flavors: variant.variantFlavors
                .filter((vf) => !disabledFlavors.has(vf.flavorId))
                .map((vf) => ({
                  flavor_id: vf.flavorId,
                  name: vf.flavor.name,
                  color_hex: vf.flavor.colorHex,
                  price_premium: vf.pricePremium.toNumber(),
                })),
            };
          }),
        );
        return {
          id: product.id,
          name: product.name,
          category: product.category,
          image_url: product.imageUrl,
          variants,
        };
      }),
    );

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
          'Cannot delete: product has associated transactions or price overrides. Change status to Archived instead.',
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
};
