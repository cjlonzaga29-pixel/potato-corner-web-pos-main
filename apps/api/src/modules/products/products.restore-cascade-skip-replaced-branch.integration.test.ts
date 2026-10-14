import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P36R6 — products.repository.ts's cascadeBranchAvailabilityOn
 * (restore-to-active cascade) must not silently re-enable a shared
 * product's branch availability at a branch where a fork-to-branch copy
 * has already replaced it (POS-PERF-P36R5's replaceSharedProductAtBranch).
 * Before this fix, archiving then restoring the source put both the
 * source and its replacement sellable at that branch at once — flagged
 * but left unfixed in docs/decisions/POS-PERF-P36R5-branch-copy-ui-and-
 * replacement.md §3. Every other branch this product sells at (never
 * replaced) must still restore exactly as before.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('restore-cascade skips a branch already replaced by a fork copy (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;

  let branchAId: string;
  let branchBId: string;
  let supervisorAId: string; // assigned only to A
  let supervisorBothId: string; // assigned to A and B — global owner of the shared product
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
      prisma.branch.create({ data: { name: `P36R6 Branch A ${suffix}`, code: `P36R6A-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R6 Branch B ${suffix}`, code: `P36R6B-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;

    const [supA, supBoth] = await Promise.all([
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'A', employmentType: 'regular', email: `p36r6-supa-${suffix}@test.local` } }),
      prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: 'Both', employmentType: 'regular', email: `p36r6-supboth-${suffix}@test.local` } }),
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

    const unit = await prisma.unitOfMeasure.create({ data: { code: `p36r6-g-${suffix}`, name: 'P36R6 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    gramUnitId = unit.id;
    const item = await prisma.inventoryItem.create({ data: { name: `P36R6 Item ${suffix}`, baseUnitId: gramUnitId } });
    itemId = item.id;

    const product = await prisma.product.create({
      data: { name: `P36R6 Shared Product ${suffix}`, status: 'active', createdBy: supervisorBothId },
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

  it('restoring the archived source re-enables Branch B but leaves Branch A (replaced by the copy) alone', async () => {
    // Fork a branch-exclusive copy for A, ready it, and replace the source there.
    const forkRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/fork-to-branch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(forkRes.status).toBe(201);
    const forkBody = (await forkRes.json()) as { data: { id: string } };
    const copyId = forkBody.data.id;
    createdProductIds.push(copyId);
    await prisma.product.update({ where: { id: copyId }, data: { status: 'active' } });

    const replaceRes = await fetch(`${baseUrl}/api/products/${copyId}/replace-source`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchAId }),
    });
    expect(replaceRes.status).toBe(200);

    // Archive the source globally (supervisorBoth owns it everywhere it still sells — Branch B).
    const archiveRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived', reason: 'P36R6 restore-cascade test' }),
    });
    expect(archiveRes.status).toBe(200);

    const [copyAvailAfterArchive, sourceAvailAAfterArchive, sourceAvailBAfterArchive] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: copyId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId: sharedProductId } } }),
    ]);
    // Archiving the source never touches the copy's own availability.
    expect(copyAvailAfterArchive.isAvailable).toBe(true);
    expect(sourceAvailAAfterArchive.isAvailable).toBe(false);
    expect(sourceAvailBAfterArchive.isAvailable).toBe(false);

    // Restore the source to active.
    const restoreRes = await fetch(`${baseUrl}/api/products/${sharedProductId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenBoth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'P36R6 restore-cascade test' }),
    });
    expect(restoreRes.status).toBe(200);

    const [copyAvailAfterRestore, sourceAvailAAfterRestore, sourceAvailBAfterRestore] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: copyId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId: sharedProductId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId: sharedProductId } } }),
    ]);
    // Branch B (never replaced) restores exactly as before.
    expect(sourceAvailBAfterRestore.isAvailable).toBe(true);
    // Branch A stays with the copy only — the source is NOT silently
    // re-enabled alongside its replacement.
    expect(sourceAvailAAfterRestore.isAvailable).toBe(false);
    expect(copyAvailAfterRestore.isAvailable).toBe(true);
  });
});
