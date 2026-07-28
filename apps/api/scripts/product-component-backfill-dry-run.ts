import 'dotenv/config';
import { runProductComponentBackfill } from '../src/modules/product-components/product-components-backfill.service.js';

/**
 * CR-011.1 — dry-run legacy backfill plan. Computes exactly what a confirmed
 * backfill would do (create/skip rows, conflicts, unresolved mappings)
 * without writing anything. Run this before
 * product-component-backfill-confirm.ts.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/product-component-backfill-dry-run.ts
 */
async function main() {
  const report = await runProductComponentBackfill(false);

  console.log('CR-011.1 ProductComponent legacy backfill — DRY RUN (no writes)');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Eligible ProductInventory rows: ${report.eligibleProductInventoryRows}`);
  console.log(`Excluded flavor-specific rows: ${report.excludedFlavorSpecificRows}`);
  console.log(`Candidate (variant, item) pairs: ${report.candidatePairs}`);
  console.log(`  would create:            ${report.created}`);
  console.log(`  already backfilled:      ${report.skippedExistingBackfilled}`);
  console.log(`  skipped (manual rows):   ${report.skippedManual}`);
  console.log(`  unresolved mappings:     ${report.unresolvedMappings.length}`);
  console.log(`  conflicts:               ${report.conflicts.length}`);

  for (const row of report.rows.filter((r) => r.action === 'create')) {
    console.log(`  CREATE variant=${row.productVariantId} item=${row.inventoryItemId} qty=${row.quantityRequired} (${row.legacyIngredientName})`);
  }
  for (const c of report.conflicts) {
    console.log(`  CONFLICT variant=${c.productVariantId} item=${c.inventoryItemId} (${c.legacyIngredientName}): ${c.reason}`);
  }
  for (const u of report.unresolvedMappings) {
    console.log(`  UNRESOLVED ingredient=${u.legacyIngredientId} (${u.legacyIngredientName}): ${u.reason}`);
  }

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('ProductComponent backfill dry-run failed:', error);
  process.exitCode = 1;
});
