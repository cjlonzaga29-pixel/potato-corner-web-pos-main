import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma, type InitializationEntityType } from '@prisma/client';
import type { ApplyAction } from './record-writer.service.js';

/**
 * CR-009 R13 — End-to-end validation of the durable initialization-audit
 * substrate.
 *
 * There is no real "apply orchestration" module yet (Phase C0's RC7 is a
 * separate, later task — see `apply-integration-contract.md`). So, exactly
 * as R8's contract documents and R13's brief instructs, THIS TEST FILE plays
 * the role of a minimal apply orchestrator: the `simulateApply` helper below
 * composes R3–R12's already-committed functions in R8's documented sequence
 * (acquire lock (R6) -> transition run to APPLYING (R4) -> per reference type
 * one transaction containing both the target-table write and R5's
 * `transitionRecordOnApply` -> final APPLIED / APPLY_FAILED transition (R4)).
 *
 * This is TEST CODE exercising the substrate end-to-end — it is intentionally
 * NOT extracted into a production `initialization-audit/*.ts` service. Every
 * InventoryCategory/UnitOfMeasure/UnitConversion/InventoryItem row created
 * here is scoped, temporary, uniquely-named test fixture data against the
 * dev/test database, cleaned up in FK-safe order in afterAll — the same
 * pattern R9/R10/R11's own integration tests already use.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`, a stale
 * pre-Phase-21 pattern) — this module has no Redis dependency.
 *
 * --- Two documented judgment calls the brief left open --------------------
 *
 * Scenario A ("incompatible unit"): a manifest UNIT_OF_MEASURE entry declares
 * a target `dimension`. The existing DB row shares the manifest entry's
 * natural key (unit code) but has a DIFFERENT `dimension`. Since a unit's
 * dimension is its fundamental classification (WEIGHT vs COUNT vs VOLUME),
 * a dimension mismatch means the existing row is NOT the same unit the
 * manifest describes and cannot be safely reused — apply resolves the entry
 * to BLOCKED, entityId = null. (Chosen incompatibility check: `dimension`
 * inequality.)
 *
 * Scenario B (FAILED under transaction rollback): a whole `prisma.$transaction`
 * rolls back atomically, so a mid-type failure cannot leave a partially
 * committed FAILED record inside that same rolled-back transaction. Chosen
 * approach: when the per-type transaction throws, catch it, then record
 * `action = FAILED` (entityId = null) for each of that type's entries via a
 * SEPARATE, fresh `transitionRecordOnApply` transaction, then transition the
 * run to APPLY_FAILED. This mirrors R11's reconciliation model (a FAILED
 * record + an APPLY_FAILED run) and keeps the durable FAILED provenance row
 * that a later retry (a brand-new run with a new migrationBatch) reconciles
 * against by the same `manifestEntryKey`.
 *
 * --- The two R8-documented open questions, and how this helper handles them
 *
 * (1) "The lock does not span the whole multi-transaction sequence." Handled
 *     per R8's third named option: the lock covers each per-type transaction
 *     individually (each `withInitializationLock` call), and the run-status
 *     transitions (startApplying/markApplied/markApplyFailed) run as their own
 *     root-`prisma` calls outside it — relying on the layered CAS + unique-
 *     constraint defenses CR-009's concurrency strategy already describes.
 * (2) "No distinct 'still APPLYING, next type' R4 status." Handled the only
 *     way R4 currently allows: APPLYING is a single status covering the whole
 *     multi-type sequence; the helper does not attempt an inter-type status
 *     write (none exists), it simply proceeds type-by-type and makes the one
 *     final APPLIED/APPLY_FAILED transition at the end.
 */

const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { FINGERPRINT_VERSION, computeFingerprint } = await import('./fingerprint.js');
const {
  normalizeNaturalKeySegment,
  buildInventoryCategoryKey,
  buildUnitOfMeasureKey,
  buildUnitConversionKey,
  validateManifestNoDuplicateKeys,
} = await import('./manifest-entry-key.js');
const { recordDryRunRun } = await import('./dry-run-contract.js');
const { withInitializationLock } = await import('./advisory-lock.js');
const { transitionRecordOnApply } = await import('./record-writer.service.js');
const {
  startApplying,
  markApplied,
  markApplyFailed,
  startRollbackAssessment,
  startRollingBack,
} = await import('./run-lifecycle.service.js');
const { assessRollbackEligibility, DOWNSTREAM_REFERENCE_EXISTS } = await import(
  './rollback-assessment.service.js'
);
const { executeRollback, buildConfirmationToken } = await import('./rollback-execution.service.js');

