import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PosCatalogResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P69 — the POS catalog's product types against a real Postgres, over
 * HTTP with real tokens: each product's displayed type, the branch's type list
 * (built-ins, then active custom types scoped to the branch, empty ones too),
 * rename, reassignment, deactivation, same-name types at two branches, and
 * that another branch's catalog and types can't be read.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { app } = await import('../../app.js');
const { productTypesService } = await import('../product-types/product-types.service.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!canRunIntegrationTests)('P69 POS product types', () => {
  const tag = randomUUID().slice(0, 8);
  const ids = { branchA: '', branchB: '', supAB: '', supB: '', staffA: '', staffB: '' };
  let server: Server;
  let baseUrl: string;

  async function user(role: 'supervisor' | 'staff', name: string) {
    const row = await prisma.user.create({
      data: { email: `${name}-${tag}@potatocorner.test`, passwordHash: 'unused', role, firstName: 'P69', lastName: name, employmentType: 'regular', mustChangePassword: false },
    });
    return row.id;
  }

  async function sellable(name: string, classification: 'regular' | 'promotional' | 'seasonal', branchId: string, productTypeId: string | null = null) {
    const row = await prisma.product.create({
      data: { name: `P69 ${name} ${tag}`, status: 'active', everPublished: true, classification, isSeasonal: classification === 'seasonal', productTypeId, category: 'Flavored Fries' },
    });
    await prisma.productVariant.create({ data: { productId: row.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 100, isActive: true } });
    await prisma.branchProductAvailability.create({ data: { branchId, productId: row.id, isAvailable: true } });
    return row.id;
  }

  async function catalog(token: string, branchId: string) {
    const response = await fetch(`${baseUrl}/api/products/catalog?branch_id=${branchId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { data: PosCatalogResponse | null };
    return { status: response.status, data: body.data };
  }

  const staffA = () => generateStaffToken(ids.branchA, { userId: ids.staffA });
  const staffB = () => generateStaffToken(ids.branchB, { userId: ids.staffB });
  const typeOf = (data: PosCatalogResponse | null, productId: string) => data?.products.find((p) => p.id === productId)?.product_type;

  beforeAll(async () => {
    ids.supAB = await user('supervisor', 'supab');
    ids.supB = await user('supervisor', 'supb');
    ids.staffA = await user('staff', 'staffa');
    ids.staffB = await user('staff', 'staffb');
    for (const key of ['branchA', 'branchB'] as const) {
      ids[key] = (await prisma.branch.create({ data: { name: `P69 ${key} ${tag}`, code: `P69${key.slice(-1)}-${tag}`, address: '1 Test St', city: 'Testville' } })).id;
    }
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ids.supAB, branchId: ids.branchA },
        { userId: ids.supAB, branchId: ids.branchB },
        { userId: ids.supB, branchId: ids.branchB },
        { userId: ids.staffA, branchId: ids.branchA },
        { userId: ids.staffB, branchId: ids.branchB },
      ],
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('labels built-ins from classification and a custom type by its name, and lists empty custom types', async () => {
    const marketing = await productTypesService.create({ name: `Marketing ${tag}`, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const empty = await productTypesService.create({ name: `Empty ${tag}`, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const promo = await sellable('Cheese Fries PPO', 'promotional', ids.branchA);
    const seasonal = await sellable('Seasonal', 'seasonal', ids.branchA);
    const regular = await sellable('Regular', 'regular', ids.branchA);
    // Promotional underneath, Marketing displayed: listed once, as Marketing.
    const custom = await sellable('Marketing Fries', 'promotional', ids.branchA, marketing.id as string);

    const { status, data } = await catalog(staffA(), ids.branchA);
    expect(status).toBe(200);
    expect(typeOf(data, promo)).toEqual({ key: 'promotional', id: null, name: 'Promotional', is_builtin: true, is_active: true });
    expect(typeOf(data, seasonal)?.key).toBe('seasonal');
    expect(typeOf(data, regular)?.key).toBe('regular');
    expect(typeOf(data, custom)).toEqual({ key: marketing.id, id: marketing.id, name: `Marketing ${tag}`, is_builtin: false, is_active: true });
    // Size stays a separate field: the variant is still "Regular".
    expect(data?.products.find((p) => p.id === promo)?.variants[0]?.name).toBe('Regular');
    expect(data?.product_types?.slice(0, 3).map((t) => t.key)).toEqual(['regular', 'promotional', 'seasonal']);
    expect(data?.product_types?.map((t) => t.id)).toEqual(expect.arrayContaining([marketing.id, empty.id]));
  });

  it('same-name types at two branches stay separate, and branch B sees neither A\'s type nor its products', async () => {
    const name = `Same ${tag}`;
    const typeA = await productTypesService.create({ name, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const typeB = await productTypesService.create({ name, branch_ids: [ids.branchB] }, { id: ids.supB, role: 'supervisor' }, null);
    expect(typeA.id).not.toBe(typeB.id);
    const onlyA = await sellable('A only', 'regular', ids.branchA, typeA.id as string);

    const b = await catalog(staffB(), ids.branchB);
    expect(b.status).toBe(200);
    expect(b.data?.product_types?.filter((t) => t.name === name).map((t) => t.id)).toEqual([typeB.id]);
    expect(b.data?.products.some((p) => p.id === onlyA)).toBe(false);
    expect(JSON.stringify(b.data)).not.toContain(`Marketing ${tag}`);
    const a = await catalog(staffA(), ids.branchA);
    expect(a.data?.product_types?.filter((t) => t.name === name).map((t) => t.id)).toEqual([typeA.id]);
  });

  it('refuses another branch\'s catalog to staff and to a supervisor without that branch', async () => {
    expect((await catalog(staffB(), ids.branchA)).status).toBe(403);
    const supB = generateSupervisorToken([ids.branchB], { userId: ids.supB });
    expect((await catalog(supB, ids.branchA)).status).toBe(403);
  });

  it('a rename and a reassignment show on the next catalog read', async () => {
    const type = await productTypesService.create({ name: `Before ${tag}`, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const productId = await sellable('Renamed', 'regular', ids.branchA, type.id as string);
    await productTypesService.update(type.id as string, { name: `After ${tag}`, expected_version: type.version }, { id: ids.supAB, role: 'supervisor' }, null);
    let data = (await catalog(staffA(), ids.branchA)).data;
    expect(typeOf(data, productId)?.name).toBe(`After ${tag}`);
    expect(data?.product_types?.some((t) => t.name === `Before ${tag}`)).toBe(false);

    await prisma.product.update({ where: { id: productId }, data: { productTypeId: null, classification: 'seasonal', isSeasonal: true } });
    data = (await catalog(staffA(), ids.branchA)).data;
    expect(typeOf(data, productId)).toMatchObject({ key: 'seasonal', is_builtin: true });
  });

  it('deactivation drops the type from the list but keeps its products sellable and labelled', async () => {
    const type = await productTypesService.create({ name: `Retired ${tag}`, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const productId = await sellable('Retired type product', 'regular', ids.branchA, type.id as string);
    await productTypesService.setActive(type.id as string, false, type.version, { id: ids.supAB, role: 'supervisor' }, null);

    const data = (await catalog(staffA(), ids.branchA)).data;
    expect(data?.product_types?.some((t) => t.id === type.id)).toBe(false);
    expect(typeOf(data, productId)).toEqual({ key: type.id, id: type.id, name: `Retired ${tag}`, is_builtin: false, is_active: false });

    await productTypesService.setActive(type.id as string, true, type.version + 1, { id: ids.supAB, role: 'supervisor' }, null);
    expect((await catalog(staffA(), ids.branchA)).data?.product_types?.some((t) => t.id === type.id)).toBe(true);
  });

  it('a draft product is not on the POS, whatever its type', async () => {
    const type = await productTypesService.create({ name: `Draft type ${tag}`, branch_ids: [ids.branchA] }, { id: ids.supAB, role: 'supervisor' }, null);
    const productId = await sellable('Draft', 'regular', ids.branchA, type.id as string);
    await prisma.product.update({ where: { id: productId }, data: { status: 'draft' } });
    const data = (await catalog(staffA(), ids.branchA)).data;
    expect(data?.products.some((p) => p.id === productId)).toBe(false);
    // The type itself is active and scoped here, so its (empty) tab is honest.
    expect(data?.product_types?.some((t) => t.id === type.id)).toBe(true);
  });
});
