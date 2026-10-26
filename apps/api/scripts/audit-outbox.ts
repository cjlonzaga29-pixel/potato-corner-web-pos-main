import 'dotenv/config';
import { auditOutboxRepository } from '../src/modules/audit-outbox/audit-outbox.repository.js';
import { runAuditOutboxCycle } from '../src/modules/audit-outbox/audit-outbox.worker.js';
import { disconnectPrisma } from '../src/lib/prisma.js';

/**
 * POS-PERF-P38R4 — operator tool for the audit outbox (see the P38 runbook,
 * "Failure monitoring and manual recovery"). Never deletes a row.
 *
 *   status                           counts by status + oldest undelivered occurrence
 *   requeue --group <groupId>        one stuck group back to pending (fresh attempts)
 *   requeue --all-stuck [--limit N]  at most N stuck groups (default 10) back to pending
 *   drain [--group <groupId>] [--cycles N]
 *                                    run at most N delivery cycles now (default 1), same
 *                                    code and guards as the API's worker; safe while it runs
 *
 * Prints the target host/database (never credentials) first. Usage:
 *   pnpm --filter @potato-corner/api exec tsx scripts/audit-outbox.ts status
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const command = process.argv[2];
  const target = new URL(process.env.DATABASE_URL ?? '');
  console.log(`target: ${target.hostname}:${target.port}${target.pathname}`);

  if (command === 'status') {
    console.log(await auditOutboxRepository.status());
  } else if (command === 'requeue') {
    const groupId = arg('--group');
    if (!groupId && !process.argv.includes('--all-stuck')) throw new Error('requeue needs --group <groupId> or --all-stuck');
    const limit = Math.min(Number(arg('--limit') ?? '10'), 100);
    console.log('requeued groups:', await auditOutboxRepository.requeueStuck({ groupId, limit }));
  } else if (command === 'drain') {
    const groupId = arg('--group');
    const cycles = Math.min(Number(arg('--cycles') ?? '1'), 50);
    for (let i = 0; i < cycles; i++) {
      const result = await runAuditOutboxCycle(groupId ? { groupIds: [groupId] } : {});
      console.log(`cycle ${i + 1}:`, result);
      if (result.claimed === 0) break;
    }
  } else {
    throw new Error('usage: audit-outbox.ts status | requeue (--group <id> | --all-stuck [--limit N]) | drain [--group <id>] [--cycles N]');
  }
}

main()
  .catch((error: unknown) => {
    console.error('audit-outbox:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
