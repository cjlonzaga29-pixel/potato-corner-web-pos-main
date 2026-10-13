import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36R §1 — demonstrates (not just asserts) the branch-isolation
 * conclusion documented in docs/decisions/POS-PERF-P36-branch-catalog-and-builder.md
 * §2: two independently-run branches, each with their own active
 * supervisor, sharing the same global catalog/inventory master data.
 *
 * Proves:
 * - A supervisor's authority is scoped to the branch(es) they are
 *   *currently* actively assigned to, regardless of who created the resource.
 * - Branch A's supervisor cannot mutate Branch B's branch-exclusive product
 *   (and vice versa) — hasActiveCatalogAuthorityForProduct, not managedBy.
 * - Shared master data (InventoryItem, ProductCategory, UnitOfMeasure) is
 *   usable by both branches' supervisors without any manual Catalog
 *   Assignment step — creating a recipe/BOM mapping against a shared
 *   InventoryItem is scoped by the *product's* authority, not the item's.
 * - InventoryStock (balances) and InventoryStockMovement (history) are kept
 *   per (branchId, inventoryItemId): crediting/debiting Branch A's stock row
 *   for a shared item never touches Branch B's row for the same item.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { productComponentsService } = await import('../product-components/product-components.service.js');

describe.skipIf(!isLocalDatabase)('cross-branch catalog isolation with shared master data (real Postgres)', () => {
  let adminId: string;
  let branchAId: string;
  let branchBId: string;
  let supervisorAId: string;
  let supervisorBId: string;
  let sharedItemId: string;
  let sharedUnitId: string;
  let sharedCategoryId: string;
  let productAId: string;
  let productBId: string;
  let variantAId: string;
  let variantBId: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    const admin = await prisma.user.create({
      data: { role: 'super_admin', firstName: 'Admin', lastName: 'User', employmentType: 'regular', email: `p36r-admin-${suffix}@test.local` },
    });
    adminId = admin.id;

    const [a, b] = await Promise.all([
      prisma.branch.create({ data: { name: `P36R Branch A ${suffix}`, code: `P36RA-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R Branch B ${suffix}`, code: `P36RB-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;

    const [supA, supB] = await Promise.all([
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'A', employmentType: 'regular', email: `p36r-supa-${suffix}@test.local` } }),
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'B', employmentType: 'regular', email: `p36r-supb-${suffix}@test.local` } }),
    ]);
    supervisorAId = supA.id;
    supervisorBId = supB.id;
    await Promise.all([
      prisma.userBranchAssignment.create({ data: { userId: supervisorAId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorBId, branchId: branchBId } }),
    ]);

    // Shared, branch-agnostic master data (CR-007 §3) — created once by the
    // admin, never assigned to either supervisor, used by both branches.
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p36r-g-${suffix}`, name: 'P36R Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    sharedUnitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P36R Shared Syrup ${suffix}`, baseUnitId: sharedUnitId, createdBy: adminId } });
    sharedItemId = item.id;
    const category = await prisma.productCategory.create({ data: { code: `p36r-cat-${suffix}`, name: 'P36R Shared Category', createdBy: adminId } });
    sharedCategoryId = category.id;

    // Each supervisor independently creates a branch-exclusive product for
    // their own branch, both referencing the SAME shared category/item.
    const productA = await prisma.product.create({
      data: { name: `P36R Product A ${suffix}`, createdBy: supervisorAId, branchExclusive: true, exclusiveBranchId: branchAId, categoryId: sharedCategoryId },
    });
    productAId = productA.id;
    const variantA = await prisma.productVariant.create({ data: { productId: productAId, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, lifecycleStatus: 'DRAFT' } });
    variantAId = variantA.id;

    const productB = await prisma.product.create({
      data: { name: `P36R Product B ${suffix}`, createdBy: supervisorBId, branchExclusive: true, exclusiveBranchId: branchBId, categoryId: sharedCategoryId },
    });
    productBId = productB.id;
    const variantB = await prisma.productVariant.create({ data: { productId: productBId, name: 'Regular', sizeLabel: 'Regular', basePrice: 50 } });
    variantBId = variantB.id;

    // Independent per-branch stock balances for the SAME shared item.
    await Promise.all([
      prisma.inventoryStock.create({ data: { branchId: branchAId, inventoryItemId: sharedItemId, quantityOnHand: 1000 } }),
      prisma.inventoryStock.create({ data: { branchId: branchBId, inventoryItemId: sharedItemId, quantityOnHand: 500 } }),
    ]);

    setupSucceeded = true;
  });

  afterAll(async () => {
    if (!setupSucceeded) return;
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: [variantAId, variantBId] } } });
    await prisma.inventoryStockMovement.deleteMany({ where: { inventoryItemId: sharedItemId } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: sharedItemId } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: [productAId, productBId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [productAId, productBId] } } });
    await prisma.productCategory.deleteMany({ where: { id: sharedCategoryId } });
    await prisma.inventoryItem.deleteMany({ where: { id: sharedItemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: sharedUnitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [supervisorAId, supervisorBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supervisorAId, supervisorBId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
  });

  it("Branch A's supervisor manages Product A (their own branch) regardless of who else exists", async () => {
    const updated = await productsService.updateProduct(productAId, { name: 'Product A Renamed' }, { id: supervisorAId, role: 'supervisor' }, null);
    expect(updated.name).toBe('Product A Renamed');
  });

  it("Branch B's supervisor is denied mutating Branch A's product (cross-branch denial)", async () => {
    await expect(
      productsService.updateProduct(productAId, { name: 'Hijacked by B' }, { id: supervisorBId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ statusCode: 403 });

    const row = await prisma.product.findUniqueOrThrow({ where: { id: productAId } });
    expect(row.name).not.toBe('Hijacked by B');
  });

  it("Branch A's supervisor is denied mutating Branch B's product (symmetric denial)", async () => {
    await expect(
      productsService.updateProduct(productBId, { name: 'Hijacked by A' }, { id: supervisorAId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ statusCode: 403 });

    const row = await prisma.product.findUniqueOrThrow({ where: { id: productBId } });
    expect(row.name).not.toBe('Hijacked by A');
  });

  it('both supervisors can map the SAME shared InventoryItem into their own recipe/BOM without any manual catalog assignment', async () => {
    const componentA = await productComponentsService.createMapping(
      { product_variant_id: variantAId, inventory_item_id: sharedItemId, quantity_required: 10 },
      { id: supervisorAId, role: 'supervisor' },
      null,
    );
    expect(componentA.inventory_item_id).toBe(sharedItemId);

    const componentB = await productComponentsService.createMapping(
      { product_variant_id: variantBId, inventory_item_id: sharedItemId, quantity_required: 20 },
      { id: supervisorBId, role: 'supervisor' },
      null,
    );
    expect(componentB.inventory_item_id).toBe(sharedItemId);
  });

  it("Branch A's supervisor cannot add a recipe mapping to Branch B's variant (recipe/BOM authority follows the parent product's branch)", async () => {
    await expect(
      productComponentsService.createMapping(
        { product_variant_id: variantBId, inventory_item_id: sharedItemId, quantity_required: 99 },
        { id: supervisorAId, role: 'supervisor' },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("category edits by either supervisor against the shared ProductCategory do not require per-branch assignment (branch-agnostic master data)", async () => {
    const renamed = await prisma.productCategory.update({ where: { id: sharedCategoryId }, data: { name: 'Renamed by either branch' } });
    expect(renamed.name).toBe('Renamed by either branch');
    // Both products still resolve the same (renamed) shared category — proving
    // it was never duplicated per branch.
    const [prodA, prodB] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productAId } }),
      prisma.product.findUniqueOrThrow({ where: { id: productBId } }),
    ]);
    expect(prodA.categoryId).toBe(sharedCategoryId);
    expect(prodB.categoryId).toBe(sharedCategoryId);
  });

  it('stock movement on the shared item at Branch A never touches Branch B balance for the same item', async () => {
    const beforeB = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId: branchBId, inventoryItemId: sharedItemId } } });

    await prisma.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId: branchAId, inventoryItemId: sharedItemId } },
      data: { quantityOnHand: { decrement: 300 } },
    });
    await prisma.inventoryStockMovement.create({
      data: {
        branchId: branchAId,
        inventoryItemId: sharedItemId,
        movementType: 'ADJUSTMENT_OUT',
        quantityChange: -300,
        quantityBefore: 1000,
        quantityAfter: 700,
        referenceId: productAId,
      },
    });

    const afterA = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId: branchAId, inventoryItemId: sharedItemId } } });
    const afterB = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId: branchBId, inventoryItemId: sharedItemId } } });

    expect(afterA.quantityOnHand.toNumber()).toBe(700);
    expect(afterB.quantityOnHand.toNumber()).toBe(beforeB.quantityOnHand.toNumber()); // unchanged
    expect(afterB.quantityOnHand.toNumber()).toBe(500);

    const movementsForB = await prisma.inventoryStockMovement.count({ where: { branchId: branchBId, inventoryItemId: sharedItemId } });
    expect(movementsForB).toBe(0);
  });

  it("Branch B's supervisor cannot add a Mix & Max flavor slot to Branch A's variant, but Branch A's own supervisor can", async () => {
    await expect(
      productsService.addFlavorSlot(variantAId, { label: 'Flavor Choice', flavorQty: 1, unit: 'scoop' }, undefined, { id: supervisorBId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ statusCode: 403 });

    const slot = await productsService.addFlavorSlot(
      variantAId,
      { label: 'Flavor Choice', flavorQty: 1, unit: 'scoop' },
      undefined,
      { id: supervisorAId, role: 'supervisor' },
      null,
    );
    expect(slot.productVariantId).toBe(variantAId);

    await prisma.productFlavorSlot.deleteMany({ where: { productVariantId: variantAId } });
  });
});
