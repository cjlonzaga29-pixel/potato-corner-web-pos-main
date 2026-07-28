import 'dotenv/config';
import { recipeReadinessService } from '../src/modules/recipe-readiness/recipe-readiness.service.js';

/**
 * CR-011.2 — read-only Recipe/BOM readiness report for pre-deployment
 * checks ahead of the CR-012 POS-deduction cutover. Never writes anything.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/recipe-readiness-report.ts
 */
async function main() {
  const report = await recipeReadinessService.buildReport();

  console.log('CR-011.2 recipe/BOM readiness report');
  console.log(`  total variants:        ${report.summary.totalVariants}`);
  console.log(`  ready:                 ${report.summary.readyCount}`);
  console.log(`  blocked:               ${report.summary.blockedCount}`);
  console.log(`  readiness percentage:  ${report.summary.readinessPercentage}%`);
  console.log('  by status:');
  for (const [status, count] of Object.entries(report.summary.countsByStatus)) {
    if (count > 0) console.log(`    ${status}: ${count}`);
  }

  const blocked = report.variants.filter((v) => v.status !== 'READY');
  if (blocked.length > 0) {
    console.log('\nBlocked variants:');
    for (const variant of blocked) {
      console.log(`  [${variant.status}] ${variant.productName} / ${variant.variantName} (${variant.sizeLabel}) — variant=${variant.productVariantId}`);
      for (const blocker of variant.blockers) {
        console.log(`    - ${blocker.message}`);
      }
    }
  }

  process.exitCode = report.summary.blockedCount > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('Recipe readiness report failed:', error);
  process.exitCode = 1;
});
