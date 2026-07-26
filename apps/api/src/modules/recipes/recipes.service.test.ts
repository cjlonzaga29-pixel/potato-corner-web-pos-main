import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./recipes.repository.js', () => ({
  recipesRepository: {
    findByVariant: vi.fn(),
    findRecipeById: vi.fn(),
    createRecipe: vi.fn(),
    updateRecipe: vi.fn(),
    deleteRecipe: vi.fn(),
    findOverridesByVariantAndBranch: vi.fn(),
    findOverrideById: vi.fn(),
    createOverride: vi.fn(),
    updateOverride: vi.fn(),
    deleteOverride: vi.fn(),
  },
}));

vi.mock('../product-inventory/product-inventory.repository.js', () => ({
  productInventoryRepository: {
    findByVariantForDeduction: vi.fn(),
    hasMappingForVariant: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findVariantById: vi.fn(), countVariantFlavorSlots: vi.fn() },
}));

vi.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findIngredientById: vi.fn(),
    findIngredientByBranchAndName: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

const { recipesRepository } = await import('./recipes.repository.js');
const { productInventoryRepository } = await import('../product-inventory/product-inventory.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { computeDeduction, assertProductInventoryExists, recipesService } = await import('./recipes.service.js');

/**
 * `ingredientBranchId` defaults to 'branch-a' — the branchId every existing
 * test in this file passes to computeDeduction — so that by default a row's
 * own ingredient already belongs to the selling branch and CR-004's
 * resolveIngredientForBranch takes its zero-extra-query fast path (no need
 * to mock inventoryRepository per test). Tests that specifically cover
 * cross-branch resolution pass a different branchId explicitly.
 */
function productInventoryRow(
  ingredientId: string,
  ingredientName: string,
  quantity: number,
  unit: string,
  flavorId: string | null,
  ingredientBranchId = 'branch-a',
) {
  return {
    id: `pi-${ingredientId}-${flavorId ?? 'base'}`,
    productVariantId: 'variant-1',
    ingredientId,
    flavorId,
    quantityRequired: { toNumber: () => quantity },
    unit,
    version: 1,
    ingredient: { id: ingredientId, name: ingredientName, branchId: ingredientBranchId, unit, currentStock: { toNumber: () => 9999 } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDeduction — base/flavor mapping override', () => {
  it('deducts base-only mappings when no flavor is selected', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 200, 'g', null),
      productInventoryRow('oil', 'Cooking Oil', 30, 'ml', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2, branchId: 'branch-a' });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 400 });
    expect(lines.find((l) => l.ingredient_id === 'oil')).toMatchObject({ quantity: 60 });
  });

  it('passes branchId, productVariantId, and flavorId through to the branch-scoped repository lookup', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(productInventoryRepository.findByVariantForDeduction).toHaveBeenCalledWith('branch-a', 'variant-1', 'flavor-1');
  });

  it('rejects when no branchId is provided — deduction must never fall back to an inferred or unscoped lookup', async () => {
    await expect(
      computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1 }),
    ).rejects.toMatchObject({ code: 'BRANCH_ID_REQUIRED' });
    expect(productInventoryRepository.findByVariantForDeduction).not.toHaveBeenCalled();
  });

  it('only consults the selling branch — mappings from another branch are never requested', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(productInventoryRepository.findByVariantForDeduction).not.toHaveBeenCalledWith('branch-b', expect.anything(), expect.anything());
  });

  it('deducts flavor-only mappings when the variant has no base mapping for that ingredient', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'sour_cream', quantity: 15 });
  });

  it('combines base and flavor mappings for different ingredients', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 200, 'g', null),
      productInventoryRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 200 });
    expect(lines.find((l) => l.ingredient_id === 'sour_cream')).toMatchObject({ quantity: 15 });
  });

  it('flavor mapping overrides the base mapping for the same ingredient when the query returns flavor rows first', async () => {
    // Row order deliberately reversed (flavor before base) — the DB gives no
    // ordering guarantee, so the override must not depend on it.
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 250, 'g', 'flavor-1'),
      productInventoryRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 250 });
  });

  it('flavor mapping overrides the base mapping for the same ingredient when the query returns base rows first', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato', 'Potato', 200, 'g', null),
      productInventoryRow('potato', 'Potato', 250, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 250 });
  });
});

