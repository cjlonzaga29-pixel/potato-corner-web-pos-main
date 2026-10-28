// POS-PERF-P37 — branch-scoped inventory for the multi-branch builder spec.
// There is no supervisor/admin API that provisions an InventoryItem's
// per-branch InventoryStock rows with a chosen balance in one step, so the
// spec seeds them directly (same precedent as seed-shared-branch-product.cjs)
// and reads balances back the same way to prove each checkout deducted only
// its own branch's stock. Run with cwd set to apps/api.
//
//   seed <branchAId> <branchBId> <suffix>   -> { itemId, itemName, unitId }
//   read <itemId> <branchId> [<branchId>...] -> { [branchId]: quantityOnHand | null }
const path = require('node:path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', '@prisma', 'client'));

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  require('./local-db-guard.cjs').assertLocalDatabase(); // POS-PERF-P44: local DB only
  const prisma = new PrismaClient();
  try {
    if (mode === 'seed') {
      const [branchAId, branchBId, suffix] = args;
      if (!branchAId || !branchBId || !suffix) throw new Error('usage: p37-branch-stock.cjs seed <branchAId> <branchBId> <suffix>');
      const unit = await prisma.unitOfMeasure.create({
        data: { code: `p37-g-${suffix}`, name: `P37 Gram ${suffix}`, dimension: 'WEIGHT', isBaseUnit: true },
      });
      const item = await prisma.inventoryItem.create({ data: { name: `P37 Potato ${suffix}`, baseUnitId: unit.id } });
      await prisma.inventoryStock.createMany({
        data: [
          { branchId: branchAId, inventoryItemId: item.id, quantityOnHand: 500 },
          { branchId: branchBId, inventoryItemId: item.id, quantityOnHand: 300 },
        ],
      });
      process.stdout.write(JSON.stringify({ itemId: item.id, itemName: item.name, unitId: unit.id }));
      return;
    }
    if (mode === 'read') {
      const [itemId, ...branchIds] = args;
      const rows = await prisma.inventoryStock.findMany({ where: { inventoryItemId: itemId, branchId: { in: branchIds } } });
      const byBranch = Object.fromEntries(branchIds.map((id) => [id, null]));
      for (const row of rows) byBranch[row.branchId] = Number(row.quantityOnHand);
      process.stdout.write(JSON.stringify(byBranch));
      return;
    }
    throw new Error(`unknown mode: ${mode}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
