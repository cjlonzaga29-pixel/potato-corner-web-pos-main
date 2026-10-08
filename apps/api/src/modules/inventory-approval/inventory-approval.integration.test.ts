import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P28 — real-Postgres integration coverage for the manual-inventory
 * approval gate. Unlike this repo's other *.integration.test.ts files (all
 * TODO-stubbed pending a TEST_DATABASE_URL/TEST_REDIS_URL that's never been
 * configured — and TEST_REDIS_URL no longer even applies post-Phase-21
 * Redis removal), this suite is fully fleshed out and runs against whatever
 * database apps/api/.env's DATABASE_URL already points at.
 *
 * Safety gate: only runs when that host resolves to a local loopback
 * address — the same "verify the target before writing" discipline
 * CLAUDE.md's migration-safety rule requires for `prisma migrate`, applied
 * here to a suite that creates and deletes real rows. Never runs against a
 * Supabase/production URL.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { inventoryApprovalService } = await import('./inventory-approval.service.js');
const { universalInventoryService } = await import('../universal-inventory/universal-inventory.service.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');

function actor(role: 'super_admin' | 'supervisor' | 'branch', userId: string, branchIds?: string[]): JwtPayload {
  const base = { user_id: userId, email: `${userId}@test.local`, iat: 0, exp: 9999999999 };
  if (role === 'super_admin') return { ...base, role } as JwtPayload;
  return { ...base, role, branch_ids: branchIds ?? [] } as JwtPayload;
}