describe('computeDeduction — CR-004 cross-branch ingredient resolution', () => {
  it('resolves a mapping pinned to a different branch\'s Ingredient to the selling branch\'s own equivalent by name', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue({
      id: 'potato-branch-b',
      name: 'Potato',
    } as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2, branchId: 'branch-b' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-b', quantity: 400 });
    expect(inventoryRepository.findIngredientByBranchAndName).toHaveBeenCalledWith('branch-b', 'Potato');
  });

  it('does not resolve (or query inventoryRepository) when the mapping already belongs to the selling branch', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-a' });
    expect(inventoryRepository.findIngredientByBranchAndName).not.toHaveBeenCalled();
  });

  it('rejects the deduction when the selling branch has not been provisioned with the mapped ingredient (fails closed, never silently deducts the wrong branch)', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      productInventoryRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue(null);

    await expect(
      computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-b' }),
    ).rejects.toMatchObject({ code: 'INGREDIENT_NOT_PROVISIONED' });
  });
});

describe('assertProductInventoryExists — CR-004', () => {
  it('resolves silently when the variant has at least one ProductInventory mapping', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(true);

    await expect(assertProductInventoryExists('branch-a', 'variant-1')).resolves.toBeUndefined();
  });

  it('passes branchId and productVariantId through to the repository check', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(true);

    await assertProductInventoryExists('branch-a', 'variant-1');

    expect(productInventoryRepository.hasMappingForVariant).toHaveBeenCalledWith('branch-a', 'variant-1');
  });

  it('throws RECIPE_MISSING when the variant has no ProductInventory mapping — a sale must never silently deduct nothing', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(false);

    await expect(assertProductInventoryExists('branch-a', 'variant-1')).rejects.toMatchObject({ code: 'RECIPE_MISSING' });
  });

  it('throws RECIPE_MISSING when the only mapping belongs to another branch — a mapping from one branch must never satisfy validation for a sale at a different branch', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(false);

    await expect(assertProductInventoryExists('branch-b', 'variant-1')).rejects.toMatchObject({ code: 'RECIPE_MISSING' });
    expect(productInventoryRepository.hasMappingForVariant).toHaveBeenCalledWith('branch-b', 'variant-1');
  });
});

function buildMasterRecipeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'recipe-1',
    productVariantId: 'variant-1',
    ingredientId: 'ingredient-1',
    flavorId: null,
    flavorSlotIndex: null,
    quantity: { toNumber: () => 10 },
    unit: 'grams',
    version: 1,
    ingredient: { name: 'Cheese Powder', branchId: 'branch-a' },
    flavor: null,
    ...overrides,
  };
}

const CREATE_INPUT_BASE = { product_variant_id: 'variant-1', ingredient_id: 'ingredient-1', quantity: 10, unit: 'grams' };
const ACTOR = { id: 'admin-1', role: 'super_admin' };

describe('recipesService.createRecipe — CR-005 3f flavorSlotIndex', () => {
  beforeEach(() => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
  });

  it('rejects when both flavor_id and flavor_slot_index are set (RECIPE_FLAVOR_AMBIGUOUS)', async () => {
    await expect(
      recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_id: 'flavor-1', flavor_slot_index: 0 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'RECIPE_FLAVOR_AMBIGUOUS', statusCode: 400 });
    expect(recipesRepository.createRecipe).not.toHaveBeenCalled();
  });

  it('creates successfully with flavor_id only (existing behavior, no slot lookup needed)', async () => {
    vi.mocked(recipesRepository.createRecipe).mockResolvedValue(buildMasterRecipeRow({ flavorId: 'flavor-1' }) as never);

    await recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_id: 'flavor-1' }, ACTOR, null);

    expect(productsRepository.countVariantFlavorSlots).not.toHaveBeenCalled();
    expect(recipesRepository.createRecipe).toHaveBeenCalledWith(expect.objectContaining({ flavorId: 'flavor-1', flavorSlotIndex: null }));
  });

  it('creates successfully with flavor_slot_index only, within range', async () => {
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(3);
    vi.mocked(recipesRepository.createRecipe).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: 1 }) as never);

    await recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_slot_index: 1 }, ACTOR, null);

    expect(recipesRepository.createRecipe).toHaveBeenCalledWith(expect.objectContaining({ flavorId: null, flavorSlotIndex: 1 }));
  });

  it('rejects flavor_slot_index on a variant with zero flavor slots (RECIPE_SLOT_INDEX_ON_SLOTLESS_VARIANT)', async () => {
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);

    await expect(
      recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_slot_index: 0 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'RECIPE_SLOT_INDEX_ON_SLOTLESS_VARIANT', statusCode: 400 });
    expect(recipesRepository.createRecipe).not.toHaveBeenCalled();
  });

  it('rejects a negative flavor_slot_index (RECIPE_SLOT_INDEX_OUT_OF_RANGE)', async () => {
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(3);

    await expect(
      recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_slot_index: -1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'RECIPE_SLOT_INDEX_OUT_OF_RANGE', statusCode: 400 });
    expect(recipesRepository.createRecipe).not.toHaveBeenCalled();
  });

  it('rejects a flavor_slot_index >= the variant\'s slot count (RECIPE_SLOT_INDEX_OUT_OF_RANGE)', async () => {
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(3);

    await expect(
      recipesService.createRecipe({ ...CREATE_INPUT_BASE, flavor_slot_index: 3 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'RECIPE_SLOT_INDEX_OUT_OF_RANGE', statusCode: 400 });
    expect(recipesRepository.createRecipe).not.toHaveBeenCalled();
  });
});

