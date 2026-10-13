import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36R2 §2/§3 — direct-API publication safety. Exercises
 * productsService.publishProduct (not the UI) against incomplete
 * configurations, and proves/fixes the race between the readiness
 * evaluation and the branch-availability flip that publish performs as two
 * separate, unlocked database steps.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { productCatalogLockId } = await import('../../lib/pg-lock.js');

describe.skipIf(!isLocalDatabase)('Product publication safety (real Postgres)', () => {
  let supervisorId: string;
  let gramUnitId: string;
  let itemId: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Pub', lastName: 'Safety', employmentType: 'regular', email: `p36r2-pub-${suffix}@test.local` },
    });
    supervisorId = sup.id;
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p36r2-g-${suffix}`, name: 'P36R2 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    gramUnitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P36R2 Item ${suffix}`, baseUnitId: gramUnitId } });
    itemId = item.id;
  });

  afterAll(async () => {
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: gramUnitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
  });

  async function makeBranch(suffix: string) {
    const branch = await prisma.branch.create({
      data: { name: `P36R2 Pub Branch ${suffix}`, code: `P36R2P-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    await prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId: branch.id } });
    return branch.id;
  }

  async function makeProductWithVariant(suffix: string, branchId: string) {
    const product = await prisma.product.create({
      data: { name: `P36R2 Product ${suffix}`, status: 'active', createdBy: supervisorId, branchExclusive: true, exclusiveBranchId: branchId },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true },
    });
    return { productId: product.id, variantId: variant.id };
  }

  it('rejects direct publish with a missing BOM/recipe (no ProductComponent rows)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const branchId = await makeBranch(suffix);
    const { productId } = await makeProductWithVariant(suffix, branchId);

    await expect(
      productsService.publishProduct(productId, branchId, { id: supervisorId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });

    const availability = await prisma.branchProductAvailability.findUnique({
      where: { branchId_productId: { branchId, productId } },
    });
    expect(availability?.isAvailable ?? false).toBe(false);
  });

  it('rejects direct publish with an invalid BOM component (zero quantity)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const branchId = await makeBranch(suffix);
    const { productId, variantId } = await makeProductWithVariant(suffix, branchId);
    await prisma.productComponent.create({
      data: { productVariantId: variantId, inventoryItemId: itemId, quantityRequired: 0, recipeUnitId: gramUnitId },
    });
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: itemId, quantityOnHand: 100 } });

    await expect(
      productsService.publishProduct(productId, branchId, { id: supervisorId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });
  });

  it('rejects publish for a supervisor at an unauthorized (non-exclusive) branch', async () => {
    const suffix = randomUUID().slice(0, 8);
    const homeBranchId = await makeBranch(suffix);
    const otherBranchId = await makeBranch(`${suffix}-other`);
    const { productId, variantId } = await makeProductWithVariant(suffix, homeBranchId);
    await prisma.productComponent.create({
      data: { productVariantId: variantId, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: gramUnitId },
    });
    await prisma.inventoryStock.create({ data: { branchId: otherBranchId, inventoryItemId: itemId, quantityOnHand: 100 } });

    await expect(
      productsService.publishProduct(productId, otherBranchId, { id: supervisorId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_BRANCH_EXCLUSIVE', statusCode: 403 });

    const availability = await prisma.branchProductAvailability.findUnique({
      where: { branchId_productId: { branchId: otherBranchId, productId } },
    });
    expect(availability?.isAvailable ?? false).toBe(false);
  });

  it('a valid, complete configuration publishes successfully on its first publish', async () => {
    const suffix = randomUUID().slice(0, 8);
    const branchId = await makeBranch(suffix);
    const { productId, variantId } = await makeProductWithVariant(suffix, branchId);
    await prisma.productComponent.create({
      data: { productVariantId: variantId, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: gramUnitId },
    });
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: itemId, quantityOnHand: 100 } });

    const result = await productsService.publishProduct(productId, branchId, { id: supervisorId, role: 'supervisor' }, null);
    expect(result.is_available).toBe(true);

    const availability = await prisma.branchProductAvailability.findUnique({
      where: { branchId_productId: { branchId, productId } },
    });
    expect(availability?.isAvailable).toBe(true);
  });

  it('current stock shortage alone does not block publish (distinct from invalid configuration)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const branchId = await makeBranch(suffix);
    const { productId, variantId } = await makeProductWithVariant(suffix, branchId);
    await prisma.productComponent.create({
      data: { productVariantId: variantId, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: gramUnitId },
    });
    // Stock row exists (so INVENTORY_STOCK_MISSING doesn't fire) but at zero —
    // a sellability/quantity concern the readiness gate treats separately
    // from configuration validity, and publish must not conflate the two.
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: itemId, quantityOnHand: 0 } });

    const result = await productsService.publishProduct(productId, branchId, { id: supervisorId, role: 'supervisor' }, null);
    expect(result.is_available).toBe(true);
  });

  it(
    "POS-PERF-P36R2: publishProduct's readiness-evaluate-then-flip is serialized against a " +
      'concurrent recipe delete holding the same product lock — the delete cannot land in the ' +
      'middle of publish, so publish never commits against a snapshot the delete has already invalidated',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const branchId = await makeBranch(suffix);
      const { productId, variantId } = await makeProductWithVariant(suffix, branchId);
      const component = await prisma.productComponent.create({
        data: { productVariantId: variantId, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: gramUnitId },
      });
      await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: itemId, quantityOnHand: 100 } });

      // Manually take productCatalogLockId ourselves and hold it open past
      // the component delete, inside the same transaction the real
      // deleteMapping would use — forcing publishProduct's own lock
      // acquisition (products.service.ts) to block until we release. This
      // makes the interleaving deterministic instead of hoping two
      // Promise.all calls happen to race.
      let releaseHold: (() => void) | undefined;
      const holdUntilReleased = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let lockAcquired = false;
      const deleteTx = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(productId)})`;
        lockAcquired = true;
        await tx.productComponent.update({
          where: { id: component.id },
          data: { deletedAt: new Date(), isActive: false },
        });
        await holdUntilReleased;
      });

      // Wait for the delete side to actually hold the lock before starting
      // publish, so publish's own lock acquisition is guaranteed to block.
      await new Promise<void>((resolve) => {
        const check = () => (lockAcquired ? resolve() : setTimeout(check, 10));
        check();
      });

      const publishPromise = productsService.publishProduct(productId, branchId, { id: supervisorId, role: 'supervisor' }, null);
      // Give publish a moment to attempt (and block on) lock acquisition
      // before we release the delete side.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!releaseHold) throw new Error('releaseHold was never assigned');
      releaseHold();

      await deleteTx;
      await expect(publishPromise).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY', statusCode: 409 });

      const availability = await prisma.branchProductAvailability.findUnique({
        where: { branchId_productId: { branchId, productId } },
      });
      expect(availability?.isAvailable ?? false).toBe(false);
    },
  );
});
