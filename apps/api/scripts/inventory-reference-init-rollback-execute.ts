import 'dotenv/config';
import { executeRollback, buildConfirmationToken } from '../src/modules/initialization-audit/rollback-execution.service.js';

/**
 * Phase C0 R8 "Rollback" — execution only, reusing CR-009's
 * `executeRollback` unchanged. Requires the run to already be in
 * `ROLLING_BACK` (via `startRollbackAssessment` + `startRollingBack`,
 * called by an operator through the run-lifecycle service, deliberately
 * NOT wrapped here — this script performs the deletion step only, never
 * the earlier transitions, per rollback-execution.service.ts's documented
 * caller boundary). Per-row confirmation only, never a batch-wide flag.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-reference-init-rollback-execute.ts <runId> <recordId>:<currentVerificationFingerprint> [<recordId>:<fingerprint> ...]
 */
async function main() {
  const runId = process.argv[2];
  const pairs = process.argv.slice(3);
  if (!runId || pairs.length === 0) {
    throw new Error('Usage: inventory-reference-init-rollback-execute.ts <runId> <recordId>:<currentVerificationFingerprint> [...]');
  }

  const confirmations = pairs.map((pair) => {
    const separatorIndex = pair.indexOf(':');
    if (separatorIndex === -1) throw new Error(`Malformed confirmation argument "${pair}" — expected <recordId>:<fingerprint>`);
    const recordId = pair.slice(0, separatorIndex);
    const fingerprint = pair.slice(separatorIndex + 1);
    return { recordId, confirmationToken: buildConfirmationToken(recordId, fingerprint === 'null' ? null : fingerprint) };
  });

  console.log(`Phase C0 rollback execution — run ${runId}, ${confirmations.length} confirmed record(s)`);
  const result = await executeRollback({ runId, confirmations });

  for (const record of result.records) {
    console.log(`  ${record.recordId} (${record.entityType}): ${record.outcome}`);
  }
  console.log(`\nRun ${result.runId}: ${result.runStatus}`);

  process.exitCode = result.runStatus === 'ROLLED_BACK' ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('Phase C0 rollback execution failed:', error);
  process.exitCode = 1;
});
