import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36R §3 — Product.version closes the gap documented in
 * docs/decisions/POS-PERF-P36-branch-catalog-and-builder.md §5:
 * ProductVariant already had expected_version optimistic concurrency, but
 * Product-level fields (name/category/display_order/seasonal window) did
 * not, so two supervisors loading the same product and saving in sequence
 * could silently clobber each other's edit. This proves the fix with a
 * genuinely stale read-then-write, not just a mocked unit test.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

describe.skipIf(!isLocalDatabase)('Product-level optimistic concurrency (real Postgres)', () => {
  let supervisorId: string;
  let branchId: string;
  let productId: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'Concurrency', employmentType: 'regular', email: `p36r-conc-${suffix}@test.local` },
    });
    supervisorId = sup.id;
    const branch = await prisma.branch.create({
      data: { name: `P36R Concurrency Branch ${suffix}`, code: `P36RC-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchId = branch.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId } });

    const product = await prisma.product.create({
      data: { name: `P36R Concurrency Product ${suffix}`, createdBy: supervisorId, branchExclusive: true, exclusiveBranchId: branchId },
    });
    productId = product.id;
    setupSucceeded = true;
  });

  afterAll(async () => {
    if (!setupSucceeded) return;
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
  });

  it('a stale expected_version is rejected with 409 and never overwrites the newer row', async () => {
    const loadedByTabOne = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(loadedByTabOne.version).toBe(1);

    // "Tab two" saves first, bumping version to 2.
    const afterTabTwo = await productsService.updateProduct(
      productId,
      { name: 'Renamed by Tab Two', expected_version: loadedByTabOne.version },
      { id: supervisorId, role: 'supervisor' },
      null,
    );
    expect(afterTabTwo.name).toBe('Renamed by Tab Two');
    expect(afterTabTwo.version).toBe(2);

    // "Tab one" still holds the stale version=1 it loaded before Tab Two saved.
    await expect(
      productsService.updateProduct(
        productId,
        { name: 'Renamed by stale Tab One', expected_version: loadedByTabOne.version },
        { id: supervisorId, role: 'supervisor' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_CONFLICT', statusCode: 409 });

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(finalRow.name).toBe('Renamed by Tab Two');
    expect(finalRow.version).toBe(2);
  });

  it('omitting expected_version is still backward compatible (no conflict check)', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const updated = await productsService.updateProduct(
      productId,
      { name: 'Renamed with no version check' },
      { id: supervisorId, role: 'supervisor' },
      null,
    );
    expect(updated.name).toBe('Renamed with no version check');
    expect(updated.version).toBe(before.version + 1);
  });

  // POS-PERF-P36R2 — the two tests above only ever issue one write at a time
  // (sequential "tab two saves, then tab one tries"), which never exercises
  // the actual race window: updateProduct reads `before.version`, checks it,
  // then calls a plain `prisma.product.update({ where: { id } })` with no
  // version predicate in the WHERE clause. Two requests that both read the
  // same version and race into that update can both pass the check and both
  // write, because nothing prevents it.
  it('two truly concurrent updateProduct calls with the same expected_version: only one succeeds, the other gets 409', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    const results = await Promise.allSettled([
      productsService.updateProduct(
        productId,
        { name: 'Concurrent A', expected_version: before.version },
        { id: supervisorId, role: 'supervisor' },
        null,
      ),
      productsService.updateProduct(
        productId,
        { name: 'Concurrent B', expected_version: before.version },
        { id: supervisorId, role: 'supervisor' },
        null,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'PRODUCT_CONFLICT', statusCode: 409 });

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(finalRow.version).toBe(before.version + 1);
  });
});
