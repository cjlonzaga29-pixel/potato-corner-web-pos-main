import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createProductSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P38R2 — opt-in measurement (PUBLICATION_BUDGET_MEASURE=1, local
 * Postgres only) of the publication transaction: SQL statements and elapsed
 * time per publish, by branches and components, first publish vs repeat,
 * optionally through a TCP proxy that adds PUBLICATION_BUDGET_RTT_MS of
 * round-trip latency to every database packet. Prints a table; asserts
 * nothing about time. Results: docs/runbooks/pos-perf-p38-automatic-branch-setup.md (P38R2).
 *
 * Optional: PUBLICATION_BUDGET_POOL (connection_limit, default 5),
 * PUBLICATION_BUDGET_CONCURRENCY (concurrent publishes, default 4), and
 * PUBLICATION_BUDGET_DUMP=<scenario><pass> (e.g. S3repeat) with
 * PUBLICATION_BUDGET_DUMP_FILE to write that publish's SQL.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);
const enabled = isLocalDatabase && process.env.PUBLICATION_BUDGET_MEASURE === '1';
const rttMs = Number(process.env.PUBLICATION_BUDGET_RTT_MS ?? '0');
const PROXY_PORT = 55432;

/** Forwards to the real local Postgres, delaying each chunk by half the RTT in each direction (order preserved). */
function startLatencyProxy(target: URL, oneWayMs: number) {
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    const pipe = (from: net.Socket, to: net.Socket) =>
      from.on('data', (chunk) => setTimeout(() => to.writable && to.write(chunk), oneWayMs));
    pipe(client, upstream);
    pipe(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  return new Promise<net.Server>((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}

const queryLog: { query: string; duration: number }[] = [];
let lastLog: { query: string; duration: number }[] = [];

vi.mock('../../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { immutabilityMiddleware } = await import('../../lib/prisma-immutability.js');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.PUBLICATION_BUDGET_MEASURE === '1' && Number(process.env.PUBLICATION_BUDGET_RTT_MS ?? '0') > 0) {
    url.hostname = '127.0.0.1';
    url.port = '55432'; // PROXY_PORT; vi.mock factories are hoisted above module constants.
  }
  // Production's pool size (db-round-trip-diagnostics: "the same 5-connection pool").
  url.searchParams.set('connection_limit', process.env.PUBLICATION_BUDGET_POOL ?? '5');
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (e) => queryLog.push({ query: e.query, duration: e.duration }));
  client.$use(immutabilityMiddleware);
  return { prisma: client, disconnectPrisma: () => client.$disconnect() };
});

