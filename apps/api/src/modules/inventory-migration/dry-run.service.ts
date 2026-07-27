import { generateMigrationBatchId } from './migration-batch.js';
import {
  fetchLegacyIngredients,
  fetchLegacyFlavors,
  fetchExistingUnitCodes,
  fetchSourceSummary,
} from './migration-source.repository.js';
import { classifyLegacyUnits } from './unit-classification.js';
import { classifyLegacyCategories } from './category-classification.js';
import { detectIdentityCollisions, detectSkuCollisions, detectBarcodeCollisions } from './identity-collision.js';
import { detectFlavorLinkedCandidates } from './flavor-linked.js';
import { evaluateReadiness } from './readiness.js';
import { normalizeInventoryName, normalizeLegacyUnit } from './normalization.js';
import type { DryRunReport, InvalidRecord } from './types.js';

/**
 * CR-006 Phase B orchestrator. Read-only: calls only the fetch* functions
 * from migration-source.repository.ts, then composes pure classification/
 * detection functions into one report. No InventoryIdentityMapping,
 * InventoryItem, InventoryStock, or ProductComponent row is created here.
 */
export async function runMigrationDryRun(batchId: string = generateMigrationBatchId()): Promise<DryRunReport> {
  const [ingredients, flavors, sourceSummary, existingUnits] = await Promise.all([
    fetchLegacyIngredients(),
    fetchLegacyFlavors(),
    fetchSourceSummary(),
    fetchExistingUnitCodes(),
  ]);

  const normalizedUnits = classifyLegacyUnits(ingredients, existingUnits);
  const categoryCandidates = classifyLegacyCategories(ingredients);
  const identityGroups = detectIdentityCollisions(ingredients);
  const identityCandidates = identityGroups.filter((g) => g.classification !== 'AMBIGUOUS');
  const ambiguousGroups = identityGroups.filter((g) => g.classification === 'AMBIGUOUS');
  const skuCollisions = detectSkuCollisions();
  const barcodeCollisions = detectBarcodeCollisions();
  const flavorLinkedCandidates = detectFlavorLinkedCandidates(flavors, ingredients);

  const invalidUnitNormalized = new Set(
    normalizedUnits.filter((u) => u.classification === 'INVALID').map((u) => u.normalizedUnit),
  );
  const invalidRecords: InvalidRecord[] = ingredients
    .filter((i) => i.deletedAt === null)
    .filter(
      (i) =>
        normalizeInventoryName(i.name).normalized.length === 0 ||
        invalidUnitNormalized.has(normalizeLegacyUnit(i.unit).normalized),
    )
    .map((i) => ({
      ingredientId: i.id,
      reason:
        normalizeInventoryName(i.name).normalized.length === 0
          ? 'Empty or whitespace-only name'
          : 'Unit classified INVALID',
    }));

  const readiness = evaluateReadiness({
    normalizedUnits,
    ambiguousGroups,
    skuCollisions,
    barcodeCollisions,
    flavorLinkedCandidates,
    invalidRecords,
  });

  return {
    batchId,
    generatedAt: new Date().toISOString(),
    sourceSummary,
    normalizedUnits,
    categoryCandidates,
    identityCandidates,
    ambiguousGroups,
    barcodeCollisions,
    skuCollisions,
    flavorLinkedCandidates,
    invalidRecords,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    migrationReadiness: readiness.migrationReadiness,
  };
}
