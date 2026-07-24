import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./recipes.repository.js', () => ({
  recipesRepository: {
    findMasterRows: vi.fn(),
    findOverrideRows: vi.fn(),
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
    hasActiveRecipeForVariant: vi.fn(),
    getMaxVersionForSelection: vi.fn(),
    findDistinctIngredientIdentities: vi.fn(),
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
const { productsRepository } = await import('../products/products.repository.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { computeDeduction, assertRecipeExists, getRecipeVersion, recipesService } = await import('./recipes.service.js');

/**
 * `ingredientBranchId` defaults to 'branch-a' — the branchId every existing
 * test in this file passes to computeDeduction — so that by default a
 * master row's own ingredient already belongs to the selling branch and
 * CR-004's resolveIngredientForBranch takes its zero-extra-query fast path
 * (no need to mock inventoryRepository per test). Tests that specifically
 * cover cross-branch resolution pass a different branchId explicitly.
 */
function ingredientRow(
  ingredientId: string,
  ingredientName: string,
  quantity: number,
  unit: string,
  flavorId: string | null,
  ingredientBranchId = 'branch-a',
) {
  return {
    id: `row-${ingredientId}-${flavorId ?? 'base'}`,
    productVariantId: 'variant-1',
    ingredientId,
    flavorId,
    quantity: { toNumber: () => quantity },
    unit,
    ingredient: { name: ingredientName, branchId: ingredientBranchId },
    flavor: flavorId ? { name: 'Sour Cream' } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDeduction — CR-001 layered algorithm', () => {
  it('matches the original master-only algorithm when no branch overrides exist (no branchId passed)', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([
      ingredientRow('potato', 'Potato', 200, 'g', null),
      ingredientRow('oil', 'Cooking Oil', 30, 'ml', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2 });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 400, source: 'master_base' });
    expect(lines.find((l) => l.ingredient_id === 'oil')).toMatchObject({ quantity: 60, source: 'master_base' });
    expect(recipesRepository.findOverrideRows).not.toHaveBeenCalled();
  });

  it('master flavor-specific row overrides the master base row for the same ingredient', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([
      ingredientRow('potato', 'Potato', 200, 'g', null),
      ingredientRow('potato', 'Potato', 250, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 250, source: 'master_flavor' });
  });

  it('a branch base override replaces the master base row for the same ingredient', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([ingredientRow('potato', 'Potato', 200, 'g', null)] as never);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([ingredientRow('potato', 'Potato', 180, 'g', null)] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 180, source: 'branch_base' });
  });

  it('a branch flavor-specific override replaces the master flavor row for the same ingredient', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([ingredientRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1')] as never);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([
      ingredientRow('sour_cream', 'Sour Cream Powder', 20, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'sour_cream', quantity: 20, source: 'branch_flavor' });
  });

  it('a branch override adds a new ingredient not present in the master recipe', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([ingredientRow('potato', 'Potato', 200, 'g', null)] as never);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([ingredientRow('seasoning', 'Special Seasoning', 5, 'g', null)] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 200, source: 'master_base' });
    expect(lines.find((l) => l.ingredient_id === 'seasoning')).toMatchObject({ quantity: 5, source: 'branch_base' });
  });

  it('combines all four layers with correct override precedence: master base -> master flavor -> branch base -> branch flavor', async () => {
    // Master: potato (base, 200g), oil (base, 30ml), sour_cream (flavor, 15g)
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([
      ingredientRow('potato', 'Potato', 200, 'g', null),
      ingredientRow('oil', 'Cooking Oil', 30, 'ml', null),
      ingredientRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1'),
    ] as never);
    // Branch: potato (base override, 180g — replaces master base),
    //         sour_cream (flavor override, 25g — replaces master flavor),
    //         seasoning (base, new ingredient not in master at all)
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([
      ingredientRow('potato', 'Potato', 180, 'g', null),
      ingredientRow('sour_cream', 'Sour Cream Powder', 25, 'g', 'flavor-1'),
      ingredientRow('seasoning', 'Special Seasoning', 5, 'g', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 3 });
    // Note: branchId omitted here on purpose to prove overrides are only
    // applied when branchId is passed — re-run with branchId below.
    expect(lines.find((l) => l.ingredient_id === 'seasoning')).toBeUndefined();

    const branchLines = await computeDeduction({
      productVariantId: 'variant-1',
      flavorId: 'flavor-1',
      quantitySold: 3,
      branchId: 'branch-a',
    });

    expect(branchLines).toHaveLength(4);
    expect(branchLines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 540, source: 'branch_base' }); // 180 * 3
    expect(branchLines.find((l) => l.ingredient_id === 'oil')).toMatchObject({ quantity: 90, source: 'master_base' }); // 30 * 3, untouched
    expect(branchLines.find((l) => l.ingredient_id === 'sour_cream')).toMatchObject({ quantity: 75, source: 'branch_flavor' }); // 25 * 3
    expect(branchLines.find((l) => l.ingredient_id === 'seasoning')).toMatchObject({ quantity: 15, source: 'branch_base' }); // 5 * 3
  });
});

