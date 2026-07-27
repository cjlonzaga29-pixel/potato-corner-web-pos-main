import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Integration-style tests against the real dev database — same rationale as
 * R4/R5's suites: eligibility assessment reads live target rows
 * (InventoryCategory/UnitOfMeasure/UnitConversion/InventoryItem) and other
 * runs' InitializationRecord rows, none of which is meaningfully mockable.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency, per established R4/R5 precedent.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { computeFingerprint } = await import('./fingerprint.js');
const {
  assessRollbackEligibility,
  REUSED_RECORD_NEVER_ELIGIBLE,
  TARGET_MODIFIED_AFTER_INITIALIZATION,
  DOWNSTREAM_REFERENCE_EXISTS,
  CROSS_RUN_DEPENDENCY_EXISTS,
} = await import('./rollback-assessment.service.js');

describe.skipIf(!canRunIntegrationTests)('rollback-assessment.service integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdUnitIds: string[] = [];
  const createdConversionIds: string[] = [];
  const createdItemIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r9-rollback-assessment-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R9',
        lastName: 'Rollback Assessment Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // FK-restrict-safe deletion order: InventoryItem/UnitConversion first
    // (they reference categories/units), then categories/units, then
    // InitializationRecord rows, then runs, then the user.
    await prisma.inventoryItem.deleteMany({ where: { id: { in: createdItemIds } } });
    await prisma.unitConversion.deleteMany({ where: { id: { in: createdConversionIds } } });
    await prisma.inventoryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: createdUnitIds } } });
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createRun(): Promise<{ id: string }> {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r9-test-${randomUUID()}`,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'test-fingerprint',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        executionMode: 'DRY_RUN',
        status: 'PLANNED',
        initiatedBy: userId,
      },
    });
    createdRunIds.push(run.id);
    return { id: run.id };
  }

  async function createCategory(overrides: Partial<{ name: string; code: string | null; description: string | null; isActive: boolean }> = {}) {
    const category = await prisma.inventoryCategory.create({
      data: {
        name: overrides.name ?? `r9-category-${randomUUID()}`,
        code: overrides.code ?? null,
        description: overrides.description ?? null,
        isActive: overrides.isActive ?? true,
      },
    });
    createdCategoryIds.push(category.id);
    return category;
  }

  async function createUnit(overrides: Partial<{ code: string; name: string; dimension: 'WEIGHT' | 'VOLUME' | 'COUNT'; isBaseUnit: boolean; isActive: boolean }> = {}) {
    const unit = await prisma.unitOfMeasure.create({
      data: {
        code: overrides.code ?? `r9-unit-${randomUUID()}`,
        name: overrides.name ?? `R9 Unit ${randomUUID()}`,
        dimension: overrides.dimension ?? 'WEIGHT',
        isBaseUnit: overrides.isBaseUnit ?? false,
        isActive: overrides.isActive ?? true,
      },
    });
    createdUnitIds.push(unit.id);
    return unit;
  }

  async function createConversion(fromUnitId: string, toUnitId: string, factor: string) {
    const conversion = await prisma.unitConversion.create({
      data: { fromUnitId, toUnitId, factor },
    });
    createdConversionIds.push(conversion.id);
    return conversion;
  }

  async function createInventoryItem(baseUnitId: string, categoryId: string | null) {
    const item = await prisma.inventoryItem.create({
      data: {
        name: `r9-item-${randomUUID()}`,
        baseUnitId,
        categoryId,
      },
    });
    createdItemIds.push(item.id);
    return item;
  }

  /** Creates a VALIDATED-then-transitioned InitializationRecord row directly, bypassing R4/R5's transaction-scoped services (this suite only needs the resulting row shape, not the apply orchestration). */
  async function createRecord(params: {
    runId: string;
    entityType: 'INVENTORY_CATEGORY' | 'UNIT_OF_MEASURE' | 'UNIT_CONVERSION';
    entityId: string | null;
    action: 'CREATED' | 'REUSED' | 'BLOCKED' | 'SKIPPED' | 'FAILED';
    createdByRun: boolean;
    reusedExisting: boolean;
    resultingFingerprint?: string | null;
  }) {
    return prisma.initializationRecord.create({
      data: {
        initializationRunId: params.runId,
        manifestEntryKey: `entry-${randomUUID()}`,
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        createdByRun: params.createdByRun,
        reusedExisting: params.reusedExisting,
        resultingFingerprint: params.resultingFingerprint ?? null,
        version: 1,
      },
    });
  }

  it('a REUSED record is BLOCKED unconditionally, even with a matching fingerprint and zero downstream references', async () => {
    const run = await createRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'REUSED',
      createdByRun: false,
      reusedExisting: true,
      resultingFingerprint: fp,
    });

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(REUSED_RECORD_NEVER_ELIGIBLE);
  });

  it('a CREATED record whose live target row was mutated is BLOCKED with TARGET_MODIFIED_AFTER_INITIALIZATION', async () => {
    const run = await createRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    // Mutate the live row directly, out of band, so its recomputed
    // fingerprint no longer matches resultingFingerprint.
    await prisma.inventoryCategory.update({ where: { id: category.id }, data: { name: 'mutated-name' } });

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(TARGET_MODIFIED_AFTER_INITIALIZATION);
    expect(assessed?.currentVerificationFingerprint).not.toBe(fp);
  });

  it('a CREATED record whose live target row was deleted out-of-band is BLOCKED with TARGET_MODIFIED_AFTER_INITIALIZATION', async () => {
    const run = await createRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    // Remove it from our own cleanup list AND delete it now, so afterAll
    // doesn't try to delete it again.
    createdCategoryIds.splice(createdCategoryIds.indexOf(category.id), 1);
    await prisma.inventoryCategory.delete({ where: { id: category.id } });

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(TARGET_MODIFIED_AFTER_INITIALIZATION);
    expect(assessed?.currentVerificationFingerprint).toBeNull();
  });

  it('a CREATED UNIT_OF_MEASURE record with a live InventoryItem.baseUnitId reference is BLOCKED with DOWNSTREAM_REFERENCE_EXISTS', async () => {
    const run = await createRun();
    const unit = await createUnit();
    const fp = computeFingerprint('UnitOfMeasure', unit, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unit.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    await createInventoryItem(unit.id, null);

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(DOWNSTREAM_REFERENCE_EXISTS);
  });

  it('a CREATED UNIT_OF_MEASURE record with a live UnitConversion.fromUnitId reference is BLOCKED with DOWNSTREAM_REFERENCE_EXISTS', async () => {
    const run = await createRun();
    const unitA = await createUnit();
    const unitB = await createUnit();
    const fp = computeFingerprint('UnitOfMeasure', unitA, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'UNIT_OF_MEASURE',
      entityId: unitA.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    await createConversion(unitA.id, unitB.id, '1000');

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(DOWNSTREAM_REFERENCE_EXISTS);
  });

  it('a CREATED INVENTORY_CATEGORY record with a live InventoryItem.categoryId reference is BLOCKED with DOWNSTREAM_REFERENCE_EXISTS', async () => {
    const run = await createRun();
    const unit = await createUnit();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    await createInventoryItem(unit.id, category.id);

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(DOWNSTREAM_REFERENCE_EXISTS);
  });

  it('a CREATED UNIT_CONVERSION record always passes the downstream-reference check (nothing in the schema FKs to UnitConversion)', async () => {
    const run = await createRun();
    const unitA = await createUnit();
    const unitB = await createUnit();
    const conversion = await createConversion(unitA.id, unitB.id, '1000');
    const fp = computeFingerprint('UnitConversion', conversion, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'UNIT_CONVERSION',
      entityId: conversion.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('ELIGIBLE');
    expect(assessed?.rollbackBlockedReason).toBeNull();
  });

  it('a CREATED record referenced by another run\'s REUSED record for the same entityId is BLOCKED with CROSS_RUN_DEPENDENCY_EXISTS', async () => {
    const firstRun = await createRun();
    const secondRun = await createRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: firstRun.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    // The second run's manifest resolved to the SAME existing target row.
    await createRecord({
      runId: secondRun.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'REUSED',
      createdByRun: false,
      reusedExisting: true,
      resultingFingerprint: fp,
    });

    const results = await assessRollbackEligibility(firstRun.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('BLOCKED');
    expect(assessed?.rollbackBlockedReason).toBe(CROSS_RUN_DEPENDENCY_EXISTS);
  });

  it('a CREATED record with matching fingerprint, no downstream reference, and no cross-run dependency is ELIGIBLE', async () => {
    const run = await createRun();
    const category = await createCategory();
    const fp = computeFingerprint('InventoryCategory', category, 1).hash;

    const record = await createRecord({
      runId: run.id,
      entityType: 'INVENTORY_CATEGORY',
      entityId: category.id,
      action: 'CREATED',
      createdByRun: true,
      reusedExisting: false,
      resultingFingerprint: fp,
    });

    const results = await assessRollbackEligibility(run.id);
    const assessed = results.find((r) => r.id === record.id);
    expect(assessed?.rollbackEligibility).toBe('ELIGIBLE');
    expect(assessed?.rollbackBlockedReason).toBeNull();
    expect(assessed?.currentVerificationFingerprint).toBe(fp);
  });

  it('BLOCKED/SKIPPED/FAILED records (no entityId) are left unassessed — rollbackEligibility stays null', async () => {
    const run = await createRun();
    const actions = ['BLOCKED', 'SKIPPED', 'FAILED'] as const;
    const recordIds: string[] = [];
    for (const action of actions) {
      const record = await createRecord({
        runId: run.id,
        entityType: 'INVENTORY_CATEGORY',
        entityId: null,
        action,
        createdByRun: false,
        reusedExisting: false,
      });
      recordIds.push(record.id);
    }

    const results = await assessRollbackEligibility(run.id);
    for (const id of recordIds) {
      const assessed = results.find((r) => r.id === id);
      expect(assessed?.rollbackEligibility).toBeNull();
      expect(assessed?.rollbackBlockedReason).toBeNull();
      expect(assessed?.currentVerificationFingerprint).toBeNull();
    }
  });
});
