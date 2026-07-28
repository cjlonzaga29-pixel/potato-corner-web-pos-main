import 'dotenv/config';
import { reconcileAllStaleRuns } from '../src/modules/initialization-audit/reconciliation.service.js';

/** CR-009's own example stale-run timeout: 15 minutes. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * CR-009 "Failure recovery and stale-run reconciliation" (R11) -- operator
 * CLI entry point.
 *
 * Unlike R10's rollback execution, this never needs a `--confirm` flag:
 * reconciliation only ever corrects `InitializationRun.status` metadata,
 * never target-table data and never `InitializationRecord` rows (see
 * reconciliation.service.ts's header comment), so it is safe to run
 * directly.
 *
 * Usage: `pnpm --filter @potato-corner/api exec tsx scripts/initialization-reconcile.ts [timeoutMs]`
 * `timeoutMs` defaults to 15 minutes if omitted.
 */
async function main() {
  const timeoutMsArg = process.argv[2];
  const timeoutMs = timeoutMsArg ? Number(timeoutMsArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout (ms): "${timeoutMsArg}"`);
  }

  const now = new Date();
  console.log('CR-009 initialization-audit reconciliation');
  console.log(`  now:        ${now.toISOString()}`);
  console.log(`  timeout:    ${timeoutMs}ms (${(timeoutMs / 60_000).toFixed(1)} minutes)`);

  const outcomes = await reconcileAllStaleRuns(now, timeoutMs);

  if (outcomes.length === 0) {
    console.log('\nNo stale runs found -- nothing to reconcile.');
    process.exitCode = 0;
    return;
  }

  console.log(`\nReconciled ${outcomes.length} stale run(s):`);

  let hasIssue = false;
  for (const outcome of outcomes) {
    const detail = outcome.failureReason ? ` -- ${outcome.failureReason}` : '';
    console.log(`  ${outcome.runId}: ${outcome.outcome}${detail}`);

    if (outcome.outcome === 'CONFLICT') {
      console.log(`    CONFLICT: ${outcome.conflictReason}`);
      hasIssue = true;
    }
    if (outcome.anomalyDetected) {
      console.log(`    ANOMALY: ${outcome.anomalyDetail}`);
      hasIssue = true;
    }
  }

  if (hasIssue) {
    console.log('\nOne or more runs reported a CONFLICT or ANOMALY -- review above before assuming this reconciliation pass is complete.');
  }

  process.exitCode = hasIssue ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('CR-009 initialization reconciliation failed:', error);
  process.exitCode = 1;
});
