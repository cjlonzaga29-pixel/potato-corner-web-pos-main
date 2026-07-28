import 'dotenv/config';
import { inventoryReconciliationService } from '../src/modules/inventory/inventory-reconciliation.service.js';

/**
 * CR-010A.3 — read-only reconciliation report. Compares
 * InventoryMovement (source of truth) -> accepted InventoryIdentityMapping
 * -> InventoryStock and prints matched/missing/drift/unresolved/orphan
 * counts. Never writes anything.
 *
 * Usage: pnpm --filter @potato-corner/api exec tsx scripts/inventory-reconciliation-report.ts
 */
async function main() {
  const report = await inventoryReconciliationService.buildReport();

  console.log('CR-010A.3 inventory reconciliation report');
  console.log(`  matched:            ${report.matched.length}`);
  console.log(`  missing stock:      ${report.missingStock.length}`);
  console.log(`  drift:              ${report.drift.length}`);
  console.log(`  unresolved mapping: ${report.unresolvedMapping.length}`);
  console.log(`  orphan stock:       ${report.orphanStock.length}`);

  if (report.missingStock.length > 0) {
    console.log('\nMissing InventoryStock rows:');
    for (const row of report.missingStock) {
      console.log(`  branch=${row.branchId} item=${row.inventoryItemId} expected=${row.expectedQuantity.toFixed(3)}`);
    }
  }

  if (report.drift.length > 0) {
    console.log('\nQuantity drift:');
    for (const row of report.drift) {
      console.log(
        `  branch=${row.branchId} item=${row.inventoryItemId} expected=${row.expectedQuantity.toFixed(3)} actual=${row.actualQuantity.toFixed(3)} drift=${row.drift.toFixed(3)}`,
      );
    }
  }

  if (report.unresolvedMapping.length > 0) {
    console.log('\nUnresolved mappings (movements exist, no accepted mapping):');
    for (const row of report.unresolvedMapping) {
      console.log(`  branch=${row.branchId} ingredient=${row.ingredientId} (${row.ingredientName}) reason=${row.reason}`);
    }
  }

  if (report.orphanStock.length > 0) {
    console.log('\nOrphan InventoryStock rows (no accepted mapping targets them):');
    for (const row of report.orphanStock) {
      console.log(`  branch=${row.branchId} item=${row.inventoryItemId} quantityOnHand=${row.quantityOnHand.toFixed(3)}`);
    }
  }

  const hasIssue = report.missingStock.length > 0 || report.drift.length > 0 || report.unresolvedMapping.length > 0 || report.orphanStock.length > 0;
  process.exitCode = hasIssue ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('Inventory reconciliation report failed:', error);
  process.exitCode = 1;
});
