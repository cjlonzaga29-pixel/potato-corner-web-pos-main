import 'dotenv/config';
import { runInventoryStockBackfill } from '../src/modules/universal-inventory/inventory-stock-backfill.service.js';

/**
 * Branch inventory cutover §13 — confirmed InventoryStock backfill. Creates
 * one zero-quantity InventoryStock row for every active branch × active
 * tracked InventoryItem pair that doesn't already have one. Additive only:
 * never overwrites an existing row's quantity, never touches legacy tables,
 * safe to run multiple times (skipDuplicates).
 *
 * Run inventory-stock-backfill-dry-run.ts first and review its output.
 * Only run this against a database you've confirmed is safe to write to —
 * this repo's DATABASE_URL may point at a shared/production project.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-stock-backfill-confirm.ts
 */
async function main() {
  const report = await runInventoryStockBackfill(true);

  console.log('Branch inventory cutover — InventoryStock backfill — CONFIRMED (writes applied)');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Active branches:       ${report.activeBranches}`);
  console.log(`Active tracked items:  ${report.activeTrackedItems}`);
  console.log(`Expected pairs:        ${report.expectedPairs}`);
  console.log(`Rows created:          ${report.created}`);
  console.log(`Rows already existing: ${report.existingPairs}`);

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('InventoryStock backfill confirm run failed:', error);
  process.exitCode = 1;
});
