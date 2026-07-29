import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../transactions/transactions.repository.js', () => ({
  transactionsRepository: {
    findVariantsForSale: vi.fn(),
    findBranchProductAvailabilityMap: vi.fn(),
    findBranchFlavorAvailabilityMap: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    productComponent: { findMany: vi.fn() },
    inventoryStock: { findMany: vi.fn() },
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: {
    findVariantsForReadiness: vi.fn(),
  },
}));

const { transactionsRepository } = await import('../transactions/transactions.repository.js');
const { prisma } = await import('../../lib/prisma.js');
const { productsRepository } = await import('../products/products.repository.js');
const { productReadinessService } = await import('./product-readiness.service.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const BRANCH_1 = 'branch-1';
const PRODUCT_1 = 'product-1';
const VARIANT_1 = 'variant-1';
const FLAVOR_1 = 'flavor-1';
const ITEM_1 = 'item-1';

interface FlavorLinkOverride {
  flavorId?: string;
  isAvailable?: boolean;
  flavorName?: string;
  flavorActive?: boolean;
}

interface SlotOverride {
  id?: string;
  label?: string;
  required?: boolean;
  snackOptions?: Array<{
    snackVariantId?: string;
    snackIsActive?: boolean;
    snackProductStatus?: string;
    snackProductId?: string;
  }>;
}

interface VariantOverrides {
  id?: string;
  productId?: string;
  name?: string;
  isActive?: boolean;
  lifecycleStatus?: string;
  productStatus?: string;
  basePrice?: number;
  variantFlavors?: FlavorLinkOverride[];
  flavorSlots?: SlotOverride[];
}

function buildVariant(overrides: VariantOverrides = {}) {
  return {
    id: overrides.id ?? VARIANT_1,
    productId: overrides.productId ?? PRODUCT_1,
    name: overrides.name ?? 'Test Variant',
    isActive: overrides.isActive ?? true,
    lifecycleStatus: overrides.lifecycleStatus ?? 'ACTIVE',
    basePrice: decimal(overrides.basePrice ?? 100),
    product: {
      id: overrides.productId ?? PRODUCT_1,
      name: 'Test Product',
      status: overrides.productStatus ?? 'active',
    },
    variantFlavors: (overrides.variantFlavors ?? []).map((f) => ({
      flavorId: f.flavorId ?? FLAVOR_1,
      isAvailable: f.isAvailable ?? true,
      flavor: {
        id: f.flavorId ?? FLAVOR_1,
        name: f.flavorName ?? 'Test Flavor',
        isActive: f.flavorActive ?? true,
      },
    })),
    flavorSlots: (overrides.flavorSlots ?? []).map((s, i) => ({
      id: s.id ?? `slot-${i}`,
      label: s.label ?? `Slot ${i}`,
      required: s.required ?? true,
      snackOptions: (s.snackOptions ?? []).map((so) => ({
        snackProductVariant: {
          id: so.snackVariantId ?? `snack-${i}`,
          isActive: so.snackIsActive ?? true,
          product: { id: so.snackProductId ?? `snack-product-${i}`, status: so.snackProductStatus ?? 'active' },
          variantFlavors: [],
        },
      })),
    })),
  };
}

function componentRow(productVariantId: string, overrides: { inventoryItemId?: string; quantityRequired?: number; itemDeleted?: boolean } = {}) {
  return {
    productVariantId,
    inventoryItemId: overrides.inventoryItemId ?? ITEM_1,
    quantityRequired: decimal(overrides.quantityRequired ?? 1),
    inventoryItem: { deletedAt: overrides.itemDeleted ? new Date() : null },
  };
}

function mockDefaults(opts: {
  variants: ReturnType<typeof buildVariant>[];
  productAvailability?: Array<{ productId: string; isAvailable: boolean }>;
  flavorAvailability?: Array<{ flavorId: string; isAvailable: boolean }>;
  componentRows?: ReturnType<typeof componentRow>[];
  stockedItemIds?: string[];
}) {
  vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue(
    opts.variants as unknown as Awaited<ReturnType<typeof transactionsRepository.findVariantsForSale>>,
  );
  vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue(
    (opts.productAvailability ?? [{ productId: PRODUCT_1, isAvailable: true }]) as unknown as Awaited<
      ReturnType<typeof transactionsRepository.findBranchProductAvailabilityMap>
    >,
  );
  vi.mocked(transactionsRepository.findBranchFlavorAvailabilityMap).mockResolvedValue(
    (opts.flavorAvailability ?? []) as unknown as Awaited<ReturnType<typeof transactionsRepository.findBranchFlavorAvailabilityMap>>,
  );
  const components = opts.componentRows ?? [componentRow(VARIANT_1)];
  vi.mocked(prisma.productComponent.findMany).mockResolvedValue(
    components as unknown as Awaited<ReturnType<typeof prisma.productComponent.findMany>>,
  );
  const stockedItemIds = opts.stockedItemIds ?? [...new Set(components.map((c) => c.inventoryItemId))];
  vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue(
    stockedItemIds.map((inventoryItemId) => ({ inventoryItemId })) as unknown as Awaited<ReturnType<typeof prisma.inventoryStock.findMany>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productReadinessService.evaluateProductVariantReadiness', () => {
  it('returns NOT_READY with VARIANT_NOT_FOUND when the variant does not exist', async () => {
    mockDefaults({ variants: [], componentRows: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.status).toBe('NOT_READY');
    expect(result.sellable).toBe(false);
    expect(result.blockingIssues.map((i) => i.code)).toEqual(['VARIANT_NOT_FOUND']);
  });

  it('is READY when every dependency is satisfied', async () => {
    mockDefaults({ variants: [buildVariant()] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.status).toBe('READY');
    expect(result.sellable).toBe(true);
    expect(result.blockingIssues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.completionPercentage).toBe(100);
  });

  it('flags PRODUCT_INACTIVE when the product is not active', async () => {
    mockDefaults({ variants: [buildVariant({ productStatus: 'draft' })] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.productActive).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'PRODUCT_INACTIVE')).toBe(true);
  });

  it('flags VARIANT_INACTIVE when the variant isActive is false', async () => {
    mockDefaults({ variants: [buildVariant({ isActive: false })] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.variantActive).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'VARIANT_INACTIVE')).toBe(true);
  });

  it('flags VARIANT_LIFECYCLE_BLOCKED when lifecycleStatus is not ACTIVE', async () => {
    mockDefaults({ variants: [buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' })] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.variantLifecycleActive).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'VARIANT_LIFECYCLE_BLOCKED')).toBe(true);
  });

  it('flags PRICE_MISSING when basePrice is zero', async () => {
    mockDefaults({ variants: [buildVariant({ basePrice: 0 })] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.priceValid).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'PRICE_MISSING')).toBe(true);
  });

  it('flags BRANCH_NOT_AVAILABLE when the product has no branch-availability row marked available', async () => {
    mockDefaults({ variants: [buildVariant()], productAvailability: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.branchAvailable).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'BRANCH_NOT_AVAILABLE')).toBe(true);
  });

  it('flags RECIPE_MISSING (blocking) when there are no active ProductComponent rows', async () => {
    mockDefaults({ variants: [buildVariant()], componentRows: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.recipeReady).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'RECIPE_MISSING')).toBe(true);
    expect(result.sellable).toBe(false);
  });

  it('flags INVALID_COMPONENT when a component has a non-positive quantity or a deleted inventory item', async () => {
    mockDefaults({ variants: [buildVariant()], componentRows: [componentRow(VARIANT_1, { itemDeleted: true })] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.componentsValid).toBe(false);
    expect(result.inventoryMappingReady).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'INVALID_COMPONENT')).toBe(true);
  });

  it('flags INVENTORY_STOCK_MISSING when a component has no InventoryStock row at this branch', async () => {
    mockDefaults({ variants: [buildVariant()], componentRows: [componentRow(VARIANT_1)], stockedItemIds: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.inventoryStockReady).toBe(false);
    expect(result.inventoryMappingReady).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'INVENTORY_STOCK_MISSING')).toBe(true);
  });

  it('does not require a flavor to be branch-toggled when the link is unavailable or inactive', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1, isAvailable: false }] })],
      flavorAvailability: [{ flavorId: FLAVOR_1, isAvailable: false }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.blockingIssues.some((i) => i.code === 'FLAVOR_NOT_AVAILABLE_AT_BRANCH')).toBe(false);
  });

  it('flags FLAVOR_NOT_AVAILABLE_AT_BRANCH when the flavor is explicitly disabled at the branch', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1 }] })],
      flavorAvailability: [{ flavorId: FLAVOR_1, isAvailable: false }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.flavorLinksConsistent).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'FLAVOR_NOT_AVAILABLE_AT_BRANCH')).toBe(true);
  });

  it('flags MIX_MAX_SLOT_INCOMPLETE when a required slot has no active, branch-available snack option', async () => {
    mockDefaults({
      variants: [buildVariant({ flavorSlots: [{ required: true, snackOptions: [] }] })],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.mixMaxSlotsComplete).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'MIX_MAX_SLOT_INCOMPLETE')).toBe(true);
  });

  it('flags MIX_MAX_SNACK_UNAVAILABLE when an offered snack variant has no active Recipe/BOM', async () => {
    mockDefaults({
      variants: [
        buildVariant({
          flavorSlots: [{ required: true, snackOptions: [{ snackVariantId: 'snack-1', snackProductId: 'snack-product-1' }] }],
        }),
      ],
      productAvailability: [
        { productId: PRODUCT_1, isAvailable: true },
        { productId: 'snack-product-1', isAvailable: true },
      ],
      componentRows: [componentRow(VARIANT_1)],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.mixMaxSlotsComplete).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'MIX_MAX_SNACK_UNAVAILABLE')).toBe(true);
  });

  it('is READY when the required slot snack option is active, branch-available, and has its own Recipe/BOM', async () => {
    mockDefaults({
      variants: [
        buildVariant({
          flavorSlots: [{ required: true, snackOptions: [{ snackVariantId: 'snack-1', snackProductId: 'snack-product-1' }] }],
        }),
      ],
      productAvailability: [
        { productId: PRODUCT_1, isAvailable: true },
        { productId: 'snack-product-1', isAvailable: true },
      ],
      componentRows: [componentRow(VARIANT_1), componentRow('snack-1', { inventoryItemId: 'item-2' })],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.mixMaxSlotsComplete).toBe(true);
    expect(result.sellable).toBe(true);
  });
});

