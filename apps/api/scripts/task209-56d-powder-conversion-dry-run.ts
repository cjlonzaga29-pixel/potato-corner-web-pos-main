import 'dotenv/config';
import { seedPotatoCornerPowderConversions } from '../src/modules/universal-inventory/potato-corner-powder-conversions.seed.js';

/**
 * TASK 209.56D — dry run for the Potato Corner flavor-powder tbsp->kg
 * item-specific unit conversions (1 tbsp = 0.006 kg). Read-only: makes no
 * database writes. Review this output, then run
 * task209-56d-powder-conversion-confirm.ts to apply.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/task209-56d-powder-conversion-dry-run.ts
 */
async function main() {
  const report = await seedPotatoCornerPowderConversions(false);

  console.log('TASK 209.56D — Potato Corner powder tbsp->kg conversion — DRY RUN (no writes)\n');
  console.log(`Would create (${report.created.length}):`);
  for (const r of report.created) console.log(`  + ${r.itemName}  [${r.itemId}]  1 tbsp = 0.006 kg`);

  console.log(`\nAlready configured, no-op (${report.alreadyConfigured.length}):`);
  for (const r of report.alreadyConfigured) console.log(`  = ${r.itemName}  [${r.itemId}]`);

  console.log(`\nConflicting existing factor, will NOT be touched (${report.conflicting.length}):`);
  for (const r of report.conflicting) console.log(`  ! ${r.itemName}  [${r.itemId}]  existing factor=${r.existingFactor} (expected 0.006) — needs manual review`);

  console.log(`\nBase unit mismatch, skipped (${report.baseUnitMismatch.length}):`);
  for (const r of report.baseUnitMismatch) console.log(`  ! ${r.itemName}  [${r.itemId}]  baseUnit=${r.baseUnitCode} (expected tbsp)`);

  console.log(`\nNot found (${report.notFound.length}):`);
  for (const name of report.notFound) console.log(`  ? ${name}`);

  if (report.conflicting.length > 0 || report.baseUnitMismatch.length > 0 || report.notFound.length > 0) {
    console.log('\nSome items need manual review before confirming — see above.');
  } else if (report.created.length > 0) {
    console.log('\nAll clear. Re-run with task209-56d-powder-conversion-confirm.ts --confirm to apply.');
  } else {
    console.log('\nNothing to do — all applicable items already configured.');
  }
}

main().catch((error: unknown) => {
  console.error('Dry run failed:', error);
  process.exitCode = 1;
});
