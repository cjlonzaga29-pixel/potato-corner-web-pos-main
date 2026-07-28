import 'dotenv/config';
import { inventoryReconciliationService } from '../src/modules/inventory/inventory-reconciliation.service.js';
import { unprocessedOutboxCount } from '../src/modules/inventory/inventory-reconciliation.types.js';

/**
 * CR-010A.3 — dry-run rebuild plan. Computes exactly what a confirmed
 * rebuild would do (create/update/unchanged rows, orphans, outbox safety
 * status) without writing anything. Run this before
 * inventory-rebuild-confirm.ts.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-rebuild-dry-run.ts
 */
async function main() {
  const plan = await inventoryReconciliationService.buildRebuildPlan();

  const toCreate = plan.rows.filter((r) => r.action === 'create');
  const toUpdate = plan.rows.filter((r) => r.action === 'update');
  const unchanged = plan.rows.filter((r) => r.action === 'unchanged');
  const unprocessed = unprocessedOutboxCount(plan.outboxCounts);

  console.log('CR-010A.3 inventory rebuild — DRY RUN (no writes)');
  console.log(`  rows to create:  ${toCreate.length}`);
  console.log(`  rows to update:  ${toUpdate.length}`);
  console.log(`  rows unchanged:  ${unchanged.length}`);
  console.log(`  orphan rows:     ${plan.orphans.length} (reported only — never auto-deleted)`);
  console.log(
    `  outbox: pending=${plan.outboxCounts.pending} processing=${plan.outboxCounts.processing} deferred=${plan.outboxCounts.deferred} stuck=${plan.outboxCounts.stuck} processed=${plan.outboxCounts.processed}`,
  );

  for (const row of toCreate) {
    console.log(`  CREATE branch=${row.branchId} item=${row.inventoryItemId} quantityOnHand=${row.expectedQuantity.toFixed(3)}`);
  }
  for (const row of toUpdate) {
    console.log(
      `  UPDATE branch=${row.branchId} item=${row.inventoryItemId} ${row.currentQuantity?.toFixed(3)} -> ${row.expectedQuantity.toFixed(3)} (version ${row.currentVersion} -> ${(row.currentVersion ?? 0) + 1})`,
    );
  }
  for (const row of plan.orphans) {
    console.log(`  ORPHAN branch=${row.branchId} item=${row.inventoryItemId} quantityOnHand=${row.quantityOnHand.toFixed(3)}`);
  }

  if (unprocessed > 0) {
    console.log(
      `\nWARNING: ${unprocessed} unprocessed outbox row(s) exist. A confirmed rebuild will refuse to run ` +
        'unless the projection worker is stopped or --allow-pending-outbox is passed to inventory-rebuild-confirm.ts.',
    );
  }

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('Inventory rebuild dry-run failed:', error);
  process.exitCode = 1;
});
