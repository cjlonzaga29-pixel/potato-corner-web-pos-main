import 'dotenv/config';
import { PHASE_C0_MANIFEST } from '../src/modules/inventory-reference-init/manifest.js';
import { validateManifest } from '../src/modules/inventory-reference-init/manifest.schema.js';
import { applyManifest } from '../src/modules/inventory-reference-init/apply.service.js';

/**
 * Phase C0 R6 "Apply safety" -- writes canonical InventoryCategory /
 * UnitOfMeasure / UnitConversion rows for a batch that has ALREADY been
 * dry-run (DRY_RUN_VALIDATED). Requires explicit `--confirm` and
 * `--acknowledge-rollback-reviewed` -- no implicit/default confirmation, no
 * startup execution, no deployment-time execution.
 *
 * NOT RUN by the Phase C0 implementation task itself — see
 * docs/decisions/PHASE-C0-canonical-inventory-reference-initialization.md
 * "Apply safety" for the rationale and the exact non-execution boundary.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-reference-init-apply.ts <batchId> <targetEnvironment> --confirm --acknowledge-rollback-reviewed
 */
async function main() {
  const migrationBatch = process.argv[2];
  const targetEnvironment = process.argv[3];
  const flags = new Set(process.argv.slice(4));

  if (!migrationBatch || !targetEnvironment) {
    throw new Error('Usage: inventory-reference-init-apply.ts <batchId> <targetEnvironment> --confirm --acknowledge-rollback-reviewed');
  }
  if (!flags.has('--confirm')) {
    throw new Error('Refusing to apply without --confirm');
  }
  if (!flags.has('--acknowledge-rollback-reviewed')) {
    throw new Error('Refusing to apply without --acknowledge-rollback-reviewed (review the rollback-assessment/rollback-execution commands first)');
  }

  const manifest = validateManifest(PHASE_C0_MANIFEST);

  console.log('Phase C0 canonical inventory reference-data — APPLY');
  console.log(`  migrationBatch: ${migrationBatch}`);
  console.log(`  targetEnv:      ${targetEnvironment}`);

  const result = await applyManifest({
    manifest,
    migrationBatch,
    targetEnvironment,
    confirm: true,
    acknowledgeRollbackReviewed: true,
  });

  console.log(`\nRun ${result.runId}: ${result.status}`);
  if (result.failureReason) console.log(`  reason: ${result.failureReason}`);

  process.exitCode = result.status === 'APPLIED' ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('Phase C0 reference-init apply failed:', error);
  process.exitCode = 1;
});
