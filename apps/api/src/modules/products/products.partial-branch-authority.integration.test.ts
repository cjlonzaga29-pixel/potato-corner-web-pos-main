import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P36R4 — proves the authority correction in catalog-authority.ts:
 * "any active-branch intersection grants authority over the whole shared
 * product" contradicted the approved requirement ("supervisor authority
 * follows assigned branches, and editing Branch A must not change Branch
 * B"). hasActiveCatalogAuthority now requires the actor's active branches
 * to be a SUPERSET of every branch a shared product is configured at, and
 * a supervisor with only partial coverage uses the new fork-to-branch path
 * (products.service.ts's forkProductForBranch) instead of editing the
 * shared row in place.
 *
 * Boots the real Express app + Postgres, same pattern as
 * products.status-branch-guard.integration.test.ts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('shared-product partial-branch-authority correction (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;

  let branchAId: string;
  let branchBId: string;
  let branchOutsideId: string;

  let supervisorAId: string; // assigned only to A
  let supervisorBothId: string; // assigned to A and B
  let tokenA: string;
  let tokenBoth: string;

  let unitId: string;
  let inventoryItemId: string;

  let sharedProductId: string;
  let sharedVariantId: string;

  let setupSucceeded = false;

  async function createSharedProduct(suffix: string) {
    const product = await prisma.product.create({
      data: { name: `P36R4 Shared Product ${suffix}`, status: 'active', createdBy: supervisorBothId },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, lifecycleStatus: 'ACTIVE' },
    });
    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branchAId, productId: product.id, isAvailable: true },
        { branchId: branchBId, productId: product.id, isAvailable: true },
      ],
    });
    return { productId: product.id, variantId: variant.id };
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const suffix = randomUUID().slice(0, 8);

    const [a, b, outside] = await Promise.all([
      prisma.branch.create({ data: { name: `P36R4 Branch A ${suffix}`, code: `P36R4A-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R4 Branch B ${suffix}`, code: `P36R4B-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R4 Branch Outside ${suffix}`, code: `P36R4O-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;
    branchOutsideId = outside.id;

    const [supA, supBoth] = await Promise.all([
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'A', employmentType: 'regular', email: `p36r4-supa-${suffix}@test.local` } }),
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'Both', employmentType: 'regular', email: `p36r4-supboth-${suffix}@test.local` } }),
    ]);
    supervisorAId = supA.id;
    supervisorBothId = supBoth.id;
    tokenA = generateSupervisorToken([], { userId: supervisorAId });
    tokenBoth = generateSupervisorToken([], { userId: supervisorBothId });

    await Promise.all([
      prisma.userBranchAssignment.create({ data: { userId: supervisorAId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorBothId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorBothId, branchId: branchBId } }),
      // Also assigned to branchOutside — so the "branch not configured for
      // this product" rejection below is proven to come from the service's
      // own check, not merely from branchGuard denying an unassigned branch.
      prisma.userBranchAssignment.create({ data: { userId: supervisorBothId, branchId: branchOutsideId } }),
    ]);

    const unit = await prisma.unitOfMeasure.create({ data: { code: `p36r4-g-${suffix}`, name: 'P36R4 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    unitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P36R4 Item ${suffix}`, baseUnitId: unitId, createdBy: supervisorBothId } });
    inventoryItemId = item.id;

    const shared = await createSharedProduct(suffix);
    sharedProductId = shared.productId;
    sharedVariantId = shared.variantId;

    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!setupSucceeded) return;
    const relatedProductIds = (
      await prisma.product.findMany({ where: { OR: [{ id: sharedProductId }, { forkedFromProductId: sharedProductId }] }, select: { id: true } })
    ).map((p) => p.id);
    await prisma.productComponent.deleteMany({ where: { inventoryItemId } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: relatedProductIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: relatedProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: relatedProductIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: inventoryItemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [supervisorAId, supervisorBothId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [supervisorAId, supervisorBothId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId, branchOutsideId] } } });
  });

  it('denies a global product-detail edit from a supervisor with authority over only one of the two selling branches', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked by partial authority' }),
    });
    expect(res.status).toBe(403);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: sharedProductId } });
    expect(row.name).not.toBe('Hijacked by partial authority');
  });

  it('allows the same edit from a supervisor with authority over every selling branch', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed by full authority' }),
    });
    expect(res.status).toBe(200);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: sharedProductId } });
    expect(row.name).toBe('Renamed by full authority');
  });

  it('denies global archive/discontinue/restore from the partial-authority supervisor — cannot take the shared product away from Branch B', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(res.status).toBe(403);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: sharedProductId } });
    expect(row.status).toBe('active');
  });

  it('removing from POS at Branch A (branch-scoped) leaves Branch B available', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'temporarily_unavailable', branch_id: branchAId }),
    });
    expect(res.status).toBe(200);

    const [availA, availB] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId: sharedProductId } } }),
    ]);
    expect(availA.isAvailable).toBe(false);
    expect(availB.isAvailable).toBe(true);

    // restore for subsequent tests
    await prisma.branchProductAvailability.update({
      where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } },
      data: { isAvailable: true },
    });
  });

  it('a forged branch_id the partial-authority supervisor has no access to is rejected even though the product sells there', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'temporarily_unavailable', branch_id: branchBId }),
    });
    expect(res.status).toBe(403);
  });

  it('denies variant create/update/delete and flavor-slot add from the partial-authority supervisor', async () => {
    const createRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/variants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Size', size_label: 'New Size', base_price: 60 }),
    });
    expect(createRes.status).toBe(403);

    const updateRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/variants/${sharedVariantId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_price: 999 }),
    });
    expect(updateRes.status).toBe(403);

    const slotRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/variants/${sharedVariantId}/flavor-slots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Flavor Choice', flavor_qty: 1, unit: 'scoop' }),
    });
    expect(slotRes.status).toBe(403);

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: sharedVariantId } });
    expect(variant.basePrice.toNumber()).toBe(50);
  });

  it('denies a recipe/BOM mapping from the partial-authority supervisor on the shared variant', async () => {
    const { productComponentsService } = await import('../product-components/product-components.service.js');
    await expect(
      productComponentsService.createMapping(
        { product_variant_id: sharedVariantId, inventory_item_id: inventoryItemId, quantity_required: 5 },
        { id: supervisorAId, role: 'supervisor' },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  describe('fork-to-branch scoped copy path', () => {
    let forkedProductId: string;

    it('rejects a fork for a branch the acting supervisor has no active assignment to', async () => {
      const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchBId }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects a fork for a branch the product is not configured at, even though the acting supervisor has active authority there', async () => {
      const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchOutsideId }),
      });
      // branchGuard passes (supervisorBoth IS assigned to branchOutside) —
      // this proves forkProductForBranch's own BRANCH_NOT_CONFIGURED_FOR_PRODUCT
      // check, not just branchGuard, is what's rejecting an unrelated branch.
      expect(res.status).toBe(422);
    });

    it('creates a branch-exclusive fork for the partial-authority supervisor, scoped to their own branch', async () => {
      const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchAId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; branch_exclusive: boolean } };
      forkedProductId = body.data.id;
      expect(forkedProductId).not.toBe(sharedProductId);

      const row = await prisma.product.findUniqueOrThrow({ where: { id: forkedProductId } });
      expect(row.branchExclusive).toBe(true);
      expect(row.exclusiveBranchId).toBe(branchAId);
      expect(row.forkedFromProductId).toBe(sharedProductId);
    });

    it('is idempotent — a retried fork request for the same (product, branch) returns the same row, not a duplicate', async () => {
      const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchAId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string } };
      expect(body.data.id).toBe(forkedProductId);

      const count = await prisma.product.count({ where: { forkedFromProductId: sharedProductId, exclusiveBranchId: branchAId } });
      expect(count).toBe(1);
    });

    it('rejects forking a product that is already branch-exclusive', async () => {
      const res = await fetch(`${baseUrl}/api/products/${forkedProductId}/fork-to-branch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchAId }),
      });
      expect(res.status).toBe(409);
    });

    it('lets the partial-authority supervisor fully edit the fork without touching the original shared product or Branch B', async () => {
      const res = await fetch(`${baseUrl}/api/products/${forkedProductId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Edited fork, branch A only' }),
      });
      expect(res.status).toBe(200);

      const [forkRow, originalRow, availB] = await Promise.all([
        prisma.product.findUniqueOrThrow({ where: { id: forkedProductId } }),
        prisma.product.findUniqueOrThrow({ where: { id: sharedProductId } }),
        prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId: sharedProductId } } }),
      ]);
      expect(forkRow.name).toBe('Edited fork, branch A only');
      expect(originalRow.name).not.toBe('Edited fork, branch A only');
      expect(availB.isAvailable).toBe(true);
    });

    it('concurrent fork requests for the same (product, branch) resolve to exactly one row', async () => {
      const suffix = randomUUID().slice(0, 8);
      const concurrentSup = await prisma.user.create({
        data: { role: 'supervisor', firstName: 'Concurrent', lastName: 'Sup', employmentType: 'regular', email: `p36r4-concurrent-${suffix}@test.local` },
      });
      await prisma.userBranchAssignment.create({ data: { userId: concurrentSup.id, branchId: branchBId } });
      const concurrentToken = generateSupervisorToken([], { userId: concurrentSup.id });

      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${concurrentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch_id: branchBId }),
        }),
        fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${concurrentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch_id: branchBId }),
        }),
      ]);
      expect([resA.status, resB.status]).toEqual([201, 201]);
      const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]) as [{ data: { id: string } }, { data: { id: string } }];
      expect(bodyA.data.id).toBe(bodyB.data.id);

      const count = await prisma.product.count({ where: { forkedFromProductId: sharedProductId, exclusiveBranchId: branchBId } });
      expect(count).toBe(1);

      const concurrentForkIds = (
        await prisma.product.findMany({ where: { forkedFromProductId: sharedProductId, exclusiveBranchId: branchBId }, select: { id: true } })
      ).map((p) => p.id);
      await prisma.productVariant.deleteMany({ where: { productId: { in: concurrentForkIds } } });
      await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: concurrentForkIds } } });
      await prisma.product.deleteMany({ where: { id: { in: concurrentForkIds } } });
      await prisma.userBranchAssignment.deleteMany({ where: { userId: concurrentSup.id } });
      await prisma.user.deleteMany({ where: { id: concurrentSup.id } });
    });
  });

  it('revoking the partial-authority supervisor\'s assignment to Branch A also removes their fork-to-branch access', async () => {
    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisorAId, branchId: branchAId }, data: { removedAt: new Date() } });

    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(403);

    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisorAId, branchId: branchAId }, data: { removedAt: null } });
  });
});