/** Maps the InitializationEntityType enum to R3's computeFingerprint entity-type keys (same map R9 uses). */
const FINGERPRINT_ENTITY_TYPE: Record<InitializationEntityType, string> = {
  INVENTORY_CATEGORY: 'InventoryCategory',
  UNIT_OF_MEASURE: 'UnitOfMeasure',
  UNIT_CONVERSION: 'UnitConversion',
};

/** Phase C0's fixed reference-type order: categories -> units -> conversions. */
const TYPE_ORDER: readonly InitializationEntityType[] = [
  'INVENTORY_CATEGORY',
  'UNIT_OF_MEASURE',
  'UNIT_CONVERSION',
];

describe.skipIf(!canRunIntegrationTests)('CR-009 R13 initialization-audit end-to-end', () => {
  /** First element of an array asserted non-empty (avoids `!` under noUncheckedIndexedAccess). */
  function firstOf<T>(arr: readonly T[]): T {
    const [head] = arr;
    if (head === undefined) throw new Error('expected a non-empty array');
    return head;
  }

  /** The record whose manifestEntryKey matches, asserted present. */
  function recordFor<T extends { manifestEntryKey: string }>(records: readonly T[], key: string): T {
    const found = records.find((r) => r.manifestEntryKey === key);
    if (!found) throw new Error(`no record for manifestEntryKey ${key}`);
    return found;
  }

  let userId: string;
  const createdRunIds: string[] = [];
  const createdMigrationBatches: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdUnitIds: string[] = [];
  const createdConversionIds: string[] = [];
  const createdItemIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r13-e2e-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R13',
        lastName: 'E2E Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // FK-restrict-safe deletion order: items/conversions first (they
    // reference categories/units), then categories/units, then
    // InitializationRecord rows, then runs, then the user. All best-effort
    // (deleteMany tolerates rows already removed mid-test).
    await prisma.inventoryItem.deleteMany({ where: { id: { in: createdItemIds } } });
    await prisma.unitConversion.deleteMany({ where: { id: { in: createdConversionIds } } });
    await prisma.inventoryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: { in: createdUnitIds } } });
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { migrationBatch: { in: createdMigrationBatches } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  // --- Manifest-entry-key acceptance tests (CR-009.2) are pure and never
  // touch the DB, but every resolved entry that DOES touch the DB flows
  // through the same real key builders, so these establish the invariants
  // the rest of the suite relies on.

  // --- Test-local apply orchestrator -------------------------------------

  interface ResolvedOutcome {
    action: ApplyAction;
    entityId: string | null;
    createdByRun: boolean;
    reusedExisting: boolean;
    preexistingFingerprint?: string | null;
    resultingFingerprint?: string | null;
  }

  interface ApplyEntry {
    manifestEntryKey: string;
    entityType: InitializationEntityType;
    /**
     * Resolves this entry inside the per-type transaction: performs the
     * target-table write (if any) and returns the action/fingerprints for
     * `transitionRecordOnApply`. Throwing simulates a mid-apply failure
     * (Scenario B) — the whole type transaction then rolls back atomically.
     */
    resolve: (tx: Prisma.TransactionClient) => Promise<ResolvedOutcome>;
  }

  interface ApplyResult {
    status: 'APPLIED' | 'APPLY_FAILED';
    failedType?: InitializationEntityType;
  }

  /**
   * Composes R6/R4/R5 into R8's documented apply sequence. Drives a
   * DRY_RUN_VALIDATED run through APPLYING and per-type transactions to a
   * final APPLIED / APPLY_FAILED.
   */
  async function simulateApply(runId: string, entries: ApplyEntry[]): Promise<ApplyResult> {
    const run = await prisma.initializationRun.findUniqueOrThrow({ where: { id: runId } });
    const applyingRun = await startApplying({ runId, expectedVersion: run.version });
    const runVersion = applyingRun.version;

    for (const entityType of TYPE_ORDER) {
      const typeEntries = entries.filter((e) => e.entityType === entityType);
      if (typeEntries.length === 0) continue;

      try {
        // R6 lock covers this single per-type transaction (open-question #1).
        await withInitializationLock(async (tx) => {
          for (const entry of typeEntries) {
            const outcome = await entry.resolve(tx);
            const existing = await tx.initializationRecord.findUniqueOrThrow({
              where: {
                initializationRunId_manifestEntryKey: {
                  initializationRunId: runId,
                  manifestEntryKey: entry.manifestEntryKey,
                },
              },
            });
            await transitionRecordOnApply(tx, {
              runId,
              manifestEntryKey: entry.manifestEntryKey,
              action: outcome.action,
              entityId: outcome.entityId,
              createdByRun: outcome.createdByRun,
              reusedExisting: outcome.reusedExisting,
              expectedVersion: existing.version,
              preexistingFingerprint: outcome.preexistingFingerprint ?? null,
              resultingFingerprint: outcome.resultingFingerprint ?? null,
            });
          }
        });
      } catch (error) {
        // The whole per-type transaction rolled back atomically. Record
        // FAILED for each of this type's entries in a SEPARATE fresh
        // transaction (Scenario B chosen approach), then fail the run.
        for (const entry of typeEntries) {
          await prisma.$transaction(async (tx) => {
            const existing = await tx.initializationRecord.findUniqueOrThrow({
              where: {
                initializationRunId_manifestEntryKey: {
                  initializationRunId: runId,
                  manifestEntryKey: entry.manifestEntryKey,
                },
              },
            });
            if (existing.action !== 'VALIDATED') return; // already resolved, don't re-transition
            await transitionRecordOnApply(tx, {
              runId,
              manifestEntryKey: entry.manifestEntryKey,
              action: 'FAILED',
              entityId: null,
              createdByRun: false,
              reusedExisting: false,
              expectedVersion: existing.version,
            });
          });
        }
        await markApplyFailed({
          runId,
          expectedVersion: runVersion,
          failureReason: `apply failed at reference type ${entityType}: ${String(error)}`,
        });
        return { status: 'APPLY_FAILED', failedType: entityType };
      }
    }

    await markApplied({ runId, expectedVersion: runVersion });
    return { status: 'APPLIED' };
  }

  // --- Fixture / resolver factories --------------------------------------

  function fingerprintOf(entityType: InitializationEntityType, row: Record<string, unknown>): string {
    return computeFingerprint(FINGERPRINT_ENTITY_TYPE[entityType], row, FINGERPRINT_VERSION).hash;
  }

  /** Resolver: CREATE a fresh category with the given name. */
  function resolveCreateCategory(name: string): ApplyEntry['resolve'] {
    return async (tx) => {
      const created = await tx.inventoryCategory.create({ data: { name, isActive: true } });
      createdCategoryIds.push(created.id);
      return {
        action: 'CREATED',
        entityId: created.id,
        createdByRun: true,
        reusedExisting: false,
        resultingFingerprint: fingerprintOf('INVENTORY_CATEGORY', created),
      };
    };
  }

  /** Resolver: CREATE-or-REUSE a category by name (used for the concurrency test). */
  function resolveCreateOrReuseCategory(name: string): ApplyEntry['resolve'] {
    return async (tx) => {
      const existing = await tx.inventoryCategory.findFirst({ where: { name } });
      if (existing) {
        const fp = fingerprintOf('INVENTORY_CATEGORY', existing);
        return {
          action: 'REUSED',
          entityId: existing.id,
          createdByRun: false,
          reusedExisting: true,
          preexistingFingerprint: fp,
          resultingFingerprint: fp,
        };
      }
      const created = await tx.inventoryCategory.create({ data: { name, isActive: true } });
      createdCategoryIds.push(created.id);
      return {
        action: 'CREATED',
        entityId: created.id,
        createdByRun: true,
        reusedExisting: false,
        resultingFingerprint: fingerprintOf('INVENTORY_CATEGORY', created),
      };
    };
  }

  /** Resolver: REUSE a pre-existing category (Scenario C). */
  function resolveReuseCategory(categoryId: string): ApplyEntry['resolve'] {
    return async (tx) => {
      const existing = await tx.inventoryCategory.findUniqueOrThrow({ where: { id: categoryId } });
      const fp = fingerprintOf('INVENTORY_CATEGORY', existing);
      return {
        action: 'REUSED',
        entityId: existing.id,
        createdByRun: false,
        reusedExisting: true,
        preexistingFingerprint: fp,
        resultingFingerprint: fp,
      };
    };
  }

  /** Resolver: CREATE a fresh unit. */
  function resolveCreateUnit(code: string, dimension: 'WEIGHT' | 'VOLUME' | 'COUNT'): ApplyEntry['resolve'] {
    return async (tx) => {
      const created = await tx.unitOfMeasure.create({
        data: { code, name: `Unit ${code}`, dimension, isBaseUnit: false, isActive: true },
      });
      createdUnitIds.push(created.id);
      return {
        action: 'CREATED',
        entityId: created.id,
        createdByRun: true,
        reusedExisting: false,
        resultingFingerprint: fingerprintOf('UNIT_OF_MEASURE', created),
      };
    };
  }

  /**
   * Resolver: resolve a UNIT_OF_MEASURE entry against an existing row sharing
   * its natural key. Reuses iff the existing row's dimension matches the
   * manifest's declared dimension; otherwise BLOCKED (Scenario A's chosen
   * incompatibility check: dimension inequality).
   */
  function resolveUnitAgainstExisting(existingUnitId: string, manifestDimension: 'WEIGHT' | 'VOLUME' | 'COUNT'): ApplyEntry['resolve'] {
    return async (tx) => {
      const existing = await tx.unitOfMeasure.findUniqueOrThrow({ where: { id: existingUnitId } });
      if (existing.dimension !== manifestDimension) {
        return { action: 'BLOCKED', entityId: null, createdByRun: false, reusedExisting: false };
      }
      const fp = fingerprintOf('UNIT_OF_MEASURE', existing);
      return {
        action: 'REUSED',
        entityId: existing.id,
        createdByRun: false,
        reusedExisting: true,
        preexistingFingerprint: fp,
        resultingFingerprint: fp,
      };
    };
  }

  /** Resolver: CREATE a conversion between two existing units. */
  function resolveCreateConversion(fromUnitId: string, toUnitId: string, factor: string): ApplyEntry['resolve'] {
    return async (tx) => {
      const created = await tx.unitConversion.create({ data: { fromUnitId, toUnitId, factor } });
      createdConversionIds.push(created.id);
      return {
        action: 'CREATED',
        entityId: created.id,
        createdByRun: true,
        reusedExisting: false,
        resultingFingerprint: fingerprintOf('UNIT_CONVERSION', created),
      };
    };
  }

  /** Resolver that always throws before any target write (simulates mid-apply failure). */
  function resolveThrow(): ApplyEntry['resolve'] {
    return async () => {
      throw new Error('simulated mid-apply failure before target row creation');
    };
  }

  /** Runs a dry-run for one manifest and records ids for cleanup. */
  async function dryRun(entries: { manifestEntryKey: string; entityType: InitializationEntityType }[]) {
    const migrationBatch = `r13-${randomUUID()}`;
    createdMigrationBatches.push(migrationBatch);
    const result = await recordDryRunRun({
      migrationBatch,
      initializationType: 'REFERENCE_DATA',
      manifestVersion: 1,
      manifestFingerprint: `fp-${randomUUID()}`,
      manifestSnapshot: { entries },
      targetEnvironment: 'test',
      initiatedBy: userId,
      dryRunReportFingerprint: `report-${randomUUID()}`,
      manifestEntries: entries,
    });
    createdRunIds.push(result.run.id);
    return result;
  }

  async function createUnitFixture(code: string, dimension: 'WEIGHT' | 'VOLUME' | 'COUNT' = 'WEIGHT') {
    const unit = await prisma.unitOfMeasure.create({
      data: { code, name: `Unit ${code}`, dimension, isBaseUnit: false, isActive: true },
    });
    createdUnitIds.push(unit.id);
    return unit;
  }

  async function createCategoryFixture(name: string) {
    const category = await prisma.inventoryCategory.create({ data: { name, isActive: true } });
    createdCategoryIds.push(category.id);
    return category;
  }

  async function createItemFixture(baseUnitId: string, categoryId: string | null) {
    const item = await prisma.inventoryItem.create({
      data: { name: `r13-item-${randomUUID()}`, baseUnitId, categoryId },
    });
    createdItemIds.push(item.id);
    return item;
  }

  // ======================================================================
  // 1. Full lifecycle: dry-run -> apply -> verify -> downstream ref blocks
  //    rollback -> remove ref -> eligible -> rollback -> ROLLED_BACK.
  // ======================================================================
  it(
    'full lifecycle: dry-run -> apply -> downstream ref blocks rollback -> remove ref -> rollback to ROLLED_BACK',
    async () => {
      const catKey = buildInventoryCategoryKey(`Cat ${randomUUID()}`);
      const unitCode = `u-${randomUUID()}`;
      const unitKey = buildUnitOfMeasureKey(unitCode);
      const catName = `r13-lifecycle-cat-${randomUUID()}`;

      const { run, records } = await dryRun([
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY' },
        { manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE' },
      ]);
      expect(run.status).toBe('DRY_RUN_VALIDATED');
      for (const r of records) {
        expect(r.action).toBe('VALIDATED');
        expect(r.entityId).toBeNull();
      }
      const dryRunCatRecordId = recordFor(records, catKey).id;
      const dryRunUnitRecordId = recordFor(records, unitKey).id;

      // Apply: both CREATED.
      const applyResult = await simulateApply(run.id, [
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY', resolve: resolveCreateCategory(catName) },
        { manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE', resolve: resolveCreateUnit(unitCode, 'WEIGHT') },
      ]);
      expect(applyResult.status).toBe('APPLIED');

      const appliedRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(appliedRun.status).toBe('APPLIED');

      // Verify record rows: SAME row identity as dry-run, now CREATED.
      const catRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunCatRecordId } });
      const unitRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunUnitRecordId } });
      expect(catRecord.action).toBe('CREATED');
      expect(catRecord.createdByRun).toBe(true);
      expect(catRecord.reusedExisting).toBe(false);
      expect(catRecord.entityId).not.toBeNull();
      expect(unitRecord.action).toBe('CREATED');
      // Safe: action=CREATED requires a non-null entityId (record-writer.service.ts's
      // assertValidActionInvariants), and both records were just asserted CREATED above.
      const categoryId = catRecord.entityId!;
      const unitId = unitRecord.entityId!;

      // Exactly one record per (runId, manifestEntryKey).
      const allRecords = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id } });
      expect(allRecords).toHaveLength(2);

      // Construct a live downstream reference: an InventoryItem pointing at
      // both the created category and the created unit.
      const item = await createItemFixture(unitId, categoryId);

      // Assess: both BLOCKED with DOWNSTREAM_REFERENCE_EXISTS.
      await assessRollbackEligibility(run.id);
      let freshCat = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunCatRecordId } });
      let freshUnit = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunUnitRecordId } });
      expect(freshCat.rollbackEligibility).toBe('BLOCKED');
      expect(freshCat.rollbackBlockedReason).toBe(DOWNSTREAM_REFERENCE_EXISTS);
      expect(freshUnit.rollbackEligibility).toBe('BLOCKED');
      expect(freshUnit.rollbackBlockedReason).toBe(DOWNSTREAM_REFERENCE_EXISTS);

      // Remove the downstream reference (hard-delete the item so both the
      // eligibility check AND the eventual FK-constrained delete succeed).
      await prisma.inventoryItem.delete({ where: { id: item.id } });
      createdItemIds.splice(createdItemIds.indexOf(item.id), 1);

      // Re-assess: both ELIGIBLE.
      await assessRollbackEligibility(run.id);
      freshCat = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunCatRecordId } });
      freshUnit = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunUnitRecordId } });
      expect(freshCat.rollbackEligibility).toBe('ELIGIBLE');
      expect(freshUnit.rollbackEligibility).toBe('ELIGIBLE');

      // Drive the run into ROLLING_BACK, then execute rollback.
      await startRollbackAssessment({ runId: run.id, expectedVersion: appliedRun.version });
      const assessingRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      await startRollingBack({ runId: run.id, expectedVersion: assessingRun.version });

      const result = await executeRollback({
        runId: run.id,
        confirmations: [
          { recordId: dryRunCatRecordId, confirmationToken: buildConfirmationToken(dryRunCatRecordId, freshCat.currentVerificationFingerprint) },
          { recordId: dryRunUnitRecordId, confirmationToken: buildConfirmationToken(dryRunUnitRecordId, freshUnit.currentVerificationFingerprint) },
        ],
      });

      expect(result.runStatus).toBe('ROLLED_BACK');

      // Records rolled back, target rows actually gone.
      const finalCat = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunCatRecordId } });
      const finalUnit = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: dryRunUnitRecordId } });
      expect(finalCat.rollbackStatus).toBe('ROLLED_BACK');
      expect(finalUnit.rollbackStatus).toBe('ROLLED_BACK');
      expect(await prisma.inventoryCategory.findUnique({ where: { id: categoryId } })).toBeNull();
      expect(await prisma.unitOfMeasure.findUnique({ where: { id: unitId } })).toBeNull();
      createdCategoryIds.splice(createdCategoryIds.indexOf(categoryId), 1);
      createdUnitIds.splice(createdUnitIds.indexOf(unitId), 1);

      const finalRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(finalRun.status).toBe('ROLLED_BACK');
    },
    60000,
  );

  // ======================================================================
  // 2. Concurrency: two applies for the SAME manifest -> the second reuses
  //    what the first created, no duplicate row.
  // ======================================================================
  it(
    'concurrency: a second apply of the same manifest reuses the first run\'s created row instead of duplicating it',
    async () => {
      const catName = `r13-conc-${randomUUID()}`;
      const catKey = buildInventoryCategoryKey(catName);

      // Run 1 — creates the category.
      const first = await dryRun([{ manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY' }]);
      await simulateApply(first.run.id, [
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY', resolve: resolveCreateOrReuseCategory(catName) },
      ]);
      const firstRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: firstOf(first.records).id } });
      expect(firstRecord.action).toBe('CREATED');
      // Safe: action=CREATED requires a non-null entityId (record-writer.service.ts's
      // assertValidActionInvariants), just asserted above.
      const categoryId = firstRecord.entityId!;

      // Run 2 — same manifest key, same resolver: must REUSE, not duplicate.
      const second = await dryRun([{ manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY' }]);
      await simulateApply(second.run.id, [
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY', resolve: resolveCreateOrReuseCategory(catName) },
      ]);
      const secondRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: firstOf(second.records).id } });
      expect(secondRecord.action).toBe('REUSED');
      expect(secondRecord.reusedExisting).toBe(true);
      expect(secondRecord.createdByRun).toBe(false);
      expect(secondRecord.entityId).toBe(categoryId);

      // Exactly one category row with this name exists (no duplicate).
      const categories = await prisma.inventoryCategory.findMany({ where: { name: catName } });
      expect(categories).toHaveLength(1);
    },
    60000,
  );

  // ======================================================================
  // 3. Scenario A — BLOCKED by an incompatible existing unit.
  // ======================================================================
  it(
    'Scenario A: UNIT_OF_MEASURE:g blocked by an incompatible existing unit (dimension mismatch) -> BLOCKED, entityId null, exactly one record',
    async () => {
      const unitCode = `g-${randomUUID()}`;
      const unitKey = buildUnitOfMeasureKey(unitCode);

      // Pre-seed an existing unit sharing this natural key but with an
      // INCOMPATIBLE dimension (COUNT). Manifest declares WEIGHT.
      const existing = await createUnitFixture(unitCode, 'COUNT');

      const { run, records } = await dryRun([{ manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE' }]);
      const recordId = firstOf(records).id;

      const applyResult = await simulateApply(run.id, [
        { manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE', resolve: resolveUnitAgainstExisting(existing.id, 'WEIGHT') },
      ]);
      expect(applyResult.status).toBe('APPLIED');

      const record = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(record.action).toBe('BLOCKED');
      expect(record.entityId).toBeNull();
      expect(record.createdByRun).toBe(false);
      expect(record.reusedExisting).toBe(false);

      // Exactly one durable record for this (runId, manifestEntryKey).
      const rows = await prisma.initializationRecord.findMany({
        where: { initializationRunId: run.id, manifestEntryKey: unitKey },
      });
      expect(rows).toHaveLength(1);
    },
    60000,
  );

  // ======================================================================
  // 4. Scenario B — FAILED before row creation, then retry under a new run.
  // ======================================================================
  it(
    'Scenario B: UNIT_CONVERSION:kg->g fails before row creation -> FAILED/entityId null, retry under a new run reconciles by the same manifestEntryKey',
    async () => {
      const kg = await createUnitFixture(`kg-${randomUUID()}`);
      const g = await createUnitFixture(`g-${randomUUID()}`);
      const convKey = buildUnitConversionKey('kg', 'g');

      // Run 1 — conversion apply throws before the target row is created.
      const first = await dryRun([{ manifestEntryKey: convKey, entityType: 'UNIT_CONVERSION' }]);
      const firstRecordId = firstOf(first.records).id;
      const firstResult = await simulateApply(first.run.id, [
        { manifestEntryKey: convKey, entityType: 'UNIT_CONVERSION', resolve: resolveThrow() },
      ]);
      expect(firstResult.status).toBe('APPLY_FAILED');
      expect(firstResult.failedType).toBe('UNIT_CONVERSION');

      const firstRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: firstRecordId } });
      expect(firstRecord.action).toBe('FAILED');
      expect(firstRecord.entityId).toBeNull();
      // No conversion row was created by the rolled-back transaction.
      const strayConversions = await prisma.unitConversion.findMany({ where: { fromUnitId: kg.id, toUnitId: g.id } });
      expect(strayConversions).toHaveLength(0);

      const firstRun = await prisma.initializationRun.findUniqueOrThrow({ where: { id: first.run.id } });
      expect(firstRun.status).toBe('APPLY_FAILED');

      // Retry — brand-new run (new migrationBatch), SAME manifestEntryKey.
      const second = await dryRun([{ manifestEntryKey: convKey, entityType: 'UNIT_CONVERSION' }]);
      const secondRecordId = firstOf(second.records).id;
      const secondResult = await simulateApply(second.run.id, [
        { manifestEntryKey: convKey, entityType: 'UNIT_CONVERSION', resolve: resolveCreateConversion(kg.id, g.id, '1000') },
      ]);
      expect(secondResult.status).toBe('APPLIED');

      const secondRecord = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: secondRecordId } });
      expect(secondRecord.action).toBe('CREATED');
      expect(secondRecord.entityId).not.toBeNull();
      // Independent of run 1's FAILED record — different rows, different runs,
      // same manifestEntryKey.
      expect(secondRecordId).not.toBe(firstRecordId);
      expect(secondRecord.manifestEntryKey).toBe(firstRecord.manifestEntryKey);
    },
    60000,
  );

  // ======================================================================
  // 5. Scenario C — REUSED.
  // ======================================================================
  it(
    'Scenario C: INVENTORY_CATEGORY:flavor reused -> createdByRun=false, reusedExisting=true',
    async () => {
      // Pre-seed a compatible existing category named "Flavor". Note the
      // manifest key normalizes: buildInventoryCategoryKey('Flavor') ===
      // buildInventoryCategoryKey('flavor').
      const catName = `Flavor-${randomUUID()}`;
      const existing = await createCategoryFixture(catName);
      const catKey = buildInventoryCategoryKey(catName);

      const { run, records } = await dryRun([{ manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY' }]);
      const recordId = firstOf(records).id;

      await simulateApply(run.id, [
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY', resolve: resolveReuseCategory(existing.id) },
      ]);

      const record = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(record.action).toBe('REUSED');
      expect(record.createdByRun).toBe(false);
      expect(record.reusedExisting).toBe(true);
      expect(record.entityId).toBe(existing.id);
    },
    60000,
  );

  // ======================================================================
  // 6. Scenario D — CREATED.
  // ======================================================================
  it(
    'Scenario D: UNIT_OF_MEASURE:g created fresh -> createdByRun=true, reusedExisting=false',
    async () => {
      const unitCode = `g-${randomUUID()}`;
      const unitKey = buildUnitOfMeasureKey(unitCode);

      const { run, records } = await dryRun([{ manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE' }]);
      const recordId = firstOf(records).id;

      await simulateApply(run.id, [
        { manifestEntryKey: unitKey, entityType: 'UNIT_OF_MEASURE', resolve: resolveCreateUnit(unitCode, 'WEIGHT') },
      ]);

      const record = await prisma.initializationRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(record.action).toBe('CREATED');
      expect(record.createdByRun).toBe(true);
      expect(record.reusedExisting).toBe(false);
      expect(record.entityId).not.toBeNull();
    },
    60000,
  );

  // ======================================================================
  // 7. Scenario E — decimal parity: manifest "1000.000" vs DB Decimal("1000").
  // ======================================================================
  it('Scenario E: manifest factor "1000.000" and database Decimal("1000") produce identical canonical value and fingerprint', () => {
    const fromUnitId = randomUUID();
    const toUnitId = randomUUID();

    const manifestHash = computeFingerprint(
      'UnitConversion',
      { fromUnitId, toUnitId, factor: '1000.000' },
      FINGERPRINT_VERSION,
    ).hash;
    const databaseHash = computeFingerprint(
      'UnitConversion',
      { fromUnitId, toUnitId, factor: new Prisma.Decimal('1000') },
      FINGERPRINT_VERSION,
    ).hash;

    expect(manifestHash).toBe(databaseHash);
  });

  // ======================================================================
  // 8. CR-009.2 acceptance tests (manifestEntryKey), threaded end-to-end.
  // ======================================================================
  it('CR-009.2: " Flavor " and "flavor" produce the same key and resolve to a single record row', async () => {
    expect(buildInventoryCategoryKey(' Flavor ')).toBe(buildInventoryCategoryKey('flavor'));

    // End-to-end: a manifest whose single entry uses the normalized key
    // yields exactly one InitializationRecord row.
    const key = buildInventoryCategoryKey(' Flavor ');
    const { run, records } = await dryRun([{ manifestEntryKey: key, entityType: 'INVENTORY_CATEGORY' }]);
    expect(records).toHaveLength(1);
    const rows = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id } });
    expect(rows).toHaveLength(1);
  });

  it('CR-009.2: "G" and "g" produce the same unit key', () => {
    expect(buildUnitOfMeasureKey('G')).toBe(buildUnitOfMeasureKey('g'));
  });

  it('CR-009.2: kg->g and g->kg produce different (directed) conversion keys', () => {
    expect(buildUnitConversionKey('kg', 'g')).not.toBe(buildUnitConversionKey('g', 'kg'));
  });

  it('CR-009.2: a raw segment containing ":" is rejected before any run is created', async () => {
    expect(() => buildInventoryCategoryKey('a:b')).toThrow(/reserved character/i);

    // No run should ever be created — the throw happens at manifest
    // key-build time, before recordDryRunRun is called.
    const migrationBatch = `r13-reject-colon-${randomUUID()}`;
    await expect(
      (async () => {
        const entries = [{ manifestEntryKey: buildInventoryCategoryKey('a:b'), entityType: 'INVENTORY_CATEGORY' as const }];
        await recordDryRunRun({
          migrationBatch,
          initializationType: 'REFERENCE_DATA',
          manifestVersion: 1,
          manifestFingerprint: 'x',
          manifestSnapshot: {},
          targetEnvironment: 'test',
          initiatedBy: userId,
          dryRunReportFingerprint: 'x',
          manifestEntries: entries,
        });
      })(),
    ).rejects.toThrow(/reserved character/i);
    const runs = await prisma.initializationRun.findMany({ where: { migrationBatch } });
    expect(runs).toHaveLength(0);
  });

  it('CR-009.2: a raw segment containing "->" is rejected', () => {
    expect(() => buildInventoryCategoryKey('a->b')).toThrow(/reserved sequence/i);
    expect(() => normalizeNaturalKeySegment('x->y')).toThrow(/reserved sequence/i);
  });

  it('CR-009.2: duplicate normalized keys within one manifest fail validation before any DB write', async () => {
    // " Flavor " and "flavor" normalize to the same key.
    const entries = [
      { manifestEntryKey: buildInventoryCategoryKey(' Flavor '), entityType: 'INVENTORY_CATEGORY' as const },
      { manifestEntryKey: buildInventoryCategoryKey('flavor'), entityType: 'INVENTORY_CATEGORY' as const },
    ];
    expect(() => validateManifestNoDuplicateKeys(entries)).toThrow(/duplicate/i);

    const migrationBatch = `r13-dup-${randomUUID()}`;
    await expect(
      recordDryRunRun({
        migrationBatch,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'x',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        initiatedBy: userId,
        dryRunReportFingerprint: 'x',
        manifestEntries: entries,
      }),
    ).rejects.toThrow(/duplicate/i);
    const runs = await prisma.initializationRun.findMany({ where: { migrationBatch } });
    expect(runs).toHaveLength(0);
  });

  // ======================================================================
  // 9. Row-identity tests.
  // ======================================================================
  it(
    'row identity: dry-run and apply use the SAME InitializationRecord id, and a retried apply does not create a second row',
    async () => {
      const catName = `r13-identity-${randomUUID()}`;
      const catKey = buildInventoryCategoryKey(catName);

      const { run, records } = await dryRun([{ manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY' }]);
      const dryRunRecordId = firstOf(records).id;

      await simulateApply(run.id, [
        { manifestEntryKey: catKey, entityType: 'INVENTORY_CATEGORY', resolve: resolveCreateCategory(catName) },
      ]);

      // Same row identity: the applied record is the exact same id the
      // dry-run created — never a second row.
      const appliedRecords = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id } });
      expect(appliedRecords).toHaveLength(1);
      const appliedRecord = firstOf(appliedRecords);
      expect(appliedRecord.id).toBe(dryRunRecordId);
      expect(appliedRecord.action).toBe('CREATED');

      // Retry apply on the already-CREATED entry: transitionRecordOnApply is
      // CAS-scoped by the dry-run version (1), which no longer matches (the
      // row is now version 2), so a re-drive fails with StaleRecordVersion —
      // never inserts a second row. Verify directly that a fresh
      // transitionRecordOnApply attempt at the stale version throws and no
      // second row appears.
      await expect(
        prisma.$transaction(async (tx) => {
          await transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey: catKey,
            action: 'CREATED',
            entityId: appliedRecord.entityId,
            createdByRun: true,
            reusedExisting: false,
            expectedVersion: 1,
          });
        }),
      ).rejects.toThrow();

      const afterRetry = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id } });
      expect(afterRetry).toHaveLength(1);
      expect(firstOf(afterRetry).id).toBe(dryRunRecordId);
    },
    60000,
  );
});
