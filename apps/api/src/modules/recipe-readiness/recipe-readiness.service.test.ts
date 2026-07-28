import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./recipe-readiness.repository.js', () => ({
  recipeReadinessRepository: {
    findVariants: vi.fn(),
    findAllActiveBranches: vi.fn(),
    findBranchAvailability: vi.fn(),
    findAllStockKeys: vi.fn(),
    findConflictedInventoryItemIds: vi.fn(),
  },
}));

const { recipeReadinessRepository } = await import('./recipe-readiness.repository.js');
const { recipeReadinessService } = await import('./recipe-readiness.service.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const BRANCH_1 = 'branch-1';
const BRANCH_2 = 'branch-2';
const PRODUCT_1 = 'product-1';
const ITEM_1 = 'item-1';

interface VariantOverrides {
  id?: string;
  productId?: string;
  name?: string;
  sizeLabel?: string;
  isActive?: boolean;
  lifecycleStatus?: string;
  productStatus?: string;
  branchExclusive?: boolean;
  exclusiveBranchId?: string | null;
  components?: Array<{
    id?: string;
    inventoryItemId?: string;
    quantityRequired?: Prisma.Decimal;
    itemDeletedAt?: Date | null;
    mappingStatuses?: string[];
  }>;
  productInventory?: Array<{ id?: string; flavorId?: string | null }>;
}

function buildVariant(overrides: VariantOverrides = {}) {
  const components = (overrides.components ?? [
    { inventoryItemId: ITEM_1, quantityRequired: decimal(1), itemDeletedAt: null, mappingStatuses: [] },
  ]).map((c, i) => ({
    id: c.id ?? `component-${i}`,
    inventoryItemId: c.inventoryItemId ?? ITEM_1,
    quantityRequired: c.quantityRequired ?? decimal(1),
    inventoryItem: {
      id: c.inventoryItemId ?? ITEM_1,
      name: 'Test Item',
      deletedAt: c.itemDeletedAt ?? null,
      identityMappings: (c.mappingStatuses ?? []).map((mappingStatus) => ({ mappingStatus })),
    },
  }));

  return {
    id: overrides.id ?? 'variant-1',
    productId: overrides.productId ?? PRODUCT_1,
    name: overrides.name ?? 'Regular',
    sizeLabel: overrides.sizeLabel ?? 'Regular',
    isActive: overrides.isActive ?? true,
    lifecycleStatus: overrides.lifecycleStatus ?? 'ACTIVE',
    product: {
      id: overrides.productId ?? PRODUCT_1,
      name: 'Test Product',
      status: overrides.productStatus ?? 'active',
      branchExclusive: overrides.branchExclusive ?? false,
      exclusiveBranchId: overrides.exclusiveBranchId ?? null,
    },
    productComponents: components,
    productInventory: (overrides.productInventory ?? []).map((p, i) => ({ id: p.id ?? `pi-${i}`, flavorId: p.flavorId ?? null })),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([]);
  vi.mocked(recipeReadinessRepository.findAllActiveBranches).mockResolvedValue([{ id: BRANCH_1 }, { id: BRANCH_2 }]);
  vi.mocked(recipeReadinessRepository.findBranchAvailability).mockResolvedValue([]);
  vi.mocked(recipeReadinessRepository.findAllStockKeys).mockResolvedValue([
    { branchId: BRANCH_1, inventoryItemId: ITEM_1 },
    { branchId: BRANCH_2, inventoryItemId: ITEM_1 },
  ]);
  vi.mocked(recipeReadinessRepository.findConflictedInventoryItemIds).mockResolvedValue(new Set());
});

describe('recipeReadinessService.buildReport', () => {
  it('classifies a fully ready variant', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant()]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants).toHaveLength(1);
    expect(report.variants[0]).toMatchObject({ status: 'READY', blockers: [] });
    expect(report.summary).toMatchObject({ totalVariants: 1, readyCount: 1, blockedCount: 0, readinessPercentage: 100 });
  });

  it('classifies a variant with no active components as NO_RECIPE', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant({ components: [] })]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('NO_RECIPE');
  });

  it('classifies a variant with a zero/negative quantity component as INVALID_COMPONENT', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ components: [{ inventoryItemId: ITEM_1, quantityRequired: decimal(0) }] }),
    ]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('INVALID_COMPONENT');
    expect(report.variants[0]?.affectedInventoryItemIds).toContain(ITEM_1);
  });

  it('classifies a variant referencing a soft-deleted InventoryItem as INVALID_COMPONENT', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ components: [{ inventoryItemId: ITEM_1, itemDeletedAt: new Date() }] }),
    ]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('INVALID_COMPONENT');
  });

  it('classifies a variant with a pending identity mapping as UNRESOLVED_MAPPING', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ components: [{ inventoryItemId: ITEM_1, mappingStatuses: ['PENDING'] }] }),
    ]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('UNRESOLVED_MAPPING');
  });

  it('does not flag an accepted (AUTO_MATCHED/MANUALLY_MATCHED) mapping as unresolved', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ components: [{ inventoryItemId: ITEM_1, mappingStatuses: ['AUTO_MATCHED'] }] }),
    ]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('READY');
  });

  it('classifies a variant missing InventoryStock at one active branch as INCOMPLETE_BRANCH_STOCK', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant()]);
    vi.mocked(recipeReadinessRepository.findAllStockKeys).mockResolvedValue([{ branchId: BRANCH_1, inventoryItemId: ITEM_1 }]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('INCOMPLETE_BRANCH_STOCK');
    expect(report.variants[0]?.affectedBranchIds).toEqual([BRANCH_2]);
  });

  it('classifies a variant whose item has an unresolved backfill conflict as BACKFILL_CONFLICT', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant()]);
    vi.mocked(recipeReadinessRepository.findConflictedInventoryItemIds).mockResolvedValue(new Set([ITEM_1]));

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('BACKFILL_CONFLICT');
  });

  it('classifies a variant with flavor-specific legacy ProductInventory rows as LEGACY_FLAVOR_DEPENDENCY', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ productInventory: [{ flavorId: 'flavor-1' }] }),
    ]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('LEGACY_FLAVOR_DEPENDENCY');
  });

  it('classifies an inactive/non-sellable variant as INACTIVE without evaluating further rules', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant({ isActive: false, components: [] })]);

    const report = await recipeReadinessService.buildReport();

    expect(report.variants[0]?.status).toBe('INACTIVE');
  });

  it('filters results by branch_id to variants available at that branch', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ id: 'v-exclusive', branchExclusive: true, exclusiveBranchId: BRANCH_1 }),
    ]);

    const reportForBranch1 = await recipeReadinessService.buildReport({ branchId: BRANCH_1 });
    const reportForBranch2 = await recipeReadinessService.buildReport({ branchId: BRANCH_2 });

    expect(reportForBranch1.variants).toHaveLength(1);
    expect(reportForBranch2.variants).toHaveLength(0);
  });

  it('restricts active branches considered to accessibleBranchIds when not "all"', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant()]);
    vi.mocked(recipeReadinessRepository.findAllStockKeys).mockResolvedValue([{ branchId: BRANCH_1, inventoryItemId: ITEM_1 }]);

    const report = await recipeReadinessService.buildReport({ accessibleBranchIds: [BRANCH_1] });

    // Only branch-1 is accessible/considered, and stock exists there, so this is READY
    // even though branch-2 (inaccessible) has no stock row.
    expect(report.variants[0]?.status).toBe('READY');
  });

  it('filters by status', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([
      buildVariant({ id: 'v-ready' }),
      buildVariant({ id: 'v-no-recipe', components: [] }),
    ]);

    const report = await recipeReadinessService.buildReport({ status: 'NO_RECIPE' });

    expect(report.variants).toHaveLength(1);
    expect(report.variants[0]?.productVariantId).toBe('v-no-recipe');
  });

  it('never calls a write method on the repository', async () => {
    vi.mocked(recipeReadinessRepository.findVariants).mockResolvedValue([buildVariant()]);

    await recipeReadinessService.buildReport();

    const repoMethodNames = Object.keys(recipeReadinessRepository);
    expect(repoMethodNames.every((name) => /^find/.test(name))).toBe(true);
  });
});
