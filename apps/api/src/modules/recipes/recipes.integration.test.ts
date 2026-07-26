import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration tests exercise the real Prisma + Redis stack end to end,
 * following the same convention as products.integration.test.ts. Set
 * TEST_DATABASE_URL and TEST_REDIS_URL to enable this suite.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

const { prisma } = await import('../../lib/prisma.js');
const { recipesService } = await import('./recipes.service.js');
const { productsService } = await import('../products/products.service.js');

describe.skipIf(!canRunIntegrationTests)('recipes integration', () => {
  beforeAll(async () => {
    // TODO: point `prisma` at TEST_DATABASE_URL, run `prisma migrate deploy`,
    // seed one super_admin, one supervisor (branch A only), one active
    // branch, one ingredient, one product variant, and one master recipe
    // row before the suite runs.
  });

  afterAll(async () => {
    // TODO: truncate all tables touched by these tests and close the
    // Prisma connection opened for this suite.
  });

  it('super_admin can create a master recipe row', async () => {
    // TODO: POST /api/recipes as super_admin; assert 201.
    expect(true).toBe(true);
  });

  it('supervisor can create a branch recipe override without approval', async () => {
    // TODO: POST /api/recipes/:variantId/overrides as supervisor with a
    // valid reason (20+ chars); assert 201, immediately active (no pending
    // status concept for overrides), and an audit_logs row with action
    // BRANCH_RECIPE_OVERRIDE_CREATED.
    expect(true).toBe(true);
  });

  it('supervisor cannot create an override with a reason under 20 characters', async () => {
    // TODO: POST with reason.length < 20; assert 422 VALIDATION_ERROR.
    expect(true).toBe(true);
  });

  it('POST /api/recipes/simulate without branch_id uses the master recipe only', async () => {
    // TODO: simulate with no branch_id; assert every line's source is
    // master_base or master_flavor, never branch_*.
    expect(true).toBe(true);
  });

  it('POST /api/recipes/simulate with branch_id applies that branch’s overrides', async () => {
    // TODO: simulate with branch_id set for a branch with an override;
    // assert the overridden ingredient's line reflects the override
    // quantity and source branch_base/branch_flavor.
    expect(true).toBe(true);
  });

  it('supervisor can update and delete their own branch override', async () => {
    // TODO: PATCH then DELETE /api/recipes/overrides/:id as supervisor;
    // assert 200 then 204, and audit_logs rows for both actions.
    expect(true).toBe(true);
  });
});

/**
 * CR-005 Sub-phase 3f — recipe flavorSlotIndex write path, and the
 * removeFlavorSlot/reorderFlavorSlots hardening that keeps Recipe rows in
 * sync with ProductFlavorSlot changes. Same real-Prisma convention as
 * products.integration.test.ts's "CR-005 Sub-phase 3d flavor slot CRUD"
 * block — these two suites necessarily share both modules' services since
 * the guards under test live in productsService but touch Recipe rows.
 */
