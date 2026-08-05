import { prisma } from '../../lib/prisma.js';
import { transactionsRepository } from '../transactions/transactions.repository.js';
import { productsRepository } from '../products/products.repository.js';
import type {
  EvaluateProductReadinessInput,
  EvaluateReadinessBatchInput,
  EvaluateReadinessInput,
  ProductReadinessResult,
  ProductVariantReadinessResult,
  ProductVariantReadinessSummary,
  ReadinessChecks,
  ReadinessIssue,
  VariantComponentReadinessResult,
} from './product-readiness.types.js';

type SaleVariantRow = Awaited<ReturnType<typeof transactionsRepository.findVariantsForSale>>[number];

interface ComponentRow {
  productVariantId: string;
  inventoryItemId: string;
  quantityRequired: { lessThanOrEqualTo(value: number): boolean };
  inventoryItem: { deletedAt: Date | null };
}

interface ReadinessData {
  branchId: string;
  productAvailabilityMap: Map<string, boolean>;
  flavorAvailabilityMap: Map<string, boolean>;
  componentsByVariant: Map<string, ComponentRow[]>;
  stockedItemIds: Set<string>;
}

/**
 * Every dependency here is fetched in one batched query keyed by the full
 * variant-id set (parent variants + every Mix & Max snack variant they
 * reference) — mirrors the batching pattern already used by
 * products.service.ts#getPosCatalog and transactions.service.ts#resolveCartItems,
 * so evaluateProductVariantReadinessBatch never issues an extra query per
 * variant. Recipe/BOM readiness is sourced from ProductComponent +
 * InventoryStock (the authoritative inventory pipeline) — legacy
 * ProductInventory is never read here.
 */
