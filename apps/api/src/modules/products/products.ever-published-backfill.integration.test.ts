import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditOutboxStatus, ProductStatus } from '@prisma/client';

/**
 * POS-PERF-P39R2 — pos_backfill_product_ever_published() (created by the
 * 20261027120000 migration, rerun as the deploy-overlap reconciliation),
 * against real Postgres. Each product below is a pre-marker history built
 * from the rows the API writes: it is marked only on evidence that it was
 * live (on POS now; a row turned on while it was active, in audit_logs or in
 * the outbox in any delivery status; or a change to active while a row was
 * on), never on deactivations, generic updates, its creator or lifecycle
 * 'active' alone. A history with no surviving evidence stays unmarked. The
 * function is idempotent and never clears a marker.
 *
 * The audit_logs fixtures are dated 2001, before any real entry, so they are
 * never the hash chain's tail (the outbox worker chains after the newest
 * entry); they are deleted afterwards.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');

const at = (minute: number) => new Date(Date.UTC(2001, 0, 1, 0, minute));

describe.skipIf(!isLocalDatabase)('POS-PERF-P39R2 ever-published backfill (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  let userId: string;
  let branchId: string;
  const productIds: Record<string, string> = {};
  const rowIds: Record<string, string> = {};
  const auditLogIds: string[] = [];

  async function product(label: string, status: ProductStatus, rowOn: boolean, extra: { everPublished?: boolean; forkedFrom?: string } = {}) {
    const created = await prisma.product.create({
      data: {
        name: `P39R2B ${label} ${suffix}`,
        status,
        createdBy: userId,
        everPublished: extra.everPublished ?? false,
        ...(extra.forkedFrom && { forkedFromProductId: extra.forkedFrom, branchExclusive: true, exclusiveBranchId: branchId }),
      },
    });
    const row = await prisma.branchProductAvailability.create({ data: { branchId, productId: created.id, isAvailable: rowOn } });
    productIds[label] = created.id;
    rowIds[label] = row.id;
    return created.id;
  }

  async function logged(action: string, entityType: string, entityId: string, minute: number, states: { before?: object; after?: object } = {}) {
    const entry = await prisma.auditLog.create({
      data: {
        action,
        entityType,
        entityId,
        actorId: userId,
        actorRole: 'supervisor',
        branchId,
        beforeState: states.before,
        afterState: states.after,
        previousHash: 'p39r2-fixture',
        currentHash: `p39r2-fixture-${randomUUID()}`,
        createdAt: at(minute),
      },
    });
    auditLogIds.push(entry.id);
  }

  async function queued(entityId: string, minute: number, status: AuditOutboxStatus, after: object = { isAvailable: true }) {
    const groupId = randomUUID();
    await prisma.auditOutbox.create({
      data: {
        eventKey: `${groupId}:0`,
        groupId,
        position: 0,
        action: 'PRODUCT_BRANCH_AVAILABILITY_CHANGED',
        entityType: 'branch_product_availability',
        entityId,
        actorId: userId,
        actorRole: 'supervisor',
        branchId,
        afterState: after,
        occurredAt: at(minute),
        status,
        nextAttemptAt: status === 'pending' ? new Date('2999-01-01T00:00:00Z') : null,
      },
    });
    return `${groupId}:0`;
  }

  const availability = (label: string, minute: number, isAvailable: boolean) =>
    logged('PRODUCT_BRANCH_AVAILABILITY_CHANGED', 'branch_product_availability', rowIds[label] as string, minute, { after: { productId: productIds[label], isAvailable } });
  const statusChange = (label: string, minute: number, before: ProductStatus, after: ProductStatus) =>
    logged('PRODUCT_STATUS_CHANGED', 'product', productIds[label] as string, minute, { before: { status: before }, after: { status: after, reason: null } });
  const replaced = (copyLabel: string, minute: number, sourceId: string) =>
    logged('PRODUCT_REPLACED_AT_BRANCH', 'product', productIds[copyLabel] as string, minute, {
      after: { sourceProductId: sourceId, sourceAvailableAtBranch: false, copyProductId: productIds[copyLabel], copyAvailableAtBranch: true },
    });

  const expected: Record<string, boolean> = {};

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P39R2B', lastName: 'Sup', employmentType: 'regular', email: `p39r2b-sup-${suffix}@test.local` },
    });
    userId = user.id;
    const branch = await prisma.branch.create({ data: { name: `P39R2B Branch ${suffix}`, code: `P39R2B-${suffix}`, address: 'Test', city: 'Test', status: 'active' } });
    branchId = branch.id;

    // Evidence: live now.
    await product('live-now', 'active', true);
    expected['live-now'] = true;

    // Evidence: on then off, in audit_logs only (pre-outbox history).
    await product('audit-logs-only', 'active', false);
    await availability('audit-logs-only', 1, true);
    await availability('audit-logs-only', 2, false);
    expected['audit-logs-only'] = true;

    // Evidence: committed publication intents in the outbox, undelivered (pending, stuck) or claimed.
    for (const status of ['pending', 'processing', 'stuck'] as const) {
      await product(`outbox-${status}`, 'active', false);
      await queued(rowIds[`outbox-${status}`] as string, 1, status, { productId: productIds[`outbox-${status}`], isAvailable: true });
      expected[`outbox-${status}`] = true;
    }

    // Evidence: delivered — the outbox row plus its audit_logs copy (one product, marked once).
    await product('outbox-delivered', 'active', false);
    const deliveredKey = await queued(rowIds['outbox-delivered'] as string, 1, 'delivered', { productId: productIds['outbox-delivered'], isAvailable: true });
    await logged('PRODUCT_BRANCH_AVAILABILITY_CHANGED', 'branch_product_availability', rowIds['outbox-delivered'] as string, 3, {
      after: { productId: productIds['outbox-delivered'], isAvailable: true, audit_event_id: deliveredKey, occurred_at: at(1).toISOString() },
    });
    expected['outbox-delivered'] = true;

    // Evidence: live, then archived (removal cascade) — status at the time was 'active'.
    await product('archived-after-live', 'archived', false);
    await availability('archived-after-live', 1, true);
    await logged('PRODUCT_CATALOG_REMOVAL_CASCADE', 'product', productIds['archived-after-live'] as string, 2, { after: { cascadedTo: 'unavailable', triggeredBy: 'archived' } });
    await statusChange('archived-after-live', 2, 'active', 'archived');
    expected['archived-after-live'] = true;

    // Evidence: a copy turned on by replacement, made active later with its row still on, since turned off.
    const source = await product('copy-source', 'active', false);
    await product('copy-activated-after-replace', 'active', false, { forkedFrom: source });
    await replaced('copy-activated-after-replace', 1, source);
    await statusChange('copy-activated-after-replace', 2, 'draft', 'active');
    await availability('copy-activated-after-replace', 3, false);
    expected['copy-activated-after-replace'] = true;
    // The replacement turned the source off; nothing shows it was ever on.
    expected['copy-source'] = false;

    // No evidence: replaced, turned off, and only then made active.
    const source2 = await product('copy-source-2', 'active', false);
    await product('copy-off-before-activation', 'active', false, { forkedFrom: source2 });
    await replaced('copy-off-before-activation', 1, source2);
    await availability('copy-off-before-activation', 2, false);
    await statusChange('copy-off-before-activation', 3, 'draft', 'active');
    expected['copy-source-2'] = false;
    expected['copy-off-before-activation'] = false;

    // No evidence: never published.
    await product('never-published', 'active', false);
    expected['never-published'] = false;

    // No evidence: only a deactivation.
    await product('deactivation-only', 'active', false);
    await availability('deactivation-only', 1, false);
    expected['deactivation-only'] = false;

    // No evidence: a generic update, and a creator.
    await product('generic-update', 'active', false);
    await logged('PRODUCT_UPDATED', 'product', productIds['generic-update'] as string, 1, { after: { status: 'active', branches: [{ is_available: true }] } });
    expected['generic-update'] = false;

    // No evidence: lifecycle 'active' alone.
    await product('status-active-only', 'active', false);
    await statusChange('status-active-only', 1, 'temporarily_unavailable', 'active');
    expected['status-active-only'] = false;

    // No evidence: turned on while paused (temporarily_unavailable), still paused.
    await product('on-while-paused', 'temporarily_unavailable', true);
    await statusChange('on-while-paused', 1, 'active', 'temporarily_unavailable');
    await availability('on-while-paused', 2, true);
    expected['on-while-paused'] = false;

    // No evidence: status 'draft' now, even with a row on and an on event.
    await product('status-draft', 'draft', true);
    await availability('status-draft', 1, true);
    expected['status-draft'] = false;

    // No evidence: the delivered audit_logs copy of an "on" intent is dated at delivery. Read as its
    // own event it would put the row on when the product was resumed; the outbox row dates it before
    // the "off", so it is not.
    await product('delivery-copy-trap', 'active', false);
    await statusChange('delivery-copy-trap', 0, 'active', 'temporarily_unavailable');
    const trapKey = await queued(rowIds['delivery-copy-trap'] as string, 1, 'delivered', { productId: productIds['delivery-copy-trap'], isAvailable: true });
    await availability('delivery-copy-trap', 2, false);
    await logged('PRODUCT_BRANCH_AVAILABILITY_CHANGED', 'branch_product_availability', rowIds['delivery-copy-trap'] as string, 3, {
      after: { productId: productIds['delivery-copy-trap'], isAvailable: true, audit_event_id: trapKey, occurred_at: at(1).toISOString() },
    });
    await statusChange('delivery-copy-trap', 4, 'temporarily_unavailable', 'active');
    expected['delivery-copy-trap'] = false;

    // Unknown history: live once (e.g. created on before P34R) with no surviving event — cannot be recovered.
    await product('lost-history', 'active', false);
    expected['lost-history'] = false;

    // Already marked with no evidence left: never cleared.
    await product('already-marked', 'active', false, { everPublished: true });
    expected['already-marked'] = true;
  }, 120_000);

  afterAll(async () => {
    const ids = Object.values(productIds);
    await prisma.auditLog.deleteMany({ where: { id: { in: auditLogIds } } });
    await prisma.auditOutbox.deleteMany({ where: { actorId: userId } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids }, forkedFromProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }, 60_000);

  /** Runs the migration's backfill function (batch size `batchSize`); returns how many products it marked. */
  async function backfill(batchSize: number) {
    const rows = await prisma.$queryRaw<{ marked: number }[]>`SELECT pos_backfill_product_ever_published(${batchSize}::integer) AS marked`;
    return rows[0]?.marked;
  }

  async function markers() {
    const rows = await prisma.product.findMany({ where: { id: { in: Object.values(productIds) } }, select: { id: true, everPublished: true, updatedAt: true, version: true } });
    const label = Object.fromEntries(Object.entries(productIds).map(([l, id]) => [id, l]));
    return Object.fromEntries(rows.map((r) => [label[r.id] as string, r]));
  }

  it('marks exactly the products with surviving evidence, without touching updatedAt or version', async () => {
    const before = await markers();
    const marked = await backfill(3);
    const after = await markers();

    expect(Object.fromEntries(Object.entries(after).map(([l, r]) => [l, r.everPublished]))).toEqual(expected);
    const newlyMarked = Object.keys(expected).filter((l) => expected[l] && !before[l]?.everPublished);
    // The function covers the whole table; this file's products are a subset of what it marked.
    expect(marked).toBeGreaterThanOrEqual(newlyMarked.length);
    for (const l of Object.keys(after)) {
      expect(after[l]?.updatedAt).toEqual(before[l]?.updatedAt);
      expect(after[l]?.version).toBe(before[l]?.version);
    }
  });

  it('is idempotent: a second run marks nothing and clears nothing', async () => {
    const before = await markers();
    const marked = await backfill(500);
    expect(marked).toBe(0);
    expect(await markers()).toEqual(before);
  });
});
