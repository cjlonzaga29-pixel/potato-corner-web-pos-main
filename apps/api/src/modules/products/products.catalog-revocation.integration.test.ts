import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P35R4 — final scope check. catalog-assignment.integration.test.ts
 * proves createAssignment (the grant path) re-reads live branch assignments
 * at assignment time. It never exercises the mutation paths that rely on
 * that grant afterward — updateProduct/changeProductStatus/deleteProduct via
 * isCatalogManager. This suite closes that gap: once a supervisor is granted
 * managedBy on a branch-exclusive product, does a later-revoked branch
 * assignment actually block them from mutating it, or does managedBy alone
 * keep working as a bypass?
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

describe.skipIf(!isLocalDatabase)('product mutation authorization after branch-assignment revocation (real Postgres)', () => {
  let adminId: string;
  let branchA: string;
  let supervisorId: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: { role: 'super_admin', firstName: 'Admin', lastName: 'User', employmentType: 'regular', email: `admin-${randomUUID()}@test.local` },
    });
    adminId = admin.id;

    const a = await prisma.branch.create({
      data: { name: 'P35R4 Branch A', code: `P35R4A-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchA = a.id;

    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'Revoked', employmentType: 'regular', email: `suprev-${randomUUID()}@test.local` },
    });
    supervisorId = sup.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId: branchA } });

    setupSucceeded = true;
  });

  afterAll(async () => {
    if (!setupSucceeded) return;
    await prisma.product.deleteMany({ where: { createdBy: adminId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supervisorId] } } });
    await prisma.branch.deleteMany({ where: { id: branchA } });
  });

  it('a supervisor whose branch assignment was revoked after being granted managedBy can no longer update the branch-exclusive product', async () => {
    const product = await prisma.product.create({
      data: {
        name: `P35R4 Product ${randomUUID().slice(0, 8)}`,
        createdBy: adminId,
        managedBy: supervisorId,
        branchExclusive: true,
        exclusiveBranchId: branchA,
      },
    });

    // Revoke the supervisor's branch assignment entirely, as an Admin would
    // do when reorganizing regional coverage. managedBy is left untouched —
    // only the branch-assignment edge is severed.
    await prisma.userBranchAssignment.updateMany({
      where: { userId: supervisorId, branchId: branchA },
      data: { removedAt: new Date() },
    });

    await expect(
      productsService.updateProduct(product.id, { name: 'Renamed after revocation' }, { id: supervisorId, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ statusCode: 403 });

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(finalRow.name).not.toBe('Renamed after revocation');
  });
});
