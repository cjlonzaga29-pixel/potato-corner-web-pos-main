import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';

/**
 * POS-PERF-P57 — through the real Express app against a real Postgres:
 *
 *   - recipe shortages: positive stock too small for a serving, with unit
 *     conversions, reservations, sizes with different needs, alternative
 *     flavors and add-ons, unique items, setup separated from stock, refresh
 *     after stock and recipe changes, branch isolation;
 *   - no built-in discounts: a branch with no types lists none;
 *   - fixed and staff-entered amounts, the cap, forged overrides, changed
 *     settings, old and offline payloads, idempotent replay, proof;
 *   - multi-branch types and product eligibility, mixed carts, forged ids;
 *   - a statutory-looking name stays an ordinary manual discount;
 *   - the product type filter.
 *
 * Supabase Storage is replaced by an in-memory bucket here; the browser pass
 * uses real local Storage.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => ({ data: { path }, error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `http://storage.test/${bucket}/${path}?token=t` }, error: null }),
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `http://storage.test/${path}`, error: null })), error: null }),
      }),
    },
  },
}));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type ApiBody = { data: Record<string, unknown> | null; error: { code: string; message?: string; details?: unknown } | null };
interface Affected {
  product_name: string;
  variant_name: string;
  choice_name: string | null;
  choice_kind: string | null;
  required: number;
  deficit: number;
  blocks_size: boolean;
}
interface Shortage {
  required: number;
  deficit: number;
  unit_code: string;
  affected: Affected[];
}
interface StockRow {
  inventory_item_id: string;
  name: string;
  status: string;
  low_stock_threshold: number | null;
  critical_threshold: number | null;
  recipe_shortage: Shortage | null;
}
interface AlertBody {
  alerts: { inventory_item_id: string; recipe_shortage: Shortage | null }[];
  recipe_shortages: { inventory_item_id: string; quantity_available: number; recipe_shortage: Shortage }[];
  setup_issues: { inventory_item_id: string; reason: string; product_name: string }[];
}

describe.skipIf(!isLocalDatabase)('P57 recipe shortages and discount amount modes (real Express + Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  const branch = { a: '', b: '', c: '', empty: '' };
  const items: Record<string, string> = {};
  const products: Record<string, { id: string; variants: Record<string, string> }> = {};
  const tokens = { ana: '', cara: '', supAB: '', supB: '', forged: '', emptyStaff: '' };
  const users: Record<string, string> = {};
  let unitG = '';
  let unitKg = '';
  let server: Server;
  let baseUrl = '';
  let png: Buffer;
  let setupSucceeded = false;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p57-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as ApiBody };
  }

  async function uploadProof(token: string, branchId: string) {
    const form = new FormData();
    form.set('branch_id', branchId);
    form.set('type', 'live_capture');
    form.set('proof', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'id.png');
    const res = await fetch(`${baseUrl}/api/transactions/discount-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()) as ApiBody;
  }

  async function makeItem(key: string, stock: Record<string, { onHand: number; reserved?: number; low?: number } | null>, track = true) {
    const id = (await prisma.inventoryItem.create({ data: { name: `P57 ${key} ${tag}`, baseUnitId: unitG, trackInventory: track } })).id;
    items[key] = id;
    for (const [branchId, level] of Object.entries(stock)) {
      if (!level) continue;
      await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: id, quantityOnHand: level.onHand, quantityReserved: level.reserved ?? 0, lowStockThreshold: level.low ?? null } });
    }
    return id;
  }

  async function makeProduct(key: string, sizes: Record<string, { price: number; recipe: { item: string; quantity: number; unitId?: string; flavorId?: string }[] }>, available: string[], classification: 'regular' | 'promotional' | 'seasonal' = 'regular') {
    const id = (await prisma.product.create({ data: { name: `P57 ${key} ${tag}`, status: 'active', classification, everPublished: true } })).id;
    const variants: Record<string, string> = {};
    for (const [size, spec] of Object.entries(sizes)) {
      const variant = await prisma.productVariant.create({ data: { productId: id, name: size, sizeLabel: size, basePrice: spec.price, isActive: true, lifecycleStatus: 'ACTIVE' } });
      variants[size] = variant.id;
      for (const line of spec.recipe) {
        await prisma.productComponent.create({
          data: { productVariantId: variant.id, inventoryItemId: items[line.item] as string, quantityRequired: line.quantity, recipeUnitId: line.unitId ?? null, flavorId: line.flavorId ?? null },
        });
      }
    }
    for (const branchId of available) await prisma.branchProductAvailability.create({ data: { branchId, productId: id, isAvailable: true } });
    products[key] = { id, variants };
    return products[key];
  }

  const alertsOf = async (branchId: string, token = tokens.supAB) => (await call('GET', `/api/branches/${branchId}/inventory-stock/alerts`, token)).body.data as unknown as AlertBody;
  const rowsOf = async (branchId: string, token = tokens.supAB) => ((await call('GET', `/api/branches/${branchId}/inventory-stock`, token)).body.data as unknown as { items: StockRow[] }).items;
  const shortageOf = async (key: string, branchId = branch.a) => (await rowsOf(branchId)).find((row) => row.inventory_item_id === items[key])?.recipe_shortage ?? null;

  const line = (productKey: string, size: string, quantity = 1) => ({ product_id: products[productKey]?.id, product_variant_id: products[productKey]?.variants[size], quantity, promotion: null });
  const BASIS = { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null };

  function sale(token: string, branchId: string, saleItems: unknown[], manual?: Record<string, unknown>, key: string = randomUUID()) {
    return call('POST', '/api/transactions', token, {
      branch_id: branchId,
      items: saleItems,
      payment_method: 'cash',
      cash_tendered: 100000,
      is_offline_transaction: false,
      idempotency_key: key,
      tax_basis: BASIS,
      discount_flow: 'manual_v1',
      discount_choice: manual ? 'selected' : 'none_applicable',
      ...(manual ? { discount_type: 'manual', manual_discount: manual } : {}),
    });
  }

  const createType = (token: string, body: Record<string, unknown>) => call('POST', '/api/discounts/manual-types', token, { apply_to_pos: true, require_proof: false, ...body });
  const posTypes = async (token: string, branchId: string) =>
    ((await call('GET', `/api/discounts/manual-types/pos?branch_id=${branchId}&capabilities=amount_modes_v1`, token)).body.data as unknown as { id: string; name: string; version: number; amount_mode: string; fixed_amount: number | null; product_ids: string[] }[]);

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const key of ['a', 'b', 'c', 'empty'] as const) {
      branch[key] = (await prisma.branch.create({ data: { name: `P57 ${key} ${tag}`, code: `P57${key}-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    }
    const mk = async (role: 'staff' | 'supervisor', first: string) =>
      (
        await prisma.user.create({
          data: { role, firstName: first, lastName: `P57${tag}`, email: `${first.toLowerCase()}-${tag}@p57.test`, employeeId: role === 'staff' ? `P57-${first}-${tag}` : null, employmentType: 'regular', mustChangePassword: false },
        })
      ).id;
    for (const name of ['Ana', 'Cara', 'Ella']) users[name] = await mk('staff', name);
    for (const name of ['SupAB', 'SupB', 'Forged']) users[name] = await mk('supervisor', name);
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: users.Ana as string, branchId: branch.a },
        { userId: users.Cara as string, branchId: branch.b },
        { userId: users.Ella as string, branchId: branch.empty },
        { userId: users.SupAB as string, branchId: branch.a },
        { userId: users.SupAB as string, branchId: branch.b },
        { userId: users.SupB as string, branchId: branch.b },
        { userId: users.Forged as string, branchId: branch.b },
      ],
    });
    for (const [name, branchId] of [['Ana', branch.a], ['Cara', branch.b], ['Ella', branch.empty]] as const) {
      await prisma.attendanceRecord.create({ data: { employeeId: users[name] as string, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    }
    tokens.ana = generateStaffToken(branch.a, { userId: users.Ana as string });
    tokens.cara = generateStaffToken(branch.b, { userId: users.Cara as string });
    tokens.emptyStaff = generateStaffToken(branch.empty, { userId: users.Ella as string });
    tokens.supAB = generateSupervisorToken([branch.a, branch.b], { userId: users.SupAB as string });
    tokens.supB = generateSupervisorToken([branch.b], { userId: users.SupB as string });
    // Forged claim: the JWT says A and B, the live assignment is B only.
    tokens.forged = generateSupervisorToken([branch.a, branch.b], { userId: users.Forged as string });

    unitG = (await prisma.unitOfMeasure.create({ data: { code: `p57-g-${tag}`, name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    unitKg = (await prisma.unitOfMeasure.create({ data: { code: `p57-kg-${tag}`, name: 'Kilogram', dimension: 'WEIGHT', isBaseUnit: false } })).id;
    await prisma.unitConversion.create({ data: { fromUnitId: unitKg, toUnitId: unitG, factor: 1000 } });

    const plenty = { onHand: 1_000_000 };
    await makeItem('rawFries', { [branch.a]: { onHand: 12 }, [branch.b]: { onHand: 500 } });
    await makeItem('chickenPops', { [branch.a]: { onHand: 40 }, [branch.b]: { onHand: 500 } });
    await makeItem('reservedOil', { [branch.a]: { onHand: 100, reserved: 90 }, [branch.b]: plenty });
    await makeItem('thresholdSalt', { [branch.a]: { onHand: 500, low: 1000 }, [branch.b]: plenty });
    await makeItem('sized', { [branch.a]: { onHand: 30 }, [branch.b]: plenty });
    await makeItem('kgFlour', { [branch.a]: { onHand: 300 }, [branch.b]: plenty });
    await makeItem('base', { [branch.a]: plenty, [branch.b]: plenty });
    await makeItem('cheese', { [branch.a]: { onHand: 5 }, [branch.b]: plenty });
    await makeItem('bbq', { [branch.a]: { onHand: 50 }, [branch.b]: plenty });
    await makeItem('mayo', { [branch.a]: { onHand: 3 }, [branch.b]: plenty });
    await makeItem('offProduct', { [branch.a]: { onHand: 1 }, [branch.b]: plenty });
    await makeItem('unassigned', { [branch.b]: plenty });
    await makeItem('untracked', { [branch.a]: { onHand: 1 }, [branch.b]: plenty }, false);
    await makeItem('plenty', { [branch.a]: plenty, [branch.b]: plenty });

    const ab = [branch.a, branch.b];
    await makeProduct('Fries', { Regular: { price: 50, recipe: [{ item: 'rawFries', quantity: 20 }] }, Large: { price: 70, recipe: [{ item: 'rawFries', quantity: 40 }] } }, ab);
    await makeProduct('Pops', { Regular: { price: 60, recipe: [{ item: 'chickenPops', quantity: 70 }] } }, ab);
    await makeProduct('Reserved', { Regular: { price: 60, recipe: [{ item: 'reservedOil', quantity: 20 }] } }, ab);
    await makeProduct('Salted', { Regular: { price: 60, recipe: [{ item: 'thresholdSalt', quantity: 1 }] } }, ab);
    await makeProduct('Sized', { Small: { price: 30, recipe: [{ item: 'sized', quantity: 20 }] }, Big: { price: 90, recipe: [{ item: 'sized', quantity: 50 }] } }, ab);
    await makeProduct('Bread', { Regular: { price: 40, recipe: [{ item: 'kgFlour', quantity: 0.5, unitId: unitKg }] } }, ab);
    await makeProduct('Off', { Regular: { price: 40, recipe: [{ item: 'offProduct', quantity: 10 }] } }, []);
    await prisma.branchProductAvailability.createMany({ data: ab.map((branchId) => ({ branchId, productId: products.Off?.id as string, isAvailable: false })) });
    await makeProduct('NoRecipe', { Regular: { price: 40, recipe: [] } }, ab);
    await makeProduct('Unassigned', { Regular: { price: 40, recipe: [{ item: 'unassigned', quantity: 1 }] } }, ab);
    await makeProduct('Untracked', { Regular: { price: 40, recipe: [{ item: 'untracked', quantity: 10 }] } }, ab);
    await makeProduct('Plain', { Regular: { price: 100, recipe: [{ item: 'plenty', quantity: 1 }] } }, [...ab, branch.empty], 'promotional');
    await makeProduct('Other', { Regular: { price: 30, recipe: [{ item: 'plenty', quantity: 1 }] } }, [...ab, branch.empty], 'seasonal');
    await prisma.inventoryStock.create({ data: { branchId: branch.empty, inventoryItemId: items.plenty as string, quantityOnHand: 1_000_000 } });

    // Alternative flavors: Cheese needs 10 (5 available), BBQ needs 10 (50 available).
    const cheese = await prisma.flavor.create({ data: { name: `P57 Cheese ${tag}`, ingredientName: 'x', ingredientUnit: 'g', isActive: true } });
    const bbq = await prisma.flavor.create({ data: { name: `P57 BBQ ${tag}`, ingredientName: 'x', ingredientUnit: 'g', isActive: true } });
    const flavored = await makeProduct('Flavored', { Regular: { price: 55, recipe: [{ item: 'base', quantity: 1 }, { item: 'cheese', quantity: 10, flavorId: cheese.id }, { item: 'bbq', quantity: 10, flavorId: bbq.id }] } }, ab);
    for (const flavorId of [cheese.id, bbq.id]) await prisma.productVariantFlavor.create({ data: { productVariantId: flavored.variants.Regular as string, flavorId, isAvailable: true } });

    // An optional add-on using 10 of an item with 3 available.
    const group = await prisma.productOptionGroup.create({ data: { code: `p57-g-${tag}`, name: 'Sauce', selectionType: 'SINGLE', required: false, minSelections: 0, isActive: true } });
    const option = await prisma.productOption.create({ data: { optionGroupId: group.id, code: `p57-o-${tag}`, name: 'Mayo', isActive: true } });
    await prisma.productOptionInventoryMapping.create({ data: { productOptionId: option.id, inventoryItemId: items.mayo as string, quantityRequired: 10, deductionUnitId: unitG } });
    await prisma.productVariantOptionGroup.create({ data: { productVariantId: products.Plain?.variants.Regular as string, optionGroupId: group.id } });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!setupSucceeded) return;
    const branches = Object.values(branch);
    await prisma.discountProofUpload.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ANY(${branches}))`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ANY(${branches})`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ANY(${branches})`;
    await prisma.manualDiscountType.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branches } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: branches } } });
  });

  it('reproduction: 12 g with 20 g needed and 40 g with 70 g needed are alerts, with no threshold invented', async () => {
    const rows = await rowsOf(branch.a);
    const fries = rows.find((row) => row.inventory_item_id === items.rawFries);
    expect(fries).toMatchObject({ status: 'healthy', low_stock_threshold: null, critical_threshold: null });
    expect(fries?.recipe_shortage?.unit_code).toBe(`p57-g-${tag}`);
    expect(fries?.recipe_shortage?.affected.find((a) => a.variant_name === 'Regular')).toMatchObject({ required: 20, deficit: 8, blocks_size: true });

    const alerts = await alertsOf(branch.a);
    const pops = alerts.recipe_shortages.find((row) => row.inventory_item_id === items.chickenPops);
    expect(pops).toMatchObject({ quantity_available: 40, recipe_shortage: { required: 70, deficit: 30 } });
    // Older clients match `alerts` against their rows, which still call these healthy.
    expect(alerts.alerts.some((row) => row.inventory_item_id === items.rawFries)).toBe(false);
    expect((await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: branch.a, inventoryItemId: items.rawFries as string } })).lowStockThreshold).toBeNull();

    // The POS blocks the same sizes for the same reason.
    const catalog = (await call('GET', `/api/products/catalog?branch_id=${branch.a}`, tokens.ana)).body.data as unknown as { products: { id: string; variants: { name: string; stock_status: string }[] }[] };
    const friesCard = catalog.products.find((product) => product.id === products.Fries?.id);
    expect(friesCard?.variants.map((v) => v.stock_status)).toEqual(['out_of_stock', 'out_of_stock']);
  });

  it('unique items, sizes, conversions and reservations', async () => {
    const alerts = await alertsOf(branch.a);
    // Two sizes of Fries are affected; the item is one alert.
    expect(alerts.recipe_shortages.filter((row) => row.inventory_item_id === items.rawFries)).toHaveLength(1);
    const fries = await shortageOf('rawFries');
    expect(fries).toMatchObject({ required: 40, deficit: 28 });
    expect(fries?.affected.map((a) => a.variant_name).sort()).toEqual(['Large', 'Regular']);

    // 30 available: Small (20) sells, only Big (50) is affected.
    const sized = await shortageOf('sized');
    expect(sized?.affected.map((a) => [a.variant_name, a.required, a.deficit])).toEqual([['Big', 50, 20]]);

    // 0.5 kg recipe against 300 g in stock.
    expect(await shortageOf('kgFlour')).toMatchObject({ required: 500, deficit: 200 });

    // On hand 100, reserved 90: judged on the 10 available.
    expect(await shortageOf('reservedOil')).toMatchObject({ required: 20, deficit: 10 });

    // At a threshold and short of a serving: stays in `alerts`, with the shortage on it, once.
    const salted = await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: branch.a, inventoryItemId: items.thresholdSalt as string } });
    expect(salted.lowStockThreshold?.toNumber()).toBe(1000);
    const saltAlert = alerts.alerts.find((row) => row.inventory_item_id === items.thresholdSalt);
    expect(saltAlert?.recipe_shortage).toBeNull();
    expect(alerts.recipe_shortages.some((row) => row.inventory_item_id === items.thresholdSalt)).toBe(false);
  });

  it('alternatives: mutually exclusive flavors and add-ons are never summed', async () => {
    // Cheese is short for its own flavor (10), not 20 across flavors; BBQ still sells.
    const cheese = await shortageOf('cheese');
    expect(cheese?.affected).toHaveLength(1);
    expect(cheese?.affected[0]).toMatchObject({ choice_kind: 'flavor', required: 10, deficit: 5, blocks_size: false });
    expect(cheese?.affected[0]?.choice_name).toContain('Cheese');
    expect(await shortageOf('bbq')).toBeNull();
    expect(await shortageOf('base')).toBeNull();

    // An optional add-on is reported without blocking the size.
    const mayo = await shortageOf('mayo');
    expect(mayo?.affected[0]).toMatchObject({ choice_kind: 'option', choice_name: 'Mayo', required: 10, blocks_size: false });
  });

  it('setup and manual deactivation are kept apart from shortages', async () => {
    const alerts = await alertsOf(branch.a);
    // Turned off by a supervisor: not a shortage.
    expect(await shortageOf('offProduct')).toBeNull();
    // No recipe: a setup problem on the product, no item involved.
    expect(alerts.setup_issues.some((issue) => issue.product_name.includes('NoRecipe'))).toBe(false);
    // Not assigned here, or untracked but still needed: setup, never a stock alert.
    // (A product whose item has no stock row fails readiness first, so its setup problem is reported by Products.)
    expect(alerts.recipe_shortages.some((row) => row.inventory_item_id === items.unassigned)).toBe(false);
    expect(alerts.setup_issues.find((issue) => issue.inventory_item_id === items.untracked)?.reason).toBe('untracked');
    expect(alerts.recipe_shortages.some((row) => row.inventory_item_id === items.untracked)).toBe(false);
    expect((await rowsOf(branch.a)).some((row) => row.inventory_item_id === items.untracked)).toBe(false);
  });

  it('results follow stock and recipe changes, and stay inside the branch', async () => {
    // Branch B has plenty of everything, so it has no alerts from these items.
    const alertsB = await alertsOf(branch.b);
    expect(alertsB.recipe_shortages.some((row) => row.inventory_item_id === items.rawFries)).toBe(false);

    // Forged ids and other branches.
    expect((await call('GET', `/api/branches/${branch.a}/inventory-stock/alerts`, tokens.supB)).status).toBe(403);
    expect((await call('GET', `/api/branches/${branch.a}/inventory-stock/alerts`, tokens.forged)).status).toBe(403);
    expect((await call('GET', `/api/branches/${branch.a}/inventory-stock`, tokens.cara)).status).toBe(403);

    // Stock arrives: 12 → 25 clears Regular (20) and leaves Large (40).
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: branch.a, inventoryItemId: items.rawFries as string } }, data: { quantityOnHand: 25 } });
    expect((await shortageOf('rawFries'))?.affected.map((a) => a.variant_name)).toEqual(['Large']);

    // The recipe changes: Pops now needs only 30, so 40 is enough.
    await prisma.productComponent.updateMany({ where: { productVariantId: products.Pops?.variants.Regular as string }, data: { quantityRequired: 30 } });
    expect(await shortageOf('chickenPops')).toBeNull();
    await prisma.productComponent.updateMany({ where: { productVariantId: products.Pops?.variants.Regular as string }, data: { quantityRequired: 70 } });
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: branch.a, inventoryItemId: items.rawFries as string } }, data: { quantityOnHand: 12 } });
  });

  it('no built-in discounts: zero types means zero options, and a no-discount sale still works', async () => {
    expect(await posTypes(tokens.emptyStaff, branch.empty)).toEqual([]);
    const res = await sale(tokens.emptyStaff, branch.empty, [line('Plain', 'Regular')]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ discount_amount: 0, total_amount: 100, discount_type: null });
  });

  it('a statutory-looking name is allowed and stays an ordinary manual discount', async () => {
    const created = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'PWD' });
    expect(created.status).toBe(201);
    const id = created.body.data?.id as string;
    const res = await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], { discount_type_id: id, type_version: 1, amount: 10, amount_mode: 'manual', expected_total_amount: 90 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ discount_type: 'manual', discount_amount: 10, total_amount: 90, calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null });
    await call('POST', `/api/discounts/manual-types/${id}/deactivate`, tokens.supAB, { expected_version: 1 });
  });

  it('branch selection: all assigned branches at once, refused whole for a branch not supervised', async () => {
    const both = await createType(tokens.supAB, { branch_ids: [branch.a, branch.b], name: 'Both branches' });
    expect(both.status).toBe(201);
    expect((both.body.data?.branch_ids as string[]).sort()).toEqual([branch.a, branch.b].sort());
    expect((await posTypes(tokens.ana, branch.a)).some((t) => t.name === 'Both branches')).toBe(true);
    expect((await posTypes(tokens.cara, branch.b)).some((t) => t.name === 'Both branches')).toBe(true);

    // A selection that reaches a branch outside live assignments writes nothing (forged JWT claim too).
    const before = await prisma.manualDiscountType.count();
    expect((await createType(tokens.supB, { branch_ids: [branch.a, branch.b], name: 'Forged' })).status).toBe(403);
    expect((await createType(tokens.forged, { branch_ids: [branch.a, branch.b], name: 'Forged' })).body.error?.code).toBe('BRANCH_ACCESS_DENIED');
    expect(await prisma.manualDiscountType.count()).toBe(before);

    // A disabled or foreign type never appears at the POS.
    const hidden = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Not on POS', apply_to_pos: false });
    expect(hidden.status).toBe(201);
    const onlyB = await createType(tokens.supB, { branch_ids: [branch.b], name: 'Only B' });
    const offered = await posTypes(tokens.ana, branch.a);
    expect(offered.some((t) => t.name === 'Not on POS' || t.name === 'Only B')).toBe(false);
    // A staff session can't read another branch by sending its id.
    const pinned = await posTypes(tokens.ana, branch.b);
    expect(pinned.some((t) => t.id === onlyB.body.data?.id)).toBe(false);

    // One edit reaches both rows, and removing a branch deactivates only that row.
    const id = both.body.data?.id as string;
    const edit = await call('PATCH', `/api/discounts/manual-types/${id}`, tokens.supAB, { name: 'Both renamed', branch_ids: [branch.a], expected_version: 1 });
    expect(edit.status).toBe(200);
    const rows = await prisma.manualDiscountType.findMany({ where: { groupId: (await prisma.manualDiscountType.findUniqueOrThrow({ where: { id } })).groupId } });
    expect(rows.find((row) => row.branchId === branch.a)).toMatchObject({ name: 'Both renamed', isActive: true, version: 2 });
    expect(rows.find((row) => row.branchId === branch.b)).toMatchObject({ isActive: false });
    // A stale save changes nothing.
    expect((await call('PATCH', `/api/discounts/manual-types/${id}`, tokens.supAB, { name: 'Stale', branch_ids: [branch.a], expected_version: 1 })).body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_CONFLICT');
  });

  it('fixed amount: one order-level amount, capped at the subtotal, forged overrides refused', async () => {
    const created = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Fixed 150', amount_mode: 'fixed', fixed_amount: 150 });
    expect(created.status).toBe(201);
    const id = created.body.data?.id as string;
    expect((await posTypes(tokens.ana, branch.a)).find((t) => t.id === id)).toMatchObject({ amount_mode: 'fixed', fixed_amount: 150 });

    // Two ₱100 units: ₱150 once, not per unit.
    const whole = await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 150, amount_mode: 'fixed', expected_total_amount: 50 });
    expect(whole.status).toBe(201);
    expect(whole.body.data).toMatchObject({ discount_amount: 150, total_amount: 50 });
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: whole.body.data?.id as string } });
    expect(stored.manualDiscountSnapshot).toMatchObject({ amount_mode: 'fixed', fixed_amount: 150, capped_to_eligible: false, amount: 150, eligible_subtotal: 200, order_subtotal: 200 });

    // ₱100 order: capped at ₱100, and the cap is recorded.
    const capped = await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], { discount_type_id: id, type_version: 1, amount: 100, amount_mode: 'fixed', expected_total_amount: 0 });
    expect(capped.status).toBe(201);
    expect(capped.body.data).toMatchObject({ discount_amount: 100, total_amount: 0 });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: capped.body.data?.id as string } })).manualDiscountSnapshot).toMatchObject({ capped_to_eligible: true });

    // A client asking for any other amount is refused; nothing is written.
    const count = await prisma.transaction.count({ where: { branchId: branch.a } });
    const forged = await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 199, amount_mode: 'fixed' });
    expect(forged.status).toBe(409);
    expect(forged.body.error?.code).toBe('MANUAL_DISCOUNT_FIXED_AMOUNT_MISMATCH');
    // An old payload (no mode) is not converted, and neither is a false claim of manual.
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 150 })).body.error?.code).toBe('MANUAL_DISCOUNT_AMOUNT_MODE_CHANGED');
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 1, amount_mode: 'manual' })).body.error?.code).toBe('MANUAL_DISCOUNT_AMOUNT_MODE_CHANGED');
    expect(await prisma.transaction.count({ where: { branchId: branch.a } })).toBe(count);

    // Same key: the same sale, and the discount once.
    const key = randomUUID();
    const first = await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 150, amount_mode: 'fixed' }, key);
    const replay = await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 150, amount_mode: 'fixed' }, key);
    expect(replay.body.data?.id).toBe(first.body.data?.id);
    expect(await prisma.transaction.count({ where: { idempotencyKey: key } })).toBe(1);

    // A settings change never reaches a sale that showed the old ones.
    const changed = await call('PATCH', `/api/discounts/manual-types/${id}`, tokens.supAB, { amount_mode: 'fixed', fixed_amount: 20, branch_ids: [branch.a], expected_version: 1 });
    expect(changed.body.data).toMatchObject({ fixed_amount: 20, version: 2 });
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular', 2)], { discount_type_id: id, type_version: 1, amount: 150, amount_mode: 'fixed' })).body.error?.code).toBe('MANUAL_DISCOUNT_TYPE_CHANGED');
    // Past sales keep what they were charged.
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: whole.body.data?.id as string } })).discountAmount.toNumber()).toBe(150);
    // A manual type can't carry a fixed amount, and an amount of zero is refused.
    expect((await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Bad', amount_mode: 'manual', fixed_amount: 5 })).status).toBeGreaterThanOrEqual(400);
    expect((await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Bad', amount_mode: 'fixed', fixed_amount: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Bad', amount_mode: 'fixed' })).status).toBeGreaterThanOrEqual(400);
  });

  it('eligibility: mixed carts cap at eligible lines, unknown products refused, older clients not offered limited types', async () => {
    const plainId = products.Plain?.id as string;
    const limited = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Plain only', product_scope: 'selected', product_ids: [plainId] });
    expect(limited.status).toBe(201);
    const id = limited.body.data?.id as string;
    expect(await prisma.manualDiscountTypeProduct.count({ where: { manualDiscountTypeId: id } })).toBe(1);

    // ₱100 eligible of a ₱130 order.
    const mixed = [line('Plain', 'Regular'), line('Other', 'Regular')];
    const over = await sale(tokens.ana, branch.a, mixed, { discount_type_id: id, type_version: 1, amount: 100.01, amount_mode: 'manual' });
    expect(over.body.error?.code).toBe('MANUAL_DISCOUNT_EXCEEDS_SUBTOTAL');
    expect(over.body.error?.details).toMatchObject({ subtotal: 130, eligible_subtotal: 100 });
    const fits = await sale(tokens.ana, branch.a, mixed, { discount_type_id: id, type_version: 1, amount: 100, amount_mode: 'manual' });
    expect(fits.status).toBe(201);
    expect(fits.body.data).toMatchObject({ discount_amount: 100, total_amount: 30 });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: fits.body.data?.id as string } })).manualDiscountSnapshot).toMatchObject({ eligible_subtotal: 100, order_subtotal: 130, product_scope: 'selected', eligible_product_ids: [plainId] });
    // Nothing eligible in the order.
    expect((await sale(tokens.ana, branch.a, [line('Other', 'Regular')], { discount_type_id: id, type_version: 1, amount: 5, amount_mode: 'manual' })).body.error?.code).toBe('MANUAL_DISCOUNT_NO_ELIGIBLE_ITEMS');

    // A fixed type caps at the eligible lines, not the order.
    const fixedLimited = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Fixed plain', amount_mode: 'fixed', fixed_amount: 120, product_scope: 'selected', product_ids: [plainId] });
    const cappedSale = await sale(tokens.ana, branch.a, mixed, { discount_type_id: fixedLimited.body.data?.id, type_version: 1, amount: 100, amount_mode: 'fixed' });
    expect(cappedSale.body.data).toMatchObject({ discount_amount: 100, total_amount: 30 });

    // Forged or foreign products are refused whole; a product only elsewhere is foreign.
    const refused = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Forged products', product_scope: 'selected', product_ids: [plainId, randomUUID()] });
    expect(refused.body.error?.code).toBe('MANUAL_DISCOUNT_PRODUCT_INVALID');
    expect((await createType(tokens.supAB, { branch_ids: [branch.a], name: 'None', product_scope: 'selected', product_ids: [] })).status).toBeGreaterThanOrEqual(400);

    // A POS that doesn't declare the capability sees only what it charges correctly.
    const old = (await call('GET', `/api/discounts/manual-types/pos?branch_id=${branch.a}`, tokens.ana)).body.data as unknown as { id: string; name: string }[];
    expect(old.some((t) => t.id === id || t.id === fixedLimited.body.data?.id)).toBe(false);
    expect(old.some((t) => t.name === 'Both renamed')).toBe(true);
    // Its existing payload for a staff-entered, whole-order type still works.
    const both = old.find((t) => t.name === 'Both renamed') as { id: string };
    const version = (await prisma.manualDiscountType.findUniqueOrThrow({ where: { id: both.id } })).version;
    const legacyShape = await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], { discount_type_id: both.id, type_version: version, amount: 10, expected_total_amount: 90 });
    expect(legacyShape.status).toBe(201);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: legacyShape.body.data?.id as string } })).manualDiscountSnapshot).toMatchObject({ amount_mode: 'manual', eligible_subtotal: 100 });
  });

  it('proof stays required and single-use on a fixed type; legacy and offline payloads keep their rules', async () => {
    const created = await createType(tokens.supAB, { branch_ids: [branch.a], name: 'Fixed with proof', amount_mode: 'fixed', fixed_amount: 10, require_proof: true });
    const id = created.body.data?.id as string;
    const claim = { discount_type_id: id, type_version: 1, amount: 10, amount_mode: 'fixed' };
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], claim)).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_REQUIRED');
    const upload = await uploadProof(tokens.ana, branch.a);
    const proofId = upload.data?.discount_proof_upload_id as string;
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], { ...claim, proof_upload_id: proofId })).status).toBe(201);
    expect((await sale(tokens.ana, branch.a, [line('Plain', 'Regular')], { ...claim, proof_upload_id: proofId })).body.error?.code).toBe('MANUAL_DISCOUNT_PROOF_ALREADY_USED');

    // A legacy client's statutory sale is unchanged (₱100 ÷ 1.12 × 0.8 = ₱71.43, VAT ₱0).
    const legacy = await call('POST', '/api/transactions', tokens.ana, {
      branch_id: branch.a,
      items: [line('Plain', 'Regular')],
      payment_method: 'cash',
      cash_tendered: 1000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      discount_type: 'pwd',
      discount_id_reference: 'PWD-1',
      tax_basis: { vat_rate: 12, discount_rate: 20 },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.data).toMatchObject({ discount_type: 'pwd', total_amount: 71.43, vat_amount: 0 });

    // Offline: a queued manual discount is refused visibly; a no-discount row syncs.
    const base = { items: [line('Plain', 'Regular')], payment_method: 'cash', cash_tendered: 1000, client_created_at: Date.now() - 60_000, tax_basis: BASIS, discount_flow: 'manual_v1' };
    const sync = await call('POST', '/api/transactions/sync-offline', tokens.ana, {
      branch_id: branch.a,
      transactions: [
        { ...base, offline_provisional_number: `PC-P57-${tag}-OFFLINE-0001`, manual_discount: claim },
        { ...base, offline_provisional_number: `PC-P57-${tag}-OFFLINE-0002`, discount_choice: 'none_applicable' },
      ],
    });
    const results = sync.body.data?.results as { status: string; error?: { code: string } }[];
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'MANUAL_DISCOUNT_OFFLINE_UNSUPPORTED' } });
    expect(results[1]).toMatchObject({ status: 'synced' });
  });

  it('product type filter: list, counts and pages follow it; type alone changes neither price nor publication', async () => {
    const res = await call('GET', `/api/products?branch_id=${branch.a}&view=active&classification=promotional&limit=100`, tokens.supAB);
    const data = res.body.data as unknown as { products: { id: string; classification: string }[]; total: number };
    expect(data.products.map((p) => p.id)).toContain(products.Plain?.id);
    expect(data.products.every((p) => p.classification === 'promotional')).toBe(true);
    expect(data.total).toBe(data.products.length);
    expect((await call('GET', `/api/products?branch_id=${branch.a}&classification=nonsense`, tokens.supAB)).status).toBe(422);
    // A promotional product is sold at its regular price unless a cashier picks a discount.
    const plainSale = await sale(tokens.ana, branch.a, [line('Plain', 'Regular')]);
    expect(plainSale.body.data).toMatchObject({ discount_amount: 0, total_amount: 100 });
  });
});
