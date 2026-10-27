import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema, type JwtPayload, type ProductBranchView } from '@potato-corner/shared';

/**
 * POS-PERF-P39R — the Products tabs never depend on audit delivery, against
 * real Postgres. Publication's availability intents commit in the outbox with
 * the publication (P38R4) and the draft check reads every outbox status, so a
 * product published and then taken off POS is Inactive — never a Draft —
 * while its entries are pending, claimed, stuck or delivered, even when no
 * audit_logs write succeeds at all. Delivery is paused for this file's
 * intents: they are written with a far-future next_attempt_at, so no worker
 * (including an API left running against the same database) can claim them
 * until a test releases them.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { auditOutboxRepository } = await import('../audit-outbox/audit-outbox.repository.js');
const { runAuditOutboxCycle } = await import('../audit-outbox/audit-outbox.worker.js');
const { AUDIT_OUTBOX_MAX_ATTEMPTS } = await import('../audit-outbox/audit-outbox.types.js');

type Actor = { id: string; role: string };
type Tabs = Record<ProductBranchView, string[]>;

const HELD_UNTIL = new Date('2999-01-01T00:00:00Z');

const faults = {
  /** While true, every audit_logs insert fails: the direct writers' (swallowed) and the outbox worker's. */
  auditLogsDown: false,
  /** While true, new outbox intents are written unclaimable (delivery paused). */
  holdIntents: true,
};

