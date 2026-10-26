// POS-PERF-P38R — fixtures for the product-page Publish browser spec. Adds two
// sizes, a shared recipe (and a flavor per size) to a product the spec created
// through the API, so the browser goes straight to the product page's
// Publish. Items come from p38-branch-setup.cjs's seed, which leaves them
// with no InventoryStock row at the product's branch. Also reads the
// assignment audit entries publication wrote. Run with cwd = apps/api.
//
//   configure <productId> <potatoId> <cupId> <flavorId> [kg]  -> { regularVariantId }
//       kg: enter the potato in a new kilogram unit with no conversion (genuinely invalid setup)
//   audits <productId>                                        -> [ "branchId:itemId", ... ]
//   availability <productId>                                  -> { published: [branchId...], audited: [branchId...] }
//       POS-PERF-P38R3: where it is on POS now, and one entry per PRODUCT_BRANCH_AVAILABILITY_CHANGED written for it
//   POS-PERF-P38R4: audits/availability first wait (up to 30 s) until the running API's audit outbox
//   worker has delivered every intent publication enqueued for the product, so they read settled entries.
const path = require('node:path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', '@prisma', 'client'));

async function waitForDelivery(prisma, productId) {
  const where = {
    status: { not: 'delivered' },
    OR: [{ afterState: { path: ['product_id'], equals: productId } }, { afterState: { path: ['productId'], equals: productId } }],
  };
  for (let i = 0; i < 60; i++) {
    const pending = await prisma.auditOutbox.findMany({ where, select: { status: true } });
    if (pending.length === 0) return;
    if (pending.some((r) => r.status === 'stuck')) throw new Error(`audit outbox: stuck intents for ${productId}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`audit outbox: intents for ${productId} still undelivered after 30 s (is the API's worker running?)`);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (mode === 'configure') {
      const [productId, potatoId, cupId, flavorId, kg] = args;
      if (!productId || !potatoId || !cupId || !flavorId) throw new Error('usage: p38r-single-publish.cjs configure <productId> <potatoId> <cupId> <flavorId> [kg]');
      let potatoUnitId = null;
      if (kg === 'kg') {
        const unit = await prisma.unitOfMeasure.create({
          data: { code: `p38r-kg-${productId.slice(0, 8)}`, name: `P38R Kilogram ${productId.slice(0, 8)}`, dimension: 'WEIGHT' },
        });
        potatoUnitId = unit.id;
      }
      let regularVariantId = '';
      for (const [name, price, grams] of [['Regular', 59, 150], ['Large', 89, 250]]) {
        const variant = await prisma.productVariant.create({
          data: { productId, name, sizeLabel: name, basePrice: price, isActive: true, lifecycleStatus: 'ACTIVE' },
        });
        if (name === 'Regular') regularVariantId = variant.id;
        await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId, isAvailable: true } });
        await prisma.productComponent.createMany({
          data: [
            { productVariantId: variant.id, inventoryItemId: potatoId, quantityRequired: potatoUnitId ? grams / 1000 : grams, recipeUnitId: potatoUnitId },
            { productVariantId: variant.id, inventoryItemId: cupId, quantityRequired: 1 },
          ],
        });
      }
      process.stdout.write(JSON.stringify({ regularVariantId }));
      return;
    }
    if (mode === 'audits') {
      const [productId] = args;
      await waitForDelivery(prisma, productId);
      const rows = await prisma.auditLog.findMany({ where: { action: 'INVENTORY_ITEM_BRANCH_ASSIGNED' } });
      const pairs = rows
        .filter((r) => r.afterState && r.afterState.product_id === productId)
        .flatMap((r) => (r.afterState.assigned || []).map((branchId) => `${branchId}:${r.entityId}`))
        .sort();
      process.stdout.write(JSON.stringify(pairs));
      return;
    }
    if (mode === 'availability') {
      const [productId] = args;
      await waitForDelivery(prisma, productId);
      const rows = await prisma.branchProductAvailability.findMany({ where: { productId, isAvailable: true } });
      const audits = await prisma.auditLog.findMany({ where: { action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED' } });
      const audited = audits.filter((r) => r.afterState && r.afterState.productId === productId).map((r) => r.branchId);
      process.stdout.write(JSON.stringify({ published: rows.map((r) => r.branchId).sort(), audited: audited.sort() }));
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
