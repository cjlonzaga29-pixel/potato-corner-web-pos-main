// POS-PERF-P36R6 — real-browser branch-copy verification. The current API
// has no write path that can ever produce a non-branch-exclusive ("shared")
// product anymore: supervisor creation is forced branch_exclusive
// (products.service.ts createProduct's SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED),
// and super_admin's catalog-write access was removed entirely in POS-PERF-
// P35. Shared products that still exist in the fleet today are pre-P35
// legacy rows. Seeded directly via Prisma, the same pattern already
// established by seed-legacy-movement.cjs for a different now-unreachable
// shape, and by products.replace-source.integration.test.ts (vitest) for
// this exact shape. Run with cwd set to apps/api so @prisma/client resolves
// against that workspace's generated client and its own DATABASE_URL.
const path = require('node:path');
// require() resolves node_modules relative to THIS file's own directory,
// not the child process's cwd — cwd alone isn't enough once this script
// lives outside apps/api's own tree. Resolve apps/api's own generated
// client explicitly (same fix needed by seed-legacy-movement.cjs's
// identical pattern, left as-is there since it happened to still resolve).
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', '@prisma', 'client'));

async function main() {
  const [branchAId, branchBId, creatorUserId, suffix] = process.argv.slice(2);
  if (!branchAId || !branchBId || !creatorUserId || !suffix) {
    throw new Error('usage: seed-shared-branch-product.cjs <branchAId> <branchBId> <creatorUserId> <suffix>');
  }
  require('./local-db-guard.cjs').assertLocalDatabase(); // POS-PERF-P44: local DB only
  const prisma = new PrismaClient();
  try {
    const unit = await prisma.unitOfMeasure.create({
      data: { code: `p36r6-g-${suffix}`, name: 'P36R6 Gram', dimension: 'WEIGHT', isBaseUnit: true },
    });
    const item = await prisma.inventoryItem.create({
      data: { name: `P36R6 Item ${suffix}`, baseUnitId: unit.id },
    });
    await prisma.inventoryStock.createMany({
      data: [
        { branchId: branchAId, inventoryItemId: item.id, quantityOnHand: 500 },
        { branchId: branchBId, inventoryItemId: item.id, quantityOnHand: 500 },
      ],
    });

    const product = await prisma.product.create({
      data: { name: `P36R6 Shared Product ${suffix}`, status: 'active', createdBy: creatorUserId },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, lifecycleStatus: 'ACTIVE' },
    });
    const component = await prisma.productComponent.create({
      data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: 10, recipeUnitId: unit.id },
    });
    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branchAId, productId: product.id, isAvailable: true },
        { branchId: branchBId, productId: product.id, isAvailable: true },
      ],
    });

    process.stdout.write(
      JSON.stringify({
        productId: product.id,
        variantId: variant.id,
        componentId: component.id,
        inventoryItemId: item.id,
        unitId: unit.id,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
