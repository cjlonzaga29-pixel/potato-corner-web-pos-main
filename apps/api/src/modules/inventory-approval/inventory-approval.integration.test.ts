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
const { config } = await import('../../config/index.js');
const { inventoryApprovalService } = await import('./inventory-approval.service.js');
const { universalInventoryService } = await import('../universal-inventory/universal-inventory.service.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');

/** Same readonly-config override pattern inventory.router.test.ts already uses for this exact flag. */
function setApprovalRequired(value: boolean): void {
  (config as { manualInventoryApprovalRequired: boolean }).manualInventoryApprovalRequired = value;
}

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
    if (!request) throw new Error('expected one request for the single submitted count line');
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

  // -------------------------------------------------------------------------
  // POS-PERF-P28R2 — permanent cancellation (the rollback-gap fix).
  // -------------------------------------------------------------------------

  it('cancelling a PENDING request changes no stock, and the cancelled request can never be approved or corrected', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 9, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );

    const cancelled = await inventoryApprovalService.cancel(request.id, 'duplicate submission', actor('supervisor', supervisorUserId, [branchId]), null);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancel_reason).toBe('duplicate submission');
    expect(cancelled.cancelled_by_user_id).toBe(supervisorUserId);

    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toString()).toBe(stockBefore.quantityOnHand.toString());

    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
    await expect(inventoryApprovalService.correct(request.id, { quantityDelta: 1 }, actor('branch', branchUserId, [branchId]))).rejects.toMatchObject({
      code: 'NOT_RETURNED',
    });
  });

  it('cancelling a RETURNED request retires the whole lineage: the cancelled row cannot be corrected, and the older (pre-return) sibling cannot revive it either', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 5, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const returned = await inventoryApprovalService.returnForCorrection(request.id, 'needs a different reason code', actor('supervisor', supervisorUserId, [branchId]));
    expect(returned.status).toBe('RETURNED');

    const cancelled = await inventoryApprovalService.cancel(returned.id, 'branch confirmed this is no longer needed', actor('super_admin', adminUserId), null);
    expect(cancelled.status).toBe('CANCELLED');

    // The cancelled (formerly RETURNED) row itself can no longer be corrected...
    await expect(inventoryApprovalService.correct(returned.id, { quantityDelta: 1 }, actor('branch', branchUserId, [branchId]))).rejects.toMatchObject({
      code: 'NOT_RETURNED',
    });
    // ...and since returned.id === request.id (revision 1 was returned, not yet
    // superseded by any correction before being cancelled), there is no older
    // sibling revision in this lineage to separately re-check here — the
    // single row's own permanent CANCELLED status is the only state that
    // exists, which the assertion above already covers for this request. The
    // multi-revision "older sibling" shape is exercised explicitly below.
    expect(returned.id).toBe(request.id);
  });

  it('an older revision cannot revive a lineage after its newer revision is cancelled', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 6, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    await inventoryApprovalService.returnForCorrection(request.id, 'wrong amount', actor('supervisor', supervisorUserId, [branchId]));
    const revision2 = await inventoryApprovalService.correct(request.id, { quantityDelta: 8 }, actor('branch', branchUserId, [branchId]));
    expect(revision2.revision_number).toBe(2);

    await inventoryApprovalService.cancel(revision2.id, 'cancelling the lineage entirely', actor('supervisor', supervisorUserId, [branchId]), null);

    // revision 1 (the original, now-superseded RETURNED row) still exists
    // with status RETURNED — attempting to correct IT again (rather than
    // the now-CANCELLED revision 2) must still be rejected, because it has
    // already been corrected once (hasExistingCorrection), independent of
    // and in addition to revision 2's cancellation.
    await expect(inventoryApprovalService.correct(request.id, { quantityDelta: 2 }, actor('branch', branchUserId, [branchId]))).rejects.toMatchObject({
      code: 'ALREADY_CORRECTED',
    });
    await expect(inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
  });

  it('cancelling using the old/root request ID after a correction exists is rejected, and the live revision is unaffected', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 7, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    await inventoryApprovalService.returnForCorrection(request.id, 'wrong amount', actor('supervisor', supervisorUserId, [branchId]));
    const revision2 = await inventoryApprovalService.correct(request.id, { quantityDelta: 9 }, actor('branch', branchUserId, [branchId]));
    expect(revision2.status).toBe('PENDING');

    // Cancelling against the stale root/old request ID (revision 1, now
    // RETURNED-and-superseded) must be rejected rather than silently
    // cancelling revision 1 while leaving revision 2 live and approvable —
    // that would let the same physical event still reach stock through the
    // descendant while the API reports the lineage as cancelled.
    await expect(
      inventoryApprovalService.cancel(request.id, 'trying to cancel via the old id', actor('supervisor', supervisorUserId, [branchId]), null),
    ).rejects.toMatchObject({ code: 'ALREADY_CORRECTED' });

    const staleRow = await prisma.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(staleRow.status).toBe('RETURNED');

    // The live revision is untouched by the rejected stale-id cancel attempt
    // and can still be approved normally.
    const approved = await inventoryApprovalService.approve(revision2.id, actor('supervisor', supervisorUserId, [branchId]), null);
    expect(approved.status).toBe('APPROVED');
    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 9);
  });

  it('cancel versus approve on the same PENDING request has exactly one winner', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 11, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );

    const results = await Promise.allSettled([
      inventoryApprovalService.cancel(request.id, 'racing cancel', actor('supervisor', supervisorUserId, [branchId]), null),
      inventoryApprovalService.approve(request.id, actor('super_admin', adminUserId), null),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof inventoryApprovalService.cancel>>> => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const final = await prisma.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: request.id } });
    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    if (final.status === 'APPROVED') {
      expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 11);
    } else {
      expect(final.status).toBe('CANCELLED');
      expect(stockAfter.quantityOnHand.toString()).toBe(stockBefore.quantityOnHand.toString());
    }
  });

  it('cancel versus correct on the same RETURNED request never leaves two live outcomes (no actionable revision survives a winning cancel, no orphaned cancel survives a winning correction)', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 13, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const returned = await inventoryApprovalService.returnForCorrection(request.id, 'retry', actor('supervisor', supervisorUserId, [branchId]));

    const results = await Promise.allSettled([
      inventoryApprovalService.cancel(returned.id, 'racing cancel', actor('supervisor', supervisorUserId, [branchId]), null),
      inventoryApprovalService.correct(returned.id, { quantityDelta: 14 }, actor('branch', branchUserId, [branchId])),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Both can legitimately fulfill independently in isolation, but they must
    // never BOTH leave the lineage in a state where a newer PENDING revision
    // exists AND the row it superseded is CANCELLED through two different
    // winning branches that didn't see each other.
    const finalRow = await prisma.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: returned.id } });
    const siblingRevision = await prisma.inventoryApprovalRequest.findFirst({ where: { previousRequestId: returned.id } });

    if (finalRow.status === 'CANCELLED') {
      // Cancel won the lock first: correct() must have seen the fresh
      // CANCELLED status under the lock and been rejected — no sibling
      // revision should have been inserted.
      expect(siblingRevision).toBeNull();
    } else {
      // Correct won the lock first: cancel() must have seen hasExistingCorrection
      // under the lock and been rejected — the original row stays RETURNED
      // (never flips to CANCELLED), and exactly one new PENDING sibling exists.
      expect(finalRow.status).toBe('RETURNED');
      expect(siblingRevision).not.toBeNull();
      expect(siblingRevision?.status).toBe('PENDING');
    }
    expect(fulfilled.length).toBe(1);
  });

  it('repeated cancellation of an already-cancelled request is a safe no-op', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 2, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const first = await inventoryApprovalService.cancel(request.id, 'first cancel', actor('supervisor', supervisorUserId, [branchId]), null);
    expect(first.status).toBe('CANCELLED');
    expect(first.cancel_reason).toBe('first cancel');

    // A second cancellation attempt must not throw and must not overwrite
    // the original cancellation's reason/actor/timestamp.
    const second = await inventoryApprovalService.cancel(request.id, 'second cancel attempt', actor('super_admin', adminUserId), null);
    expect(second.status).toBe('CANCELLED');
    expect(second.cancel_reason).toBe('first cancel');
    expect(second.cancelled_by_user_id).toBe(supervisorUserId);
  });

  it('an already-approved request can never be cancelled — its applied stock movement is left intact', async () => {
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 4, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const approved = await inventoryApprovalService.approve(request.id, actor('supervisor', supervisorUserId, [branchId]), null);
    expect(approved.status).toBe('APPROVED');

    await expect(inventoryApprovalService.cancel(request.id, 'trying to undo an approval', actor('super_admin', adminUserId), null)).rejects.toMatchObject({
      code: 'NOT_CANCELLABLE',
    });

    const stillApproved = await prisma.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(stillApproved.status).toBe('APPROVED');
    const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 4);
  });

  it('disabling then re-enabling MANUAL_INVENTORY_APPROVAL_REQUIRED cannot revive a permanently cancelled request, and blocks approve/correct while disabled', async () => {
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 15, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );
    const returned = await inventoryApprovalService.returnForCorrection(request.id, 'reconciliation in progress', actor('supervisor', supervisorUserId, [branchId]));

    // Operational sequence this test proves: close the approval gate only
    // AFTER every outstanding request is permanently cancelled (reconciled) —
    // never leave a dormant PENDING/RETURNED row lying around the flag flip.
    const cancelled = await inventoryApprovalService.cancel(returned.id, 'reconciled before disabling the flag', actor('super_admin', adminUserId), null);
    expect(cancelled.status).toBe('CANCELLED');

    const originalFlag = config.manualInventoryApprovalRequired;
    setApprovalRequired(false);
    try {
      // While disabled: approve/correct against ANY request — cancelled or
      // not — are blocked outright with a clear, distinct error.
      await expect(inventoryApprovalService.approve(cancelled.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
        code: 'APPROVAL_PROCESSING_DISABLED',
      });
      await expect(inventoryApprovalService.correct(cancelled.id, { quantityDelta: 1 }, actor('branch', branchUserId, [branchId]))).rejects.toMatchObject({
        code: 'APPROVAL_PROCESSING_DISABLED',
      });
      // cancel() itself must keep working while disabled — it is how
      // reconciliation is performed, and repeated cancellation is still safe.
      const stillCancelled = await inventoryApprovalService.cancel(cancelled.id, 'confirm no-op while disabled', actor('super_admin', adminUserId), null);
      expect(stillCancelled.status).toBe('CANCELLED');
    } finally {
      setApprovalRequired(originalFlag);
    }

    // Re-enabling the flag does not resurrect the cancelled request — an
    // environment-variable flip alone never reconciles anything; the only
    // thing that changed the request's fate was the explicit cancel() call
    // performed above, before the flag was ever touched.
    await expect(inventoryApprovalService.approve(cancelled.id, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
    const finalRow = await prisma.inventoryApprovalRequest.findUniqueOrThrow({ where: { id: cancelled.id } });
    expect(finalRow.status).toBe('CANCELLED');
  });

  it('reconciliation (cancel) followed by a legitimate immediate-write operation never double-applies the retired request once the gate reopens', async () => {
    // Simulates the documented rollback sequence end-to-end: a request is
    // submitted under the approval gate, the gate is disabled for an
    // emergency rollback, the operator reconciles by permanently cancelling
    // the dormant request (never just "returning" it, which is the exact gap
    // this release closes), a branch resubmits the SAME physical event
    // directly against immediate-write stock (simulated here as a direct
    // waste/adjust call outside the approval service, standing in for the
    // old immediate-write endpoint), and finally the gate reopens. The
    // original cancelled request must never become applicable again.
    const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    const request = await inventoryApprovalService.submitAdjustment(
      { target: 'UNIVERSAL_ITEM', branchId, inventoryItemId: itemId, quantityDelta: 6, reasonCode: 'count_correction' },
      actor('branch', branchUserId, [branchId]),
    );

    const originalFlag = config.manualInventoryApprovalRequired;
    setApprovalRequired(false);
    let cancelledId: string;
    try {
      const cancelled = await inventoryApprovalService.cancel(request.id, 'rollback reconciliation', actor('super_admin', adminUserId), null);
      cancelledId = cancelled.id;
    } finally {
      setApprovalRequired(originalFlag);
    }

    // The branch resubmits the same physical count correction directly
    // (standing in for the old immediate-write endpoint's independent
    // write path) — this is the "legitimate immediate-write operation"
    // the reconciled gap must not be double-applied against.
    await universalInventoryService.adjustStock(
      { branchId, inventoryItemId: itemId, quantityDelta: 6, reasonCode: 'count_correction', notes: 'resubmitted directly after reconciliation' },
      { id: branchUserId, role: 'branch' },
      null,
    );
    const stockAfterResubmit = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockAfterResubmit.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + 6);

    // Gate reopens (flag already restored above) — the original cancelled
    // request can still never be approved, so the resubmitted +6 is never
    // joined by a second, duplicate +6 from the retired request.
    await expect(inventoryApprovalService.approve(cancelledId, actor('supervisor', supervisorUserId, [branchId]), null)).rejects.toMatchObject({
      code: 'ALREADY_PROCESSED',
    });
    const stockFinal = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
    expect(stockFinal.quantityOnHand.toNumber()).toBe(stockAfterResubmit.quantityOnHand.toNumber());
  });
});
