// POS-PERF-P15R3 — local-only helper for measuring the real checkout user
// flow end to end (part 3 of the task). prisma/seed.ts + seed-catalog.ts
// create users/branch/products/variants but deliberately no inventory/BOM
// mapping, so a real checkout always rejects with RECIPE_MISSING against a
// freshly seeded database. This adds exactly one minimal, no-flavor-
// required product's inventory mapping (Drinks / Water, MAIN01) so a cash
// sale can actually complete through the browser.
//
// Usage: ALLOW_DATABASE_SEED=true DATABASE_URL=... npx tsx scripts/seed-pos-demo-inventory.ts
import { PrismaClient, Prisma } from '@prisma/client';

if (process.env.ALLOW_DATABASE_SEED !== 'true') {
  console.error('Refusing to run: set ALLOW_DATABASE_SEED=true (same guard as prisma/seed.ts).');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'MAIN01' } });

  // Created directly here rather than via prisma/seed-catalog.ts: that
  // script's upsertFlavor is stale against the current schema (Flavor.
  // ingredientName/ingredientUnit are required, non-null columns it never
  // supplies — a real, pre-existing bug this exercise surfaced, out of
  // scope to fix here). Drinks/Water needs no flavor at all, so it's
  // created standalone, bypassing that broken path entirely.
  const product =
    (await prisma.product.findFirst({ where: { name: 'Drinks (demo)' } })) ??
    (await prisma.product.create({ data: { name: 'Drinks (demo)', category: 'Drinks', status: 'active' } }));
  const variant =
    (await prisma.productVariant.findFirst({ where: { productId: product.id, sizeLabel: 'Water' } })) ??
    (await prisma.productVariant.create({
      data: { productId: product.id, name: 'Water', sizeLabel: 'Water', basePrice: new Prisma.Decimal(35), isActive: true, lifecycleStatus: 'ACTIVE' },
    }));

  const unit = await prisma.unitOfMeasure.upsert({
    where: { code: 'pc-demo' },
    update: {},
    create: { code: 'pc-demo', name: 'Piece (demo)', dimension: 'COUNT', isBaseUnit: true },
  });

  const item =
    (await prisma.inventoryItem.findFirst({ where: { sku: 'DEMO-WATER' } })) ??
    (await prisma.inventoryItem.create({
      data: { name: 'Bottled Water (demo)', sku: 'DEMO-WATER', baseUnitId: unit.id, trackInventory: true, unitCost: new Prisma.Decimal(10) },
    }));

  await prisma.inventoryStock.upsert({
    where: { branchId_inventoryItemId: { branchId: branch.id, inventoryItemId: item.id } },
    update: { quantityOnHand: new Prisma.Decimal(500) },
    create: { branchId: branch.id, inventoryItemId: item.id, quantityOnHand: new Prisma.Decimal(500), quantityReserved: new Prisma.Decimal(0) },
  });

  const existingComponent = await prisma.productComponent.findFirst({ where: { productVariantId: variant.id, inventoryItemId: item.id } });
  if (!existingComponent) {
    await prisma.productComponent.create({
      data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: new Prisma.Decimal(1), recipeUnitId: null },
    });
  }

  await prisma.branchProductAvailability.upsert({
    where: { branchId_productId: { branchId: branch.id, productId: variant.productId } },
    update: { isAvailable: true },
    create: { branchId: branch.id, productId: variant.productId, isAvailable: true },
  });

  console.log(`Demo checkout ready: Drinks / Water (variant ${variant.id}) at ${branch.name}, 500 units in stock.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
