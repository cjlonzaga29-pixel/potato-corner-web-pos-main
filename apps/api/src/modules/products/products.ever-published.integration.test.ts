import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema, type JwtPayload, type ProductBranchView } from '@potato-corner/shared';

/**
 * POS-PERF-P39R2 — products.ever_published, against real Postgres. Every
 * write that can make a product live sets it in that write's own transaction
 * (a failure anywhere rolls the marker back with the business change), it is
 * never cleared, a write that leaves the product not live (a draft-status
 * copy turned on, a restore that enables nothing) does not set it, branch
 * copies start without it, and the Products tabs read it instead of audit
 * history — so losing every audit row cannot move a product into Drafts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

type Actor = { id: string; role: string };
type Tabs = Record<ProductBranchView, string[]>;

const faults = {
  /** While true, the marker's write fails (the last write of most activation transactions). */
  markerDown: false,
  /** While true, publication's audit outbox insert fails (written after the marker). */
  outboxDown: false,
};

describe.skipIf(!isLocalDatabase)('POS-PERF-P39R2 ever-published marker (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  const ids: Record<string, string> = {};
  let supervisor: Actor;
  let supervisorJwt: JwtPayload;
  let branchA: string;
  let branchB: string;
  let branchX: string;
  let gramId: string;
  let pieceId: string;
  let potato: string;
  let cup: string;
  let flavorId: string;

  async function makeBranch(label: string, assigned = true) {
    const branch = await prisma.branch.create({
      data: { name: `P39R2 Branch ${label} ${suffix}`, code: `P39R2${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchIds.push(branch.id);
    if (assigned) await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P39R2 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  /** A product set up for `branches`, on POS nowhere; `ready` gives it a publishable size (recipe + flavor). */
  async function createProduct(label: string, branches: string[], ready = true) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P39R2 ${label} ${suffix}`, status: 'active', branch_ids: branches }),
      supervisor,
      null,
    );
    if (ready) {
      const variant = await prisma.productVariant.create({
        data: { productId: created.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 59, isActive: true, lifecycleStatus: 'ACTIVE' },
      });
      await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId, isAvailable: true } });
      await prisma.productComponent.createMany({
        data: [
          { productVariantId: variant.id, inventoryItemId: potato, quantityRequired: 150, recipeUnitId: gramId, flavorId: null },
          { productVariantId: variant.id, inventoryItemId: cup, quantityRequired: 1, recipeUnitId: pieceId, flavorId: null },
        ],
      });
    }
    ids[label] = created.id;
    return created.id;
  }

  async function state(productId: string) {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { status: true, everPublished: true, branchAvailability: { select: { branchId: true, isAvailable: true } } },
    });
    const on = product.branchAvailability.filter((r) => r.isAvailable).map((r) => r.branchId).sort();
    return { status: product.status, everPublished: product.everPublished, on };
  }

  /** Product labels per tab at `branchId`, checking that every tab returns the same counts and that total equals the rows. */
  async function classify(branchId: string, search = suffix): Promise<{ tabs: Tabs; counts: Record<ProductBranchView, number> | undefined }> {
    const byId = Object.fromEntries(Object.entries(ids).map(([label, id]) => [id, label]));
    const tabs: Tabs = { active: [], drafts: [], inactive: [] };
    let counts: Record<ProductBranchView, number> | undefined;
    for (const view of ['active', 'drafts', 'inactive'] as const) {
      const result = await productsService.getAllProducts(supervisorJwt, { branch_id: branchId, view, search, page: 1, limit: 50, sort_by: 'name', sort_order: 'asc' });
      tabs[view] = result.products.map((p) => byId[p.id] ?? `foreign:${p.id}`).sort();
      expect(result.total).toBe(tabs[view].length);
      if (counts) expect(result.counts).toEqual(counts);
      counts = result.counts;
    }
    return { tabs, counts };
  }

  beforeAll(async () => {
    prisma.$use(async (params, next) => {
      if (faults.markerDown && params.model === 'Product' && params.action === 'updateMany') {
        const args = params.args as { data?: { everPublished?: unknown } };
        if (args.data?.everPublished === true) throw new Error('simulated marker write failure');
      }
      if (faults.outboxDown && params.model === 'AuditOutbox' && params.action === 'createMany') {
        throw new Error('simulated audit outbox failure');
      }
      return next(params);
    });

    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P39R2', lastName: 'Sup', employmentType: 'regular', email: `p39r2-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p39r2-g-${suffix}`, name: 'P39R2 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p39r2-pc-${suffix}`, name: 'P39R2 Piece', dimension: 'COUNT', isBaseUnit: true } });
    gramId = gram.id;
    pieceId = piece.id;
    unitIds.push(gramId, pieceId);
    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    const flavor = await prisma.flavor.create({ data: { name: `P39R2 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);

    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
    branchX = await makeBranch('X', false);
    supervisorJwt = { user_id: user.id, role: 'supervisor', email: user.email, branch_ids: [branchA, branchB] } as JwtPayload;
  }, 60_000);

  afterEach(() => {
    faults.markerDown = false;
    faults.outboxDown = false;
  });

  afterAll(async () => {
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    // Copies reference their source: delete them first.
    await prisma.product.deleteMany({ where: { id: { in: productIds }, forkedFromProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.branchFlavorAvailability.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditOutbox.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  }, 60_000);

  describe('activation paths set the marker in the same transaction', () => {
    it('Single Publish (publishProduct)', async () => {
      const id = await createProduct('single-publish', [branchA, branchB]);
      expect((await state(id)).everPublished).toBe(false);
      await productsService.publishProduct(id, branchA, supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [branchA] });
    }, 60_000);

    it('Builder Add to POS (publishProductToBranches), and a retry writes nothing', async () => {
      const id = await createProduct('add-to-pos', [branchA, branchB]);
      await productsService.publishProductToBranches(id, [branchA, branchB], supervisor, null);
      const after = await prisma.product.findUniqueOrThrow({ where: { id }, select: { everPublished: true, updatedAt: true } });
      expect(after.everPublished).toBe(true);
      await productsService.publishProductToBranches(id, [branchA, branchB], supervisor, null);
      expect(await prisma.product.findUniqueOrThrow({ where: { id }, select: { everPublished: true, updatedAt: true } })).toEqual(after);
    }, 60_000);

    it('per-branch availability enable', async () => {
      const id = await createProduct('per-branch', [branchA]);
      await productsService.updateBranchProductAvailability(id, branchA, true, supervisor, null);
      expect((await state(id)).everPublished).toBe(true);
    }, 60_000);

    it('bulk availability enable, including a batch that turns one branch on and another off', async () => {
      const id = await createProduct('bulk', [branchA, branchB]);
      await productsService.bulkUpdateBranchProductAvailability(id, [{ branch_id: branchA, is_available: true }, { branch_id: branchB, is_available: false }], supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [branchA] });
    }, 60_000);

    it('branch-scoped status change to active', async () => {
      const id = await createProduct('branch-status', [branchA]);
      await productsService.changeProductStatus(id, { status: 'active', branch_id: branchA }, supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [branchA] });
    }, 60_000);

    it('global temporarily_unavailable -> active with a row already on', async () => {
      const id = await createProduct('resume', [branchA]);
      await productsService.changeProductStatus(id, { status: 'temporarily_unavailable' }, supervisor, null);
      // Turned on while paused: not live, so not marked.
      await productsService.updateBranchProductAvailability(id, branchA, true, supervisor, null);
      expect(await state(id)).toEqual({ status: 'temporarily_unavailable', everPublished: false, on: [branchA] });
      await productsService.changeProductStatus(id, { status: 'active' }, supervisor, null);
      expect((await state(id)).everPublished).toBe(true);
    }, 60_000);

    it('restore cascade marks only when it actually enables availability', async () => {
      // Never published, archived, configured at an active branch: restore turns its row on, so it is live.
      const enabling = await createProduct('restore-enables', [branchA], false);
      await productsService.changeProductStatus(enabling, { status: 'archived' }, supervisor, null);
      await productsService.changeProductStatus(enabling, { status: 'active' }, supervisor, null);
      expect(await state(enabling)).toEqual({ status: 'active', everPublished: true, on: [branchA] });
    }, 60_000);

    it('branch copies start unpublished, lifecycle active alone marks nothing, replacement marks the live copy, and a restore that enables nothing leaves a never-published source unmarked', async () => {
      // Never published anywhere, set up for A and B; once copies replace it at both, restore has nothing to enable.
      const source = await createProduct('copy-source', [branchA, branchB]);
      await prisma.inventoryStock.createMany({
        data: [branchA, branchB].flatMap((branchId) => [potato, cup].map((inventoryItemId) => ({ branchId, inventoryItemId }))),
        skipDuplicates: true,
      });

      const copyB = await productsService.forkProductForBranch(source, branchB, supervisor, null);
      ids['copy-b'] = copyB.id;
      await productsService.changeProductStatus(copyB.id, { status: 'active' }, supervisor, null);
      await productsService.replaceSharedProductAtBranch(copyB.id, branchB, supervisor, null);

      const copy = await productsService.forkProductForBranch(source, branchA, supervisor, null);
      ids['copy'] = copy.id;
      expect(await state(copy.id)).toEqual({ status: 'draft', everPublished: false, on: [] });
      expect((await classify(branchA)).tabs.drafts).toContain('copy');

      // draft -> active with every row off: lifecycle 'active' alone is not publication.
      await productsService.changeProductStatus(copy.id, { status: 'active' }, supervisor, null);
      expect(await state(copy.id)).toEqual({ status: 'active', everPublished: false, on: [] });
      expect((await classify(branchA)).tabs.drafts).toContain('copy');

      // Replacement turns the active copy on at A (and the source off there): live, so marked.
      await productsService.replaceSharedProductAtBranch(copy.id, branchA, supervisor, null);
      expect(await state(copy.id)).toEqual({ status: 'active', everPublished: true, on: [branchA] });
      expect(await state(source)).toEqual({ status: 'active', everPublished: false, on: [] });

      // Archive and restore the source: the cascade skips A (replaced), so it enables nothing.
      await productsService.changeProductStatus(source, { status: 'archived' }, supervisor, null);
      await productsService.changeProductStatus(source, { status: 'active' }, supervisor, null);
      expect(await state(source)).toEqual({ status: 'active', everPublished: false, on: [] });
      const tabs = (await classify(branchA)).tabs;
      expect(tabs.drafts).toContain('copy-source');
      expect(tabs.active).toContain('copy');
    }, 120_000);

    it('a copy of a published product does not inherit its marker', async () => {
      const source = await createProduct('published-source', [branchA, branchB]);
      await productsService.publishProductToBranches(source, [branchA, branchB], supervisor, null);
      expect((await state(source)).everPublished).toBe(true);
      const copy = await productsService.forkProductForBranch(source, branchB, supervisor, null);
      ids['published-copy'] = copy.id;
      expect(await state(copy.id)).toEqual({ status: 'draft', everPublished: false, on: [] });
    }, 60_000);

    it('a status-draft product turned on directly stays unmarked and a Draft', async () => {
      const id = await createProduct('status-draft-on', [branchA], false);
      await prisma.product.update({ where: { id }, data: { status: 'draft' } });
      await productsService.updateBranchProductAvailability(id, branchA, true, supervisor, null);
      expect(await state(id)).toEqual({ status: 'draft', everPublished: false, on: [branchA] });
      expect((await classify(branchA)).tabs.drafts).toContain('status-draft-on');
    }, 60_000);
  });

  describe('failure rolls the marker back with the business change', () => {
    it('publication that is not ready marks nothing', async () => {
      const id = await createProduct('not-ready', [branchA], false);
      await expect(productsService.publishProduct(id, branchA, supervisor, null)).rejects.toMatchObject({ code: 'PRODUCT_NOT_READY' });
      expect(await state(id)).toEqual({ status: 'active', everPublished: false, on: [] });
    }, 60_000);

    it('a marker failure undoes the publication: rows, stock links and audit intents', async () => {
      const item = await makeItem('Rollback Salt', gramId);
      const id = await createProduct('marker-fails', [branchA]);
      const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: id } });
      await prisma.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item, quantityRequired: 2, recipeUnitId: gramId } });
      faults.markerDown = true;
      await expect(productsService.publishProductToBranches(id, [branchA], supervisor, null)).rejects.toThrow('simulated marker write failure');
      expect(await state(id)).toEqual({ status: 'active', everPublished: false, on: [] });
      expect(await prisma.inventoryStock.count({ where: { inventoryItemId: item } })).toBe(0);
      const rowIds = (await prisma.branchProductAvailability.findMany({ where: { productId: id }, select: { id: true } })).map((r) => r.id);
      expect(await prisma.auditOutbox.count({ where: { entityId: { in: rowIds } } })).toBe(0);
    }, 60_000);

    it('an audit outbox failure after the marker undoes the marker too', async () => {
      const id = await createProduct('outbox-fails', [branchA]);
      faults.outboxDown = true;
      await expect(productsService.publishProduct(id, branchA, supervisor, null)).rejects.toThrow('simulated audit outbox failure');
      expect(await state(id)).toEqual({ status: 'active', everPublished: false, on: [] });
    }, 60_000);

    it('per-branch enable, bulk enable and restore roll back on a marker failure', async () => {
      const perBranch = await createProduct('per-branch-fails', [branchA]);
      const bulk = await createProduct('bulk-fails', [branchA, branchB]);
      const restore = await createProduct('restore-fails', [branchA], false);
      await productsService.changeProductStatus(restore, { status: 'archived' }, supervisor, null);
      faults.markerDown = true;
      await expect(productsService.updateBranchProductAvailability(perBranch, branchA, true, supervisor, null)).rejects.toThrow('simulated marker write failure');
      await expect(
        productsService.bulkUpdateBranchProductAvailability(bulk, [{ branch_id: branchA, is_available: true }, { branch_id: branchB, is_available: true }], supervisor, null),
      ).rejects.toThrow('simulated marker write failure');
      await expect(productsService.changeProductStatus(restore, { status: 'active' }, supervisor, null)).rejects.toThrow('simulated marker write failure');
      faults.markerDown = false;
      expect(await state(perBranch)).toEqual({ status: 'active', everPublished: false, on: [] });
      expect(await state(bulk)).toEqual({ status: 'active', everPublished: false, on: [] });
      expect(await state(restore)).toEqual({ status: 'archived', everPublished: false, on: [] });
    }, 60_000);

    it('a bulk batch with a branch outside the assignment is refused before anything is written', async () => {
      const id = await createProduct('bulk-denied', [branchA]);
      await expect(
        productsService.bulkUpdateBranchProductAvailability(id, [{ branch_id: branchA, is_available: true }, { branch_id: branchX, is_available: true }], supervisor, null),
      ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
      expect(await state(id)).toEqual({ status: 'active', everPublished: false, on: [] });
    }, 60_000);
  });

  describe('monotonic marker and classification', () => {
    it('deactivate, discontinue, archive and restore never clear it', async () => {
      const id = await createProduct('monotonic', [branchA, branchB]);
      await productsService.publishProductToBranches(id, [branchA, branchB], supervisor, null);
      await productsService.unpublishProduct(id, branchA, supervisor, null);
      await productsService.unpublishProduct(id, branchB, supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [] });
      await productsService.changeProductStatus(id, { status: 'discontinued' }, supervisor, null);
      expect((await state(id)).everPublished).toBe(true);
      await productsService.changeProductStatus(id, { status: 'archived' }, supervisor, null);
      expect(await state(id)).toEqual({ status: 'archived', everPublished: true, on: [] });
      await productsService.changeProductStatus(id, { status: 'active' }, supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [branchA, branchB].sort() });
      await productsService.bulkUpdateBranchProductAvailability(id, [{ branch_id: branchA, is_available: false }, { branch_id: branchB, is_available: false }], supervisor, null);
      expect(await state(id)).toEqual({ status: 'active', everPublished: true, on: [] });
    }, 120_000);

    it('tabs and counts ignore audit history entirely: deleting every audit row moves nothing', async () => {
      const draft = await createProduct('tabs-draft', [branchA, branchB]);
      const shared = await createProduct('tabs-shared', [branchA, branchB]);
      await productsService.publishProductToBranches(shared, [branchB], supervisor, null);
      const taken = await createProduct('tabs-taken-off', [branchA]);
      await productsService.publishProduct(taken, branchA, supervisor, null);
      await productsService.unpublishProduct(taken, branchA, supervisor, null);

      const search = 'P39R2 tabs';
      const before = { a: await classify(branchA, search), b: await classify(branchB, search) };
      expect(before.a.tabs).toEqual({ active: [], drafts: ['tabs-draft'], inactive: ['tabs-shared', 'tabs-taken-off'] });
      expect(before.b.tabs).toEqual({ active: ['tabs-shared'], drafts: ['tabs-draft'], inactive: [] });

      const rowIds = (await prisma.branchProductAvailability.findMany({ where: { productId: { in: [draft, shared, taken] } }, select: { id: true } })).map((r) => r.id);
      const historyWhere = { entityId: { in: [...rowIds, draft, shared, taken] } };
      expect((await prisma.auditOutbox.count({ where: historyWhere })) + (await prisma.auditLog.count({ where: historyWhere }))).toBeGreaterThan(0);
      await prisma.auditOutbox.deleteMany({ where: historyWhere });
      await prisma.auditLog.deleteMany({ where: historyWhere });

      expect(await classify(branchA, search)).toEqual(before.a);
      expect(await classify(branchB, search)).toEqual(before.b);
    }, 120_000);

    it('a product live through an older API (no marker) is never a Draft while it is on POS anywhere', async () => {
      // What a pre-P39R2 instance writes during a deploy overlap: the row on, no marker.
      const id = await createProduct('overlap-live', [branchA, branchB]);
      await prisma.branchProductAvailability.updateMany({ where: { productId: id, branchId: branchB }, data: { isAvailable: true } });
      expect(await state(id)).toEqual({ status: 'active', everPublished: false, on: [branchB] });
      expect((await classify(branchA, 'P39R2 overlap')).tabs).toEqual({ active: [], drafts: [], inactive: ['overlap-live'] });
      expect((await classify(branchB, 'P39R2 overlap')).tabs).toEqual({ active: ['overlap-live'], drafts: [], inactive: [] });
    }, 60_000);

    it('rows, counts, search and pagination agree', async () => {
      const all = await classify(branchA);
      const counts = all.counts as Record<ProductBranchView, number>;
      for (const view of ['active', 'drafts', 'inactive'] as const) {
        expect(counts[view]).toBe(all.tabs[view].length);
        const seen: string[] = [];
        for (let page = 1; page <= Math.max(1, Math.ceil(counts[view] / 2)); page++) {
          const result = await productsService.getAllProducts(supervisorJwt, { branch_id: branchA, view, search: suffix, page, limit: 2, sort_by: 'name', sort_order: 'asc' });
          expect(result.total).toBe(counts[view]);
          seen.push(...result.products.map((p) => p.id));
        }
        expect(new Set(seen).size).toBe(counts[view]);
        expect(seen.length).toBe(counts[view]);
      }
      const narrowed = await classify(branchA, `monotonic ${suffix}`);
      expect(narrowed.tabs).toEqual({ active: [], drafts: [], inactive: ['monotonic'] });
    }, 120_000);

    it('keeps branch isolation: a branch outside the assignment is refused', async () => {
      await expect(
        productsService.getAllProducts(supervisorJwt, { branch_id: branchX, view: 'drafts', page: 1, limit: 25 }),
      ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    });
  });
});
