import { prisma } from '../../lib/prisma.js';
import { transactionsRepository } from '../transactions/transactions.repository.js';
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import type {
  EvaluateReadinessBatchInput,
  EvaluateReadinessInput,
  ProductVariantReadinessResult,
  ReadinessChecks,
  ReadinessIssue,
} from './product-readiness.types.js';

type SaleVariantRow = Awaited<ReturnType<typeof transactionsRepository.findVariantsForSale>>[number];

interface ReadinessData {
  branchId: string;
  productAvailabilityMap: Map<string, boolean>;
  flavorAvailabilityMap: Map<string, boolean>;
  baseMappedVariantIds: Set<string>;
  /** variantId -> set of flavorIds with an active flavor-scoped ProductInventory mapping. */
  flavorMappedByVariant: Map<string, Set<string>>;
  recipeReadyVariantIds: Set<string>;
}

/**
 * Every dependency here is fetched in one batched query keyed by the full
 * variant-id set (parent variants + every Mix & Max snack variant they
 * reference) — mirrors the batching pattern already used by
 * products.service.ts#getPosCatalog (findActiveMappingsForVariants) and
 * transactions.service.ts#resolveCartItems (findBranchProductAvailabilityMap
 * / findBranchFlavorAvailabilityMap), so evaluateProductVariantReadinessBatch
 * never issues an extra query per variant.
 */
async function fetchReadinessData(branchId: string, variants: SaleVariantRow[]): Promise<ReadinessData> {
  const snackVariantIds = variants.flatMap((v) => (v.flavorSlots ?? []).flatMap((s) => s.snackOptions.map((so) => so.snackProductVariant.id)));
  const allVariantIds = [...new Set([...variants.map((v) => v.id), ...snackVariantIds])];

  const productIds = [
    ...new Set(variants.flatMap((v) => [v.productId, ...(v.flavorSlots ?? []).flatMap((s) => s.snackOptions.map((so) => so.snackProductVariant.product.id))])),
  ];

  const flavorIds = [
    ...new Set(
      variants.flatMap((v) => [
        ...v.variantFlavors.map((vf) => vf.flavorId),
        ...(v.flavorSlots ?? []).flatMap((s) => s.snackOptions.flatMap((so) => so.snackProductVariant.variantFlavors.map((vf) => vf.flavorId))),
      ]),
    ),
  ];

  const [productAvailabilityRows, flavorAvailabilityRows, mappingRows, recipeRows] = await Promise.all([
    productIds.length ? transactionsRepository.findBranchProductAvailabilityMap(branchId, productIds) : Promise.resolve([]),
    flavorIds.length ? transactionsRepository.findBranchFlavorAvailabilityMap(branchId, flavorIds) : Promise.resolve([]),
    allVariantIds.length ? productInventoryRepository.findActiveMappingsForVariants(branchId, allVariantIds) : Promise.resolve([]),
    // No existing repository exposes a batched "has an active ProductComponent
    // row" check (product-components.repository.ts#findByVariant only takes a
    // single id) — this direct query follows the same batched-select shape as
    // findActiveMappingsForVariants above rather than adding a new repository
    // module for one query.
    allVariantIds.length
      ? prisma.productComponent.findMany({
          where: { productVariantId: { in: allVariantIds }, isActive: true },
          select: { productVariantId: true },
        })
      : Promise.resolve([]),
  ]);

  const flavorMappedByVariant = new Map<string, Set<string>>();
  for (const m of mappingRows) {
    if (m.flavorId === null) continue;
    const set = flavorMappedByVariant.get(m.productVariantId) ?? new Set<string>();
    set.add(m.flavorId);
    flavorMappedByVariant.set(m.productVariantId, set);
  }

  return {
    branchId,
    productAvailabilityMap: new Map(productAvailabilityRows.map((r) => [r.productId, r.isAvailable])),
    flavorAvailabilityMap: new Map(flavorAvailabilityRows.map((r) => [r.flavorId, r.isAvailable])),
    baseMappedVariantIds: new Set(mappingRows.filter((m) => m.flavorId === null).map((m) => m.productVariantId)),
    flavorMappedByVariant,
    recipeReadyVariantIds: new Set(recipeRows.map((r) => r.productVariantId)),
  };
}

