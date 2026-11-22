import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * POS-PERF-P69R — catalog-change hints against a real Postgres, over HTTP with
 * real tokens. Socket.io itself is replaced by a recorder (getIO), so this
 * proves which branch rooms each committed write notifies and with what
 * payload; that a socket only ever sits in its own branch room is proven by
 * joinRoomsForUser's tests.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
vi.mock('../../socket/socket.server.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../socket/socket.server.js')>();
  return {
    ...original,
    getIO: () => ({
      to: (room: string | string[]) => ({
        emit: (event: string, payload: unknown) => {
          for (const r of Array.isArray(room) ? room : [room]) emitted.push({ room: r, event, payload });
        },
      }),
    }),
  };
});

const { prisma } = await import('../../lib/prisma.js');
const { app } = await import('../../app.js');
const { flushCatalogChangedForTests } = await import('../../lib/catalog-change-notifier.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

const CATALOG_CHANGED = 'catalog:changed';

describe.skipIf(!canRunIntegrationTests)('P69R catalog-change hints', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', supAB: '', supB: '', staffA: '' };
  let server: Server;
  let baseUrl: string;

  async function user(role: 'supervisor' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P69R', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function sellableAtA(name: string) {
    const row = await prisma.product.create({
      data: { name: `P69R ${name} ${tag}`, status: 'active', everPublished: true, classification: 'regular', category: 'Flavored Fries', createdBy: ids.supAB },
    });
    await prisma.productVariant.create({ data: { productId: row.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true } });
    await prisma.branchProductAvailability.create({ data: { branchId: ids.branchA, productId: row.id, isAvailable: true } });
    return row.id;
  }

  async function call(method: string, path: string, token: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    return { status: response.status, data: json?.data ?? null };
  }

  /** Lets the `finish` lookups settle, then sends whatever was coalesced. */
  async function hints() {
    await new Promise((resolve) => setTimeout(resolve, 100));
    flushCatalogChangedForTests();
    return emitted.filter((e) => e.event === CATALOG_CHANGED);
  }

  const supAB = () => generateSupervisorToken([ids.branchA, ids.branchB], { userId: ids.supAB });
  const supB = () => generateSupervisorToken([ids.branchB], { userId: ids.supB });

  beforeAll(async () => {
    ids.supAB = await user('supervisor', 'supab');
    ids.supB = await user('supervisor', 'supb');
    ids.staffA = await user('staff', 'staffa');
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P69R ${key} ${tag}`, code: `P9R${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    }
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supB, branchId: ids.branchB },
        { userId: ids.staffA, branchId: ids.branchA },
      ],
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    await hints();
    emitted.length = 0;
  });

  it('type create, rename, deactivate and reactivate each hint only the branches in the type scope, with only a branch id', async () => {
    const created = await call('POST', '/api/product-types', supAB(), { name: `Hinted ${tag}`, branch_ids: [ids.branchA] });
    expect(created.status).toBe(201);
    expect(await hints()).toEqual([{ room: `branch:${ids.branchA}`, event: CATALOG_CHANGED, payload: { branch_id: ids.branchA } }]);

    emitted.length = 0;
    const typeId = created.data?.id as string;
    const renamed = await call('PATCH', `/api/product-types/${typeId}`, supAB(), { name: `Hinted2 ${tag}`, expected_version: created.data?.version });
    expect(renamed.status).toBe(200);
    expect((await hints()).map((e) => e.room)).toEqual([`branch:${ids.branchA}`]);

    emitted.length = 0;
    const off = await call('POST', `/api/product-types/${typeId}/deactivate`, supAB(), { expected_version: renamed.data?.version });
    expect(off.status).toBe(200);
    expect((await hints()).map((e) => e.room)).toEqual([`branch:${ids.branchA}`]);

    emitted.length = 0;
    const on = await call('POST', `/api/product-types/${typeId}/reactivate`, supAB(), { expected_version: off.data?.version });
    expect(on.status).toBe(200);
    expect((await hints()).map((e) => e.room)).toEqual([`branch:${ids.branchA}`]);

    emitted.length = 0;
    const widened = await call('PATCH', `/api/product-types/${typeId}`, supAB(), { branch_ids: [ids.branchA, ids.branchB], expected_version: on.data?.version });
    expect(widened.status).toBe(200);
    expect((await hints()).map((e) => e.room).sort()).toEqual([`branch:${ids.branchA}`, `branch:${ids.branchB}`].sort());
  });

  it('a refused write hints nobody', async () => {
    const created = await call('POST', '/api/product-types', supAB(), { name: `Guarded ${tag}`, branch_ids: [ids.branchA] });
    await hints();
    emitted.length = 0;
    const refused = await call('PATCH', `/api/product-types/${created.data?.id as string}`, supB(), { name: `Hijack ${tag}`, expected_version: created.data?.version });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const staffWrite = await call('POST', '/api/product-types', generateStaffToken(ids.branchA, { userId: ids.staffA }), { name: `Staff ${tag}`, branch_ids: [ids.branchA] });
    expect(staffWrite.status).toBe(403);
    expect(await hints()).toEqual([]);
  });

  it('reassigning a product to a type hints the branches that list the product, not other branches', async () => {
    const type = await call('POST', '/api/product-types', supAB(), { name: `Assign ${tag}`, branch_ids: [ids.branchA] });
    const productId = await sellableAtA('Reassigned');
    await hints();
    emitted.length = 0;

    const patched = await call('PATCH', `/api/products/${productId}`, supAB(), { product_type: type.data?.id });
    expect(patched.status).toBe(200);
    expect(await hints()).toEqual([{ room: `branch:${ids.branchA}`, event: CATALOG_CHANGED, payload: { branch_id: ids.branchA } }]);
  });

  it('a burst of product writes is one hint per branch, and reads hint nothing', async () => {
    const productId = await sellableAtA('Burst');
    await hints();
    emitted.length = 0;

    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => call('PATCH', `/api/products/${productId}`, supAB(), { description: `burst ${i}` })));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    await call('GET', `/api/products/catalog?branch_id=${ids.branchA}`, generateStaffToken(ids.branchA, { userId: ids.staffA }));
    expect((await hints()).map((e) => e.room)).toEqual([`branch:${ids.branchA}`]);
  });
});