describe('productReadinessService.evaluateProductVariantReadinessBatch', () => {
  it('returns an empty array without issuing any queries for an empty input', async () => {
    const result = await productReadinessService.evaluateProductVariantReadinessBatch({ branchId: BRANCH_1, productVariantIds: [] });

    expect(result).toEqual([]);
    expect(transactionsRepository.findVariantsForSale).not.toHaveBeenCalled();
  });

  it('produces the same result as N individual calls, and issues exactly one round of batched queries regardless of input size', async () => {
    const VARIANT_2 = 'variant-2';
    const variants = [buildVariant({ id: VARIANT_1 }), buildVariant({ id: VARIANT_2, basePrice: 0 })];
    mockDefaults({
      variants,
      componentRows: [componentRow(VARIANT_1), componentRow(VARIANT_2)],
    });

    const batchResult = await productReadinessService.evaluateProductVariantReadinessBatch({
      branchId: BRANCH_1,
      productVariantIds: [VARIANT_1, VARIANT_2],
    });

    expect(transactionsRepository.findVariantsForSale).toHaveBeenCalledTimes(1);
    expect(transactionsRepository.findBranchProductAvailabilityMap).toHaveBeenCalledTimes(1);
    expect(prisma.productComponent.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryStock.findMany).toHaveBeenCalledTimes(1);

    expect(batchResult).toHaveLength(2);
    const [batchFirst, batchSecond] = batchResult as [(typeof batchResult)[number], (typeof batchResult)[number]];
    expect(batchFirst.status).toBe('READY');
    expect(batchSecond.status).toBe('NOT_READY');
    expect(batchSecond.blockingIssues.some((i) => i.code === 'PRICE_MISSING')).toBe(true);

    const [variant1, variant2] = variants as [(typeof variants)[number], (typeof variants)[number]];

    vi.clearAllMocks();
    mockDefaults({ variants: [variant1], componentRows: [componentRow(VARIANT_1)] });
    const single1 = await productReadinessService.evaluateProductVariantReadiness({ branchId: BRANCH_1, productVariantId: VARIANT_1 });

    vi.clearAllMocks();
    mockDefaults({ variants: [variant2], componentRows: [componentRow(VARIANT_2)] });
    const single2 = await productReadinessService.evaluateProductVariantReadiness({ branchId: BRANCH_1, productVariantId: VARIANT_2 });

    expect(batchFirst).toEqual(single1);
    expect(batchSecond).toEqual(single2);
  });

  it('returns a NOT_READY VARIANT_NOT_FOUND entry for ids not present in the fetched rows, preserving input order', async () => {
    const MISSING = 'variant-missing';
    mockDefaults({ variants: [buildVariant()] });

    const result = await productReadinessService.evaluateProductVariantReadinessBatch({
      branchId: BRANCH_1,
      productVariantIds: [MISSING, VARIANT_1],
    });

    const [first, second] = result as [(typeof result)[number], (typeof result)[number]];
    expect(first.productVariantId).toBe(MISSING);
    expect(first.blockingIssues.map((i) => i.code)).toEqual(['VARIANT_NOT_FOUND']);
    expect(second.productVariantId).toBe(VARIANT_1);
    expect(second.status).toBe('READY');
  });
});