function issue(
  code: ReadinessIssue['code'],
  severity: ReadinessIssue['severity'],
  entityType: ReadinessIssue['entityType'],
  entityId: string,
  message: string,
  recommendedAction: string,
  extra: Partial<ReadinessIssue> = {},
): ReadinessIssue {
  return { code, severity, entityType, entityId, message, recommendedAction, ...extra };
}

function notFoundResult(branchId: string, productVariantId: string): ProductVariantReadinessResult {
  const checks: ReadinessChecks = {
    variantExists: false,
    productActive: false,
    variantActive: false,
    variantLifecycleActive: false,
    priceValid: false,
    branchAvailable: false,
    baseInventoryMapped: false,
    flavorLinksConsistent: false,
    mixMaxSlotsComplete: false,
    recipeReady: false,
  };
  return {
    branchId,
    productId: null,
    productVariantId,
    status: 'NOT_READY',
    sellable: false,
    recipeReady: false,
    inventoryMappingReady: false,
    posSellable: false,
    completionPercentage: 0,
    checks,
    blockingIssues: [
      issue('VARIANT_NOT_FOUND', 'blocking', 'product_variant', productVariantId, 'Product variant does not exist.', 'Verify the product variant id.', {
        productVariantId,
        branchId,
      }),
    ],
    warnings: [],
  };
}

