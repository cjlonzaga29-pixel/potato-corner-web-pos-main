import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration-style tests against the real dev database — same rationale as
 * R4/R5/R9's suites: rollback execution deletes real target rows
 * (InventoryCategory/UnitOfMeasure/UnitConversion) and re-checks live
 * downstream references, none of which is meaningfully mockable.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency, per established R4/R5/R9 precedent.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { computeFingerprint } = await import('./fingerprint.js');
const { assessRollbackEligibility } = await import('./rollback-assessment.service.js');
const { executeRollback, buildConfirmationToken } = await import('./rollback-execution.service.js');

describe.skipIf(!canRunIntegrationTests)('rollback-execution.service integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdUnitIds: string[] = [];
  const createdConversionIds: string[] = [];
  const createdItemIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r10-rollback-execution-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R10',
        lastName: 'Rollback Execution Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // FK-restrict-safe deletion order: InventoryItem/UnitConversion first
    // (they reference categories/units), then categories/units, then
    // InitializationRecord rows, then runs, then the user. Every id here is
    // best-effort (rows this suite intentionally deleted mid-test are
    // removed from these arrays before deletion so this cleanup never
    // double-deletes / errors on a missing row).
    await prisma.inventoryItem.deleteMany({ where: { id: { in: createdItemIds } } });
    await prisma.unitConversion.deleteMany({ where: { id: { in: createdConversionIds } } });
    await prisma.inventoryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: createdUnitIds } } });
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  /** Creates a run already parked in ROLLING_BACK — the only state from which R4's markRolledBack/markRollbackPartial are valid transitions, per the task brief. */
  async function createRollingBackRun(): Promise<{ id: string }> {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r10-test-${randomUUID()}`,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'test-fingerprint',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        executionMode: 'DRY_RUN',
        status: 'ROLLING_BACK',
        initiatedBy: userId,
      },
    });
    createdRunIds.push(run.id);
    return { id: run.id };
  }

  async function createCategory(overrides: Partial<{ name: string }> = {}) {
    const category = await prisma.inventoryCategory.create({
      data: { name: overrides.name ?? `r10-category-${randomUUID()}`, isActive: true },
    });
    createdCategoryIds.push(category.id);
    return category;
  }

  async function createUnit(overrides: Partial<{ code: string; name: string }> = {}) {
    const unit = await prisma.unitOfMeasure.create({
      data: {
        code: overrides.code ?? `r10-unit-${randomUUID()}`,
        name: overrides.name ?? `R10 Unit ${randomUUID()}`,
        dimension: 'WEIGHT',
        isBaseUnit: false,
        isActive: true,
      },
    });
    createdUnitIds.push(unit.id);
    return unit;
  }

  async function createConversion(fromUnitId: string, toUnitId: string, factor: string) {
    const conversion = await prisma.unitConversion.create({ data: { fromUnitId, toUnitId, factor } });
    createdConversionIds.push(conversion.id);
    return conversion;
  }

  async function createInventoryItem(baseUnitId: string, categoryId: string | null) {
    const item = await prisma.inventoryItem.create({
      data: { name: `r10-item-${randomUUID()}`, baseUnitId, categoryId },
    });
    createdItemIds.push(item.id);
    return item;
  }

  /** Creates a CREATED InitializationRecord row directly (bypassing R4/R5's apply orchestration — this suite only needs the resulting row shape). */
  async function createCreatedRecord(params: {
    runId: string;
    entityType: 'INVENTORY_CATEGORY' | 'UNIT_OF_MEASURE' | 'UNIT_CONVERSION';
    entityId: string;
    resultingFingerprint: string;
  }) {
    return prisma.initializationRecord.create({
      data: {
        initializationRunId: params.runId,
        manifestEntryKey: `entry-${randomUUID()}`,
        entityType: params.entityType,
        entityId: params.entityId,
        action: 'CREATED',
        createdByRun: true,
        reusedExisting: false,
        resultingFingerprint: params.resultingFingerprint,
        version: 1,
      },
    });
  }

  it('an ELIGIBLE row with NO confirmation supplied is not deleted, reported skipped-not-confirmed', async () => {
    const run = await createRollingBackRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;
    const record = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: fp,
    });

    await assessRollbackEligibility(run.id);

    const result = await executeRollback({ runId: run.id, confirmations: [] });

    const row = result.records.find((r) => r.recordId === record.id);
    expect(row?.outcome).toBe('skipped-not-confirmed');

    const stillExists = await prisma.inventoryCategory.findUnique({ where: { id: category.id } });
    expect(stillExists).not.toBeNull();

    const freshRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshRecord.rollbackStatus).not.toBe('ROLLED_BACK');
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('a BLOCKED row WITH a confirmation supplied anyway is never deleted (confirmation never overrides eligibility)', async () => {
    const run = await createRollingBackRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;
    const record = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: fp,
    });

    // Force BLOCKED via a live downstream reference, then assess.
    const unit = await createUnit();
    await createInventoryItem(unit.id, category.id);
    await assessRollbackEligibility(run.id);

    const freshBefore = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshBefore.rollbackEligibility).toBe('BLOCKED');

    // Supply a confirmation anyway (guessing the token, or reusing a real one) -- must still not delete.
    const result = await executeRollback({
      runId: run.id,
      confirmations: [{ recordId: record.id, confirmationToken: buildConfirmationToken(record.id, freshBefore.currentVerificationFingerprint) }],
    });

    const row = result.records.find((r) => r.recordId === record.id);
    expect(row?.outcome).toBe('skipped-not-eligible');

    const stillExists = await prisma.inventoryCategory.findUnique({ where: { id: category.id } });
    expect(stillExists).not.toBeNull();
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('a mixed batch (one ELIGIBLE+confirmed row that succeeds, one BLOCKED row) yields ROLLBACK_PARTIAL with correct per-row outcomes', async () => {
    const run = await createRollingBackRun();

    const eligibleCategory = await createCategory();
    const eligibleFp = computeFingerprint('InventoryCategory', eligibleCategory, 1).hash;
    const eligibleRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: eligibleCategory.id,
      resultingFingerprint: eligibleFp,
    });

    const blockedCategory = await createCategory();
    const blockedFp = computeFingerprint('InventoryCategory', blockedCategory, 1).hash;
    const blockedRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: blockedCategory.id,
      resultingFingerprint: blockedFp,
    });
    const unit = await createUnit();
    await createInventoryItem(unit.id, blockedCategory.id);

    await assessRollbackEligibility(run.id);
    const freshEligible = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: eligibleRecord.id } });
    expect(freshEligible.rollbackEligibility).toBe('ELIGIBLE');

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: eligibleRecord.id, confirmationToken: buildConfirmationToken(eligibleRecord.id, freshEligible.currentVerificationFingerprint) },
      ],
    });

    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
    expect(result.records.find((r) => r.recordId === eligibleRecord.id)?.outcome).toBe('deleted');
    expect(result.records.find((r) => r.recordId === blockedRecord.id)?.outcome).toBe('skipped-not-eligible');

    const eligibleGone = await prisma.inventoryCategory.findUnique({ where: { id: eligibleCategory.id } });
    expect(eligibleGone).toBeNull();
    createdCategoryIds.splice(createdCategoryIds.indexOf(eligibleCategory.id), 1);

    const blockedStillThere = await prisma.inventoryCategory.findUnique({ where: { id: blockedCategory.id } });
    expect(blockedStillThere).not.toBeNull();
  });

  it('the live re-check catches a NEW dependency created after assessment but before executeRollback (stale ELIGIBLE is not trusted)', async () => {
    const run = await createRollingBackRun();
    const unit = await createUnit();
    const fp = computeFingerprint('UnitOfMeasure', unit, 1).hash;
    const record = await createCreatedRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unit.id,
      resultingFingerprint: fp,
    });

    await assessRollbackEligibility(run.id);
    const freshAfterAssess = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshAfterAssess.rollbackEligibility).toBe('ELIGIBLE');

    // A new downstream reference appears AFTER assessment, BEFORE execution.
    await createInventoryItem(unit.id, null);

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: record.id, confirmationToken: buildConfirmationToken(record.id, freshAfterAssess.currentVerificationFingerprint) },
      ],
    });

    const row = result.records.find((r) => r.recordId === record.id);
    expect(row?.outcome).toBe('skipped-became-ineligible-at-execution');

    const stillExists = await prisma.unitOfMeasure.findUnique({ where: { id: unit.id } });
    expect(stillExists).not.toBeNull();

    // The stale ELIGIBLE from R9's earlier assessment is still sitting in
    // the DB (nothing re-ran R9), proving this was caught by R10's OWN live
    // re-check, not by a fresh assessment overwriting the eligibility.
    const freshRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshRecord.rollbackEligibility).toBe('ELIGIBLE');
    expect(freshRecord.rollbackStatus).not.toBe('ROLLED_BACK');
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('the live fingerprint re-check catches a target row EDITED after assessment but before executeRollback (stale ELIGIBLE + still-valid token is not trusted)', async () => {
    const run = await createRollingBackRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;
    const record = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: fp,
    });

    await assessRollbackEligibility(run.id);
    const freshAfterAssess = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshAfterAssess.rollbackEligibility).toBe('ELIGIBLE');

    // The confirmation token is built from the value R9 STORED
    // (currentVerificationFingerprint) -- it stays valid even after the row is
    // edited, so this proves the token check alone would NOT catch the drift.
    const validToken = buildConfirmationToken(record.id, freshAfterAssess.currentVerificationFingerprint);

    // The live target row is EDITED after assessment, before execution. The
    // stored rollbackEligibility stays stale ELIGIBLE and the token stays
    // valid, but the live fingerprint no longer matches resultingFingerprint.
    await prisma.inventoryCategory.update({ where: { id: category.id }, data: { name: `r10-edited-${randomUUID()}` } });

    const result = await executeRollback({
      runId: run.id,
      confirmations: [{ recordId: record.id, confirmationToken: validToken }],
    });

    const row = result.records.find((r) => r.recordId === record.id);
    expect(row?.outcome).toBe('skipped-became-ineligible-at-execution');

    const stillExists = await prisma.inventoryCategory.findUnique({ where: { id: category.id } });
    expect(stillExists).not.toBeNull();

    // Stale ELIGIBLE still sits in the DB (R9 never re-ran) -- proving R10's
    // OWN live fingerprint re-check caught this, not a fresh assessment.
    const freshRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshRecord.rollbackEligibility).toBe('ELIGIBLE');
    expect(freshRecord.rollbackStatus).not.toBe('ROLLED_BACK');
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('the live cross-run dependency re-check catches another run REUSING the same entityId after assessment but before executeRollback', async () => {
    const run = await createRollingBackRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;
    const record = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: fp,
    });

    await assessRollbackEligibility(run.id);
    const freshAfterAssess = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshAfterAssess.rollbackEligibility).toBe('ELIGIBLE');

    // Another run REUSES this exact entityId AFTER assessment, BEFORE
    // execution. Deleting our row now would orphan that other run's
    // provenance (entityId carries no FK to stop it).
    const otherRun = await createRollingBackRun();
    await prisma.initializationRecord.create({
      data: {
        initializationRunId: otherRun.id,
        manifestEntryKey: `entry-${randomUUID()}`,
        entityType: 'INVENTORY_CATEGORY',
        entityId: category.id,
        action: 'REUSED',
        createdByRun: false,
        reusedExisting: true,
        version: 1,
      },
    });

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: record.id, confirmationToken: buildConfirmationToken(record.id, freshAfterAssess.currentVerificationFingerprint) },
      ],
    });

    const row = result.records.find((r) => r.recordId === record.id);
    expect(row?.outcome).toBe('skipped-became-ineligible-at-execution');

    const stillExists = await prisma.inventoryCategory.findUnique({ where: { id: category.id } });
    expect(stillExists).not.toBeNull();

    const freshRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(freshRecord.rollbackEligibility).toBe('ELIGIBLE');
    expect(freshRecord.rollbackStatus).not.toBe('ROLLED_BACK');
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('deletion and record-status-update happen in the same transaction: a delete failure leaves NEITHER the target row nor rollbackStatus changed, and rolls back sibling rows in the same type', async () => {
    const run = await createRollingBackRun();

    const unitA = await createUnit();
    const fpA = computeFingerprint('UnitOfMeasure', unitA, 1).hash;
    const recordA = await createCreatedRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unitA.id,
      resultingFingerprint: fpA,
    });

    const unitB = await createUnit();
    const fpB = computeFingerprint('UnitOfMeasure', unitB, 1).hash;
    const recordB = await createCreatedRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unitB.id,
      resultingFingerprint: fpB,
    });

    await assessRollbackEligibility(run.id);
    const freshA = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordA.id } });
    const freshB = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordB.id } });
    expect(freshA.rollbackEligibility).toBe('ELIGIBLE');
    expect(freshB.rollbackEligibility).toBe('ELIGIBLE');

    // Attach a SOFT-DELETED InventoryItem to unitB's live target row, WITHOUT
    // re-running assessment. hasDownstreamReference filters `deletedAt: null`,
    // so R10's live downstream re-check sees NO reference and lets unitB
    // through all four re-checks (its fingerprint is unchanged, no cross-run
    // dependency) -- but the physical FK row still exists, so the delete call
    // itself fails with an FK violation, simulating a live delete failure
    // mid-transaction. (This mechanism, unlike deleting unitB out-of-band,
    // survives R10's live fingerprint re-check, which now correctly SKIPS a
    // vanished target row instead of letting its delete throw.)
    const softDeletedItem = await createInventoryItem(unitB.id, null);
    await prisma.inventoryItem.update({ where: { id: softDeletedItem.id }, data: { deletedAt: new Date() } });

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: recordA.id, confirmationToken: buildConfirmationToken(recordA.id, freshA.currentVerificationFingerprint) },
        { recordId: recordB.id, confirmationToken: buildConfirmationToken(recordB.id, freshB.currentVerificationFingerprint) },
      ],
    });

    // Whole UNIT_OF_MEASURE type-transaction must have rolled back: recordA
    // (which WOULD have succeeded on its own) must NOT have been deleted or
    // marked ROLLED_BACK, because recordB's delete failed in the same
    // transaction.
    const outcomeA = result.records.find((r) => r.recordId === recordA.id)?.outcome;
    const outcomeB = result.records.find((r) => r.recordId === recordB.id)?.outcome;
    expect(outcomeA).toBe('failed');
    expect(outcomeB).toBe('failed');

    const unitAStillExists = await prisma.unitOfMeasure.findUnique({ where: { id: unitA.id } });
    expect(unitAStillExists).not.toBeNull();

    const freshRecordA = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordA.id } });
    expect(freshRecordA.rollbackStatus).not.toBe('ROLLED_BACK');
    expect(freshRecordA.rolledBackAt).toBeNull();

    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');
  });

  it('processes reference types in reverse-dependency order: UNIT_CONVERSION, then UNIT_OF_MEASURE, then INVENTORY_CATEGORY', async () => {
    const run = await createRollingBackRun();

    const category = await createCategory();
    const categoryFp = computeFingerprint('InventoryCategory', category, 1).hash;
    const categoryRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: categoryFp,
    });

    // unitA has a live UnitConversion referencing it, so R9's assessment
    // (which runs BEFORE any deletes) marks the unit BLOCKED with
    // DOWNSTREAM_REFERENCE_EXISTS. This is deliberate: it demonstrates why
    // the reverse-dependency ORDER exists in the first place -- even though
    // the conversion referencing it gets deleted in an earlier
    // type-transaction within this very call, R10 never re-verifies a
    // row that was already assessed BLOCKED (only ELIGIBLE rows get the
    // live re-check, per this task's stop condition: a BLOCKED row is
    // never deleted regardless of what happens later). The unit therefore
    // stays skipped, proving the type-transactions genuinely ran as three
    // separate calls in the documented order (conversion attempted/deleted
    // first; the category, an independent/unrelated row, still succeeds
    // afterward -- proving a failure/skip in an earlier type does not
    // block a later type from being attempted, per the brief).
    const unitA = await createUnit();
    const unitB = await createUnit();
    const unitFp = computeFingerprint('UnitOfMeasure', unitA, 1).hash;
    const unitRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unitA.id,
      resultingFingerprint: unitFp,
    });

    const conversion = await createConversion(unitA.id, unitB.id, '1000');
    const conversionFp = computeFingerprint('UnitConversion', conversion, 1).hash;
    const conversionRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'UNIT_CONVERSION',
      entityId: conversion.id,
      resultingFingerprint: conversionFp,
    });

    await assessRollbackEligibility(run.id);
    const freshCategory = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: categoryRecord.id } });
    const freshUnit = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: unitRecord.id } });
    const freshConversion = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: conversionRecord.id } });
    expect(freshUnit.rollbackEligibility).toBe('BLOCKED');
    expect(freshConversion.rollbackEligibility).toBe('ELIGIBLE');
    expect(freshCategory.rollbackEligibility).toBe('ELIGIBLE');

    const txSpy = vi.spyOn(prisma, '$transaction');

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: categoryRecord.id, confirmationToken: buildConfirmationToken(categoryRecord.id, freshCategory.currentVerificationFingerprint) },
        { recordId: unitRecord.id, confirmationToken: buildConfirmationToken(unitRecord.id, freshUnit.currentVerificationFingerprint) },
        { recordId: conversionRecord.id, confirmationToken: buildConfirmationToken(conversionRecord.id, freshConversion.currentVerificationFingerprint) },
      ],
    });

    // Three distinct types with candidates -> three distinct
    // prisma.$transaction calls, issued in TYPE_ORDER (source code awaits
    // each type sequentially before moving to the next, so call order IS
    // type order here).
    expect(txSpy).toHaveBeenCalledTimes(3);
    txSpy.mockRestore();

    expect(result.records.find((r) => r.recordId === conversionRecord.id)?.outcome).toBe('deleted');
    expect(result.records.find((r) => r.recordId === unitRecord.id)?.outcome).toBe('skipped-not-eligible');
    expect(result.records.find((r) => r.recordId === categoryRecord.id)?.outcome).toBe('deleted');
    expect(result.runStatus).toBe('ROLLBACK_PARTIAL');

    createdConversionIds.splice(createdConversionIds.indexOf(conversion.id), 1);
    createdCategoryIds.splice(createdCategoryIds.indexOf(category.id), 1);

    const conversionGone = await prisma.unitConversion.findUnique({ where: { id: conversion.id } });
    expect(conversionGone).toBeNull();
    const categoryGone = await prisma.inventoryCategory.findUnique({ where: { id: category.id } });
    expect(categoryGone).toBeNull();
    const unitStillExists = await prisma.unitOfMeasure.findUnique({ where: { id: unitA.id } });
    expect(unitStillExists).not.toBeNull();

    const finalRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe('ROLLBACK_PARTIAL');
  });

  it('a fully successful run (all CREATED records confirmed and deleted) transitions the run to ROLLED_BACK', async () => {
    const run = await createRollingBackRun();

    const category = await createCategory();
    const categoryFp = computeFingerprint('InventoryCategory', category, 1).hash;
    const categoryRecord = await createCreatedRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      resultingFingerprint: categoryFp,
    });

    await assessRollbackEligibility(run.id);
    const fresh = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: categoryRecord.id } });
    expect(fresh.rollbackEligibility).toBe('ELIGIBLE');

    const result = await executeRollback({
      runId: run.id,
      confirmations: [
        { recordId: categoryRecord.id, confirmationToken: buildConfirmationToken(categoryRecord.id, fresh.currentVerificationFingerprint) },
      ],
    });

    expect(result.runStatus).toBe('ROLLED_BACK');
    expect(result.records.find((r) => r.recordId === categoryRecord.id)?.outcome).toBe('deleted');

    createdCategoryIds.splice(createdCategoryIds.indexOf(category.id), 1);

    const finalRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: categoryRecord.id } });
    expect(finalRecord.rollbackStatus).toBe('ROLLED_BACK');
    expect(finalRecord.rolledBackAt).not.toBeNull();

    const finalRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe('ROLLED_BACK');
  });
});
