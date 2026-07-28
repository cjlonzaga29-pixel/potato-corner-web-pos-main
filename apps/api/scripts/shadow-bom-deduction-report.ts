import 'dotenv/config';
import { shadowBomDeductionService } from '../src/modules/shadow-bom-deduction/shadow-bom-deduction.service.js';
import type { ShadowBomReportFilters } from '../src/modules/shadow-bom-deduction/shadow-bom-deduction.types.js';

/**
 * CR-012.1 -- read-only shadow BOM deduction comparison report. Never
 * writes anything; summarizes ShadowBomComparison rows already recorded by
 * the shadow-mode comparison hook in transactions.service.ts.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/shadow-bom-deduction-report.ts [--since=2026-07-01]
 */
function parseSinceArg(): Date | undefined {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  if (!arg) return undefined;
  const value = arg.slice('--since='.length);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function main() {
  const filters: ShadowBomReportFilters = {};
  const since = parseSinceArg();
  if (since) filters.since = since;

  const summary = await shadowBomDeductionService.getSummary(filters);

  console.log('CR-012.1 shadow BOM deduction comparison report');
  if (since) console.log(`  since:                 ${since.toISOString()}`);
  console.log(`  total compared:        ${summary.total}`);
  console.log(`  match count:           ${summary.matchCount}`);
  console.log(`  match percentage:      ${summary.matchPercentage}%`);
  console.log('  by classification:');
  for (const [classification, count] of Object.entries(summary.countsByClassification)) {
    if (count > 0) console.log(`    ${classification}: ${count}`);
  }
  if (summary.affectedProductVariantIds.length > 0) {
    console.log(`  affected product variants: ${summary.affectedProductVariantIds.length}`);
  }
  if (summary.affectedBranchIds.length > 0) {
    console.log(`  affected branches:         ${summary.affectedBranchIds.length}`);
  }

  const errorCount = summary.countsByClassification.ERROR ?? 0;
  const unitConversionCount = summary.countsByClassification.UNIT_CONVERSION_UNSUPPORTED ?? 0;
  const flavorDependencyCount = summary.countsByClassification.FLAVOR_DEPENDENCY ?? 0;
  // Eligible lines exclude BOM_NOT_READY (readiness-blocked, not yet a fair
  // comparison) from the match-percentage gate below.
  const bomNotReadyCount = summary.countsByClassification.BOM_NOT_READY ?? 0;
  const eligibleCount = summary.total - bomNotReadyCount;
  const eligibleMatchPercentage = eligibleCount === 0 ? 100 : Math.round((summary.matchCount / eligibleCount) * 10000) / 100;

  const fail = errorCount > 0 || unitConversionCount > 0 || flavorDependencyCount > 0 || eligibleMatchPercentage < 100;
  process.exitCode = fail ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('Shadow BOM deduction report failed:', error);
  process.exitCode = 1;
});
