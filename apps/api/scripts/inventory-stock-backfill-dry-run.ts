import 'dotenv/config';
import { runInventoryStockBackfill } from '../src/modules/universal-inventory/inventory-stock-backfill.service.js';

/**
 * Branch inventory cutover §13 — dry-run InventoryStock backfill. Reports how
 * many (branch, item) InventoryStock rows are missing without writing
 * anything. Run this before inventory-stock-backfill-confirm.ts, and only
 * against a database you've confirmed is safe to write to.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-stock-backfill-dry-run.ts
 */
async function main() {
  const report = await runInventoryStockBackfill(false);

  console.log('Branch inventory cutover — InventoryStock backfill — DRY RUN (no writes)');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Active branches:       ${report.activeBranches}`);
  console.log(`Active tracked items:  ${report.activeTrackedItems}`);
  console.log(`Expected pairs:        ${report.expectedPairs}`);
  console.log(`Existing pairs:        ${report.existingPairs}`);
  console.log(`Missing pairs (would create): ${report.missingPairs}`);

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('InventoryStock backfill dry-run failed:', error);
  process.exitCode = 1;
});
