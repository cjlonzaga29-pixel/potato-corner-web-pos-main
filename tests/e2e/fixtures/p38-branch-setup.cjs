// POS-PERF-P38 — fixtures for the automatic selected-branch setup browser spec.
// Creates the shared recipe items with NO InventoryStock row at any of the
// spec's branches — the reported state (a valid item never linked to the
// newly selected branches) — except one pre-existing Potato balance at
// Branch A, which publication must leave byte-for-byte unchanged. Also
// reads balances back, and records a stock delivery at one branch so a sale
// can be rung up there (there is no supervisor API that sets a balance in
// one step; same precedent as p37-branch-stock.cjs). Run with cwd = apps/api.
//
//   seed <branchAId> <suffix>                      -> { potatoId, potatoName, cupId, cupName, flavorId, flavorName }
//   read <itemId,itemId> <branchId> [<branchId>...] -> { [branchId]: { [itemId]: { on_hand, reserved, low } | null } }
//   deliver <branchId> <itemId> <quantity>          -> { ok: true }
const path = require('node:path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', '@prisma', 'client'));

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (mode === 'seed') {
      const [branchAId, suffix] = args;
      if (!branchAId || !suffix) throw new Error('usage: p38-branch-setup.cjs seed <branchAId> <suffix>');
      const gram = await prisma.unitOfMeasure.create({ data: { code: `p38-g-${suffix}`, name: `P38 Gram ${suffix}`, dimension: 'WEIGHT', isBaseUnit: true } });
      const piece = await prisma.unitOfMeasure.create({ data: { code: `p38-pc-${suffix}`, name: `P38 Piece ${suffix}`, dimension: 'COUNT', isBaseUnit: true } });
      const potato = await prisma.inventoryItem.create({ data: { name: `P38 Potato ${suffix}`, baseUnitId: gram.id } });
      const cup = await prisma.inventoryItem.create({ data: { name: `P38 Cup ${suffix}`, baseUnitId: piece.id } });
      await prisma.inventoryStock.create({
        data: { branchId: branchAId, inventoryItemId: potato.id, quantityOnHand: 500, quantityReserved: 7, lowStockThreshold: 50 },
      });
      const flavor = await prisma.flavor.create({ data: { name: `P38 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
      process.stdout.write(
        JSON.stringify({ potatoId: potato.id, potatoName: potato.name, cupId: cup.id, cupName: cup.name, flavorId: flavor.id, flavorName: flavor.name }),
      );
      return;
    }
    if (mode === 'read') {
      const [itemCsv, ...branchIds] = args;
      const itemIds = (itemCsv ?? '').split(',').filter(Boolean);
      const rows = await prisma.inventoryStock.findMany({ where: { inventoryItemId: { in: itemIds }, branchId: { in: branchIds } } });
      const out = Object.fromEntries(branchIds.map((b) => [b, Object.fromEntries(itemIds.map((i) => [i, null]))]));
      for (const row of rows) {
        out[row.branchId][row.inventoryItemId] = {
          on_hand: Number(row.quantityOnHand),
          reserved: Number(row.quantityReserved),
          low: row.lowStockThreshold === null ? null : Number(row.lowStockThreshold),
        };
      }
      process.stdout.write(JSON.stringify(out));
      return;
    }
    if (mode === 'deliver') {
      const [branchId, itemId, quantity] = args;
      await prisma.inventoryStock.update({
        where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } },
        data: { quantityOnHand: Number(quantity) },
      });
      process.stdout.write(JSON.stringify({ ok: true }));
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