describe('recipesService.updateRecipe — CR-005 3f flavorSlotIndex', () => {
  it('updates flavor_slot_index within range, persists it, and bumps version', async () => {
    vi.mocked(recipesRepository.findRecipeById).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: null, version: 1 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(2);
    vi.mocked(recipesRepository.updateRecipe).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: 1, version: 2 }) as never);

    const result = await recipesService.updateRecipe('recipe-1', { flavor_slot_index: 1 }, ACTOR, null);

    expect(recipesRepository.updateRecipe).toHaveBeenCalledWith('recipe-1', expect.objectContaining({ flavorSlotIndex: 1 }));
    expect(result).toMatchObject({ flavor_slot_index: 1, version: 2 });
  });

  it('clears flavor_slot_index when explicitly set to null', async () => {
    vi.mocked(recipesRepository.findRecipeById).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: 0 }) as never);
    vi.mocked(recipesRepository.updateRecipe).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: null }) as never);

    await recipesService.updateRecipe('recipe-1', { flavor_slot_index: null }, ACTOR, null);

    // null clears without re-validating range (assertRecipeFlavorTargetingValid short-circuits on null).
    expect(productsRepository.countVariantFlavorSlots).not.toHaveBeenCalled();
    expect(recipesRepository.updateRecipe).toHaveBeenCalledWith('recipe-1', expect.objectContaining({ flavorSlotIndex: null }));
  });

  it('omitting flavor_slot_index leaves the existing value unchanged (validated, not overwritten)', async () => {
    vi.mocked(recipesRepository.findRecipeById).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: 1 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(2);
    vi.mocked(recipesRepository.updateRecipe).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: 1, quantity: { toNumber: () => 20 } }) as never);

    await recipesService.updateRecipe('recipe-1', { quantity: 20 }, ACTOR, null);

    expect(productsRepository.countVariantFlavorSlots).toHaveBeenCalledWith('variant-1');
    expect(recipesRepository.updateRecipe).toHaveBeenCalledWith('recipe-1', expect.objectContaining({ flavorSlotIndex: undefined }));
  });

  it('rejects an out-of-range flavor_slot_index against the variant\'s current slot count', async () => {
    vi.mocked(recipesRepository.findRecipeById).mockResolvedValue(buildMasterRecipeRow({ flavorSlotIndex: null }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(2);

    await expect(
      recipesService.updateRecipe('recipe-1', { flavor_slot_index: 5 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'RECIPE_SLOT_INDEX_OUT_OF_RANGE', statusCode: 400 });
    expect(recipesRepository.updateRecipe).not.toHaveBeenCalled();
  });

  it('emits a RECIPE_UPDATED socket notification after a successful update', async () => {
    const { notifySuperAdmin } = await import('../../lib/notify.js');
    vi.mocked(recipesRepository.findRecipeById).mockResolvedValue(buildMasterRecipeRow() as never);
    vi.mocked(recipesRepository.updateRecipe).mockResolvedValue(buildMasterRecipeRow({ version: 2 }) as never);

    await recipesService.updateRecipe('recipe-1', { quantity: 15 }, ACTOR, null);

    expect(notifySuperAdmin).toHaveBeenCalledWith(
      'recipe:updated',
      expect.objectContaining({ recipe_id: 'recipe-1', product_variant_id: 'variant-1', version: 2 }),
    );
  });
});