describe.skipIf(!enabled)('POS-PERF-P38R2 publication transaction budget (measurement)', () => {
  let proxy: net.Server | null = null;
  let prisma: typeof import('../../lib/prisma.js')['prisma'];
  let productsService: typeof import('./products.service.js')['productsService'];
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];
  const unitIds: string[] = [];
  const flavorIds: string[] = [];
  const optionGroupIds: string[] = [];
  let supervisor: { id: string; role: string };
  let gramId: string;
  let pieceId: string;
  let kgId: string;
  const rows: Record<string, string | number>[] = [];

  async function makeBranch(label: string) {
    const branch = await prisma.branch.create({
      data: { name: `P38R2 ${label} ${suffix}`, code: `P38R2${label}-${suffix}`, address: 'Test', city: 'Test' },
    });
    branchIds.push(branch.id);
    await prisma.userBranchAssignment.create({ data: { userId: supervisor.id, branchId: branch.id } });
    return branch.id;
  }

  async function makeItem(label: string, baseUnitId: string) {
    const item = await prisma.inventoryItem.create({ data: { name: `P38R2 ${label} ${suffix}`, baseUnitId } });
    itemIds.push(item.id);
    return item.id;
  }

  /**
   * sizes × (ingredients + packaging) base components, `flavors` flavors per
   * size each with one flavor-specific seasoning, and `groups` option groups
   * of `options` options each mapped to its own inventory item.
   */
  async function makeProduct(label: string, selection: string[], shape: { sizes: number; ingredients: number; packaging: number; flavors: number; groups: number; options: number }) {
    const ingredients = await Promise.all(Array.from({ length: shape.ingredients }, (_, i) => makeItem(`${label} Ing ${i}`, gramId)));
    const packaging = await Promise.all(Array.from({ length: shape.packaging }, (_, i) => makeItem(`${label} Pack ${i}`, pieceId)));
    // One kg-entered ingredient with an item-specific conversion, so the conversion lookup runs.
    const kgItem = await makeItem(`${label} Kg`, gramId);
    await prisma.inventoryItemUnitConversion.create({ data: { inventoryItemId: kgItem, fromUnitId: kgId, toUnitId: gramId, factor: 1000 } });
    const flavors = [];
    for (let i = 0; i < shape.flavors; i++) {
      const flavor = await prisma.flavor.create({ data: { name: `P38R2 ${label} F${i} ${suffix}`, ingredientName: 'Powder', ingredientUnit: 'g' } });
      flavorIds.push(flavor.id);
      flavors.push({ id: flavor.id, powder: await makeItem(`${label} Powder ${i}`, gramId) });
    }
    const groups = [];
    for (let g = 0; g < shape.groups; g++) {
      const group = await prisma.productOptionGroup.create({
        data: { code: `p38r2-${label}-${g}-${suffix}`, name: `Group ${g}`, selectionType: 'SINGLE', required: g === 0, minSelections: g === 0 ? 1 : 0 },
      });
      optionGroupIds.push(group.id);
      for (let o = 0; o < shape.options; o++) {
        const option = await prisma.productOption.create({ data: { optionGroupId: group.id, code: `o${o}`, name: `Option ${o}` } });
        const mapped = await makeItem(`${label} Opt ${g}-${o}`, gramId);
        await prisma.productOptionInventoryMapping.create({ data: { productOptionId: option.id, inventoryItemId: mapped, quantityRequired: 10, deductionUnitId: gramId } });
      }
      groups.push(group.id);
    }

    const created = await productsService.createProduct(
      createProductSchema.parse({ name: `P38R2 ${label} ${suffix}`, status: 'active', branch_ids: selection }),
      supervisor,
      null,
    );
    for (let s = 0; s < shape.sizes; s++) {
      const variant = await prisma.productVariant.create({
        data: { productId: created.id, name: `Size ${s}`, sizeLabel: `S${s}`, basePrice: 50 + s * 10, isActive: true, lifecycleStatus: 'ACTIVE' },
      });
      await prisma.productComponent.createMany({
        data: [
          ...ingredients.map((id) => ({ productVariantId: variant.id, inventoryItemId: id, quantityRequired: 100, recipeUnitId: gramId })),
          ...packaging.map((id) => ({ productVariantId: variant.id, inventoryItemId: id, quantityRequired: 1, recipeUnitId: pieceId })),
          { productVariantId: variant.id, inventoryItemId: kgItem, quantityRequired: 0.05, recipeUnitId: kgId },
          ...flavors.map((f) => ({ productVariantId: variant.id, inventoryItemId: f.powder, quantityRequired: 5, recipeUnitId: gramId, flavorId: f.id })),
        ],
      });
      for (const f of flavors) await prisma.productVariantFlavor.create({ data: { productVariantId: variant.id, flavorId: f.id, isAvailable: true } });
      for (const groupId of groups) await prisma.productVariantOptionGroup.create({ data: { productVariantId: variant.id, optionGroupId: groupId } });
    }
    const componentCount = shape.sizes * (shape.ingredients + shape.packaging + 1 + shape.flavors);
    const distinctItems = shape.ingredients + shape.packaging + 1 + shape.flavors + shape.groups * shape.options;
    return { productId: created.id, componentCount, distinctItems };
  }

  /** Wraps one publish: statements, elapsed of the whole call and of the transaction (BEGIN..COMMIT). */
  async function measure(run: () => Promise<unknown>) {
    const originalTx = prisma.$transaction.bind(prisma);
    let txMs = 0;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: Parameters<typeof prisma.$transaction>) => {
      const start = performance.now();
      return (originalTx as (...a: unknown[]) => Promise<unknown>)(...args).finally(() => { txMs = performance.now() - start; });
    }) as typeof prisma.$transaction);
    queryLog.length = 0;
    const start = performance.now();
    let error: string | null = null;
    try {
      await run();
    } catch (e) {
      error = (e as { code?: string }).code ?? (e as Error).message.slice(0, 80);
    } finally {
      spy.mockRestore();
    }
    const totalMs = performance.now() - start;
    lastLog = [...queryLog];
    const statements = queryLog.filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(q.query)).length;
    const auditInserts = queryLog.filter((q) => /INSERT INTO "public"\."audit_logs"/.test(q.query)).length;
    const intentInserts = queryLog.filter((q) => /INSERT INTO "public"\."audit_outbox"/.test(q.query)).length;
    const lockWait = queryLog.find((q) => q.query.includes('pg_advisory_xact_lock'))?.duration ?? 0;
    const begin = queryLog.findIndex((q) => q.query.startsWith('BEGIN'));
    const end = queryLog.findIndex((q) => /^(COMMIT|ROLLBACK)/.test(q.query));
    const inTx = begin >= 0 && end > begin ? end - begin - 1 : 0;
    return { statements, inTx, auditInserts, intentInserts, txMs: Math.round(txMs), totalMs: Math.round(totalMs), lockWait, error };
  }

  beforeAll(async () => {
    if (rttMs > 0) proxy = await startLatencyProxy(new URL(databaseUrl), rttMs / 2);
    ({ prisma } = await import('../../lib/prisma.js'));
    ({ productsService } = await import('./products.service.js'));
    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P38R2', lastName: 'Sup', employmentType: 'regular', email: `p38r2-sup-${suffix}@test.local` },
    });
    userIds.push(user.id);
    supervisor = { id: user.id, role: 'supervisor' };
    gramId = (await prisma.unitOfMeasure.create({ data: { code: `p38r2-g-${suffix}`, name: 'P38R2 g', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    pieceId = (await prisma.unitOfMeasure.create({ data: { code: `p38r2-pc-${suffix}`, name: 'P38R2 pc', dimension: 'COUNT', isBaseUnit: true } })).id;
    kgId = (await prisma.unitOfMeasure.create({ data: { code: `p38r2-kg-${suffix}`, name: 'P38R2 kg', dimension: 'WEIGHT' } })).id;
    unitIds.push(gramId, pieceId, kgId);
  }, 600_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.table(rows);
    const productIds = (await prisma.product.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.productComponent.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantFlavor.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariantOptionGroup.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productOptionInventoryMapping.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.productOption.deleteMany({ where: { optionGroupId: { in: optionGroupIds } } });
    await prisma.productOptionGroup.deleteMany({ where: { id: { in: optionGroupIds } } });
    await prisma.branchProductAvailability.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productChangeLog.deleteMany({ where: { productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.branchFlavorAvailability.deleteMany({ where: { flavorId: { in: flavorIds } } });
    await prisma.flavor.deleteMany({ where: { id: { in: flavorIds } } });
    await prisma.inventoryStock.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItemUnitConversion.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditOutbox.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.branch.updateMany({ where: { id: { in: branchIds } }, data: { status: 'inactive' } });
    await prisma.$disconnect();
    proxy?.close();
  }, 600_000);

  const scenarios = [
    { label: 'S1', branches: 1, shape: { sizes: 1, ingredients: 1, packaging: 1, flavors: 0, groups: 0, options: 0 } },
    { label: 'S2', branches: 2, shape: { sizes: 2, ingredients: 2, packaging: 2, flavors: 2, groups: 1, options: 3 } },
    { label: 'S3', branches: 4, shape: { sizes: 3, ingredients: 3, packaging: 3, flavors: 4, groups: 2, options: 4 } },
    { label: 'S4', branches: 8, shape: { sizes: 3, ingredients: 3, packaging: 3, flavors: 4, groups: 2, options: 4 } },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.label}: ${scenario.branches} branch(es)`, async () => {
      const selection: string[] = [];
      for (let b = 0; b < scenario.branches; b++) selection.push(await makeBranch(`${scenario.label}${b}`));
      const product = await makeProduct(scenario.label, selection, scenario.shape);
      for (const pass of ['first', 'repeat'] as const) {
        const result = await measure(() => productsService.publishProductToBranches(product.productId, selection, supervisor, null));
        rows.push({
          scenario: scenario.label,
          rtt: rttMs,
          branches: scenario.branches,
          components: product.componentCount,
          items: product.distinctItems,
          pass,
          links: pass === 'first' ? scenario.branches * product.distinctItems : 0,
          statements: result.statements,
          inTx: result.inTx,
          audits: result.auditInserts,
          intents: result.intentInserts,
          txMs: result.txMs,
          totalMs: result.totalMs,
          error: result.error ?? '',
        });
        if (rttMs === 0) expect(result.error).toBeNull();
        // POS-PERF-P38R4 — the audit entries are delivered by the outbox worker, outside the request: time that separately.
        const pending = await prisma.auditOutbox.findMany({ where: { actorId: supervisor.id, status: 'pending' }, select: { groupId: true } });
        if (pending.length > 0) {
          const { runAuditOutboxCycle } = await import('../audit-outbox/audit-outbox.worker.js');
          const delivery = await measure(() => runAuditOutboxCycle({ groupIds: [...new Set(pending.map((r) => r.groupId))], batchSize: 1000 }));
          rows.push({
            scenario: scenario.label,
            rtt: rttMs,
            branches: scenario.branches,
            components: product.componentCount,
            items: product.distinctItems,
            pass: `${pass}: worker delivery (${pending.length} entries)`,
            links: '',
            statements: delivery.statements,
            inTx: delivery.inTx,
            audits: delivery.auditInserts,
            intents: '',
            txMs: delivery.txMs,
            totalMs: delivery.totalMs,
            error: delivery.error ?? '',
          });
        }
        if (process.env.PUBLICATION_BUDGET_DUMP === scenario.label + pass) {
          const fs = await import('node:fs');
          fs.writeFileSync(process.env.PUBLICATION_BUDGET_DUMP_FILE ?? 'dump.txt', lastLog.map((q) => q.query.replace(/\s+/g, ' ').slice(0, 220)).join('\n'));
        }
      }
    }, 600_000);
  }

  it('concurrent publication of one product (product-lock contention)', async () => {
    const shape = { sizes: 3, ingredients: 3, packaging: 3, flavors: 4, groups: 2, options: 4 };
    const branches: string[] = [];
    for (let b = 0; b < Number(process.env.PUBLICATION_BUDGET_CONCURRENCY ?? '4'); b++) branches.push(await makeBranch(`C${b}`));
    const product = await makeProduct('C', branches, shape);
    queryLog.length = 0;
    const started = performance.now();
    const outcomes = await Promise.all(
      branches.map(async (branchId) => {
        const t = performance.now();
        try {
          await productsService.publishProduct(product.productId, branchId, supervisor, null);
          return { ok: true, ms: Math.round(performance.now() - t), error: '' };
        } catch (e) {
          return { ok: false, ms: Math.round(performance.now() - t), error: (e as { code?: string }).code ?? (e as Error).message.slice(0, 100) };
        }
      }),
    );
    const lockWaits = queryLog.filter((q) => q.query.includes('pg_advisory_xact_lock')).map((q) => q.duration);
    outcomes.forEach((o, i) =>
      rows.push({ scenario: 'CONC', rtt: rttMs, branches: 1, components: product.componentCount, items: product.distinctItems, pass: `parallel #${i}`, links: '', statements: '', audits: '', txMs: o.ms, totalMs: Math.round(performance.now() - started), error: o.error || `lock wait ${lockWaits[i] ?? '?'}ms` }),
    );
  }, 600_000);
});
