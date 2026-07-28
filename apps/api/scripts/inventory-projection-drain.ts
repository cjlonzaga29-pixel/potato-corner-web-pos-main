import 'dotenv/config';
import { runProjectionCycle } from '../src/modules/inventory/inventory-projection.worker.js';

/**
 * CR-010A.2 — one-shot drain of the projection outbox. Runs exactly one
 * claim/process cycle and exits; does not start the poll loop and is not
 * wired into server startup. Safe to run repeatedly (idempotent per
 * movementId) or on a cron outside the API process.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-projection-drain.ts [batchSize]
 */
async function main() {
  const batchSize = process.argv[2] ? Number(process.argv[2]) : undefined;
  const result = await runProjectionCycle({ batchSize });
  console.log('Inventory projection outbox drain cycle:', result);
}

main().catch((error: unknown) => {
  console.error('Inventory projection outbox drain failed:', error);
  process.exitCode = 1;
});
