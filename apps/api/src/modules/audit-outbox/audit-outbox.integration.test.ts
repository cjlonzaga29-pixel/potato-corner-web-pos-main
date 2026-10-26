import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditLog } from '@prisma/client';
import { createProductSchema } from '@potato-corner/shared';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/node', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sentry/node')>()), captureException: sentry.captureException }));

/**
 * POS-PERF-P38R4 — durable audit delivery for product publication, against
 * real Postgres with deterministic faults: intents commit and roll back with
 * the publication; the worker delivers them after a crash at any point
 * without losing or duplicating an entry; concurrent and stale workers stay
 * safe; exhausted groups stay visible and recoverable; the hash chain stays
 * linked and verifiable alongside the existing (unlocked) audit writers.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('../products/products.service.js');
const { recordAuditLog, computeAuditHash } = await import('../../middleware/audit-log.js');
const { auditOutboxRepository } = await import('./audit-outbox.repository.js');
const { runAuditOutboxCycle } = await import('./audit-outbox.worker.js');
const { AUDIT_OUTBOX_MAX_ATTEMPTS, AUDIT_OUTBOX_STALE_LOCK_MS } = await import('./audit-outbox.types.js');

type Actor = { id: string; role: string };
const PUBLICATION_ACTIONS = ['INVENTORY_ITEM_BRANCH_ASSIGNED', 'PRODUCT_BRANCH_AVAILABILITY_CHANGED'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fault injection. Inactive unless a test sets it. */
const faults = {
  /** Let the publication's intent INSERT run, then fail the transaction. */
  failAfterIntents: false,
  /** Fail this many audit batch INSERTs before they run. */
  auditFailBefore: 0,
  /** Run this many audit batch INSERTs, then fail before COMMIT (a crash after insertion). */
  auditFailAfter: 0,
  auditFailAlways: false,
};

