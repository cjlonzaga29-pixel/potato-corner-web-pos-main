import 'dotenv/config';
import { PHASE_C0_MANIFEST } from '../src/modules/inventory-reference-init/manifest.js';
import { validateManifest } from '../src/modules/inventory-reference-init/manifest.schema.js';
import { runDryRun } from '../src/modules/inventory-reference-init/dry-run.service.js';
import { generateReferenceInitBatchId } from '../src/modules/inventory-reference-init/batch-id.js';

/**
 * Phase C0 R5 "Dry-run" -- read-only planning against live
 * InventoryCategory/UnitOfMeasure/UnitConversion rows. Durably records the
 * run as DRY_RUN_VALIDATED (CR-009.2's lifecycle) but performs zero writes
 * against the three target tables.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-reference-init-dry-run.ts [batchId] [targetEnvironment] [initiatedByUserId]
 */
async function main() {
  const migrationBatch = process.argv[2] ?? generateReferenceInitBatchId();
  const targetEnvironment = process.argv[3] ?? 'unspecified';
  const initiatedBy = process.argv[4];
  if (!initiatedBy) {
    throw new Error('initiatedByUserId (3rd argument) is required -- InitializationRun.initiatedBy has no default');
  }

  const manifest = validateManifest(PHASE_C0_MANIFEST);

  console.log('Phase C0 canonical inventory reference-data — dry-run');
  console.log(`  manifestKey:     ${manifest.manifestKey}`);
  console.log(`  manifestVersion: ${manifest.manifestVersion}`);
  console.log(`  migrationBatch:  ${migrationBatch}`);
  console.log(`  targetEnv:       ${targetEnvironment}`);

  const { plan, manifestFingerprint } = await runDryRun({ manifest, migrationBatch, targetEnvironment, initiatedBy });

  console.log(`  manifestFingerprint: ${manifestFingerprint}`);
  console.log('\nCategories:');
  for (const c of plan.categories) console.log(`  ${c.manifestEntryKey}: ${c.match.status}`);
  console.log('\nUnits:');
  for (const u of plan.units) console.log(`  ${u.manifestEntryKey}: ${u.match.status}`);
  console.log('\nConversions:');
  for (const c of plan.conversions) console.log(`  ${c.manifestEntryKey}: ${c.match.status}`);

  console.log(`\nZero blockers: ${plan.hasZeroBlockers}`);
  if (!plan.hasZeroBlockers) {
    console.log('BLOCKERS PRESENT — apply would refuse to run against this exact live snapshot.');
  }

  process.exitCode = plan.hasZeroBlockers ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('Phase C0 reference-init dry-run failed:', error);
  process.exitCode = 1;
});
