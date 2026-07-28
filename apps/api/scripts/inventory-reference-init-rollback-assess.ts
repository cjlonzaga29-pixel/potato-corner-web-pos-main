import 'dotenv/config';
import { assessRollbackEligibility } from '../src/modules/initialization-audit/rollback-assessment.service.js';

/**
 * Phase C0 R8 "Rollback" — assessment only, reusing CR-009's
 * `assessRollbackEligibility` unchanged (entity-agnostic; works for any
 * `InitializationRun`, not just reference-init runs). Never deletes
 * anything -- computes and stores `rollbackEligibility` per record so an
 * operator can review before running rollback-execute.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-reference-init-rollback-assess.ts <runId>
 */
async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error('Usage: inventory-reference-init-rollback-assess.ts <runId>');

  console.log(`Phase C0 rollback assessment — run ${runId}`);
  const records = await assessRollbackEligibility(runId);

  for (const record of records) {
    console.log(`  ${record.manifestEntryKey}: action=${record.action} eligibility=${record.rollbackEligibility ?? 'n/a'}${record.rollbackBlockedReason ? ` (${record.rollbackBlockedReason})` : ''}`);
  }

  const eligible = records.filter((r) => r.rollbackEligibility === 'ELIGIBLE');
  console.log(`\n${eligible.length} of ${records.length} record(s) ELIGIBLE for rollback.`);
  console.log('Run rollback-execute with each eligible record id + its confirmation token (buildConfirmationToken) to proceed.');
}

main().catch((error: unknown) => {
  console.error('Phase C0 rollback assessment failed:', error);
  process.exitCode = 1;
});
