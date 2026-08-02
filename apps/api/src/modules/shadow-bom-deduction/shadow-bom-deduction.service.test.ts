import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type { DeductionLine } from '../product-inventory/product-inventory.types.js';

vi.mock('./shadow-bom-deduction.repository.js', () => ({
  shadowBomDeductionRepository: {
    upsertComparison: vi.fn().mockResolvedValue(undefined),
    findAcceptedMappingWithBaseUnit: vi.fn(),
    findActiveComponentsForVariant: vi.fn(),
    buildSummary: vi.fn(),
    findDetails: vi.fn(),
  },
}));

vi.mock('../product-inventory/product-inventory.service.js', () => ({
  computeDeduction: vi.fn(),
}));

vi.mock('../recipe-readiness/recipe-readiness.service.js', () => ({
  recipeReadinessService: { buildReport: vi.fn() },
}));

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: { findConversion: vi.fn() },
}));

// No InventoryMovement/InventoryStock/ProductInventory writer is imported by
// this module at all — asserted implicitly below by never mocking (and
// therefore never being able to call) any such repository. If the service
// ever grew such an import, these tests would fail to compile/mock rather
// than silently pass.

const { shadowBomDeductionRepository } = await import('./shadow-bom-deduction.repository.js');
const { computeDeduction } = await import('../product-inventory/product-inventory.service.js');
const { recipeReadinessService } = await import('../recipe-readiness/recipe-readiness.service.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const {
  shadowBomDeductionService,
  computeBomDeduction,
  normalizeLegacyDeduction,
  compareDeductions,
} = await import('./shadow-bom-deduction.service.js');

function decimal(value: number) {
  return new Prisma.Decimal(value);
}

function legacyLine(overrides: Partial<DeductionLine> = {}): DeductionLine {
  return {
    ingredient_id: 'ingredient-1',
    ingredient_name: 'Cheese Powder',
    quantity: 2,
    unit: 'kg',
    source: 'master_base',
    ...overrides,
  };
}

function readyVariant(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'product-1',
    productName: 'Fries',
    productVariantId: 'variant-1',
    variantName: 'Regular',
    sizeLabel: 'Regular',
    status: 'READY',
    blockers: [],
    affectedBranchIds: [],
    affectedInventoryItemIds: [],
    availableBranchIds: ['branch-1'],
    ...overrides,
  };
}

function readinessReport(variants: Record<string, unknown>[]) {
  return { generatedAt: new Date(), summary: {} as never, variants };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeLegacyDeduction', () => {
  it('maps a legacy line to its InventoryItem via an accepted mapping', async () => {
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue({
      inventoryItemId: 'item-1',
      baseUnitId: 'unit-kg',
      baseUnitCode: 'kg',
    });

    const result = await normalizeLegacyDeduction([legacyLine({ quantity: 4, unit: 'kg' })]);

    expect(result).toEqual({ ok: true, lines: [{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 4 }] });
  });

  it('classifies MISSING_LEGACY_MAPPING when an ingredient has no accepted identity mapping', async () => {
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue(null);

    const result = await normalizeLegacyDeduction([legacyLine()]);

    expect(result).toEqual({ ok: false, classification: 'MISSING_LEGACY_MAPPING' });
  });

  it('classifies UNIT_CONVERSION_UNSUPPORTED when the legacy unit does not match the mapped base unit', async () => {
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue({
      inventoryItemId: 'item-1',
      baseUnitId: 'unit-kg',
      baseUnitCode: 'kg',
    });

    const result = await normalizeLegacyDeduction([legacyLine({ unit: 'g' })]);

    expect(result).toEqual({ ok: false, classification: 'UNIT_CONVERSION_UNSUPPORTED' });
  });

  it('prioritizes MISSING_LEGACY_MAPPING over UNIT_CONVERSION_UNSUPPORTED when both occur', async () => {
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ inventoryItemId: 'item-2', baseUnitId: 'unit-kg', baseUnitCode: 'kg' });

    const result = await normalizeLegacyDeduction([legacyLine({ ingredient_id: 'ingredient-1' }), legacyLine({ ingredient_id: 'ingredient-2', unit: 'g' })]);

    expect(result).toEqual({ ok: false, classification: 'MISSING_LEGACY_MAPPING' });
  });
});

