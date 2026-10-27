import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductSchema, type JwtPayload, type ProductBranchView } from '@potato-corner/shared';

/**
 * POS-PERF-P39 — the supervisor Products page's Active / Drafts / Inactive
 * tabs, against real Postgres: every product configured at the branch is in
 * exactly one tab, a product taken off POS is never mistaken for a draft
 * (POS-PERF-P39R2: products.ever_published, not audit history — an audit row
 * alone never makes a product non-draft), archived and
 * temporarily-unavailable products are Inactive, other branches' products are
 * not listed, counts follow search, pages neither repeat nor skip, and the
 * branch must be one the supervisor may read.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');

type Actor = { id: string; role: string };

describe.skipIf(!isLocalDatabase)('POS-PERF-P39 product branch views (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const outboxKeys: string[] = [];
  let branchA: string;
  let branchB: string;
  let branchX: string;
  let supervisor: Actor;
  let supervisorJwt: JwtPayload;
  const ids: Record<string, string> = {};

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P39 Branch ${label} ${suffix}`, code: `P39${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchIds.push(branch.id);
    return branch.id;
  }

  async function create(label: string, branches: string[], status: 'active' | 'draft' = 'active') {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P39V ${label} ${suffix}`, status, branch_ids: branches }),
      supervisor,
      null,
    );
    ids[label] = created.id;
    return created.id;
  }

  async function list(branchId: string, view: ProductBranchView, extra: { search?: string; page?: number; limit?: number } = {}) {
    return productsService.getAllProducts(supervisorJwt, {
      branch_id: branchId,
      view,
      search: extra.search ?? `P39V`,
      page: extra.page ?? 1,
      limit: extra.limit ?? 25,
      sort_by: 'name',
      sort_order: 'asc',
    });
  }

  /** Product ids (by label) in each tab, limited to this test's products. */
  async function tabs(branchId: string) {
    const out: Record<ProductBranchView, string[]> = { active: [], drafts: [], inactive: [] };
    const byId = Object.fromEntries(Object.entries(ids).map(([label, id]) => [id, label]));
    for (const view of ['active', 'drafts', 'inactive'] as const) {
      const result = await list(branchId, view, { search: suffix });
      out[view] = result.products.map((p) => byId[p.id] ?? `foreign:${p.id}`).sort();
    }
    return out;
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P39', lastName: 'Sup', employmentType: 'regular', email: `p39-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };
    branchA = await makeBranch('A');
    branchB = await makeBranch('B');
    branchX = await makeBranch('X');
    for (const branchId of [branchA, branchB]) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId } });
    supervisorJwt = { user_id: user.id, role: 'supervisor', email: user.email, branch_ids: [branchA, branchB] } as JwtPayload;

    // Drafts: a builder product never put on POS, and a legacy status-draft product.
    await create('builder-draft', [branchA, branchB]);
    await create('legacy-draft', [branchA], 'draft');
    // On POS at A only (published through the audited availability path).
    const onPos = await create('on-pos-at-a', [branchA, branchB]);
    await productsService.updateBranchProductAvailability(onPos, branchA, true, supervisor, null);
    // Published, then taken off POS everywhere: not a draft.
    const offAgain = await create('taken-off', [branchA]);
    await productsService.updateBranchProductAvailability(offAgain, branchA, true, supervisor, null);
    await productsService.updateBranchProductAvailability(offAgain, branchA, false, supervisor, null);
    // Archived and globally temporarily unavailable.
    const archived = await create('archived', [branchA]);
    await productsService.changeProductStatus(archived, { status: 'archived' }, supervisor, null);
    const paused = await create('temporarily-unavailable', [branchA]);
    await productsService.updateBranchProductAvailability(paused, branchA, true, supervisor, null);
    await productsService.changeProductStatus(paused, { status: 'temporarily_unavailable' }, supervisor, null);
    // An availability audit intent with no publication behind it: still a Draft (P39R2 — audit rows are not the marker).
    const queued = await create('audit-row-only', [branchA]);
    const queuedRow = await prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchA, productId: queued } } });
    const groupId = randomUUID();
    outboxKeys.push(`${groupId}:0`);
    await prisma.auditOutbox.create({
      data: {
        eventKey: `${groupId}:0`,
        groupId,
        position: 0,
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityType: 'branch_product_availability',
        entityId: queuedRow.id,
        actorId: user.id,
        actorRole: 'supervisor',
        branchId: branchA,
        occurredAt: new Date(),
      },
    });
    await prisma.branchProductAvailability.update({ where: { id: queuedRow.id }, data: { isAvailable: false } });
    // Only at B.
    const bOnly = await create('b-only', [branchB]);
    await productsService.updateBranchProductAvailability(bOnly, branchB, true, supervisor, null);
  });

  afterAll(async () => {
    const productIds = Object.values(ids);
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.auditOutbox.deleteMany({ where: { eventKey: { in: outboxKeys } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  it('puts every product configured at the branch in exactly one tab', async () => {
    expect(await tabs(branchA)).toEqual({
      active: ['on-pos-at-a'],
      drafts: ['audit-row-only', 'builder-draft', 'legacy-draft'],
      inactive: ['archived', 'taken-off', 'temporarily-unavailable'],
    });
  });

  it('classifies per branch: on POS at A is Inactive at B, and products not configured at a branch are not listed there', async () => {
    expect(await tabs(branchB)).toEqual({
      active: ['b-only'],
      drafts: ['builder-draft'],
      inactive: ['on-pos-at-a'],
    });
  });

  it('keeps the true lifecycle status on Inactive rows so archived is never shown as a draft', async () => {
    const inactive = await list(branchA, 'inactive', { search: suffix });
    const statusById = Object.fromEntries(inactive.products.map((p) => [p.id, p.status]));
    expect(statusById[ids.archived as string]).toBe('archived');
    expect(statusById[ids['temporarily-unavailable'] as string]).toBe('temporarily_unavailable');
    const row = inactive.products.find((p) => p.id === ids.archived);
    expect(row?.branches).toEqual([expect.objectContaining({ branch_id: branchA, is_available: false })]);
  });

  it('returns the same counts on every tab, and they follow the search', async () => {
    const counts = (await list(branchA, 'active', { search: suffix })).counts;
    expect(counts).toEqual({ active: 1, drafts: 3, inactive: 3 });
    expect((await list(branchA, 'drafts', { search: suffix })).counts).toEqual(counts);
    expect((await list(branchA, 'inactive', { search: `taken-off ${suffix}` })).counts).toEqual({ active: 0, drafts: 0, inactive: 1 });
  });

  it('pages without repeating or skipping rows, and total matches the tab count', async () => {
    const first = await list(branchA, 'inactive', { search: suffix, limit: 2, page: 1 });
    const second = await list(branchA, 'inactive', { search: suffix, limit: 2, page: 2 });
    expect(first.total).toBe(3);
    expect(first.products).toHaveLength(2);
    expect(second.products).toHaveLength(1);
    const all = [...first.products, ...second.products].map((p) => p.id);
    expect(new Set(all).size).toBe(3);
  });

  it('refuses a branch the supervisor is not assigned to', async () => {
    await expect(list(branchX, 'active')).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
  });

  it('leaves the unscoped list (Super Admin products page) unchanged: no counts', async () => {
    const result = await productsService.getAllProducts(supervisorJwt, { search: suffix, page: 1, limit: 25 });
    expect(result.counts).toBeUndefined();
    expect(result.products.length).toBe(Object.keys(ids).length);
  });
});
