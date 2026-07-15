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
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findVariantById: vi.fn() },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { recipesRepository } = await import('./recipes.repository.js');
const { computeDeduction } = await import('./recipes.service.js');

function ingredientRow(ingredientId: string, ingredientName: string, quantity: number, unit: string, flavorId: string | null) {
  return {
    id: `row-${ingredientId}-${flavorId ?? 'base'}`,
    productVariantId: 'variant-1',
    ingredientId,
    flavorId,
    quantity: { toNumber: () => quantity },
    unit,
    ingredient: { name: ingredientName },
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