describe.skipIf(!canRunIntegrationTests)('recipes integration — CR-005 Sub-phase 3f flavorSlotIndex write path', () => {
  let superAdminId: string;
  let supervisorId: string;
  let branchId: string;
  let ingredientId: string;
  let productId: string;
  const createdProductIds: string[] = [];

  const SUPER_ADMIN = () => ({ id: superAdminId, role: 'super_admin' });
  const SUPERVISOR = () => ({ id: supervisorId, role: 'supervisor' });

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `cr005f-admin-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'CR-005F',
        lastName: 'Test Admin',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    superAdminId = admin.id;

    const supervisor = await prisma.user.create({
      data: {
        email: `cr005f-sup-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'supervisor',
        firstName: 'CR-005F',
        lastName: 'Test Supervisor',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    supervisorId = supervisor.id;

    const branch = await prisma.branch.create({
      data: { name: 'CR-005F Test Branch', code: `CR005F-${randomUUID().slice(0, 8)}`, address: '1 Test St', city: 'Testville' },
    });
    branchId = branch.id;

    const ingredient = await prisma.ingredient.create({
      data: { branchId, name: 'CR-005F Cheese Powder', unit: 'g', currentStock: 0, lowStockThreshold: 0, criticalThreshold: 0 },
    });
    ingredientId = ingredient.id;

    const product = await prisma.product.create({ data: { name: 'CR-005F Slot Fries', status: 'active' } });
    productId = product.id;
    createdProductIds.push(productId);
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productFlavorSlot.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productInventory.deleteMany({ where: { productVariant: { productId: { in: createdProductIds } } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.ingredient.deleteMany({ where: { branchId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.user.deleteMany({ where: { id: { in: [superAdminId, supervisorId] } } });
    await prisma.$disconnect();
  });

  async function createDraftVariant(namePrefix: string, maxFlavors = 5) {
    return prisma.productVariant.create({
      data: {
        productId,
        name: `${namePrefix}-${randomUUID().slice(0, 8)}`,
        sizeLabel: 'Regular',
        basePrice: 65,
        isActive: true,
        lifecycleStatus: 'DRAFT',
        createdById: superAdminId,
        maxFlavors,
      },
    });
  }

  it('creates three recipes against three flavor slots and persists each flavorSlotIndex correctly', async () => {
    const variant = await createDraftVariant('three-slots-three-recipes');
    await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    await productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    const r0 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 0, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );
    const r1 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 1, quantity: 6, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );
    const r2 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 2, quantity: 7, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );

    expect([r0.flavor_slot_index, r1.flavor_slot_index, r2.flavor_slot_index]).toEqual([0, 1, 2]);

    const persisted = await prisma.recipe.findMany({ where: { productVariantId: variant.id }, orderBy: { flavorSlotIndex: 'asc' } });
    expect(persisted.map((r) => r.flavorSlotIndex)).toEqual([0, 1, 2]);
  });

  it('cascades a slot reorder onto Recipe.flavorSlotIndex, preserving recipe->slot linkage', async () => {
    const variant = await createDraftVariant('reorder-cascade');
    const s0 = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s1 = await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s2 = await productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    const r0 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 0, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );
    const r2 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 2, quantity: 7, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );

    // [A, B, C] -> [C, A, B]: A moves from index 0 to 1; C moves from index 2 to 0.
    await productsService.reorderFlavorSlots(variant.id, { slotIds: [s2.id, s0.id, s1.id] }, undefined, SUPERVISOR(), null);

    const r0After = await prisma.recipe.findUniqueOrThrow({ where: { id: r0.id } });
    const r2After = await prisma.recipe.findUniqueOrThrow({ where: { id: r2.id } });
    expect(r0After.flavorSlotIndex).toBe(1);
    expect(r2After.flavorSlotIndex).toBe(0);
  });

  it('rejects removing a flavor slot that a recipe still references (SLOT_HAS_DEPENDENT_RECIPES), leaving the recipe untouched', async () => {
    const variant = await createDraftVariant('remove-guard');
    const slot = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const recipe = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 0, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );

    await expect(productsService.removeFlavorSlot(slot.id, undefined, SUPERVISOR(), null)).rejects.toMatchObject({
      code: 'SLOT_HAS_DEPENDENT_RECIPES',
      statusCode: 409,
    });

    const stillThere = await prisma.productFlavorSlot.findUnique({ where: { id: slot.id } });
    expect(stillThere).not.toBeNull();
    const recipeAfter = await prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    expect(recipeAfter.flavorSlotIndex).toBe(0);
  });

  it('removing a flavor slot shifts higher-indexed recipes down to keep pointing at the same logical slot', async () => {
    const variant = await createDraftVariant('remove-shift');
    const s0 = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s1 = await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s2 = await productsService.addFlavorSlot(variant.id, { label: 'C', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    const r1 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 1, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );
    const r2 = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 2, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );

    // Delete the recipe at the slot being removed so the guard clears, then remove slot B (index 1).
    await recipesService.deleteRecipe(r1.id, SUPER_ADMIN(), null);
    await productsService.removeFlavorSlot(s1.id, undefined, SUPERVISOR(), null);

    const remainingSlots = await prisma.productFlavorSlot.findMany({ where: { productVariantId: variant.id }, orderBy: { slotIndex: 'asc' } });
    expect(remainingSlots.map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(remainingSlots.map((s) => s.id)).toEqual([s0.id, s2.id]);

    const r2After = await prisma.recipe.findUniqueOrThrow({ where: { id: r2.id } });
    expect(r2After.flavorSlotIndex).toBe(1);
  });

  it('rolls back the whole reorder — slots and recipes both — when the Recipe cascade step fails mid-transaction', async () => {
    const { recipesRepository } = await import('./recipes.repository.js');
    const { productsService: ps } = await import('../products/products.service.js');

    const variant = await createDraftVariant('cascade-rollback');
    const s0 = await productsService.addFlavorSlot(variant.id, { label: 'A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);
    const s1 = await productsService.addFlavorSlot(variant.id, { label: 'B', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR(), null);

    // Promote to ACTIVE so the mutation runs inside performSlotEditWithActiveGovernance's prisma.$transaction.
    // approveVariant now requires at least one active ProductInventory mapping
    // (CR-005 Guarantee 6 — replaces the old vacuous-pass Recipe-resolvability
    // check), so provision one against this suite's own ingredient first.
    await ps.submitVariantForApproval(variant.id, SUPERVISOR(), null);
    await prisma.productInventory.create({
      data: { branchId, productVariantId: variant.id, ingredientId, flavorId: null, quantityRequired: 5, unit: 'g' },
    });
    await ps.approveVariant(variant.id, undefined, SUPER_ADMIN(), null);

    const recipe = await recipesService.createRecipe(
      { product_variant_id: variant.id, ingredient_id: ingredientId, flavor_slot_index: 0, quantity: 5, unit: 'grams' },
      SUPER_ADMIN(),
      null,
    );

    const { vi } = await import('vitest');
    const cascadeSpy = vi
      .spyOn(recipesRepository, 'cascadeRecipeSlotReindex')
      .mockRejectedValueOnce(new Error('simulated cascade failure'));

    await expect(
      ps.reorderFlavorSlots(variant.id, { slotIds: [s1.id, s0.id] }, 'reorder test', SUPER_ADMIN(), null),
    ).rejects.toThrow('simulated cascade failure');

    cascadeSpy.mockRestore();

    const slotsAfter = await prisma.productFlavorSlot.findMany({ where: { productVariantId: variant.id }, orderBy: { slotIndex: 'asc' } });
    expect(slotsAfter.map((s) => s.id)).toEqual([s0.id, s1.id]);
    expect(slotsAfter.map((s) => s.slotIndex)).toEqual([0, 1]);

    const recipeAfter = await prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    expect(recipeAfter.flavorSlotIndex).toBe(0);

    const logs = await prisma.productChangeLog.count({ where: { productVariantId: variant.id } });
    expect(logs).toBe(0);
  });
});
