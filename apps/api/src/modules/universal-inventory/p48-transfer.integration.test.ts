import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P48 — the transfer rules the stock-needs transfer page relies on,
 * against real Postgres. The page adds no new endpoint: it reads branch stock
 * (needs = rows whose status isn't healthy, same as the alerts endpoint) and
 * posts the existing transfer, which must still refuse unauthorized or unsafe
 * requests itself and revalidate the source balance under a row lock.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { universalInventoryService } = await import('./universal-inventory.service.js');
const { hasBranchAccess } = await import('../../lib/branch-access.js');

describe.skipIf(!isLocalDatabase)('POS-PERF-P48 stock needs and transfer (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const branchIds: string[] = [];
  const userIds: string[] = [];
  let main: string;
  let north: string;
  let foreign: string;
  let unitId: string;
  let cheese: string;
  let oil: string;
  let northOnly: string;
  let supervisor: JwtPayload;
  let actor: { id: string; role: string };

  async function stock(branchId: string, itemId: string) {
    return prisma.inventoryStock.findUnique({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
  }

  async function onHand(branchId: string, itemId: string) {
    return (await stock(branchId, itemId))?.quantityOnHand.toNumber() ?? null;
  }

  beforeAll(async () => {
    for (const label of ['Main', 'North', 'Foreign']) {
      const branch = await prisma.branch.create({
        data: { name: `P48 ${label} ${suffix}`, code: `P48${label.slice(0, 1)}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      });
      branchIds.push(branch.id);
    }
    [main, north, foreign] = branchIds as [string, string, string];

    const user = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'P48Sup', lastName: suffix, employmentType: 'regular', email: `p48-sup-${suffix}@test.local`, isActive: true, status: 'active' },
    });
    userIds.push(user.id);
    for (const b of [main, north]) await prisma.userBranchAssignment.create({ data: { userId: user.id, branchId: b, assignedAt: new Date() } });
    supervisor = { user_id: user.id, role: 'supervisor', email: `p48-sup-${suffix}@test.local`, branch_ids: [main, north] } as JwtPayload;
    actor = { id: user.id, role: 'supervisor' };

    const unit = await prisma.unitOfMeasure.create({ data: { code: `p48g-${suffix}`, name: 'P48 gram', dimension: 'WEIGHT', isBaseUnit: true } });
    unitId = unit.id;
    const mkItem = async (name: string) => (await prisma.inventoryItem.create({ data: { name: `${name} ${suffix}`, baseUnitId: unitId, unitCost: 2 } })).id;
    cheese = await mkItem('P48 Cheese');
    oil = await mkItem('P48 Oil');
    northOnly = await mkItem('P48 NorthOnly');

    const mkStock = (branchId: string, itemId: string, qty: number, low: number | null, critical: number | null, reserved = 0) =>
      prisma.inventoryStock.create({
        data: { branchId, inventoryItemId: itemId, quantityOnHand: qty, quantityReserved: reserved, lowStockThreshold: low, criticalThreshold: critical, unitCost: 2 },
      });
    await mkStock(main, cheese, 1, 10, 2); // critical
    await mkStock(main, oil, 8, 10, 2); // low
    await mkStock(north, cheese, 40, 10, 2, 5); // 35 available
    await mkStock(north, oil, 300, 10, 2);
    await mkStock(north, northOnly, 50, 10, 2); // not assigned to Main
    await mkStock(foreign, cheese, 100, 10, 2);
  });

  afterAll(async () => {
    await prisma.inventoryStockMovement.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.inventoryStock.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.inventoryItem.deleteMany({ where: { baseUnitId: unitId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  it('the destination’s needs (non-healthy stock rows) equal its inventory alerts', async () => {
    const { items } = await universalInventoryService.getBranchStock(main);
    const needs = items.filter((r) => r.status !== 'healthy').map((r) => [r.inventory_item_id, r.status]);
    const { alerts } = await universalInventoryService.getBranchStockAlerts(main);
    expect(needs.sort()).toEqual(alerts.map((a) => [a.inventory_item_id, a.severity]).sort());
    expect(Object.fromEntries(needs)).toEqual({ [cheese]: 'critical', [oil]: 'low' });
  });

  it('offers and accepts only the supervisor’s own active branches', async () => {
    const { branches } = await universalInventoryService.getTransferDestinations(north, actor);
    expect(branches.map((b) => b.id)).toEqual([main]);
    // Source authorization is branchGuard → hasBranchAccess on the URL branch.
    expect(await hasBranchAccess(supervisor, north)).toBe(true);
    expect(await hasBranchAccess(supervisor, foreign)).toBe(false);
  });

  it('refuses an unassigned destination without moving stock', async () => {
    await expect(
      universalInventoryService.transferStock({ fromBranchId: north, toBranchId: foreign, inventoryItemId: cheese, quantity: 1 }, actor, null),
    ).rejects.toMatchObject({ code: 'TRANSFER_DESTINATION_DENIED', statusCode: 403 });
    expect(await onHand(north, cheese)).toBe(40);
    expect(await onHand(foreign, cheese)).toBe(100);
  });

  it('refuses same-branch transfers', async () => {
    await expect(
      universalInventoryService.transferStock({ fromBranchId: main, toBranchId: main, inventoryItemId: cheese, quantity: 1 }, actor, null),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSFER', statusCode: 422 });
  });

  it('refuses more than available (reserved stock excluded) without moving stock', async () => {
    await expect(
      universalInventoryService.transferStock({ fromBranchId: north, toBranchId: main, inventoryItemId: cheese, quantity: 36 }, actor, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', statusCode: 409 });
    expect(await onHand(north, cheese)).toBe(40);
    expect(await onHand(main, cheese)).toBe(1);
  });

  it('revalidates a stale source balance at submission', async () => {
    const before = await universalInventoryService.getBranchStock(north);
    expect(before.items.find((r) => r.inventory_item_id === oil)?.quantity_available).toBe(300);
    // Someone else drains the source after the page loaded.
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: north, inventoryItemId: oil } }, data: { quantityOnHand: 5 } });
    await expect(
      universalInventoryService.transferStock({ fromBranchId: north, toBranchId: main, inventoryItemId: oil, quantity: 9 }, actor, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await onHand(north, oil)).toBe(5);
    expect(await onHand(main, oil)).toBe(8);
  });

  it('refuses an item the destination does not stock and never creates the assignment', async () => {
    await expect(
      universalInventoryService.transferStock({ fromBranchId: north, toBranchId: main, inventoryItemId: northOnly, quantity: 1 }, actor, null),
    ).rejects.toMatchObject({ code: 'STOCK_ROW_NOT_FOUND', statusCode: 404 });
    expect(await stock(main, northOnly)).toBeNull();
    expect(await onHand(north, northOnly)).toBe(50);
  });

  it('moves stock in both legs with one reference, the actor recorded, and an audit entry', async () => {
    const result = await universalInventoryService.transferStock(
      { fromBranchId: north, toBranchId: main, inventoryItemId: cheese, quantity: 9, notes: 'P48 weekend top-up' },
      actor,
      '127.0.0.1',
    );
    expect(await onHand(north, cheese)).toBe(31);
    expect(await onHand(main, cheese)).toBe(10);
    expect(result.transfer_out.quantity_after).toBe(31);
    expect(result.transfer_in.quantity_after).toBe(10);

    const movements = await prisma.inventoryStockMovement.findMany({ where: { referenceId: result.transfer_out.reference_id ?? '' } });
    expect(movements.map((m) => [m.branchId, m.movementType, m.quantityChange.toNumber()]).sort()).toEqual(
      [
        [main, 'TRANSFER_IN', 9],
        [north, 'TRANSFER_OUT', -9],
      ].sort(),
    );
    expect(movements.every((m) => m.performedByUserId === actor.id && m.notes === 'P48 weekend top-up' && m.unitId === unitId)).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'INVENTORY_STOCK_TRANSFERRED', entityId: result.transfer_out.id } });
    expect(audit).toMatchObject({ actorId: actor.id, actorRole: 'supervisor', branchId: north });

    // Main's cheese is now at its low threshold — still a need, by the same rule.
    const { items } = await universalInventoryService.getBranchStock(main);
    expect(items.find((r) => r.inventory_item_id === cheese)?.status).toBe('low');
  });
});
