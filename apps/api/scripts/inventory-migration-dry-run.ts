import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrationDryRun } from '../src/modules/inventory-migration/dry-run.service.js';
import { generateMigrationBatchId } from '../src/modules/inventory-migration/migration-batch.js';

async function main() {
  const batchId = process.argv[2] ?? generateMigrationBatchId();
  const report = await runMigrationDryRun(batchId);

  const outputPath = `reports/inventory-migration/${report.batchId}.json`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`CR-006 Phase B dry-run — batch ${report.batchId}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Legacy ingredients: ${report.sourceSummary.ingredientCount} (${report.sourceSummary.activeIngredientCount} active)`);
  console.log(`Distinct legacy units: ${report.normalizedUnits.length}`);
  console.log(`Category candidates: ${report.categoryCandidates.length}`);
  console.log(`Identity candidates (safe/distinct/invalid): ${report.identityCandidates.length}`);
  console.log(`Ambiguous groups: ${report.ambiguousGroups.length}`);
  console.log(`Flavor-linked candidates: ${report.flavorLinkedCandidates.length}`);
  console.log(`SKU collisions: ${report.skuCollisions.length}`);
  console.log(`Barcode collisions: ${report.barcodeCollisions.length}`);
  console.log(`Invalid records: ${report.invalidRecords.length}`);
  console.log(`Migration readiness: ${report.migrationReadiness ? 'READY' : 'NOT READY'}`);

  if (report.blockers.length > 0) {
    console.log('\nBlockers:');
    for (const blocker of report.blockers) console.log(`  - ${blocker}`);
  }
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
  console.log(`\nFull report written to: ${outputPath}`);

  process.exitCode = report.blockers.length > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('CR-006 Phase B dry-run failed:', error);
  process.exitCode = 1;
});
