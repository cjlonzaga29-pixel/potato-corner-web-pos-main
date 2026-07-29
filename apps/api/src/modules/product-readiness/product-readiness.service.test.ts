import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../transactions/transactions.repository.js', () => ({
  transactionsRepository: {
    findVariantsForSale: vi.fn(),
    findBranchProductAvailabilityMap: vi.fn(),
    findBranchFlavorAvailabilityMap: vi.fn(),
  },
}));

vi.mock('../product-inventory/product-inventory.repository.js', () => ({
  productInventoryRepository: {
    findActiveMappingsForVariants: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    productComponent: { findMany: vi.fn() },
  },
}));

const { transactionsRepository } = await import('../transactions/transactions.repository.js');
const { productInventoryRepository } = await import('../product-inventory/product-inventory.repository.js');
const { prisma } = await import('../../lib/prisma.js');
const { productReadinessService } = await import('./product-readiness.service.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const BRANCH_1 = 'branch-1';
const PRODUCT_1 = 'product-1';
const VARIANT_1 = 'variant-1';
const FLAVOR_1 = 'flavor-1';

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

function mockDefaults(opts: {
  variants: ReturnType<typeof buildVariant>[];
  productAvailability?: Array<{ productId: string; isAvailable: boolean }>;
  flavorAvailability?: Array<{ flavorId: string; isAvailable: boolean }>;
  mappings?: Array<{ productVariantId: string; flavorId: string | null }>;
  recipeRows?: Array<{ productVariantId: string }>;
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
  vi.mocked(productInventoryRepository.findActiveMappingsForVariants).mockResolvedValue(
    (opts.mappings ?? [{ productVariantId: VARIANT_1, flavorId: null }]) as unknown as Awaited<
      ReturnType<typeof productInventoryRepository.findActiveMappingsForVariants>
    >,
  );
  vi.mocked(prisma.productComponent.findMany).mockResolvedValue(
    (opts.recipeRows ?? []) as unknown as Awaited<ReturnType<typeof prisma.productComponent.findMany>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productReadinessService.evaluateProductVariantReadiness', () => {
  it('returns NOT_READY with VARIANT_NOT_FOUND when the variant does not exist', async () => {
    mockDefaults({ variants: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.status).toBe('NOT_READY');
    expect(result.sellable).toBe(false);
    expect(result.blockingIssues.map((i) => i.code)).toEqual(['VARIANT_NOT_FOUND']);
  });

  it('is READY when every dependency is satisfied', async () => {
    mockDefaults({ variants: [buildVariant()], recipeRows: [{ productVariantId: VARIANT_1 }] });

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

  it('flags BASE_INVENTORY_MAPPING_MISSING when there is no base ProductInventory row', async () => {
    mockDefaults({ variants: [buildVariant()], mappings: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.baseInventoryMapped).toBe(false);
    expect(result.inventoryMappingReady).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'BASE_INVENTORY_MAPPING_MISSING')).toBe(true);
  });

  it('flags FLAVOR_INVENTORY_MAPPING_MISSING when a linked, active flavor has no flavor-scoped mapping', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1 }] })],
      mappings: [{ productVariantId: VARIANT_1, flavorId: null }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.flavorLinksConsistent).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'FLAVOR_INVENTORY_MAPPING_MISSING')).toBe(true);
  });

  it('does not require a mapping for a flavor link that is unavailable or inactive', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1, isAvailable: false }] })],
      mappings: [{ productVariantId: VARIANT_1, flavorId: null }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.blockingIssues.some((i) => i.code === 'FLAVOR_INVENTORY_MAPPING_MISSING')).toBe(false);
  });

  it('flags FLAVOR_NOT_AVAILABLE_AT_BRANCH when the flavor is explicitly disabled at the branch', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1 }] })],
      mappings: [
        { productVariantId: VARIANT_1, flavorId: null },
        { productVariantId: VARIANT_1, flavorId: FLAVOR_1 },
      ],
      flavorAvailability: [{ flavorId: FLAVOR_1, isAvailable: false }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.flavorLinksConsistent).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'FLAVOR_NOT_AVAILABLE_AT_BRANCH')).toBe(true);
  });

  it('warns UNLINKED_FLAVOR_MAPPING (non-blocking) for a mapping whose flavor is not actively linked', async () => {
    mockDefaults({
      variants: [buildVariant()],
      mappings: [
        { productVariantId: VARIANT_1, flavorId: null },
        { productVariantId: VARIANT_1, flavorId: FLAVOR_1 },
      ],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.warnings.some((i) => i.code === 'UNLINKED_FLAVOR_MAPPING')).toBe(true);
    expect(result.blockingIssues.some((i) => i.code === 'UNLINKED_FLAVOR_MAPPING')).toBe(false);
    expect(result.sellable).toBe(true);
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

  it('flags MIX_MAX_SNACK_UNAVAILABLE when an offered snack variant has no base ProductInventory mapping', async () => {
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
      mappings: [{ productVariantId: VARIANT_1, flavorId: null }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.mixMaxSlotsComplete).toBe(false);
    expect(result.blockingIssues.some((i) => i.code === 'MIX_MAX_SNACK_UNAVAILABLE')).toBe(true);
  });

  it('is READY when the required slot snack option is active, branch-available, and base-mapped', async () => {
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
      mappings: [
        { productVariantId: VARIANT_1, flavorId: null },
        { productVariantId: 'snack-1', flavorId: null },
      ],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.checks.mixMaxSlotsComplete).toBe(true);
    expect(result.sellable).toBe(true);
  });

  it('warns RECIPE_MISSING when there are no active ProductComponent rows', async () => {
    mockDefaults({ variants: [buildVariant()], recipeRows: [] });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.recipeReady).toBe(false);
    expect(result.warnings.some((i) => i.code === 'RECIPE_MISSING')).toBe(true);
    expect(result.sellable).toBe(true);
  });

  it('warns RECIPE_FLAVOR_SCOPE_UNSUPPORTED when recipeReady=true but flavor-scoped ProductInventory rows exist (recipe/inventory divergence)', async () => {
    mockDefaults({
      variants: [buildVariant({ variantFlavors: [{ flavorId: FLAVOR_1 }] })],
      mappings: [
        { productVariantId: VARIANT_1, flavorId: null },
        { productVariantId: VARIANT_1, flavorId: FLAVOR_1 },
      ],
      recipeRows: [{ productVariantId: VARIANT_1 }],
    });

    const result = await productReadinessService.evaluateProductVariantReadiness({
      branchId: BRANCH_1,
      productVariantId: VARIANT_1,
    });

    expect(result.recipeReady).toBe(true);
    expect(result.inventoryMappingReady).toBe(true);
    expect(result.warnings.some((i) => i.code === 'RECIPE_FLAVOR_SCOPE_UNSUPPORTED')).toBe(true);
    // A warning must never flip sellable/status — recipe/inventory divergence is disclosed, not blocking.
    expect(result.sellable).toBe(true);
    expect(result.status).toBe('READY');
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
      mappings: [
        { productVariantId: VARIANT_1, flavorId: null },
        { productVariantId: VARIANT_2, flavorId: null },
      ],
    });

    const batchResult = await productReadinessService.evaluateProductVariantReadinessBatch({
      branchId: BRANCH_1,
      productVariantIds: [VARIANT_1, VARIANT_2],
    });

    expect(transactionsRepository.findVariantsForSale).toHaveBeenCalledTimes(1);
    expect(transactionsRepository.findBranchProductAvailabilityMap).toHaveBeenCalledTimes(1);
    expect(productInventoryRepository.findActiveMappingsForVariants).toHaveBeenCalledTimes(1);
    expect(prisma.productComponent.findMany).toHaveBeenCalledTimes(1);

    expect(batchResult).toHaveLength(2);
    const [batchFirst, batchSecond] = batchResult as [(typeof batchResult)[number], (typeof batchResult)[number]];
    expect(batchFirst.status).toBe('READY');
    expect(batchSecond.status).toBe('NOT_READY');
    expect(batchSecond.blockingIssues.some((i) => i.code === 'PRICE_MISSING')).toBe(true);

    const [variant1, variant2] = variants as [(typeof variants)[number], (typeof variants)[number]];

    vi.clearAllMocks();
    mockDefaults({
      variants: [variant1],
      mappings: [{ productVariantId: VARIANT_1, flavorId: null }],
    });
    const single1 = await productReadinessService.evaluateProductVariantReadiness({ branchId: BRANCH_1, productVariantId: VARIANT_1 });

    vi.clearAllMocks();
    mockDefaults({
      variants: [variant2],
      mappings: [{ productVariantId: VARIANT_2, flavorId: null }],
    });
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