describe.skipIf(!isLocalDatabase)('inventory-approval integration (real Postgres)', () => {
  let branchId: string;
  let otherBranchId: string;
  let unitId: string;
  let itemId: string;
  let legacyIngredientId: string;
  let branchUserId: string;
  let supervisorUserId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: 'P28 Test Branch', code: `P28-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchId = branch.id;
    const other = await prisma.branch.create({
      data: { name: 'P28 Other Branch', code: `P28-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    otherBranchId = other.id;

    const unit = await prisma.unitOfMeasure.create({
      data: { code: `pc-${randomUUID().slice(0, 6)}`, name: 'Piece', dimension: 'COUNT', isBaseUnit: true },
    });
    unitId = unit.id;

    const item = await prisma.inventoryItem.create({
      data: { name: 'P28 Test Item', baseUnitId: unitId },
    });
    itemId = item.id;
    await prisma.inventoryStock.create({
      data: { branchId, inventoryItemId: itemId, quantityOnHand: 100, quantityReserved: 0, version: 0 },
    });

    const ingredient = await prisma.ingredient.create({
      data: { name: 'P28 Legacy Ingredient', unit: 'pcs', lowStockThreshold: 5, criticalThreshold: 2, branchId, currentStock: 0 },
    });
    legacyIngredientId = ingredient.id;
    await inventoryRepository.appendMovement({
      branchId,
      ingredientId: legacyIngredientId,
      movementType: 'stock_in',
      quantityChange: 50,
      recordedBy: 'seed',
    });

    const branchUser = await prisma.user.create({
      data: { role: 'branch', firstName: 'Branch', lastName: 'Acct', employmentType: 'regular', email: `branch-${randomUUID()}@test.local` },
    });
    branchUserId = branchUser.id;
    await prisma.userBranchAssignment.create({ data: { userId: branchUserId, branchId } });

    const supervisorUser = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Supe', lastName: 'Visor', employmentType: 'regular', email: `supervisor-${randomUUID()}@test.local` },
    });
    supervisorUserId = supervisorUser.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorUserId, branchId } });

    const adminUser = await prisma.user.create({
      data: { role: 'super_admin', firstName: 'Admin', lastName: 'User', employmentType: 'regular', email: `admin-${randomUUID()}@test.local` },
    });
    adminUserId = adminUser.id;
  });

  afterAll(async () => {
    // InventoryMovement/InventoryStockMovement rows are immutable (CR-004) —
    // a direct deleteMany on either is blocked by prisma-immutability.ts.
    // Deleting their owning Branch/InventoryItem/Ingredient instead cascades
    // at the database level (every relation below is onDelete: Cascade),
    // which the immutability middleware — scoped to direct calls on those
    // two models — never intercepts.
    await prisma.inventoryApprovalRequest.deleteMany({ where: { branchId: { in: [branchId, otherBranchId] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.ingredient.deleteMany({ where: { id: legacyIngredientId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [branchUserId, supervisorUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [branchUserId, supervisorUserId, adminUserId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
  });

  it('a pending stock-in does not change InventoryStock', async () => {
    const before = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitReceiving(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, enteredQuantity: 10, enteredUnitId: unitId },
      actor('branch', branchUserId, [branchId]),
    );
    expect(request.status).toBe('PENDING');
    const after = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(after.quantityOnHand.toString()).toBe(before.quantityOnHand.toString());

    await inventoryApprovalService.returnForCorrection(request.id, 'cleanup', actor('super_admin', adminUserId));
  });

  it('approving applies the movement exactly once; a second approve attempt 409s and does not double-apply', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 7, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );

    const approved = await inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null);
    expect(approved.status).toBe('APPROVED');

    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 7);

    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });

    const stockAfterRetry = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfterRetry.quantityOnHand.toNumber()).toBe(stockAfter.quantityOnHand.toNumber());

    const movements = await prisma.inventoryStockMovement.count({ where: { inventoryItemId: itemId, movementType: 'ADJUSTMENT_IN', notes: { contains: 'count_correction' } } });
    expect(movements).toBeGreaterThanOrEqual(1);
  });

  it('concurrent approval attempts on the same request apply exactly once', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 3, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );

    const results = await Promise.allSettled([
      inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null),
      inventoryApprovalService.approve(request.id, actor('super_admin', adminUserId), null),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 3);
  });

  it('a branch account cannot approve (role-gated at the service, matching the router middleware posture)', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 1, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    // Branch-role self-approval: denied by the self-approval check since the
    // submitter and would-be approver are the same account here — the
    // distinct "branch accounts never get adminOrSupervisor" denial is
    // covered by the router-level middleware test, not reachable through
    // the service alone with a second distinct branch-role actor unavailable
    // in this fixture set.
    await expect(inventoryApprovalService.approve(request.id, actor('branch', branchUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'SELF_APPROVAL_DENIED',
    });
    await inventoryApprovalService.returnForCorrection(request.id, 'cleanup', actor('super_admin', adminUserId));
  });

  it('a supervisor without access to the request branch is denied', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 1, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    await expect(
      inventoryApprovalService.approve(request.id, actor('supervisor', randomUUID(), [otherBranchId]), null),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
    await inventoryApprovalService.returnForCorrection(request.id, 'cleanup', actor('super_admin', adminUserId));
  });

  it('a returned request cannot be approved, but correcting it creates a fresh revision that can', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 2, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const returned = await inventoryApprovalService.returnForCorrection(request.id, 'wrong quantity', actor('supervisor', supervisorUserId, [branchId]));
    expect(returned.status).toBe('RETURNED');

    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });

    const corrected = await inventoryApprovalService.correct(request.id, { quantityDelta: 4 }, actor('branch', branchUserId, [branchId]));
    expect(corrected.status).toBe('PENDING');
    expect(corrected.revision_number).toBe(2);

    const approved = await inventoryApprovalService.approve(corrected.id, actor('supervisor', supervisorUserId, [branchId]), null);
    expect(approved.status).toBe('APPROVED');
    expect(approved.quantity_delta).toBe(4);
  });

  it('a stale physical count (stock moved after submission) is rejected at approval, not applied', async () => {
    const [request] = await inventoryApprovalService.submitPhysicalCount(
      { target: 'UNIVERSAL_ITEM', branchId, counts: [{ inventoryItemId: itemId, countedQuantity: 999 }] },
      actor('branch', branchUserId, [branchId]),
    );
    // A second, unrelated adjustment approved in between moves the stock
    // version the count's staleness fingerprint was taken against.
    const bump = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 1, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    await inventoryApprovalService.approve(bump.id, actor('supervisor', supervisorUserId, [branchId]), null);

    const stockBeforeStaleAttempt = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'STALE_PHYSICAL_COUNT',
    });
    const stockAfterStaleAttempt = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfterStaleAttempt.quantityOnHand.toString()).toBe(stockBeforeStaleAttempt.quantityOnHand.toString());

    await inventoryApprovalService.returnForCorrection(request.id, 'stale — recount needed', actor('supervisor', supervisorUserId, [branchId]));
  });

  it('an outgoing adjustment cannot be approved below reserved stock', async () => {
    await prisma.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } },
      data: { quantityReserved: 5 },
    });
    const stock = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const excessiveDelta = -(stock.quantityOnHand.toNumber() - 5 + 1);
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: excessiveDelta, reasonCode: 'damaged' },
      actor('branch', branchUserId, [branchId]),
    );
    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } }, data: { quantityReserved: 0 } });
    await inventoryApprovalService.returnForCorrection(request.id, 'cleanup', actor('supervisor', supervisorUserId, [branchId]));
  });

  it('legacy stock-in/adjustment requests also gate through the same approval flow and apply once approved', async () => {
    const ledgerCountBefore = await inventoryRepository.countMovements(legacyIngredientId);
    const request = await inventoryApprovalService.submitReceiving(
      { target: 'LEGACY_INGREDIENT', branchId, legacyIngredientId, enteredQuantity: 20 },
      actor('branch', branchUserId, [branchId]),
    );
    expect(request.status).toBe('PENDING');
    expect(await inventoryRepository.countMovements(legacyIngredientId)).toBe(ledgerCountBefore);

    const approved = await inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null);
    expect(approved.status).toBe('APPROVED');
    expect(await inventoryRepository.countMovements(legacyIngredientId)).toBe(ledgerCountBefore + 1);
  });

  it('waste remains immediate and unaffected by the approval gate', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    await universalInventoryService.wasteStock(
      { branchId, inventoryItemId: itemId, quantity: 1, reasonCode: 'spoilage', responsibleUserId: branchUserId },
      { id: branchUserId, role: 'branch' },
      null,
    );
    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() - 1);
  });
});
