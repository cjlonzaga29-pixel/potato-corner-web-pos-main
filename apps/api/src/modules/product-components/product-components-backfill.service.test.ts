import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./product-components-backfill.repository.js', () => ({
  productComponentsBackfillRepository: {
    countActiveProductInventoryRows: vi.fn(),
    fetchEligibleProductInventoryRows: vi.fn(),
    fetchIdentityMappingsForIngredients: vi.fn(),
    fetchInventoryItemBaseUnits: vi.fn(),
    findExistingComponent: vi.fn(),
  },
}));

vi.mock('./product-components.repository.js', () => ({
  productComponentsRepository: {
    create: vi.fn(),
  },
}));

const { productComponentsBackfillRepository: repo } = await import('./product-components-backfill.repository.js');
const { productComponentsRepository } = await import('./product-components.repository.js');
const { runProductComponentBackfill } = await import('./product-components-backfill.service.js');
const { BACKFILL_CREATED_BY } = await import('./product-components-backfill.types.js');

function decimal(value: number) {
  return { toNumber: () => value };
}

function pi(overrides: Partial<Record<string, unknown>> = {}) {
  const { quantityRequired, ...rest } = overrides;
  return {
    id: 'pi-1',
    productVariantId: 'variant-1',
    ingredientId: 'ingredient-1',
    quantityRequired: decimal(typeof quantityRequired === 'number' ? quantityRequired : 2),
    unit: 'kg',
    ingredient: { name: 'Cheese Powder' },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repo.fetchInventoryItemBaseUnits).mockResolvedValue([{ id: 'item-1', baseUnit: { code: 'kg' } }] as never);
  vi.mocked(repo.findExistingComponent).mockResolvedValue(null);
});

describe('runProductComponentBackfill — dry run', () => {
  it('performs no writes and reports the row it would create', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(1);
    expect(report.rows).toEqual([
      { action: 'create', productVariantId: 'variant-1', inventoryItemId: 'item-1', legacyIngredientName: 'Cheese Powder', quantityRequired: 2 },
    ]);
    expect(productComponentsRepository.create).not.toHaveBeenCalled();
  });
});

describe('runProductComponentBackfill — confirmed run', () => {
  it('creates the ProductComponent row, stamped with the backfill marker', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);

    const report = await runProductComponentBackfill(true);

    expect(report.dryRun).toBe(false);
    expect(productComponentsRepository.create).toHaveBeenCalledWith({
      productVariantId: 'variant-1',
      inventoryItemId: 'item-1',
      quantityRequired: 2,
      createdBy: BACKFILL_CREATED_BY,
    });
  });

  it('is idempotent — a second confirmed run against the same data skips the already-backfilled row', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);
    vi.mocked(repo.findExistingComponent).mockResolvedValue({ id: 'pc-1', createdBy: BACKFILL_CREATED_BY, deletedAt: null } as never);

    const report = await runProductComponentBackfill(true);

    expect(report.created).toBe(0);
    expect(report.skippedExistingBackfilled).toBe(1);
    expect(report.rows[0]?.action).toBe('skip_existing_backfilled');
    expect(productComponentsRepository.create).not.toHaveBeenCalled();
  });

  it('does not overwrite a manually created ProductComponent row', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);
    vi.mocked(repo.findExistingComponent).mockResolvedValue({ id: 'pc-1', createdBy: 'admin-1', deletedAt: null } as never);

    const report = await runProductComponentBackfill(true);

    expect(report.created).toBe(0);
    expect(report.skippedManual).toBe(1);
    expect(report.rows[0]?.action).toBe('skip_manual');
    expect(productComponentsRepository.create).not.toHaveBeenCalled();
  });

  it('does not resurrect a previously (deliberately) deactivated backfill row', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);
    vi.mocked(repo.findExistingComponent).mockResolvedValue({ id: 'pc-1', createdBy: BACKFILL_CREATED_BY, deletedAt: new Date() } as never);

    const report = await runProductComponentBackfill(true);

    expect(report.skippedManual).toBe(1);
    expect(productComponentsRepository.create).not.toHaveBeenCalled();
  });
});

describe('runProductComponentBackfill — unresolved and excluded mappings', () => {
  it('reports an ingredient with no identity mapping as unresolved', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.unresolvedMappings).toEqual([
      { legacyIngredientId: 'ingredient-1', legacyIngredientName: 'Cheese Powder', reason: 'No InventoryIdentityMapping row exists for this ingredient' },
    ]);
    expect(report.created).toBe(0);
  });

  it('reports an AMBIGUOUS mapping status as unresolved', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: null, mappingStatus: 'AMBIGUOUS', mappingMethod: null },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.unresolvedMappings).toHaveLength(1);
    expect(report.unresolvedMappings[0]?.reason).toContain('AMBIGUOUS');
  });

  it('excludes a flavor-linked (FLAVOR_IDENTITY) identity mapping', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'FLAVOR_IDENTITY' },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.created).toBe(0);
    expect(report.unresolvedMappings[0]?.reason).toContain('flavor-linked');
  });

  it('excludes flavor-specific ProductInventory rows before they ever reach the eligible set (counted, not fetched)', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(5);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi()] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.eligibleProductInventoryRows).toBe(1);
    expect(report.excludedFlavorSpecificRows).toBe(4);
  });
});

describe('runProductComponentBackfill — conflicts', () => {
  it('reports a quantity/unit disagreement across branches as a conflict and skips it', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(2);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([
      pi({ id: 'pi-1', quantityRequired: 2 }),
      pi({ id: 'pi-2', quantityRequired: 3 }),
    ] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.reason).toContain('disagree');
    expect(report.created).toBe(0);
    expect(productComponentsRepository.create).not.toHaveBeenCalled();
  });

  it('reports a legacy unit that does not match the resolved item base unit as a conflict', async () => {
    vi.mocked(repo.countActiveProductInventoryRows).mockResolvedValue(1);
    vi.mocked(repo.fetchEligibleProductInventoryRows).mockResolvedValue([pi({ unit: 'g' })] as never);
    vi.mocked(repo.fetchIdentityMappingsForIngredients).mockResolvedValue([
      { legacyIngredientId: 'ingredient-1', inventoryItemId: 'item-1', mappingStatus: 'AUTO_MATCHED', mappingMethod: 'NORMALIZED_NAME_UNIT_CATEGORY' },
    ] as never);

    const report = await runProductComponentBackfill(false);

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.reason).toContain('does not match');
  });
});