describe('productReadinessService.evaluateProductReadiness (Phase D1 — Admin Readiness panel)', () => {
  it('returns NOT_READY / NO_ELIGIBLE_VARIANTS when the product has no active+lifecycle-ACTIVE variant', async () => {
    vi.mocked(productsRepository.findVariantsForReadiness).mockResolvedValue([
      { id: VARIANT_1, name: 'Test Variant', isActive: false, lifecycleStatus: 'ACTIVE' },
    ] as unknown as Awaited<ReturnType<typeof productsRepository.findVariantsForReadiness>>);

    const result = await productReadinessService.evaluateProductReadiness({ productId: PRODUCT_1, branchId: BRANCH_1 });

    expect(result.status).toBe('NOT_READY');
    expect(result.sellable).toBe(false);
    expect(result.eligibleVariantCount).toBe(0);
    expect(result.variantCount).toBe(1);
    expect(result.blockingIssues.map((i) => i.code)).toEqual(['NO_ELIGIBLE_VARIANTS']);
    expect(transactionsRepository.findVariantsForSale).not.toHaveBeenCalled();
  });

  it('excludes inactive/non-lifecycle-ACTIVE variants from the aggregate, and is READY when every eligible variant is sellable', async () => {
    const INACTIVE_VARIANT = 'variant-inactive';
    vi.mocked(productsRepository.findVariantsForReadiness).mockResolvedValue([
      { id: VARIANT_1, name: 'Eligible Variant', isActive: true, lifecycleStatus: 'ACTIVE' },
      { id: INACTIVE_VARIANT, name: 'Inactive Variant', isActive: false, lifecycleStatus: 'ACTIVE' },
    ] as unknown as Awaited<ReturnType<typeof productsRepository.findVariantsForReadiness>>);
    mockDefaults({ variants: [buildVariant({ id: VARIANT_1 })] });

    const result = await productReadinessService.evaluateProductReadiness({ productId: PRODUCT_1, branchId: BRANCH_1 });

    expect(result.status).toBe('READY');
    expect(result.sellable).toBe(true);
    expect(result.variantCount).toBe(2);
    expect(result.eligibleVariantCount).toBe(1);
    expect(result.readyVariantCount).toBe(1);
    expect(result.variants.map((v) => v.productVariantId)).toEqual([VARIANT_1]);
    // The batch call only requests the eligible variant — the inactive one never reaches the readiness engine.
    expect(vi.mocked(transactionsRepository.findVariantsForSale).mock.calls[0]?.[0]).toEqual([VARIANT_1]);
  });

  it('is NOT_READY and surfaces the blocking issue when an eligible variant is not sellable', async () => {
    vi.mocked(productsRepository.findVariantsForReadiness).mockResolvedValue([
      { id: VARIANT_1, name: 'Eligible Variant', isActive: true, lifecycleStatus: 'ACTIVE' },
    ] as unknown as Awaited<ReturnType<typeof productsRepository.findVariantsForReadiness>>);
    mockDefaults({ variants: [buildVariant({ id: VARIANT_1, basePrice: 0 })] });

    const result = await productReadinessService.evaluateProductReadiness({ productId: PRODUCT_1, branchId: BRANCH_1 });

    expect(result.status).toBe('NOT_READY');
    expect(result.readyVariantCount).toBe(0);
    expect(result.blockingIssues.some((i) => i.code === 'PRICE_MISSING')).toBe(true);
    expect(result.variants[0]?.status).toBe('NOT_READY');
  });
});
