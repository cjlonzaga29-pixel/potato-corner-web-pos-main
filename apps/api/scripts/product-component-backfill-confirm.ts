import 'dotenv/config';
import { runProductComponentBackfill } from '../src/modules/product-components/product-components-backfill.service.js';

/**
 * CR-011.1 — confirmed legacy backfill. Copies eligible active
 * ProductInventory mappings into ProductComponent via
 * InventoryIdentityMapping. Requires --confirm; run
 * product-component-backfill-dry-run.ts first and review its output.
 *
 * Idempotent: re-running this after a successful run creates nothing new
 * (already-backfilled rows are recognized and skipped). Never touches or
 * deletes ProductInventory, and never overwrites a ProductComponent row it
 * did not itself create.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/product-component-backfill-confirm.ts --confirm
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--confirm')) {
    throw new Error('Refusing to run without --confirm. Run product-component-backfill-dry-run.ts first, then re-run with --confirm.');
  }

  const report = await runProductComponentBackfill(true);

  console.log('CR-011.1 ProductComponent legacy backfill — APPLIED');
  console.log(`  created:                 ${report.created}`);
  console.log(`  already backfilled:      ${report.skippedExistingBackfilled}`);
  console.log(`  skipped (manual rows):   ${report.skippedManual}`);
  console.log(`  unresolved mappings:     ${report.unresolvedMappings.length}`);
  console.log(`  conflicts:               ${report.conflicts.length}`);

  if (report.unresolvedMappings.length > 0 || report.conflicts.length > 0) {
    console.log('\n  Some legacy mappings were not backfilled — re-run product-component-backfill-dry-run.ts for the full list.');
  }

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('ProductComponent backfill failed:', error);
  process.exitCode = 1;
});
