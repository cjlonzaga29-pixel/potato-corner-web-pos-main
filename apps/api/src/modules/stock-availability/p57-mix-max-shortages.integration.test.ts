import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P57 — required choices through the real Express app and Postgres.
 * Every scenario compares what reporting says (alerts, inventory rows) with
 * what the POS does (catalog card, cart check) and what checkout does.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn(), notifyUser: vi.fn() }));
vi.mock('../../middleware/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rate-limiter.js')>()),
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateStaffToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

interface Affected {
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
  affected: Affected[];
}
interface AlertBody {
  alerts: { inventory_item_id: string; recipe_shortage: Shortage | null }[];
  recipe_shortages: { inventory_item_id: string; recipe_shortage: Shortage }[];
  setup_issues: { inventory_item_id: string | null; name: string; reason: string; product_name: string }[];
}
interface Selection {
  slot_index: number;
  snack_product_variant_id: string;
  flavor_id: string;
}

describe.skipIf(!isLocalDatabase)('P57 required choices: reporting agrees with the POS and checkout', () => {
  const tag = randomUUID().slice(0, 8);
  let branchId = '';
  let staffToken = '';
  let supervisorToken = '';
  let unitG = '';
  let unitKg = '';
  let server: Server;
  let baseUrl = '';
  let setupSucceeded = false;
  const items: Record<string, string> = {};
  const flavors: Record<string, string> = {};
  const snacks: Record<string, { productId: string; variantId: string }> = {};
  const parents: Record<string, { productId: string; variantId: string }> = {};

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Device-ID': `p57-${tag}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as { data: unknown; error: { code: string } | null } };
  }

  async function makeItem(key: string, onHand: number, reserved = 0) {
    const id = (await prisma.inventoryItem.create({ data: { name: `MM ${key} ${tag}`, baseUnitId: unitG, trackInventory: true } })).id;
    items[key] = id;
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: id, quantityOnHand: onHand, quantityReserved: reserved } });
  }

  async function makeVariant(key: string, recipe: { item: string; quantity: number; unitId?: string; flavorId?: string }[], flavorIds: string[] = []) {
    const productId = (await prisma.product.create({ data: { name: `MM ${key} ${tag}`, status: 'active', everPublished: true } })).id;
    const variantId = (await prisma.productVariant.create({ data: { productId, name: 'Regular', sizeLabel: 'Regular', basePrice: 50, isActive: true, lifecycleStatus: 'ACTIVE' } })).id;
    for (const line of recipe) {
      await prisma.productComponent.create({
        data: { productVariantId: variantId, inventoryItemId: items[line.item] as string, quantityRequired: line.quantity, recipeUnitId: line.unitId ?? null, flavorId: line.flavorId ?? null },
      });
    }
    for (const flavorId of flavorIds) await prisma.productVariantFlavor.create({ data: { productVariantId: variantId, flavorId, isAvailable: true } });
    await prisma.branchProductAvailability.create({ data: { branchId, productId, isAvailable: true } });
    return { productId, variantId };
  }

  async function makeSnack(key: string, recipe: { item: string; quantity: number; unitId?: string }[]) {
    snacks[key] = await makeVariant(`snack ${key}`, recipe, [flavors.plain as string]);
  }

  /** A Mix & Max size: packaging on the parent, one required selector per slot. */
  async function makeMixMax(key: string, slots: string[][], packaging: { item: string; quantity: number }[] = [{ item: 'box', quantity: 1 }]) {
    const parent = await makeVariant(`parent ${key}`, packaging);
    parents[key] = parent;
    for (const [index, snackKeys] of slots.entries()) {
      const slot = await prisma.productFlavorSlot.create({ data: { productVariantId: parent.variantId, slotIndex: index + 1, label: `Slot ${index + 1}`, flavorQty: 1, unit: 'g', required: true } });
      for (const snackKey of snackKeys) {
        await prisma.productFlavorSlotSnackOption.create({ data: { flavorSlotId: slot.id, snackProductVariantId: snacks[snackKey]?.variantId as string } });
      }
    }
  }

  const alerts = async () => (await call('GET', `/api/branches/${branchId}/inventory-stock/alerts`, supervisorToken)).body.data as AlertBody;
  const rows = async () => ((await call('GET', `/api/branches/${branchId}/inventory-stock`, supervisorToken)).body.data as { items: { inventory_item_id: string; recipe_shortage: Shortage | null }[] }).items;
  const shortageOf = async (key: string) => (await rows()).find((row) => row.inventory_item_id === items[key])?.recipe_shortage ?? null;
  const affectedFor = async (key: string, parentKey: string) => {
    const name = `MM parent ${parentKey} ${tag}`;
    const product = await prisma.product.findFirstOrThrow({ where: { name } });
    const shortage = await shortageOf(key);
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id } });
    return (shortage?.affected ?? []).filter((entry) => (entry as Affected & { variant_id?: string }).variant_id === variant.id);
  };
  const card = async (parentKey: string) => {
    const catalog = (await call('GET', `/api/products/catalog?branch_id=${branchId}`, staffToken)).body.data as { products: { id: string; variants: { stock_status: string; max_sellable_units: number | null; stock_shortages?: unknown[] }[] }[] };
    return catalog.products.find((product) => product.id === parents[parentKey]?.productId)?.variants[0];
  };
  const pick = (...snackKeys: string[]): Selection[] =>
    snackKeys.map((key, index) => ({ slot_index: index + 1, snack_product_variant_id: snacks[key]?.variantId as string, flavor_id: flavors.plain as string }));
  const cartCheck = async (parentKey: string, selections: Selection[]) =>
    (await call('POST', '/api/products/catalog/availability-check', staffToken, { branch_id: branchId, lines: [{ product_variant_id: parents[parentKey]?.variantId, selected_flavors: selections, quantity: 1 }] })).body.data as { ok: boolean };
  const checkout = (parentKey: string, selections: Selection[]) =>
    call('POST', '/api/transactions', staffToken, {
      branch_id: branchId,
      items: [{ product_id: parents[parentKey]?.productId, product_variant_id: parents[parentKey]?.variantId, selected_flavors: selections, quantity: 1, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 100000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
      discount_flow: 'manual_v1',
      discount_choice: 'none_applicable',
    });

  beforeAll(async () => {
    branchId = (await prisma.branch.create({ data: { name: `MM ${tag}`, code: `MM-${tag}`, address: 'x', city: 'x', status: 'active' } })).id;
    const staffId = (await prisma.user.create({ data: { role: 'staff', firstName: 'Mia', lastName: tag, email: `mia-${tag}@p57.test`, employeeId: `MM-${tag}`, employmentType: 'regular', mustChangePassword: false } })).id;
    const supervisorId = (await prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: tag, email: `sup-${tag}@p57.test`, employmentType: 'regular', mustChangePassword: false } })).id;
    await prisma.userBranchAssignment.createMany({ data: [{ userId: staffId, branchId }, { userId: supervisorId, branchId }] });
    await prisma.attendanceRecord.create({ data: { employeeId: staffId, branchId, clockInServerTime: new Date(Date.now() - 3600_000), clockInGpsStatus: 'within_radius' } });
    staffToken = generateStaffToken(branchId, { userId: staffId });
    supervisorToken = generateSupervisorToken([branchId], { userId: supervisorId });

    unitG = (await prisma.unitOfMeasure.create({ data: { code: `mm-g-${tag}`, name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } })).id;
    unitKg = (await prisma.unitOfMeasure.create({ data: { code: `mm-kg-${tag}`, name: 'Kilogram', dimension: 'WEIGHT', isBaseUnit: false } })).id;
    await prisma.unitConversion.create({ data: { fromUnitId: unitKg, toUnitId: unitG, factor: 1000 } });
    for (const key of ['plain', 'off', 'spicy']) {
      flavors[key] = (await prisma.flavor.create({ data: { name: `MM ${key} ${tag}`, ingredientName: 'x', ingredientUnit: 'g', isActive: true } })).id;
    }
    await makeItem('box', 1_000_000);
    await makeItem('plenty', 1_000_000);

    // Each slot alone fits in 60 g; two of them do not.
    await makeItem('shared', 60);
    await makeSnack('shared', [{ item: 'shared', quantity: 40 }]);
    await makeMixMax('sharedOnly', [['shared'], ['shared']]);

    // The same item and quantity, with an alternative that still sells.
    await makeItem('contested', 60);
    await makeSnack('contested', [{ item: 'contested', quantity: 40 }]);
    await makeSnack('alternative', [{ item: 'plenty', quantity: 1 }]);
    await makeMixMax('withAlternative', [['contested', 'alternative'], ['contested', 'alternative']]);

    // 100 on hand covers both slots; 30 reserved leaves 70, which does not.
    await makeItem('reserved', 100, 30);
    await makeSnack('reserved', [{ item: 'reserved', quantity: 40 }]);
    await makeMixMax('reservedOnly', [['reserved'], ['reserved']]);

    // 0.04 kg per slot against stock counted in grams.
    await makeItem('kg', 70);
    await makeSnack('kg', [{ item: 'kg', quantity: 0.04, unitId: unitKg }]);
    await makeMixMax('converted', [['kg'], ['kg']]);

    // The parent's packaging and the slot share one item.
    await makeItem('wrapShared', 45);
    await makeSnack('wrapShared', [{ item: 'wrapShared', quantity: 40 }]);
    await makeMixMax('packagingShared', [['wrapShared']], [{ item: 'wrapShared', quantity: 10 }]);

    // One option alone can't be covered, the other can: the size still sells.
    await makeItem('singleShort', 5);
    await makeSnack('singleShort', [{ item: 'singleShort', quantity: 40 }]);
    await makeMixMax('oneOptionShort', [['singleShort', 'alternative']]);

    // Two slots trading off two items: neither pairing fits.
    await makeItem('tradeA', 50);
    await makeItem('tradeB', 50);
    await makeSnack('tradeAB', [{ item: 'tradeA', quantity: 30 }, { item: 'tradeB', quantity: 30 }]);
    await makeMixMax('tradeOff', [['tradeAB'], ['tradeAB']]);

    // Every snack's only flavor is off at this branch: setup, not stock.
    await makeItem('noFlavorStock', 1_000_000);
    snacks.noFlavor = await makeVariant('snack noFlavor', [{ item: 'noFlavorStock', quantity: 1 }], [flavors.off as string]);
    await prisma.branchFlavorAvailability.create({ data: { branchId, flavorId: flavors.off as string, isAvailable: false } });
    await makeMixMax('noChoices', [['noFlavor']]);

    // A supervisor turned the only snack off: readiness refuses it, no shortage.
    await makeItem('switchedOff', 1);
    await makeSnack('switchedOff', [{ item: 'switchedOff', quantity: 40 }]);
    await makeMixMax('snackOff', [['switchedOff']]);
    await prisma.branchProductAvailability.update({ where: { branchId_productId: { branchId, productId: snacks.switchedOff?.productId as string } }, data: { isAvailable: false } });

    // A snack recipe in a unit with no conversion: checkout couldn't sell it, and it must not fail the branch's read.
    const unitOz = (await prisma.unitOfMeasure.create({ data: { code: `mm-oz-${tag}`, name: 'Ounce', dimension: 'WEIGHT', isBaseUnit: false } })).id;
    await makeItem('noConversion', 1_000_000);
    await makeSnack('noConversion', [{ item: 'noConversion', quantity: 1, unitId: unitOz }]);
    await makeMixMax('unconvertible', [['noConversion']]);

    // A flavor and a required add-on sharing one item, on a regular product.
    await makeItem('sharedOption', 50);
    parents.flavorAndOption = await makeVariant('parent flavorAndOption', [{ item: 'box', quantity: 1 }, { item: 'sharedOption', quantity: 30, flavorId: flavors.spicy as string }], [flavors.spicy as string]);
    const group = await prisma.productOptionGroup.create({ data: { code: `mm-req-${tag}`, name: 'Sauce', selectionType: 'SINGLE', required: true, minSelections: 1, isActive: true } });
    const option = await prisma.productOption.create({ data: { optionGroupId: group.id, code: `mm-req-o-${tag}`, name: 'Sauce A', isActive: true } });
    await prisma.productOptionInventoryMapping.create({ data: { productOptionId: option.id, inventoryItemId: items.sharedOption as string, quantityRequired: 30, deductionUnitId: unitG } });
    await prisma.productVariantOptionGroup.create({ data: { productVariantId: parents.flavorAndOption.variantId, optionGroupId: group.id } });

    // An "Add-ons" group flagged required: checkout treats it as optional.
    await makeItem('addOnStock', 1);
    parents.addOnFlagged = await makeVariant('parent addOnFlagged', [{ item: 'box', quantity: 1 }]);
    const addOnGroup = await prisma.productOptionGroup.create({ data: { code: `mm-add-${tag}`, name: 'Add-ons', selectionType: 'MULTIPLE', required: true, minSelections: 1, isActive: true } });
    const addOn = await prisma.productOption.create({ data: { optionGroupId: addOnGroup.id, code: `mm-add-o-${tag}`, name: 'Extra', isActive: true } });
    await prisma.productOptionInventoryMapping.create({ data: { productOptionId: addOn.id, inventoryItemId: items.addOnStock as string, quantityRequired: 10, deductionUnitId: unitG } });
    await prisma.productVariantOptionGroup.create({ data: { productVariantId: parents.addOnFlagged.variantId, optionGroupId: addOnGroup.id } });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (!setupSucceeded) return;
    await prisma.$executeRaw`DELETE FROM "transaction_items" WHERE "transaction_id" IN (SELECT id FROM "transactions" WHERE "branch_id" = ${branchId})`;
    await prisma.$executeRaw`DELETE FROM "inventory_deduction_jobs" WHERE "branch_id" = ${branchId}`;
    await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ${branchId}`;
    await prisma.$executeRaw`DELETE FROM "checkout_attempts" WHERE "branch_id" = ${branchId}`;
    await prisma.attendanceRecord.deleteMany({ where: { branchId } });
    await prisma.shift.deleteMany({ where: { branchId } });
  });

  it('two slots needing more of one item than the branch has: every surface says blocked', async () => {
    const entries = await affectedFor('shared', 'sharedOnly');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ choice_kind: 'combination', required: 80, deficit: 20, blocks_size: true });
    expect((await card('sharedOnly'))?.stock_status).toBe('out_of_stock');
    expect((await cartCheck('sharedOnly', pick('shared', 'shared'))).ok).toBe(false);
    expect((await checkout('sharedOnly', pick('shared', 'shared'))).status).toBeGreaterThanOrEqual(400);
    expect(await prisma.transaction.count({ where: { branchId } })).toBe(0);
    // Counted as one item, in the same list the inventory filter reads.
    const listed = (await alerts()).recipe_shortages.filter((row) => row.inventory_item_id === items.shared);
    expect(listed).toHaveLength(1);
  });

  it('a valid alternative combination is not a shortage, and it really sells', async () => {
    expect(await affectedFor('contested', 'withAlternative')).toEqual([]);
    expect((await card('withAlternative'))?.stock_status).not.toBe('out_of_stock');
    expect((await cartCheck('withAlternative', pick('contested', 'contested'))).ok).toBe(false);
    expect((await cartCheck('withAlternative', pick('contested', 'alternative'))).ok).toBe(true);
    const sold = await checkout('withAlternative', pick('contested', 'alternative'));
    expect(sold.status).toBe(201);
    // The sale took 40 g, leaving 20 g: now the contested snack can't serve even one slot, and the alternative still sells.
    const after = await affectedFor('contested', 'withAlternative');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((entry) => !entry.blocks_size)).toBe(true);
    expect((await card('withAlternative'))?.stock_status).not.toBe('out_of_stock');
  });

  it('reservations can make an otherwise valid combination impossible, and clear with them', async () => {
    expect(await affectedFor('reserved', 'reservedOnly')).toHaveLength(1);
    expect((await affectedFor('reserved', 'reservedOnly'))[0]).toMatchObject({ required: 80, deficit: 10, blocks_size: true });
    expect((await card('reservedOnly'))?.stock_status).toBe('out_of_stock');
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: items.reserved as string } }, data: { quantityReserved: 0 } });
    expect(await affectedFor('reserved', 'reservedOnly')).toEqual([]);
    expect((await card('reservedOnly'))?.stock_status).not.toBe('out_of_stock');
    expect((await card('reservedOnly'))?.max_sellable_units).toBe(1);
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: items.reserved as string } }, data: { quantityReserved: 30 } });
  });

  it('unit conversions are applied before quantities are added', async () => {
    expect((await affectedFor('kg', 'converted'))[0]).toMatchObject({ required: 80, deficit: 10, blocks_size: true });
    expect((await card('converted'))?.stock_status).toBe('out_of_stock');
    expect((await cartCheck('converted', pick('kg', 'kg'))).ok).toBe(false);
  });

  it('packaging on the parent adds to what its slots use', async () => {
    expect((await affectedFor('wrapShared', 'packagingShared'))[0]).toMatchObject({ required: 50, deficit: 5, blocks_size: true });
    expect((await card('packagingShared'))?.stock_status).toBe('out_of_stock');
    expect((await cartCheck('packagingShared', pick('wrapShared'))).ok).toBe(false);
  });

  it('one short option among alternatives is listed without blocking the size', async () => {
    const entries = await affectedFor('singleShort', 'oneOptionShort');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ choice_kind: 'slot', required: 40, blocks_size: false });
    expect(entries[0]?.choice_name).toContain('snack singleShort');
    expect((await card('oneOptionShort'))?.stock_status).not.toBe('out_of_stock');
  });

  it('every short item of a blocked combination is named, once per item', async () => {
    for (const key of ['tradeA', 'tradeB']) {
      expect((await affectedFor(key, 'tradeOff'))[0]).toMatchObject({ required: 60, deficit: 10, blocks_size: true });
    }
    const listed = (await alerts()).recipe_shortages.filter((row) => row.inventory_item_id === items.tradeA || row.inventory_item_id === items.tradeB);
    expect(listed).toHaveLength(2);
  });

  it('a slot with nothing to choose is setup, not a stock shortage', async () => {
    const body = await alerts();
    const issues = body.setup_issues.filter((issue) => issue.product_name === `MM parent noChoices ${tag}`);
    expect(issues).toEqual([expect.objectContaining({ reason: 'no_slot_choice', inventory_item_id: null, name: 'Slot 1' })]);
    expect(await shortageOf('noFlavorStock')).toBeNull();
    expect((await card('noChoices'))?.stock_status).not.toBe('out_of_stock');
  });

  it('a snack recipe that cannot be converted is setup, and every read still answers', async () => {
    const issues = (await alerts()).setup_issues.filter((issue) => issue.product_name === `MM parent unconvertible ${tag}`);
    expect(issues).toEqual([expect.objectContaining({ reason: 'no_slot_choice', inventory_item_id: null })]);
    // The snack is also sold by itself: its own size reports the same cause, and Inventory still loads.
    expect((await alerts()).setup_issues.filter((issue) => issue.product_name === `MM snack noConversion ${tag}`)).toEqual([expect.objectContaining({ reason: 'no_unit_conversion', inventory_item_id: null })]);
    expect(await shortageOf('noConversion')).toBeNull();
    expect((await card('unconvertible'))?.stock_status).not.toBe('out_of_stock');
    expect((await card('sharedOnly'))?.stock_status).toBe('out_of_stock');
    // Never called out of stock on a recipe it couldn't read.
    const catalog = (await call('GET', `/api/products/catalog?branch_id=${branchId}`, staffToken)).body.data as { products: { id: string; variants: { stock_status: string }[] }[] };
    expect(catalog.products.find((product) => product.id === snacks.noConversion?.productId)?.variants[0]?.stock_status).toBe('unknown');
  });

  it('a manually disabled snack is not reported as a shortage', async () => {
    expect(await shortageOf('switchedOff')).toBeNull();
    expect(await affectedFor('switchedOff', 'snackOff')).toEqual([]);
  });

  it('a flavor and a required add-on sharing an item are added together, as the cart check does', async () => {
    const entries = await affectedFor('sharedOption', 'flavorAndOption');
    expect(entries.some((entry) => entry.blocks_size && entry.required === 60 && entry.deficit === 10)).toBe(true);
    expect((await card('flavorAndOption'))?.stock_status).toBe('out_of_stock');
    const optionId = (await prisma.productOption.findFirstOrThrow({ where: { code: `mm-req-o-${tag}` } })).id;
    const check = (await call('POST', '/api/products/catalog/availability-check', staffToken, { branch_id: branchId, lines: [{ product_variant_id: parents.flavorAndOption?.variantId, flavor_id: flavors.spicy, selected_option_ids: [optionId], quantity: 1 }] })).body.data as { ok: boolean };
    expect(check.ok).toBe(false);
  });

  it('an Add-ons group flagged required stays optional, as at checkout', async () => {
    const entries = await affectedFor('addOnStock', 'addOnFlagged');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ choice_kind: 'option', blocks_size: false });
    expect((await card('addOnFlagged'))?.stock_status).not.toBe('out_of_stock');
    const sold = await call('POST', '/api/transactions', staffToken, {
      branch_id: branchId,
      items: [{ product_id: parents.addOnFlagged?.productId, product_variant_id: parents.addOnFlagged?.variantId, quantity: 1, promotion: null }],
      payment_method: 'cash',
      cash_tendered: 100000,
      is_offline_transaction: false,
      idempotency_key: randomUUID(),
      tax_basis: { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null },
      discount_flow: 'manual_v1',
      discount_choice: 'none_applicable',
    });
    expect(sold.status).toBe(201);
  });
});