describe('computeDeduction — CR-004 cross-branch ingredient resolution', () => {
  it('resolves a master row pinned to a different branch\'s Ingredient to the selling branch\'s own equivalent by name', async () => {
    // Master recipe's ingredientId was created against branch-a's Ingredient
    // row, but this sale happens at branch-b.
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([
      ingredientRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue({
      id: 'potato-branch-b',
      name: 'Potato',
    } as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2, branchId: 'branch-b' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-b', quantity: 400, source: 'master_base' });
    expect(inventoryRepository.findIngredientByBranchAndName).toHaveBeenCalledWith('branch-b', 'Potato');
  });

  it('does not resolve (or query inventoryRepository) when the master row already belongs to the selling branch', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([ingredientRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a')] as never);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-a' });
    expect(inventoryRepository.findIngredientByBranchAndName).not.toHaveBeenCalled();
  });

  it('rejects the deduction when the selling branch has not been provisioned with the master ingredient (fails closed, never silently deducts the wrong branch)', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([ingredientRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a')] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue(null);

    await expect(
      computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-b' }),
    ).rejects.toMatchObject({ code: 'INGREDIENT_NOT_PROVISIONED' });
  });

  it('never resolves branch override rows against another branch — they already belong to the requesting branch', async () => {
    vi.mocked(recipesRepository.findMasterRows).mockResolvedValue([]);
    vi.mocked(recipesRepository.findOverrideRows).mockResolvedValue([ingredientRow('seasoning-branch-b', 'Seasoning', 5, 'g', null, 'branch-b')] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-b' });

    expect(lines[0]).toMatchObject({ ingredient_id: 'seasoning-branch-b' });
    expect(inventoryRepository.findIngredientByBranchAndName).not.toHaveBeenCalled();
  });
});

describe('assertRecipeExists — CR-004', () => {
  it('resolves silently when the variant has at least one active master recipe row', async () => {
    vi.mocked(recipesRepository.hasActiveRecipeForVariant).mockResolvedValue(true);

    await expect(assertRecipeExists('variant-1')).resolves.toBeUndefined();
  });

  it('throws RECIPE_MISSING when the variant has no master recipe rows — a sale must never silently deduct nothing', async () => {
    vi.mocked(recipesRepository.hasActiveRecipeForVariant).mockResolvedValue(false);

    await expect(assertRecipeExists('variant-1')).rejects.toMatchObject({ code: 'RECIPE_MISSING' });
  });
});

describe('getRecipeVersion — CR-004', () => {
  it('delegates to the repository\'s max-version lookup for the variant+flavor selection', async () => {
    vi.mocked(recipesRepository.getMaxVersionForSelection).mockResolvedValue(3);

    await expect(getRecipeVersion('variant-1', 'flavor-1')).resolves.toBe(3);
    expect(recipesRepository.getMaxVersionForSelection).toHaveBeenCalledWith('variant-1', 'flavor-1');
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