async function fetchReadinessData(branchId: string, variants: SaleVariantRow[]): Promise<ReadinessData> {
  const snackVariantIds = variants.flatMap((v) => (v.flavorSlots ?? []).flatMap((s) => s.snackOptions.map((so) => so.snackProductVariant.id)));
  const allVariantIds = [...new Set([...variants.map((v) => v.id), ...snackVariantIds])];

  const productIds = [
    ...new Set(variants.flatMap((v) => [v.productId, ...(v.flavorSlots ?? []).flatMap((s) => s.snackOptions.map((so) => so.snackProductVariant.product.id))])),
  ];

  const flavorIds = [...new Set(variants.flatMap((v) => v.variantFlavors.map((vf) => vf.flavorId)))];

  const [productAvailabilityRows, flavorAvailabilityRows, componentRows] = await Promise.all([
    productIds.length ? transactionsRepository.findBranchProductAvailabilityMap(branchId, productIds) : Promise.resolve([]),
    flavorIds.length ? transactionsRepository.findBranchFlavorAvailabilityMap(branchId, flavorIds) : Promise.resolve([]),
    allVariantIds.length
      ? prisma.productComponent.findMany({
          where: { productVariantId: { in: allVariantIds }, isActive: true },
          select: {
            productVariantId: true,
            inventoryItemId: true,
            quantityRequired: true,
            inventoryItem: { select: { deletedAt: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const componentsByVariant = new Map<string, ComponentRow[]>();
  for (const row of componentRows) {
    const list = componentsByVariant.get(row.productVariantId) ?? [];
    list.push(row);
    componentsByVariant.set(row.productVariantId, list);
  }

  const itemIds = [...new Set(componentRows.map((r) => r.inventoryItemId))];
  const stockRows = itemIds.length
    ? await prisma.inventoryStock.findMany({ where: { branchId, inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true } })
    : [];

  return {
    branchId,
    productAvailabilityMap: new Map(productAvailabilityRows.map((r) => [r.productId, r.isAvailable])),
    flavorAvailabilityMap: new Map(flavorAvailabilityRows.map((r) => [r.flavorId, r.isAvailable])),
    componentsByVariant,
    stockedItemIds: new Set(stockRows.map((r) => r.inventoryItemId)),
  };
}

/** Shared by buildReadinessResult and evaluateVariantComponentReadiness so both check the exact same validity rule. */
function findInvalidComponentItemIds(components: ComponentRow[]): string[] {
  return [...new Set(components.filter((c) => c.quantityRequired.lessThanOrEqualTo(0) || c.inventoryItem.deletedAt !== null).map((c) => c.inventoryItemId))];
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
    recipeReady: false,
    componentsValid: false,
    inventoryStockReady: false,
    flavorLinksConsistent: false,
    mixMaxSlotsComplete: false,
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

  const components = data.componentsByVariant.get(variant.id) ?? [];

  const recipeReady = components.length > 0;
  if (!recipeReady) {
    blockingIssues.push(
      issue(
        'RECIPE_MISSING',
        'blocking',
        'product_variant',
        variant.id,
        `${variant.name} has no active Recipe/BOM (ProductComponent) rows.`,
        'Configure a Recipe/BOM for this variant.',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  const invalidItemIds = findInvalidComponentItemIds(components);
  const componentsValid = invalidItemIds.length === 0;
  if (!componentsValid) {
    blockingIssues.push(
      issue(
        'INVALID_COMPONENT',
        'blocking',
        'product_variant',
        variant.id,
        `${variant.name} has a Recipe/BOM component with an invalid quantity or a deleted inventory item.`,
        'Fix or remove the invalid Recipe/BOM component(s).',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  const missingStockItemIds = [...new Set(components.filter((c) => !data.stockedItemIds.has(c.inventoryItemId)).map((c) => c.inventoryItemId))];
  const inventoryStockReady = missingStockItemIds.length === 0;
  if (!inventoryStockReady) {
    blockingIssues.push(
      issue(
        'INVENTORY_STOCK_MISSING',
        'blocking',
        'product_variant',
        variant.id,
        `${variant.name} has a Recipe/BOM component with no InventoryStock row at this branch.`,
        'Provision inventory stock for the missing item(s) at this branch.',
        { productId, productVariantId: variant.id, branchId },
      ),
    );
  }

  let flavorLinksConsistent = true;
  for (const vf of variant.variantFlavors) {
    if (!vf.isAvailable || !vf.flavor.isActive) continue;
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
      const snackHasRecipe = (data.componentsByVariant.get(sv.id) ?? []).length > 0;
      if (!snackHasRecipe) {
        mixMaxSlotsComplete = false;
        blockingIssues.push(
          issue(
            'MIX_MAX_SNACK_UNAVAILABLE',
            'blocking',
            'product_variant',
            sv.id,
            `${variant.name} slot "${slot.label}" offers a snack variant with no active Recipe/BOM.`,
            'Configure a Recipe/BOM for the snack variant.',
            { productId, productVariantId: variant.id, branchId },
          ),
        );
      }
    }
  }

  const inventoryMappingReady = componentsValid && inventoryStockReady;
  const sellable = blockingIssues.length === 0;

  const checks: ReadinessChecks = {
    variantExists: true,
    productActive,
    variantActive,
    variantLifecycleActive,
    priceValid,
    branchAvailable,
    recipeReady,
    componentsValid,
    inventoryStockReady,
    flavorLinksConsistent,
    mixMaxSlotsComplete,
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

/**
 * Shared by evaluateProductVariantReadinessBatch and by callers (checkout's
 * resolveCartItems) that already hold a findVariantsForSale result — lets
 * checkout gate on the same readiness data without a second, redundant fetch
 * of the same variant rows.
 */
async function evaluateFromLoadedVariants(
  branchId: string,
  variants: SaleVariantRow[],
  productVariantIds: string[],
): Promise<ProductVariantReadinessResult[]> {
  if (productVariantIds.length === 0) return [];

  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const data = await fetchReadinessData(branchId, variants);

  return productVariantIds.map((id) => {
    const variant = variantMap.get(id);
    return variant ? buildReadinessResult(variant, data) : notFoundResult(branchId, id);
  });
}

/**
 * Product-level roll-up for the Admin Readiness panel (Phase D1). Aggregates
 * evaluateProductVariantReadinessBatch results for a product's "eligible"
 * variants (isActive && lifecycleStatus === 'ACTIVE') at one branch — a
 * variant an admin has deliberately deactivated/archived is excluded rather
 * than perpetually blocking the product as NOT_READY.
 */
async function buildProductReadinessResult(
  productId: string,
  branchId: string,
  totalVariantCount: number,
  variantResults: ProductVariantReadinessResult[],
  variantNames: Map<string, string>,
): Promise<ProductReadinessResult> {
  if (variantResults.length === 0) {
    const blockingIssues: ReadinessIssue[] = [
      issue(
        'NO_ELIGIBLE_VARIANTS',
        'blocking',
        'product',
        productId,
        'This product has no active variant eligible for sale.',
        'Activate at least one variant (isActive + lifecycle ACTIVE) before publishing.',
        { productId, branchId },
      ),
    ];
    return {
      productId,
      branchId,
      status: 'NOT_READY',
      sellable: false,
      completionPercentage: 0,
      variantCount: totalVariantCount,
      eligibleVariantCount: 0,
      readyVariantCount: 0,
      blockingIssues,
      warnings: [],
      variants: [],
    };
  }

  const variants: ProductVariantReadinessSummary[] = variantResults.map((r) => ({
    productVariantId: r.productVariantId,
    variantName: variantNames.get(r.productVariantId) ?? r.productVariantId,
    status: r.status,
    sellable: r.sellable,
    completionPercentage: r.completionPercentage,
    recipeReady: r.recipeReady,
    inventoryMappingReady: r.inventoryMappingReady,
    blockingIssues: r.blockingIssues,
    warnings: r.warnings,
  }));

  const blockingIssues = variantResults.flatMap((r) => r.blockingIssues);
  const warnings = variantResults.flatMap((r) => r.warnings);
  const readyVariantCount = variantResults.filter((r) => r.sellable).length;
  const sellable = readyVariantCount === variantResults.length;
  const completionPercentage =
    Math.round((variantResults.reduce((sum, r) => sum + r.completionPercentage, 0) / variantResults.length) * 100) / 100;

  return {
    productId,
    branchId,
    status: sellable ? 'READY' : 'NOT_READY',
    sellable,
    completionPercentage,
    variantCount: totalVariantCount,
    eligibleVariantCount: variantResults.length,
    readyVariantCount,
    blockingIssues,
    warnings,
    variants,
  };
}

export const productReadinessService = {
  /** Read-only. Never writes anything. */
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
    return evaluateFromLoadedVariants(input.branchId, variants, input.productVariantIds);
  },

  /** Same evaluation as evaluateProductVariantReadinessBatch, but reuses a findVariantsForSale result the caller already fetched. */
  evaluateProductVariantReadinessForVariants: evaluateFromLoadedVariants,

  /**
   * Branch-agnostic BOM structural readiness — the same RECIPE_MISSING /
   * INVALID_COMPONENT rules buildReadinessResult evaluates, minus every
   * branch-scoped check (InventoryStock, branch availability) and the
   * variant's own lifecycleStatus. Used by variant approval (Task 191):
   * approval is a global, not-branch-scoped gate that runs while the variant
   * is still PENDING_APPROVAL, so gating on variantLifecycleActive (as
   * evaluateProductVariantReadiness does) would always fail.
   */
  async evaluateVariantComponentReadiness(productVariantId: string): Promise<VariantComponentReadinessResult> {
    const components = await prisma.productComponent.findMany({
      where: { productVariantId, isActive: true },
      select: {
        productVariantId: true,
        inventoryItemId: true,
        quantityRequired: true,
        inventoryItem: { select: { deletedAt: true } },
      },
    });

    const blockingIssues: ReadinessIssue[] = [];

    const recipeReady = components.length > 0;
    if (!recipeReady) {
      blockingIssues.push(
        issue(
          'RECIPE_MISSING',
          'blocking',
          'product_variant',
          productVariantId,
          'Variant has no active Recipe/BOM (ProductComponent) rows.',
          'Configure a Recipe/BOM for this variant.',
          { productVariantId },
        ),
      );
    }

    const invalidItemIds = findInvalidComponentItemIds(components);
    const componentsValid = invalidItemIds.length === 0;
    if (!componentsValid) {
      blockingIssues.push(
        issue(
          'INVALID_COMPONENT',
          'blocking',
          'product_variant',
          productVariantId,
          'Variant has a Recipe/BOM component with an invalid quantity or a deleted inventory item.',
          'Fix or remove the invalid Recipe/BOM component(s).',
          { productVariantId },
        ),
      );
    }

    return { productVariantId, recipeReady, componentsValid, ready: recipeReady && componentsValid, blockingIssues };
  },

  /** Product-level readiness for the Admin Readiness panel (Phase D1) — see buildProductReadinessResult. */
  async evaluateProductReadiness(input: EvaluateProductReadinessInput): Promise<ProductReadinessResult> {
    const allVariants = await productsRepository.findVariantsForReadiness(input.productId);
    const eligibleVariants = allVariants.filter((v) => v.isActive && v.lifecycleStatus === 'ACTIVE');
    const variantNames = new Map(allVariants.map((v) => [v.id, v.name]));

    const variantResults = await this.evaluateProductVariantReadinessBatch({
      branchId: input.branchId,
      productVariantIds: eligibleVariants.map((v) => v.id),
    });

    return buildProductReadinessResult(input.productId, input.branchId, allVariants.length, variantResults, variantNames);
  },
};
