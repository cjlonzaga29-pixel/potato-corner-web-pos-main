import 'dotenv/config';
import { seedPotatoCornerPowderConversions } from '../src/modules/universal-inventory/potato-corner-powder-conversions.seed.js';

/**
 * TASK 209.56D — applies the Potato Corner flavor-powder tbsp->kg
 * item-specific unit conversions (1 tbsp = 0.006 kg). Requires --confirm;
 * run task209-56d-powder-conversion-dry-run.ts first and review its output.
 *
 * Idempotent: re-running this after a successful run creates nothing new
 * (already-configured items are recognized and skipped). Never overwrites
 * an existing differing factor, never touches items outside the canonical
 * powder list, never creates a global UnitConversion row, never changes
 * native inventory quantities, BOM, or stock movements.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/task209-56d-powder-conversion-confirm.ts --confirm
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--confirm')) {
    throw new Error('Refusing to run without --confirm. Run task209-56d-powder-conversion-dry-run.ts first, then re-run with --confirm.');
  }

  const report = await seedPotatoCornerPowderConversions(true);

  console.log('TASK 209.56D — Potato Corner powder tbsp->kg conversion — APPLIED\n');
  console.log(`created:              ${report.created.length}`);
  for (const r of report.created) console.log(`  + ${r.itemName}  [${r.itemId}]  1 tbsp = 0.006 kg`);
  console.log(`already configured:   ${report.alreadyConfigured.length}`);
  console.log(`conflicting (skipped):${report.conflicting.length}`);
  for (const r of report.conflicting) console.log(`  ! ${r.itemName}  [${r.itemId}]  existing factor=${r.existingFactor} — needs manual review`);
  console.log(`base unit mismatch:   ${report.baseUnitMismatch.length}`);
  for (const r of report.baseUnitMismatch) console.log(`  ! ${r.itemName}  [${r.itemId}]  baseUnit=${r.baseUnitCode}`);
  console.log(`not found:            ${report.notFound.length}`);
  for (const name of report.notFound) console.log(`  ? ${name}`);

  if (report.conflicting.length > 0 || report.baseUnitMismatch.length > 0 || report.notFound.length > 0) {
    console.log('\nSome items were skipped and need manual review — see above.');
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('Confirm run failed:', error);
  process.exitCode = 1;
});
