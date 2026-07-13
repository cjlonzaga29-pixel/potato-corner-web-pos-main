import type { JwtPayload } from '@potato-corner/shared';
import { flavorsRepository } from './flavors.repository.js';
import { FlavorError, type FlavorListFilters } from './flavors.types.js';
import { productsRepository } from '../products/products.repository.js';
import { ProductError } from '../products/products.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

function toFlavorResponse(flavor: {
  id: string;
  name: string;
  description: string | null;
  colorHex: string | null;
  displayOrder: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { variantFlavors: number };
  branchAvailability?: { isAvailable: boolean }[];
}) {
  return {
    id: flavor.id,
    name: flavor.name,
    description: flavor.description,
    color_hex: flavor.colorHex,
    display_order: flavor.displayOrder,
    is_active: flavor.isActive,
    created_at: flavor.createdAt.toISOString(),
    updated_at: flavor.updatedAt.toISOString(),
    branch_active_count: flavor.branchAvailability?.filter((b) => b.isAvailable).length ?? 0,
    linked_variant_count: flavor._count?.variantFlavors ?? 0,
  };
}

function toBranchFlavorAvailabilityRow(row: {
  branchId: string;
  isAvailable: boolean;
  unavailableReason: string | null;
  updatedAt: Date;
  branch: { code: string; name: string; city: string };
}) {
  return {
    branch_id: row.branchId,
    branch_code: row.branch.code,
    branch_name: row.branch.name,
    city: row.branch.city,
    is_available: row.isAvailable,
    unavailable_reason: row.unavailableReason,
    updated_at: row.updatedAt.toISOString(),
  };
}

function toLinkedVariant(link: {
  productVariantId: string;
  pricePremium: { toNumber(): number };
  isAvailable: boolean;
  productVariant: { name: string; sizeLabel: string; product: { id: string; name: string } };
}) {
  return {
    product_variant_id: link.productVariantId,
    variant_name: link.productVariant.name,
    size_label: link.productVariant.sizeLabel,
    product_id: link.productVariant.product.id,
    product_name: link.productVariant.product.name,
    price_premium: link.pricePremium.toNumber(),
    is_available: link.isAvailable,
  };
}

interface CreateFlavorInput {
  name: string;
  description?: string;
  color_hex: string;
  display_order?: number;
  is_active: boolean;
}

interface UpdateFlavorInput {
  name?: string;
  description?: string;
  color_hex?: string;
  display_order?: number;
  is_active?: boolean;
}

interface LinkVariantFlavorInput {
  flavor_id: string;
  price_premium: number;
  is_available: boolean;
}

interface UpdateVariantFlavorInput {
  price_premium?: number;
  is_available?: boolean;
}

