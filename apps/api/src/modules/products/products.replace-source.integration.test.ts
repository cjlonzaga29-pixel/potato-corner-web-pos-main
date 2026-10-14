import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P36R5 — explicit replacement: POST /:productId/replace-source
 * (products.service.ts's replaceSharedProductAtBranch). A supervisor with a
 * fork-to-branch copy (P36R4) explicitly chooses to make it the sellable
 * product at its branch, disabling the shared source there only — every
 * other branch the source sells at, and the source's own identity/history,
 * are untouched. Boots the real Express app + Postgres, same pattern as
 * products.partial-branch-authority.integration.test.ts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('replace-source-with-copy (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;

  let branchAId: string;
  let branchBId: string;

  let supervisorAId: string; // assigned only to A
  let supervisorBothId: string; // assigned to A and B
  let tokenA: string;
  let tokenBoth: string;

  let gramUnitId: string;
  let itemId: string;

  let sharedProductId: string;

  const createdProductIds: string[] = [];
  let setupSucceeded = false;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const suffix = randomUUID().slice(0, 8);

    const [a, b] = await Promise.all([
      prisma.branch.create({ data: { name: `P36R5 Branch A ${suffix}`, code: `P36R5A-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R5 Branch B ${suffix}`, code: `P36R5B-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;

    const [supA, supBoth] = await Promise.all([
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'A', employmentType: 'regular', email: `p36r5-supa-${suffix}@test.local` } }),
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'Both', employmentType: 'regular', email: `p36r5-supboth-${suffix}@test.local` } }),
    ]);
    supervisorAId = supA.id;
    supervisorBothId = supBoth.id;
    tokenA = generateSupervisorToken([], { userId: supervisorAId });
    tokenBoth = generateSupervisorToken([], { userId: supervisorBothId });

    await Promise.all([
      prisma.userBranchAssignment.create({ data: { userId: supervisorAId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorBothId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorBothId, branchId: branchBId } }),
    ]);

    const unit = await prisma.unitOfMeasure.create({ data: { code: `p36r5-g-${suffix}`, name: 'P36R5 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    gramUnitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P36R5 Item ${suffix}`, baseUnitId: gramUnitId } });
    itemId = item.id;

    const product = await prisma.product.create({
      data: { name: `P36R5 Shared Product ${suffix}`, status: 'active', createdBy: supervisorBothId },
    });
    sharedProductId = product.id;
    createdProductIds.push(product.id);
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, lifecycleStatus: 'ACTIVE' },
    });
    await prisma.productComponent.create({
      data: { productVariantId: variant.id, inventoryItemId: itemId, quantityRequired: 10, recipeUnitId: gramUnitId },
    });
    await Promise.all([
      prisma.inventoryStock.create({ data: { branchId: branchAId, inventoryItemId: itemId, quantityOnHand: 100 } }),
      prisma.inventoryStock.create({ data: { branchId: branchBId, inventoryItemId: itemId, quantityOnHand: 100 } }),
    ]);
    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branchAId, productId: product.id, isAvailable: true },
        { branchId: branchBId, productId: product.id, isAvailable: true },
      ],
    });

    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!setupSucceeded) return;
    const relatedProductIds = (
      await prisma.product.findMany({
        where: { OR: [{ id: { in: createdProductIds } }, { forkedFromProductId: { in: createdProductIds } }] },
        select: { id: true },
      })
    ).map((p) => p.id);
    await prisma.productComponent.deleteMany({ where: { inventoryItemId: itemId } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: relatedProductIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: relatedProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: relatedProductIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: itemId } });
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: gramUnitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [supervisorAId, supervisorBothId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [supervisorAId, supervisorBothId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
  });

  /** Forks sharedProductId to branchId as supervisorA, cloning the recipe (readiness-ready), but leaves the copy in its default draft status. */
  async function forkReadyCopy() {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    createdProductIds.push(body.data.id);
    return body.data.id;
  }

  it('rejects replace-source for a product that is not a fork-to-branch copy', async () => {
    const res = await fetch(`${baseUrl}/api/products/${sharedProductId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PRODUCT_NOT_A_BRANCH_COPY');
  });

  it('rejects replace-source while the copy is still draft/not-ready, and touches neither row', async () => {
    const copyId = await forkReadyCopy();

    const res = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PRODUCT_NOT_READY');

    const [copyAvail, sourceAvail] = await Promise.all([
      prisma.branchProductAvailability.findUnique({ where: { branchId_productId: { branchId: branchAId, productId: copyId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
    ]);
    expect(copyAvail?.isAvailable ?? false).toBe(false);
    expect(sourceAvail.isAvailable).toBe(true);
  });

  it('rejects replace-source for a branch_id the actor controls but that is not this copy\'s own branch', async () => {
    const copyId = await forkReadyCopy();
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    // supervisorBoth controls branchB, but this copy was forked for branchA —
    // branchGuard passes (supervisorBoth IS assigned to branchB), proving the
    // service's own exclusiveBranchId check, not branchGuard, rejects this.
    const res = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchBId }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BRANCH_MISMATCH');
  });

  it('rejects replace-source for a branch the actor has no active assignment to', async () => {
    const copyId = await forkReadyCopy();
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    const res = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchBId }),
    });
    expect(res.status).toBe(403);
  });

  it('replaces the source at Branch A only, leaving Branch B untouched, atomically', async () => {
    const copyId = await forkReadyCopy();
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    const res = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { copy: { is_available: boolean }; source: { is_available: boolean } } };
    expect(body.data.copy.is_available).toBe(true);
    expect(body.data.source.is_available).toBe(false);

    const [copyAvail, sourceAvailA, sourceAvailB, sourceRow] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: copyId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId: sharedProductId } } }),
      prisma.product.findUniqueOrThrow({ where: { id: sharedProductId } }),
    ]);
    expect(copyAvail.isAvailable).toBe(true);
    expect(sourceAvailA.isAvailable).toBe(false);
    // Branch B was never touched — same source product, still selling there.
    expect(sourceAvailB.isAvailable).toBe(true);
    // Source product identity/history (its own id/variants) is untouched —
    // this action only ever writes BranchProductAvailability.
    expect(sourceRow.id).toBe(sharedProductId);
    expect(sourceRow.status).toBe('active');
  });

  it('two concurrent replace-source requests for the same copy/branch both succeed and leave a single consistent end state', async () => {
    const copyId = await forkReadyCopy();
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchAId }),
      }),
      fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchAId }),
      }),
    ]);
    expect([resA.status, resB.status]).toEqual([200, 200]);

    const [copyAvail, sourceAvailA] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: copyId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
    ]);
    expect(copyAvail.isAvailable).toBe(true);
    expect(sourceAvailA.isAvailable).toBe(false);
  });

  it('denies replace-source once the supervisor\'s assignment to the copy\'s branch is revoked', async () => {
    const copyId = await forkReadyCopy();
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisorAId, branchId: branchAId }, data: { removedAt: new Date() } });

    const res = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(res.status).toBe(403);

    await prisma.userBranchAssignment.updateMany({ where: { userId: supervisorAId, branchId: branchAId }, data: { removedAt: null } });
  });
});