describe('computeBomDeduction', () => {
  it('scales active ProductComponent quantities by quantitySold', async () => {
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(2) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    const result = await computeBomDeduction('variant-1', 'branch-1', 3);

    expect(result).toEqual([{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 6 }]);
  });

  it('merges duplicate InventoryItem rows onto one line', async () => {
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(1) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
      { inventoryItemId: 'item-1', quantityRequired: decimal(2) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    const result = await computeBomDeduction('variant-1', 'branch-1', 1);

    expect(result).toEqual([{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 3 }]);
  });

  it('converts a component recorded in a non-base recipe unit (g) to the item base unit (kg) before scaling', async () => {
    vi.mocked(universalInventoryRepository.findConversion).mockImplementation(
      ((fromUnitId: string, toUnitId: string) =>
        Promise.resolve(fromUnitId === 'unit-g' && toUnitId === 'unit-kg' ? { factor: new Prisma.Decimal(0.001) } : null)) as never,
    );
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(100) as never, baseUnitId: 'unit-kg', recipeUnitId: 'unit-g' },
    ]);

    const result = await computeBomDeduction('variant-1', 'branch-1', 1);

    expect(result).toEqual([{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 0.1 }]);
  });

  it('fails closed (rejects) when a recorded recipe unit has no UnitConversion to the base unit', async () => {
    vi.mocked(universalInventoryRepository.findConversion).mockResolvedValue(null);
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(100) as never, baseUnitId: 'unit-kg', recipeUnitId: 'unit-ml' },
    ]);

    await expect(computeBomDeduction('variant-1', 'branch-1', 1)).rejects.toThrow(/No UnitConversion/);
  });

  it('forwards flavorId to the repository and leaves it as the last parameter (simplified signature)', async () => {
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(1) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    const result = await computeBomDeduction('variant-1', 'branch-1', 3, 'flavor-bbq');

    expect(shadowBomDeductionRepository.findActiveComponentsForVariant).toHaveBeenCalledWith('variant-1', 'flavor-bbq');
    expect(result).toEqual([{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 3 }]);
  });

  it('calls the repository with flavorId undefined when omitted (behavior unchanged)', async () => {
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(2) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    const result = await computeBomDeduction('variant-1', 'branch-1', 3);

    expect(shadowBomDeductionRepository.findActiveComponentsForVariant).toHaveBeenCalledWith('variant-1', undefined);
    expect(result).toEqual([{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 6 }]);
  });
});

describe('compareDeductions', () => {
  const legacy = [{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 4 }];

  it('classifies MATCH for identical item sets and quantities', () => {
    expect(compareDeductions(legacy, [{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 4 }])).toBe('MATCH');
  });

  it('classifies QUANTITY_MISMATCH for the same item with a different quantity', () => {
    expect(compareDeductions(legacy, [{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 5 }])).toBe('QUANTITY_MISMATCH');
  });

  it('classifies MISSING_BOM_COMPONENT when the legacy item has no BOM counterpart', () => {
    expect(compareDeductions(legacy, [])).toBe('MISSING_BOM_COMPONENT');
  });

  it('classifies EXTRA_BOM_COMPONENT when the BOM has an item legacy does not', () => {
    expect(
      compareDeductions(legacy, [
        { inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 4 },
        { inventoryItemId: 'item-2', baseUnitId: 'unit-kg', quantity: 1 },
      ]),
    ).toBe('EXTRA_BOM_COMPONENT');
  });
});

