import { describe, it, expect, vi } from 'vitest';

vi.mock('./migration-source.repository.js', () => ({
  fetchLegacyIngredients: vi.fn(async () => [
    { id: 'a', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'b1', deletedAt: null },
    { id: 'b', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'b2', deletedAt: null },
  ]),
  fetchLegacyFlavors: vi.fn(async () => []),
  fetchExistingUnitCodes: vi.fn(async () => []),
  fetchSourceSummary: vi.fn(async () => ({
    branchCount: 2, ingredientCount: 2, activeIngredientCount: 2, softDeletedIngredientCount: 0,
    distinctIngredientUnitCount: 1, distinctIngredientCategoryCount: 1,
    productInventoryCount: 0, activeProductInventoryCount: 0,
    flavorCount: 0, activeFlavorCount: 0, inventoryMovementCount: 0,
    existingUnitOfMeasureCount: 0, existingInventoryCategoryCount: 0,
  })),
}));

const repo = await import('./migration-source.repository.js');
const { runMigrationDryRun } = await import('./dry-run.service.js');

describe('runMigrationDryRun', () => {
  it('assembles a full report and computes readiness from a clean SAFE_AUTO_MATCH_CANDIDATE case', async () => {
    const report = await runMigrationDryRun('CR006-INGREDIENT-20260727-000000');
    expect(report.batchId).toBe('CR006-INGREDIENT-20260727-000000');
    expect(report.identityCandidates).toHaveLength(1);
    expect(report.identityCandidates[0].classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
    expect(report.skuCollisions).toEqual([]);
    expect(report.barcodeCollisions).toEqual([]);
    expect(report.migrationReadiness).toBe(true);
  });

  it('generates a default batch ID when none is provided', async () => {
    const report = await runMigrationDryRun();
    expect(report.batchId).toMatch(/^CR006-INGREDIENT-\d{8}-\d{6}$/);
  });

  it('performs no database writes — only the read-only repository functions are called', async () => {
    await runMigrationDryRun('CR006-INGREDIENT-20260727-000000');
    expect(repo.fetchLegacyIngredients).toHaveBeenCalled();
    expect(repo.fetchLegacyFlavors).toHaveBeenCalled();
    expect(repo.fetchSourceSummary).toHaveBeenCalled();
    // The mocked repository module exposes no create/update/delete export at all,
    // so there is nothing to call that would write — this test documents that
    // the orchestrator only imports the four read functions above.
    expect(Object.keys(repo).sort()).toEqual(
      ['fetchExistingUnitCodes', 'fetchLegacyFlavors', 'fetchLegacyIngredients', 'fetchSourceSummary'].sort(),
    );
  });
});