describe.skipIf(!isLocalDatabase)('POS-PERF-P39R branch views while audit delivery is pending, stuck or delivered (real Postgres)', () => {
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
  let gramId: string;
  let pieceId: string;
  let potato: string;
  let cup: string;
  let flavorId: string;

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P39R Branch ${label} ${suffix}`, code: `P39R${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P39R ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  /** A publishable product (one active size with a recipe and a flavor) set up for `branches`, on POS nowhere. */
  async function createReadyProduct(label: string, branches: string[]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P39R ${label} ${suffix}`, status: 'active', branch_ids: branches }),
      supervisor,
      null,
    );
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
    ids[label] = created.id;
    return created.id;
  }

  /** Product labels in each tab at `branchId`, plus the counts the response carried, limited to this file's products. */
  async function classify(branchId: string): Promise<{ tabs: Tabs; counts: Record<ProductBranchView, number> | undefined }> {
    const byId = Object.fromEntries(Object.entries(ids).map(([label, id]) => [id, label]));
    const tabs: Tabs = { active: [], drafts: [], inactive: [] };
    let counts: Record<ProductBranchView, number> | undefined;
    for (const view of ['active', 'drafts', 'inactive'] as const) {
      const result = await productsService.getAllProducts(supervisorJwt, {
        branch_id: branchId,
        view,
        search: suffix,
        page: 1,
        limit: 25,
        sort_by: 'name',
        sort_order: 'asc',
      });
      tabs[view] = result.products.map((p) => byId[p.id] ?? `foreign:${p.id}`).sort();
      expect(result.total).toBe(tabs[view].length);
      if (counts) expect(result.counts).toEqual(counts);
      counts = result.counts;
    }
    return { tabs, counts };
  }

  /** The outbox rows for `productId`'s availability rows, and the audit_logs entries for them. */
  async function availabilityHistory(productId: string) {
    const rowIds = (await prisma.branchProductAvailability.findMany({ where: { productId }, select: { id: true } })).map((r) => r.id);
    const where = { entityType: 'branch_product_availability', entityId: { in: rowIds } };
    const [outbox, logged] = await Promise.all([prisma.auditOutbox.findMany({ where }), prisma.auditLog.findMany({ where })]);
    return { outbox, logged };
  }

  // The same classification at A and B must hold at every stage of P's delivery below.
  const expectedA: Tabs = { active: [], drafts: ['genuine-draft'], inactive: ['history-in-audit-logs-only', 'published-at-a-and-b', 'published-at-b-only'] };
  const expectedB: Tabs = { active: ['published-at-b-only'], drafts: ['genuine-draft'], inactive: ['published-at-a-and-b'] };

  async function expectStableClassification() {
    const a = await classify(branchA);
    const b = await classify(branchB);
    expect(a.tabs).toEqual(expectedA);
    expect(a.counts).toEqual({ active: 0, drafts: 1, inactive: 3 });
    expect(b.tabs).toEqual(expectedB);
    expect(b.counts).toEqual({ active: 1, drafts: 1, inactive: 1 });
  }

  let publishedGroupId: string;

  beforeAll(async () => {
    prisma.$use(async (params, next) => {
      if (faults.auditLogsDown && params.model === 'AuditLog' && (params.action === 'create' || params.action === 'createMany')) {
        throw new Error('simulated audit_logs outage');
      }
      if (faults.holdIntents && params.model === 'AuditOutbox' && params.action === 'createMany') {
        const args = params.args as { data: Record<string, unknown>[] };
        args.data = args.data.map((row) => ({ ...row, nextAttemptAt: HELD_UNTIL }));
      }
      return next(params);
    });

    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P39R', lastName: 'Sup', employmentType: 'regular', email: `p39r-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p39r-g-${suffix}`, name: 'P39R Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p39r-pc-${suffix}`, name: 'P39R Piece', dimension: 'COUNT', isBaseUnit: true } });
    gramId = gram.id;
    pieceId = piece.id;
    unitIds.push(gramId, pieceId);
    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    const flavor = await prisma.flavor.create({ data: { name: `P39R Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);

    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
    supervisorJwt = { user_id: user.id, role: 'supervisor', email: user.email, branch_ids: [branchA, branchB] } as JwtPayload;
  }, 60_000);

  afterAll(async () => {
    faults.auditLogsDown = false;
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
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

  it('a genuine draft is a Draft, and a fresh A+B publication is Active at both while its audit entries are only pending', async () => {
    await createReadyProduct('genuine-draft', [branchA, branchB]);
    const published = await createReadyProduct('published-at-a-and-b', [branchA, branchB]);
    await productsService.publishProductToBranches(published, [branchA, branchB], supervisor, null);

    const { outbox, logged } = await availabilityHistory(published);
    expect(outbox.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(logged).toHaveLength(0);
    publishedGroupId = outbox[0]?.groupId as string;

    expect((await classify(branchA)).tabs).toEqual({ active: ['published-at-a-and-b'], drafts: ['genuine-draft'], inactive: [] });
    expect((await classify(branchB)).tabs).toEqual({ active: ['published-at-a-and-b'], drafts: ['genuine-draft'], inactive: [] });
  }, 60_000);

  it('deactivated at A, then at both, with no audit_logs write possible: Inactive, never a Draft', async () => {
    const published = ids['published-at-a-and-b'] as string;
    faults.auditLogsDown = true;
    try {
      await productsService.unpublishProduct(published, branchA, supervisor, null);
      const a = await classify(branchA);
      const b = await classify(branchB);
      expect(a.tabs).toEqual({ active: [], drafts: ['genuine-draft'], inactive: ['published-at-a-and-b'] });
      expect(b.tabs).toEqual({ active: ['published-at-a-and-b'], drafts: ['genuine-draft'], inactive: [] });

      await productsService.unpublishProduct(published, branchB, supervisor, null);
    } finally {
      faults.auditLogsDown = false;
    }

    // The unpublish audits were swallowed, so the only history is the still-pending publication intents.
    const { outbox, logged } = await availabilityHistory(published);
    expect(logged).toHaveLength(0);
    expect(outbox.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(await prisma.branchProductAvailability.count({ where: { productId: published, isAvailable: true } })).toBe(0);

    // Published only at B (configured at A too): Inactive at A, Active at B, still undelivered.
    const bOnly = await createReadyProduct('published-at-b-only', [branchA, branchB]);
    await productsService.publishProductToBranches(bOnly, [branchB], supervisor, null);
    expect((await availabilityHistory(bOnly)).logged).toHaveLength(0);

    // Published and taken off before the outbox existed: its history is in audit_logs alone.
    const legacy = await createReadyProduct('history-in-audit-logs-only', [branchA]);
    await productsService.updateBranchProductAvailability(legacy, branchA, true, supervisor, null);
    await productsService.updateBranchProductAvailability(legacy, branchA, false, supervisor, null);
    const legacyHistory = await availabilityHistory(legacy);
    expect(legacyHistory.outbox).toHaveLength(0);
    expect(legacyHistory.logged.length).toBeGreaterThan(0);

    await expectStableClassification();
  }, 60_000);

  it('keeps the same tabs and counts while the group is claimed, then stuck after exhausted attempts', async () => {
    // Claimed by a worker that has not delivered yet: the row state claimBatch
    // writes, set directly so no other worker can take the group in between.
    const claimToken = randomUUID();
    await prisma.auditOutbox.updateMany({ where: { groupId: publishedGroupId, status: 'pending' }, data: { status: 'processing', claimToken, lockedAt: new Date() } });
    const rows = await prisma.auditOutbox.findMany({ where: { groupId: publishedGroupId }, orderBy: { position: 'asc' } });
    // The group also carries the publication's stock-link intents; it changes state as a whole.
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['processing']));
    await expectStableClassification();

    // Its last allowed attempt fails: the worker's exhausted-group write.
    const failed = await auditOutboxRepository.recordFailure({
      group: { groupId: publishedGroupId, claimToken, attempts: AUDIT_OUTBOX_MAX_ATTEMPTS - 1, rows },
      attempts: AUDIT_OUTBOX_MAX_ATTEMPTS,
      nextStatus: 'stuck',
      lastError: 'simulated audit_logs outage',
      nextAttemptAt: null,
    });
    expect(failed).toBe(rows.length);
    expect(new Set((await prisma.auditOutbox.findMany({ where: { groupId: publishedGroupId } })).map((r) => r.status))).toEqual(new Set(['stuck']));
    await expectStableClassification();
  }, 120_000);

  it('keeps the same tabs and counts once every entry is delivered', async () => {
    faults.holdIntents = false;
    expect(await auditOutboxRepository.requeueStuck({ groupId: publishedGroupId, limit: 1 })).toEqual([publishedGroupId]);
    const bOnlyGroups = [...new Set((await availabilityHistory(ids['published-at-b-only'] as string)).outbox.map((r) => r.groupId))];
    await prisma.auditOutbox.updateMany({ where: { groupId: { in: bOnlyGroups }, status: 'pending' }, data: { nextAttemptAt: null } });
    // Released: this cycle, or any other worker on the database, delivers them; either way exactly once.
    await runAuditOutboxCycle({ groupIds: [publishedGroupId, ...bOnlyGroups], batchSize: 1000 });

    for (const label of ['published-at-a-and-b', 'published-at-b-only']) {
      const { outbox, logged } = await availabilityHistory(ids[label] as string);
      expect(outbox.length).toBeGreaterThan(0);
      expect(outbox.every((r) => r.status === 'delivered')).toBe(true);
      expect(logged.filter((r) => r.action === 'PRODUCT_BRANCH_AVAILABILITY_CHANGED')).toHaveLength(outbox.length);
    }
    await expectStableClassification();
  }, 60_000);

  it('archived and discontinued products stay Inactive with their real status; restore puts the product back on POS', async () => {
    const published = ids['published-at-a-and-b'] as string;
    const bOnly = ids['published-at-b-only'] as string;
    await productsService.changeProductStatus(published, { status: 'archived' }, supervisor, null);
    await productsService.changeProductStatus(bOnly, { status: 'discontinued' }, supervisor, null);

    const a = await classify(branchA);
    const b = await classify(branchB);
    expect(a.tabs).toEqual(expectedA);
    expect(b.tabs).toEqual({ active: [], drafts: ['genuine-draft'], inactive: ['published-at-a-and-b', 'published-at-b-only'] });
    const inactiveAtB = await productsService.getAllProducts(supervisorJwt, { branch_id: branchB, view: 'inactive', search: suffix, page: 1, limit: 25 });
    expect(Object.fromEntries(inactiveAtB.products.map((p) => [p.id, p.status]))).toEqual({ [published]: 'archived', [bOnly]: 'discontinued' });

    await productsService.changeProductStatus(published, { status: 'active' }, supervisor, null);
    expect((await classify(branchA)).tabs.active).toEqual(['published-at-a-and-b']);
    expect((await classify(branchB)).tabs.active).toEqual(['published-at-a-and-b']);
  }, 60_000);
});