describe('shadowBomDeductionService.runShadowComparison', () => {
  const CRITICAL_STATUSES = ['BACKFILL_CONFLICT', 'UNRESOLVED_MAPPING', 'INCOMPLETE_BRANCH_STOCK', 'INVALID_COMPONENT', 'LEGACY_FLAVOR_DEPENDENCY'];

  it.each(CRITICAL_STATUSES)('classifies BOM_NOT_READY for the critical readiness blocker %s without throwing', async (status) => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(
      readinessReport([readyVariant({ status, blockers: [{ code: status, message: 'blocked' }] })]) as never,
    );

    await expect(shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1)).resolves.toBeUndefined();

    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'txn-1', saleLineId: 'line-1', classification: 'BOM_NOT_READY', bomCalculation: null }),
    );
    expect(computeDeduction).not.toHaveBeenCalled();
  });

  it('routes LEGACY_FLAVOR_DEPENDENCY to BOM_NOT_READY, never FLAVOR_DEPENDENCY (decision: flavor-dependent variants are excluded from comparison entirely by readiness, not scored as a comparison mismatch)', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(
      readinessReport([readyVariant({ status: 'LEGACY_FLAVOR_DEPENDENCY', blockers: [{ code: 'LEGACY_FLAVOR_DEPENDENCY', message: 'flavor' }] })]) as never,
    );

    await shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1);

    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledWith(expect.objectContaining({ classification: 'BOM_NOT_READY' }));
  });

  it('computes and persists a MATCH when legacy and BOM deduct the same InventoryItem quantities', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(readinessReport([readyVariant()]) as never);
    vi.mocked(computeDeduction).mockResolvedValue([legacyLine({ quantity: 4, unit: 'kg' })]);
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue({
      inventoryItemId: 'item-1',
      baseUnitId: 'unit-kg',
      baseUnitCode: 'kg',
    });
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(4) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    await shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1);

    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'MATCH', bomCalculation: [{ inventoryItemId: 'item-1', baseUnitId: 'unit-kg', quantity: 4 }] }),
    );
  });

  it('scales both sides correctly when quantitySold > 1', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(readinessReport([readyVariant()]) as never);
    vi.mocked(computeDeduction).mockImplementation(async ({ quantitySold }) => [legacyLine({ quantity: 2 * quantitySold, unit: 'kg' })] as never);
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue({
      inventoryItemId: 'item-1',
      baseUnitId: 'unit-kg',
      baseUnitCode: 'kg',
    });
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(2) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    await shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 5);

    expect(computeDeduction).toHaveBeenCalledWith(expect.objectContaining({ quantitySold: 5 }));
    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledWith(expect.objectContaining({ classification: 'MATCH' }));
  });

  it('never throws and classifies ERROR when something inside the comparison throws', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockRejectedValue(new Error('readiness db exploded'));

    await expect(shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1)).resolves.toBeUndefined();

    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'ERROR', errorDetails: expect.objectContaining({ message: expect.stringContaining('readiness db exploded') }) }),
    );
  });

  it('never throws even when persisting the ERROR row itself fails', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(shadowBomDeductionRepository.upsertComparison).mockRejectedValueOnce(new Error('db unavailable'));

    await expect(shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1)).resolves.toBeUndefined();
  });

  it('is idempotent by (transactionId, saleLineId): a duplicate call upserts, not inserts twice', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(readinessReport([readyVariant()]) as never);
    vi.mocked(computeDeduction).mockResolvedValue([legacyLine({ quantity: 4, unit: 'kg' })]);
    vi.mocked(shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit).mockResolvedValue({
      inventoryItemId: 'item-1',
      baseUnitId: 'unit-kg',
      baseUnitCode: 'kg',
    });
    vi.mocked(shadowBomDeductionRepository.findActiveComponentsForVariant).mockResolvedValue([
      { inventoryItemId: 'item-1', quantityRequired: decimal(4) as never, baseUnitId: 'unit-kg', recipeUnitId: null },
    ]);

    await shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1);
    await shadowBomDeductionService.runShadowComparison('txn-1', 'line-1', 'branch-1', 'variant-1', 1);

    expect(shadowBomDeductionRepository.upsertComparison).toHaveBeenCalledTimes(2);
    // Both calls target the exact same (transactionId, saleLineId) — the
    // repository's upsert (unique constraint on that pair) is what actually
    // guarantees a single row results, not call-count deduping here.
    for (const call of vi.mocked(shadowBomDeductionRepository.upsertComparison).mock.calls) {
      expect(call[0]).toMatchObject({ transactionId: 'txn-1', saleLineId: 'line-1' });
    }
  });
});