/** True if `row`'s current_hash is the chain hash of its stored fields and previous_hash. */
function hashVerifies(row: AuditLog): boolean {
  const entry = {
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorId: row.actorId,
    actorRole: row.actorRole,
    branchId: row.branchId,
    beforeState: row.beforeState ?? undefined,
    afterState: row.afterState ?? undefined,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
  return computeAuditHash(entry, row.previousHash) === row.currentHash;
}

describe.skipIf(!isLocalDatabase)('POS-PERF-P38R4 durable publication audit delivery (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  let supervisor: Actor;
  let gramId: string;
  let pieceId: string;
  let potato: string;
  let cup: string;
  let flavorId: string;

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P38R4 Branch ${label} ${suffix}`, code: `P38R4${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38R4 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  async function createProduct(label: string, selection: string[]) {
    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38R4 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
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
    return created.id;
  }

  function aboutProduct(after: unknown, productId: string) {
    const state = after as { product_id?: string; productId?: string } | null;
    return state?.product_id === productId || state?.productId === productId;
  }

  async function intentsFor(productId: string) {
    const rows = await prisma.auditOutbox.findMany({ where: { actorId: supervisor.id }, orderBy: [{ groupId: 'asc' }, { position: 'asc' }] });
    return rows.filter((r) => aboutProduct(r.afterState, productId));
  }

  async function auditsFor(productId: string) {
    const rows = await prisma.auditLog.findMany({ where: { actorId: supervisor.id, action: { in: PUBLICATION_ACTIONS } }, orderBy: { createdAt: 'asc' } });
    return rows.filter((r) => aboutProduct(r.afterState, productId));
  }

  async function deliver(groupIds: string[]) {
    return runAuditOutboxCycle({ groupIds, batchSize: 1000 });
  }

  /** Stands in for the backoff elapsing (the clock is not mocked: Prisma and Postgres use it). */
  async function elapseBackoff(groupId: string) {
    await prisma.auditOutbox.updateMany({ where: { groupId, status: 'pending' }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
  }

  /** A group of `count` probe intents, committed on its own. */
  async function enqueueProbe(label: string, count: number): Promise<string> {
    const groupId = await prisma.$transaction((tx) =>
      auditOutboxRepository.enqueue(
        tx,
        Array.from({ length: count }, (_, i) => ({
          action: 'P38R4_PROBE',
          entityType: 'p38r4_probe',
          entityId: `${label}-${i}`,
          actorId: supervisor.id,
          actorRole: supervisor.role,
          afterState: { label, index: i, suffix },
          ipAddress: null,
        })),
      ),
    );
    if (!groupId) throw new Error('enqueue returned no group');
    return groupId;
  }

  async function probeAudits(groupId: string) {
    const rows = await prisma.auditLog.findMany({ where: { actorId: supervisor.id, entityType: 'p38r4_probe' }, orderBy: { createdAt: 'asc' } });
    return rows.filter((r) => (r.afterState as { audit_event_id?: string }).audit_event_id?.startsWith(`${groupId}:`));
  }

  beforeAll(async () => {
    prisma.$use(async (params, next) => {
      if (params.model === 'AuditOutbox' && params.action === 'createMany' && faults.failAfterIntents) {
        faults.failAfterIntents = false;
        await next(params);
        throw new Error('simulated failure after the intents were written');
      }
      if (params.model === 'AuditLog' && params.action === 'createMany') {
        if (faults.auditFailAlways) throw new Error('simulated audit outage');
        if (faults.auditFailBefore > 0) {
          faults.auditFailBefore -= 1;
          throw new Error('simulated failure before the audit insert');
        }
        const result: unknown = await next(params);
        if (faults.auditFailAfter > 0) {
          faults.auditFailAfter -= 1;
          throw new Error('simulated crash after the audit insert, before commit');
        }
        return result;
      }
      return next(params);
    });

    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38R4', lastName: 'Sup', employmentType: 'regular', email: `p38r4-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };

    const gram = await prisma.unitOfMeasure.create({ data: { code: `p38r4-g-${suffix}`, name: 'P38R4 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const piece = await prisma.unitOfMeasure.create({ data: { code: `p38r4-pc-${suffix}`, name: 'P38R4 Piece', dimension: 'COUNT', isBaseUnit: true } });
    gramId = gram.id;
    pieceId = piece.id;
    unitIds.push(gramId, pieceId);
    potato = await makeItem('Potato', gramId);
    cup = await makeItem('Cup', pieceId);
    const flavor = await prisma.flavor.create({ data: { name: `P38R4 Cheese ${suffix}`, ingredientName: 'Cheese Powder', ingredientUnit: 'g' } });
    flavorId = flavor.id;
    flavorIds.push(flavorId);
  }, 60_000);

  afterEach(() => {
    Object.assign(faults, { failAfterIntents: false, auditFailBefore: 0, auditFailAfter: 0, auditFailAlways: false });
    sentry.captureException.mockClear();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
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

  it('commits the publication and its intents together, and delivers them with actor, branch, payload and occurrence time intact', async () => {
    const a = await makeBranch('A');
    const b = await makeBranch('B');
    const productId = await createProduct('Together', [a, b]);
    const before = new Date();

    const result = await productsService.publishProductToBranches(productId, [a, b], supervisor, '203.0.113.7');
    const after = new Date();

    // Committed together: links, availability, and exactly the intents for what changed — nothing in audit_logs yet.
    expect(result.setup.stock_links).toHaveLength(4);
    const intents = await intentsFor(productId);
    expect(new Set(intents.map((i) => i.groupId)).size).toBe(1);
    expect(intents.map((i) => [i.position, i.action, i.status])).toEqual([
      [0, 'INVENTORY_ITEM_BRANCH_ASSIGNED', 'pending'],
      [1, 'INVENTORY_ITEM_BRANCH_ASSIGNED', 'pending'],
      [2, 'PRODUCT_BRANCH_AVAILABILITY_CHANGED', 'pending'],
      [3, 'PRODUCT_BRANCH_AVAILABILITY_CHANGED', 'pending'],
    ]);
    expect(intents.every((i) => i.eventKey === `${i.groupId}:${i.position}`)).toBe(true);
    expect(intents.every((i) => i.actorId === supervisor.id && i.actorRole === 'supervisor' && i.ipAddress === '203.0.113.7')).toBe(true);
    const occurredAt = intents[0]?.occurredAt as Date;
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await auditsFor(productId)).toEqual([]);

    await sleep(30); // so delivery time is distinguishable from occurrence time
    expect((await deliver([intents[0]?.groupId as string])).delivered).toBe(1);

    const audits = await auditsFor(productId);
    expect(audits).toHaveLength(4);
    const availability = await prisma.branchProductAvailability.findMany({ where: { productId }, orderBy: { branchId: 'asc' } });
    expect(
      audits.map((r) => ({ action: r.action, entityId: r.entityId, branchId: r.branchId, actorId: r.actorId, actorRole: r.actorRole, ipAddress: r.ipAddress })),
    ).toEqual([
      ...[potato, cup].map((item) => ({ action: 'INVENTORY_ITEM_BRANCH_ASSIGNED', entityId: item, branchId: null, actorId: supervisor.id, actorRole: 'supervisor', ipAddress: '203.0.113.7' })),
      ...[a, b].map((branchId) => ({
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityId: availability.find((row) => row.branchId === branchId)?.id,
        branchId,
        actorId: supervisor.id,
        actorRole: 'supervisor',
        ipAddress: '203.0.113.7',
      })),
    ]);
    // Original payload, plus occurrence time and event identity. created_at is the (later) delivery time.
    intents.forEach((intent, index) => {
      const audit = audits[index] as AuditLog;
      expect(audit.afterState).toEqual({ ...(intent.afterState as object), occurred_at: occurredAt.toISOString(), audit_event_id: intent.eventKey });
      expect(audit.createdAt.getTime()).toBeGreaterThan(occurredAt.getTime());
      expect(hashVerifies(audit)).toBe(true);
    });
    expect((audits[0]?.afterState as { assigned: string[] }).assigned.sort()).toEqual([a, b].sort());
    const delivered = await prisma.auditOutbox.findMany({ where: { groupId: intents[0]?.groupId } });
    expect(delivered.every((row) => row.status === 'delivered' && row.deliveredAt !== null && row.claimToken === null)).toBe(true);
  });

  it('a failure after the intents were written rolls back the links, the availability and the intents', async () => {
    const branch = await makeBranch('R');
    const productId = await createProduct('Rollback', [branch]);
    faults.failAfterIntents = true;

    await expect(productsService.publishProductToBranches(productId, [branch], supervisor, null)).rejects.toThrow('simulated failure after the intents were written');

    expect(await prisma.inventoryStock.count({ where: { branchId: branch } })).toBe(0);
    expect(await prisma.branchProductAvailability.count({ where: { productId, isAvailable: true } })).toBe(0);
    expect(await intentsFor(productId)).toEqual([]);

    // A retry then commits normally, with one set of intents.
    await productsService.publishProductToBranches(productId, [branch], supervisor, null);
    expect((await intentsFor(productId)).map((i) => i.action)).toEqual(['INVENTORY_ITEM_BRANCH_ASSIGNED', 'INVENTORY_ITEM_BRANCH_ASSIGNED', 'PRODUCT_BRANCH_AVAILABILITY_CHANGED']);
  });

  it('a repeat publish enqueues nothing; concurrent first publishes enqueue the required intents once', async () => {
    const branch = await makeBranch('C');
    const productId = await createProduct('Concurrent', [branch]);

    const results = await Promise.all([0, 1, 2].map(() => productsService.publishProductToBranches(productId, [branch], supervisor, null)));
    expect(results.flatMap((r) => r.setup.stock_links)).toHaveLength(2);
    const intents = await intentsFor(productId);
    expect(new Set(intents.map((i) => i.groupId)).size).toBe(1);
    expect(intents.map((i) => i.action)).toEqual(['INVENTORY_ITEM_BRANCH_ASSIGNED', 'INVENTORY_ITEM_BRANCH_ASSIGNED', 'PRODUCT_BRANCH_AVAILABILITY_CHANGED']);

    await productsService.publishProductToBranches(productId, [branch], supervisor, null);
    await productsService.publishProduct(productId, branch, supervisor, null);
    expect(await intentsFor(productId)).toHaveLength(3);
  });

  it('after a crash between commit and delivery, the pending intents are delivered once by the next worker cycle', async () => {
    const branch = await makeBranch('K');
    const productId = await createProduct('Crash', [branch]);
    // The publication commits; the process "dies" before any worker runs.
    await productsService.publishProduct(productId, branch, supervisor, null);
    const [first] = await intentsFor(productId);
    const groupId = first?.groupId as string;
    expect((await intentsFor(productId)).every((i) => i.status === 'pending')).toBe(true);

    // "Restart": a fresh cycle finds and delivers them; another finds nothing.
    expect(await deliver([groupId])).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await deliver([groupId])).toMatchObject({ claimed: 0 });
    expect((await auditsFor(productId)).map((r) => r.action)).toEqual([
      'INVENTORY_ITEM_BRANCH_ASSIGNED',
      'INVENTORY_ITEM_BRANCH_ASSIGNED',
      'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
    ]);
  });

  it('a crash after the audit insert but before commit leaves nothing in audit_logs and the group recoverable; the retry writes it once', async () => {
    const groupId = await enqueueProbe('crash-after-insert', 3);
    faults.auditFailAfter = 1;

    expect(await deliver([groupId])).toMatchObject({ claimed: 1, retried: 1 });
    expect(await probeAudits(groupId)).toEqual([]);
    const rows = await prisma.auditOutbox.findMany({ where: { groupId } });
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 1 && r.lastError === 'simulated crash after the audit insert, before commit')).toBe(true);
    expect(rows.every((r) => (r.nextAttemptAt?.getTime() ?? 0) > Date.now())).toBe(true);

    // Backoff is respected, then the retry delivers exactly once.
    expect(await deliver([groupId])).toMatchObject({ claimed: 0 });
    await elapseBackoff(groupId);
    expect(await deliver([groupId])).toMatchObject({ claimed: 1, delivered: 1 });
    const audits = await probeAudits(groupId);
    expect(audits.map((r) => r.entityId)).toEqual(['crash-after-insert-0', 'crash-after-insert-1', 'crash-after-insert-2']);
    expect(audits.every(hashVerifies)).toBe(true);
  });

  it('a lost reply after the delivery committed is not retried into a duplicate', async () => {
    const groupId = await enqueueProbe('lost-commit-reply', 2);
    const real = auditOutboxRepository.deliverGroup.bind(auditOutboxRepository);
    vi.spyOn(auditOutboxRepository, 'deliverGroup').mockImplementationOnce(async (group) => {
      await real(group);
      throw new Error('simulated lost reply to COMMIT');
    });

    // The failure can't be recorded against rows that are already delivered.
    expect(await deliver([groupId])).toMatchObject({ claimed: 1, skipped: 1 });
    expect(await probeAudits(groupId)).toHaveLength(2);
    expect((await prisma.auditOutbox.findMany({ where: { groupId } })).every((r) => r.status === 'delivered' && r.attempts === 0)).toBe(true);
    expect(await deliver([groupId])).toMatchObject({ claimed: 0 });
    expect(await probeAudits(groupId)).toHaveLength(2);
  });

  it('a stale claim is recovered, and the stale owner can neither finalize nor fail it afterwards', async () => {
    const groupId = await enqueueProbe('stale', 2);
    const [crashed] = await auditOutboxRepository.claimBatch(10, AUDIT_OUTBOX_STALE_LOCK_MS, [groupId]);
    expect(crashed?.rows).toHaveLength(2);

    // A live claim is not taken over.
    expect(await deliver([groupId])).toMatchObject({ claimed: 0 });
    // Past the stale timeout another worker recovers and delivers it.
    await sleep(20);
    expect(await runAuditOutboxCycle({ groupIds: [groupId], staleLockMs: 10 })).toMatchObject({ claimed: 1, delivered: 1 });

    if (!crashed) throw new Error('no claim');
    expect(await auditOutboxRepository.deliverGroup(crashed)).toBe(false);
    expect(await auditOutboxRepository.recordFailure({ group: crashed, attempts: 1, nextStatus: 'pending', lastError: 'late', nextAttemptAt: null })).toBe(0);
    expect(await probeAudits(groupId)).toHaveLength(2);
    expect((await prisma.auditOutbox.findMany({ where: { groupId } })).every((r) => r.status === 'delivered' && r.lastError === null)).toBe(true);
  });

  it('a stale owner and its recoverer delivering at the same moment write the group once', async () => {
    const groupId = await enqueueProbe('stale-race', 3);
    const [stale] = await auditOutboxRepository.claimBatch(10, AUDIT_OUTBOX_STALE_LOCK_MS, [groupId]);
    await sleep(20);
    const [recovered] = await auditOutboxRepository.claimBatch(10, 10, [groupId]);
    if (!stale || !recovered) throw new Error('claims missing');
    expect(recovered.claimToken).not.toBe(stale.claimToken);

    const outcomes = await Promise.all([auditOutboxRepository.deliverGroup(stale), auditOutboxRepository.deliverGroup(recovered)]);
    expect(outcomes).toEqual([false, true]);
    expect(await probeAudits(groupId)).toHaveLength(3);
  });

  it('transient failures retry with backoff; an exhausted group turns stuck, stays visible, alerts once, and is recoverable', async () => {
    const transient = await enqueueProbe('transient', 2);
    faults.auditFailBefore = 1;
    expect(await deliver([transient])).toMatchObject({ retried: 1 });
    await elapseBackoff(transient);
    expect(await deliver([transient])).toMatchObject({ delivered: 1 });
    expect(await probeAudits(transient)).toHaveLength(2);
    expect(sentry.captureException).not.toHaveBeenCalled();

    const exhausted = await enqueueProbe('exhausted', 2);
    faults.auditFailAlways = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let attempt = 1; attempt <= AUDIT_OUTBOX_MAX_ATTEMPTS; attempt++) {
      await elapseBackoff(exhausted);
      const cycle = await deliver([exhausted]);
      expect(cycle).toMatchObject(attempt < AUDIT_OUTBOX_MAX_ATTEMPTS ? { retried: 1 } : { stuck: 1 });
    }
    const stuck = await prisma.auditOutbox.findMany({ where: { groupId: exhausted } });
    expect(stuck.every((r) => r.status === 'stuck' && r.attempts === AUDIT_OUTBOX_MAX_ATTEMPTS && r.lastError === 'simulated audit outage' && r.nextAttemptAt === null)).toBe(true);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { audit_outbox: 'stuck' } }));
    expect(errors.mock.calls.filter((call) => call[0] === 'AUDIT_OUTBOX_STUCK')).toHaveLength(1);

    // Not claimed again automatically, and never deleted.
    faults.auditFailAlways = false;
    expect(await deliver([exhausted])).toMatchObject({ claimed: 0 });
    expect(await probeAudits(exhausted)).toEqual([]);

    // Manual recovery: requeue, then the next cycle delivers it once.
    expect(await auditOutboxRepository.requeueStuck({ groupId: exhausted, limit: 10 })).toEqual([exhausted]);
    expect(await deliver([exhausted])).toMatchObject({ delivered: 1 });
    expect(await probeAudits(exhausted)).toHaveLength(2);
  });

  it('concurrent workers alongside concurrent legacy audit writers: every event once, outbox entries chained and verifiable, no fork between workers', async () => {
    const groups: string[] = [];
    for (let i = 0; i < 12; i++) groups.push(await enqueueProbe(`concurrent-${i}`, 3));
    const legacyTag = `p38r4-legacy-${suffix}`;

    async function workerLoop() {
      for (let i = 0; i < 50; i++) {
        if ((await runAuditOutboxCycle({ groupIds: groups, batchSize: 4 })).claimed === 0) return;
      }
    }
    await Promise.all([
      workerLoop(),
      workerLoop(),
      workerLoop(),
      workerLoop(),
      ...Array.from({ length: 30 }, (_, i) =>
        recordAuditLog({ action: 'P38R4_LEGACY', entityType: legacyTag, entityId: String(i), actorId: supervisor.id, actorRole: supervisor.role }),
      ),
    ]);

    const outboxRows = await prisma.auditOutbox.findMany({ where: { groupId: { in: groups } } });
    expect(outboxRows).toHaveLength(36);
    expect(outboxRows.every((r) => r.status === 'delivered')).toBe(true);

    const delivered = (await Promise.all(groups.map((g) => probeAudits(g)))).flat();
    const eventIds = delivered.map((r) => (r.afterState as { audit_event_id: string }).audit_event_id);
    expect(eventIds.sort()).toEqual(outboxRows.map((r) => r.eventKey).sort());
    expect(delivered.every(hashVerifies)).toBe(true);

    // Each outbox entry links to an older entry; groups are contiguous. A
    // group's first entry may chain onto a row another suite running in
    // parallel has since deleted in its cleanup (production never deletes
    // audit rows), so only those may be missing here.
    const predecessors = await prisma.auditLog.findMany({ where: { currentHash: { in: delivered.map((r) => r.previousHash) } } });
    const byHash = new Map(predecessors.map((r) => [r.currentHash, r]));
    const groupStarts = new Set(delivered.filter((r) => (r.afterState as { audit_event_id: string }).audit_event_id.endsWith(':0')).map((r) => r.id));
    for (const row of delivered) {
      const predecessor = byHash.get(row.previousHash);
      if (!predecessor && groupStarts.has(row.id)) continue;
      expect(predecessor).toBeDefined();
      expect((predecessor as AuditLog).createdAt.getTime()).toBeLessThan(row.createdAt.getTime());
    }
    for (const groupId of groups) {
      const rows = await probeAudits(groupId);
      for (let i = 1; i < rows.length; i++) expect(rows[i]?.previousHash).toBe(rows[i - 1]?.currentHash);
      // Nothing else chained onto the middle of a group.
      const midHashes = rows.slice(0, -1).map((r) => r.currentHash);
      expect(await prisma.auditLog.count({ where: { previousHash: { in: midHashes } } })).toBe(midHashes.length);
    }
    // Workers never chain to the same tail.
    const outboxPrevious = delivered.map((r) => r.previousHash);
    expect(new Set(outboxPrevious).size).toBe(outboxPrevious.length);

    // Legacy writers are unlocked (pre-existing): report, don't hide, any fork they made.
    const legacy = await prisma.auditLog.findMany({ where: { entityType: legacyTag } });
    expect(legacy).toHaveLength(30);
    const sharedTails = await prisma.auditLog.groupBy({
      by: ['previousHash'],
      where: { previousHash: { in: [...outboxPrevious, ...legacy.map((r) => r.previousHash)] } },
      _count: { _all: true },
      having: { previousHash: { _count: { gt: 1 } } },
    });
    // eslint-disable-next-line no-console
    console.info(`[P38R4] chain forks involving an unlocked legacy writer in this run: ${sharedTails.length}`);
  });
});
