import 'dotenv/config';
import { inventoryReconciliationService } from '../src/modules/inventory/inventory-reconciliation.service.js';

/**
 * CR-010A.3 — confirmed rebuild. Recomputes InventoryStock from the full
 * InventoryMovement ledger and writes it. Requires --confirm; run
 * inventory-rebuild-dry-run.ts first and review its output.
 *
 * Never touches Ingredient, ProductInventory, InventoryMovement, or the
 * projection outbox. Orphan InventoryStock rows are reported and left in
 * place unless --delete-orphans is also passed.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-rebuild-confirm.ts --confirm [--allow-pending-outbox] [--delete-orphans]
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--confirm')) {
    throw new Error('Refusing to run without --confirm. Run inventory-rebuild-dry-run.ts first, then re-run with --confirm.');
  }

  const result = await inventoryReconciliationService.executeRebuild({
    confirm: true,
    allowPendingOutbox: args.has('--allow-pending-outbox'),
    deleteOrphans: args.has('--delete-orphans'),
  });

  console.log('CR-010A.3 inventory rebuild — APPLIED');
  console.log(`  created:         ${result.created}`);
  console.log(`  updated:         ${result.updated}`);
  console.log(`  unchanged:       ${result.unchanged}`);
  console.log(`  orphans found:   ${result.orphans.length}`);
  console.log(`  orphans deleted: ${result.orphansDeleted}`);

  if (result.orphans.length > 0 && result.orphansDeleted === 0) {
    console.log('  (orphans left in place — pass --delete-orphans to remove them)');
  }

  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('Inventory rebuild failed:', error);
  process.exitCode = 1;
});