/** Pure, deterministic, side-effect free — every input is pre-fetched by fetchReadinessData. */
function buildReadinessResult(variant: SaleVariantRow, data: ReadinessData): ProductVariantReadinessResult {
  const blockingIssues: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const branchId = data.branchId;
  const productId = variant.productId;

  // Checks 1-3 / 7 (product exists/active/valid category): product existence
  // is guaranteed by the FK on ProductVariant.productId; category is not
  // selected by findVariantsForSale today (transactions.service.ts never
  // needed it) so it is intentionally not evaluated in Phase A — see
  // "architectural concerns discovered" in the Phase A report.
  const productActive = variant.product.status === 'active';
  if (!productActive) {
    blockingIssues.push(
      issue('PRODUCT_INACTIVE', 'blocking', 'product', productId, `${variant.product.name} is not active (status: ${variant.product.status}).`, 'Set the product status to Active.', {
        productId,
        productVariantId: variant.id,
        branchId,
      }),
    );
  }

  const variantActive = variant.isActive;
  if (!variantActive) {
    blockingIssues.push(
      issue('VARIANT_INACTIVE', 'blocking', 'product_variant', variant.id, `${variant.name} is not active.`, 'Activate the variant.', {
        productId,
        productVariantId: variant.id,
        branchId,
      }),
    );
  }

  const variantLifecycleActive = variant.lifecycleStatus === 'ACTIVE';
  if (!variantLifecycleActive) {
    blockingIssues.push(
      issue(
        'VARIANT_LIFECYCLE_BLOCKED',
        'blocking',
        'product_variant',
        variant.id,
        `${variant.name} lifecycle status is ${variant.lifecycleStatus}, which does not permit sale.`,
        'Move the variant lifecycle status to ACTIVE (approval workflow).',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  const price = variant.basePrice.toNumber();
  const priceValid = price > 0;
  if (!priceValid) {
    blockingIssues.push(
      issue('PRICE_MISSING', 'blocking', 'product_variant', variant.id, `${variant.name} has no valid positive selling price.`, 'Set a positive base price for this variant.', {
        productId,
        productVariantId: variant.id,
        branchId,
      }),
    );
  }

  const branchAvailable = data.productAvailabilityMap.get(productId) === true;
  if (!branchAvailable) {
    blockingIssues.push(
      issue('BRANCH_NOT_AVAILABLE', 'blocking', 'product', productId, `${variant.product.name} is not available at this branch.`, 'Enable the product for this branch under Branch Availability.', {
        productId,
        productVariantId: variant.id,
        branchId,
      }),
    );
  }

  const baseInventoryMapped = data.baseMappedVariantIds.has(variant.id);
  if (!baseInventoryMapped) {
    blockingIssues.push(
      issue(
        'BASE_INVENTORY_MAPPING_MISSING',
        'blocking',
        'product_variant',
        variant.id,
        `${variant.name} has no active base ProductInventory mapping for this branch.`,
        'Add at least one base ProductInventory mapping for this branch and variant.',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  let flavorLinksConsistent = true;
  const linkedFlavorIds = new Set(variant.variantFlavors.map((vf) => vf.flavorId));
  const mappedFlavorIds = data.flavorMappedByVariant.get(variant.id) ?? new Set<string>();
  for (const vf of variant.variantFlavors) {
    if (!vf.isAvailable || !vf.flavor.isActive) continue;
    const mapped = mappedFlavorIds.has(vf.flavorId);
    if (!mapped) {
      flavorLinksConsistent = false;
      blockingIssues.push(
        issue(
          'FLAVOR_INVENTORY_MAPPING_MISSING',
          'blocking',
          'flavor',
          vf.flavorId,
          `${variant.name} is missing a ProductInventory mapping for linked flavor "${vf.flavor.name}".`,
          `Add a flavor-specific ProductInventory mapping for "${vf.flavor.name}".`,
          { productId, productVariantId: variant.id, branchId, flavorId: vf.flavorId, flavorName: vf.flavor.name },
        ),
      );
    }
    if (data.flavorAvailabilityMap.get(vf.flavorId) === false) {
      flavorLinksConsistent = false;
      blockingIssues.push(
        issue(
          'FLAVOR_NOT_AVAILABLE_AT_BRANCH',
          'blocking',
          'flavor',
          vf.flavorId,
          `Flavor "${vf.flavor.name}" is disabled at this branch.`,
          `Enable flavor "${vf.flavor.name}" for this branch, or remove it from this variant.`,
          { productId, productVariantId: variant.id, branchId, flavorId: vf.flavorId, flavorName: vf.flavor.name },
        ),
      );
    }
  }
  for (const mappedFlavorId of mappedFlavorIds) {
    if (!linkedFlavorIds.has(mappedFlavorId)) {
      warnings.push(
        issue(
          'UNLINKED_FLAVOR_MAPPING',
          'warning',
          'flavor',
          mappedFlavorId,
          `${variant.name} has a ProductInventory mapping for a flavor that is not actively linked to it.`,
          'Remove the stale mapping or re-link the flavor to this variant.',
          { productId, productVariantId: variant.id, branchId, flavorId: mappedFlavorId },
        ),
      );
    }
  }

  let mixMaxSlotsComplete = true;
  const flavorSlots = variant.flavorSlots ?? [];
  for (const slot of flavorSlots) {
    const activeOptions = slot.snackOptions.filter((so) => {
      const sv = so.snackProductVariant;
      return sv.isActive && sv.product.status === 'active' && data.productAvailabilityMap.get(sv.product.id) === true;
    });
    if (slot.required && activeOptions.length === 0) {
      mixMaxSlotsComplete = false;
      blockingIssues.push(
        issue(
          'MIX_MAX_SLOT_INCOMPLETE',
          'blocking',
          'flavor_slot',
          slot.id,
          `${variant.name} slot "${slot.label}" has no active, branch-available snack option.`,
          'Add or re-enable at least one active snack option for this slot.',
          { productId, productVariantId: variant.id, branchId },
        ),
      );
    }
    for (const so of activeOptions) {
      const sv = so.snackProductVariant;
      if (!data.baseMappedVariantIds.has(sv.id)) {
        mixMaxSlotsComplete = false;
        blockingIssues.push(
          issue(
            'MIX_MAX_SNACK_UNAVAILABLE',
            'blocking',
            'product_variant',
            sv.id,
            `${variant.name} slot "${slot.label}" offers a snack variant with no active base ProductInventory mapping for this branch.`,
            'Add a base ProductInventory mapping for the snack variant at this branch.',
            { productId, productVariantId: variant.id, branchId },
          ),
        );
      }
    }
  }

  const recipeReady = data.recipeReadyVariantIds.has(variant.id);
  if (!recipeReady) {
    warnings.push(
      issue(
        'RECIPE_MISSING',
        'warning',
        'product_variant',
        variant.id,
        `${variant.name} has no active ProductComponent (Recipe/BOM) rows.`,
        'Configure a Recipe/BOM for this variant, or confirm ProductInventory-only deduction is intentional.',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }
  const hasFlavorInventoryRows = mappedFlavorIds.size > 0;
  if (recipeReady && hasFlavorInventoryRows) {
    // ProductComponent has no flavor scope today (see recipe-readiness.service.ts
    // LEGACY_FLAVOR_DEPENDENCY) — a "ready" BOM cannot represent per-flavor
    // seasoning correctly for a variant that has flavor-specific ProductInventory
    // rows. Surfaced as a warning, never silently reported as full readiness.
    warnings.push(
      issue(
        'RECIPE_FLAVOR_SCOPE_UNSUPPORTED',
        'warning',
        'product_variant',
        variant.id,
        `${variant.name} has flavor-specific ProductInventory mappings, but ProductComponent (Recipe/BOM) is flavor-agnostic and cannot represent that consumption.`,
        'Do not treat Recipe/BOM readiness as proof of correct per-flavor deduction; this requires a flavor-scoped ProductComponent design (approval required).',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  const inventoryMappingReady = baseInventoryMapped && flavorLinksConsistent && mixMaxSlotsComplete;
  const sellable = blockingIssues.length === 0;

  const checks: ReadinessChecks = {
    variantExists: true,
    productActive,
    variantActive,
    variantLifecycleActive,
    priceValid,
    branchAvailable,
    baseInventoryMapped,
    flavorLinksConsistent,
    mixMaxSlotsComplete,
    recipeReady,
  };
  const checkValues = Object.values(checks);
  const completionPercentage = Math.round((checkValues.filter(Boolean).length / checkValues.length) * 10000) / 100;

  return {
    branchId,
    productId,
    productVariantId: variant.id,
    status: sellable ? 'READY' : 'NOT_READY',
    sellable,
    recipeReady,
    inventoryMappingReady,
    posSellable: sellable,
    completionPercentage,
    checks,
    blockingIssues,
    warnings,
  };
}

export const productReadinessService = {
  /** Read-only. Never writes anything, never called from any existing runtime path yet (Phase A extraction only). */
  async evaluateProductVariantReadiness(input: EvaluateReadinessInput): Promise<ProductVariantReadinessResult> {
    const variants = await transactionsRepository.findVariantsForSale([input.productVariantId]);
    const variant = variants[0];
    if (!variant) return notFoundResult(input.branchId, input.productVariantId);

    const data = await fetchReadinessData(input.branchId, [variant]);
    return buildReadinessResult(variant, data);
  },

  /** Single batched fetch across all dependencies regardless of productVariantIds.length — no N+1. */
  async evaluateProductVariantReadinessBatch(input: EvaluateReadinessBatchInput): Promise<ProductVariantReadinessResult[]> {
    if (input.productVariantIds.length === 0) return [];

    const variants = await transactionsRepository.findVariantsForSale(input.productVariantIds);
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    const data = await fetchReadinessData(input.branchId, variants);

    return input.productVariantIds.map((id) => {
      const variant = variantMap.get(id);
      return variant ? buildReadinessResult(variant, data) : notFoundResult(input.branchId, id);
    });
  },
};