export const flavorsService = {
  async getAllFlavors(_requestingUser: JwtPayload, filters: FlavorListFilters) {
    const { flavors, total } = await flavorsRepository.findAll(filters);
    return {
      flavors: flavors.map((f) => toFlavorResponse(f)),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getFlavorById(flavorId: string, _requestingUser: JwtPayload) {
    const flavor = await flavorsRepository.findById(flavorId);
    if (!flavor) throw new FlavorError('FLAVOR_NOT_FOUND', 'Flavor not found', 404);

    return {
      ...toFlavorResponse({ ...flavor, _count: { variantFlavors: flavor.variantFlavors.length } }),
      branch_availability: flavor.branchAvailability.map(toBranchFlavorAvailabilityRow),
      linked_variants: flavor.variantFlavors.map(toLinkedVariant),
    };
  },

  async createFlavor(data: CreateFlavorInput, actor: ActorContext, ipAddress: string | null) {
    const existing = await flavorsRepository.findByName(data.name);
    if (existing) {
      throw new FlavorError('FLAVOR_NAME_CONFLICT', `A flavor named "${data.name}" already exists`, 409);
    }

    const flavor = await flavorsRepository.create({
      name: data.name,
      description: data.description,
      colorHex: data.color_hex,
      displayOrder: data.display_order,
      isActive: data.is_active,
    });
    const response = toFlavorResponse(flavor);

    await recordAuditLog({
      action: 'FLAVOR_CREATED',
      entityType: 'flavor',
      entityId: flavor.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateFlavor(flavorId: string, data: UpdateFlavorInput, actor: ActorContext, ipAddress: string | null) {
    const before = await flavorsRepository.findById(flavorId);
    if (!before) throw new FlavorError('FLAVOR_NOT_FOUND', 'Flavor not found', 404);

    const flavor = await flavorsRepository.update(flavorId, {
      name: data.name,
      description: data.description,
      colorHex: data.color_hex,
      displayOrder: data.display_order,
      isActive: data.is_active,
    });
    const response = toFlavorResponse(flavor);

    await recordAuditLog({
      action: 'FLAVOR_UPDATED',
      entityType: 'flavor',
      entityId: flavor.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toFlavorResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async linkFlavorToVariant(
    productId: string,
    variantId: string,
    data: LinkVariantFlavorInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);

    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) {
      throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
    }

    const flavor = await flavorsRepository.findById(data.flavor_id);
    if (!flavor) throw new FlavorError('FLAVOR_NOT_FOUND', 'Flavor not found', 404);

    const existingLink = await flavorsRepository.findVariantFlavorLink(variantId, data.flavor_id);
    if (existingLink) {
      throw new FlavorError('VARIANT_FLAVOR_ALREADY_LINKED', 'This flavor is already linked to this variant', 409);
    }

    const link = await flavorsRepository.linkVariantFlavor(variantId, data.flavor_id, data.price_premium, data.is_available);
    const response = {
      flavor_id: link.flavorId,
      name: link.flavor.name,
      color_hex: link.flavor.colorHex,
      price_premium: link.pricePremium.toNumber(),
      is_available: link.isAvailable,
    };

    await recordAuditLog({
      action: 'VARIANT_FLAVOR_LINKED',
      entityType: 'product_variant_flavor',
      entityId: `${variantId}:${data.flavor_id}`,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateVariantFlavor(
    productId: string,
    variantId: string,
    flavorId: string,
    data: UpdateVariantFlavorInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) {
      throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);
    }

    const existingLink = await flavorsRepository.findVariantFlavorLink(variantId, flavorId);
    if (!existingLink) {
      throw new FlavorError('VARIANT_FLAVOR_LINK_NOT_FOUND', 'This flavor is not linked to this variant', 404);
    }

    const updated = await flavorsRepository.updateVariantFlavor(variantId, flavorId, {
      pricePremium: data.price_premium,
      isAvailable: data.is_available,
    });
    const response = {
      flavor_id: updated.flavorId,
      name: updated.flavor.name,
      color_hex: updated.flavor.colorHex,
      price_premium: updated.pricePremium.toNumber(),
      is_available: updated.isAvailable,
    };

    await recordAuditLog({
      action: 'VARIANT_FLAVOR_UPDATED',
      entityType: 'product_variant_flavor',
      entityId: `${variantId}:${flavorId}`,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: {
        price_premium: existingLink.pricePremium.toNumber(),
        is_available: existingLink.isAvailable,
      },
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async getFlavorBranchAvailability(flavorId: string, _actor: ActorContext) {
    const flavor = await flavorsRepository.findById(flavorId);
    if (!flavor) throw new FlavorError('FLAVOR_NOT_FOUND', 'Flavor not found', 404);

    const [branches, rows] = await Promise.all([
      flavorsRepository.allActiveBranches(),
      flavorsRepository.findBranchFlavorAvailability(flavorId),
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
        unavailable_reason: row?.unavailableReason ?? null,
        updated_at: row?.updatedAt.toISOString() ?? null,
      };
    });
  },

  async updateBranchFlavorAvailability(
    flavorId: string,
    branchId: string,
    isAvailable: boolean,
    unavailableReason: string | undefined,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const flavor = await flavorsRepository.findById(flavorId);
    if (!flavor) throw new FlavorError('FLAVOR_NOT_FOUND', 'Flavor not found', 404);

    const row = await flavorsRepository.upsertBranchFlavorAvailability(branchId, flavorId, isAvailable, unavailableReason);
    const response = toBranchFlavorAvailabilityRow(row);

    await recordAuditLog({
      action: 'FLAVOR_BRANCH_AVAILABILITY_CHANGED',
      entityType: 'branch_flavor_availability',
      entityId: row.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { flavorId, isAvailable, unavailableReason: response.unavailable_reason },
      ipAddress,
    });

    return response;
  },
};
