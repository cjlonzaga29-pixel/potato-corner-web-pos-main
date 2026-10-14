import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36R3 §3 — option-group assignment's actual concurrency
 * guarantees, verified against a real Postgres database instead of assumed.
 * `ProductVariantOptionGroup` carries a `@@unique([productVariantId,
 * optionGroupId])` constraint (schema.prisma) and no `version` column —
 * the task's own instruction is not to add one mechanically unless a real
 * gap is proven. Two real gaps were found and fixed here, both in the same
 * shape: a raw Prisma error (P2002 / P2025) from the existing DB constraint
 * correctly stopping the invalid state, but reaching app.ts's generic
 * `next(error)` -> 500 "Something went wrong" instead of the service's own
 * already-defined, actionable error code for the exact same case.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productOptionsService } = await import('./product-options.service.js');
const { ProductOptionError } = await import('./product-options.types.js');

describe.skipIf(!isLocalDatabase)('Product option-group assignment concurrency (real Postgres)', () => {
  let supervisorId: string;
  let branchId: string;
  let productId: string;
  let variantId: string;
  let optionGroupId: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Opt', lastName: 'Conc', employmentType: 'regular', email: `p36r3-opt-${suffix}@test.local` },
    });
    supervisorId = sup.id;

    const branch = await prisma.branch.create({
      data: { name: `P36R3 Option Branch ${suffix}`, code: `P36R3O-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchId = branch.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId } });

    const product = await prisma.product.create({
      data: { name: `P36R3 Option Product ${suffix}`, status: 'active', createdBy: supervisorId, branchExclusive: true, exclusiveBranchId: branchId },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true },
    });
    variantId = variant.id;

    const group = await prisma.productOptionGroup.create({
      data: { code: `p36r3-group-${suffix}`, name: 'Add-ons', selectionType: 'MULTIPLE', createdBy: supervisorId },
    });
    optionGroupId = group.id;
  });

  afterEach(async () => {
    await prisma.productVariantOptionGroup.deleteMany({ where: { productVariantId: variantId } });
  });

  afterAll(async () => {
    await prisma.productOptionGroup.deleteMany({ where: { id: optionGroupId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
  });

  const actor = () => ({ id: supervisorId, role: 'supervisor' });

  it(
    'two concurrent assigns of the same option group to the same variant: exactly one succeeds, the loser gets the ' +
      'actionable VARIANT_OPTION_GROUP_ALREADY_ASSIGNED 409 — not a raw P2002 500 (the unique constraint already made ' +
      'this data-safe; this proves the HTTP-level response is also correct)',
    async () => {
      const results = await Promise.allSettled([
        productOptionsService.assignOptionGroupToVariant(productId, variantId, { option_group_id: optionGroupId }, actor(), null),
        productOptionsService.assignOptionGroupToVariant(productId, variantId, { option_group_id: optionGroupId }, actor(), null),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(ProductOptionError);
      expect(rejection).toMatchObject({ code: 'VARIANT_OPTION_GROUP_ALREADY_ASSIGNED', statusCode: 409 });

      const rows = await prisma.productVariantOptionGroup.findMany({ where: { productVariantId: variantId, optionGroupId } });
      expect(rows.length).toBe(1);
    },
  );

  it(
    'two concurrent unassigns of the same assignment: exactly one succeeds, the loser gets the actionable ' +
      'VARIANT_OPTION_GROUP_NOT_FOUND 404 — not a raw P2025 500 (the row is genuinely gone either way; this proves ' +
      'the second caller is told clearly instead of hitting an opaque server error)',
    async () => {
      const assignment = await productOptionsService.assignOptionGroupToVariant(
        productId,
        variantId,
        { option_group_id: optionGroupId },
        actor(),
        null,
      );

      const results = await Promise.allSettled([
        productOptionsService.unassignOptionGroupFromVariant(productId, variantId, assignment.id, actor(), null),
        productOptionsService.unassignOptionGroupFromVariant(productId, variantId, assignment.id, actor(), null),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejection = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejection).toBeInstanceOf(ProductOptionError);
      expect(rejection).toMatchObject({ code: 'VARIANT_OPTION_GROUP_NOT_FOUND', statusCode: 404 });

      const row = await prisma.productVariantOptionGroup.findUnique({ where: { id: assignment.id } });
      expect(row).toBeNull();
    },
  );

  it(
    'an update racing a concurrent unassign of the same assignment: the update either lands before the delete ' +
      '(succeeds) or after (actionable VARIANT_OPTION_GROUP_NOT_FOUND 404) — never a raw P2025 500',
    async () => {
      const assignment = await productOptionsService.assignOptionGroupToVariant(
        productId,
        variantId,
        { option_group_id: optionGroupId },
        actor(),
        null,
      );

      const results = await Promise.allSettled([
        productOptionsService.updateVariantOptionGroup(productId, variantId, assignment.id, { required: true }, actor(), null),
        productOptionsService.unassignOptionGroupFromVariant(productId, variantId, assignment.id, actor(), null),
      ]);

      const [updateResult, unassignResult] = results;
      // The unassign is unconditional (no precondition to fail on), so it
      // must always succeed regardless of ordering.
      expect(unassignResult.status).toBe('fulfilled');

      if (updateResult.status === 'rejected') {
        expect(updateResult.reason).toBeInstanceOf(ProductOptionError);
        expect(updateResult.reason).toMatchObject({ code: 'VARIANT_OPTION_GROUP_NOT_FOUND', statusCode: 404 });
      }

      const row = await prisma.productVariantOptionGroup.findUnique({ where: { id: assignment.id } });
      expect(row).toBeNull();
    },
  );
});
