import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { InitializationAction, InitializationEntityType, InitializationRollbackStatus, InitializationRunStatus } from '@prisma/client';

/**
 * Integration-style tests against the real dev database -- same rationale
 * as R4/R5/R9/R10's suites: reconciliation reads real `InitializationRun`/
 * `InitializationRecord` rows constructed directly via Prisma (no real
 * apply/rollback orchestration exists yet), none of which is meaningfully
 * mockable.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`), per
 * established R4/R5/R9/R10 precedent -- this module has no Redis
 * dependency.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { markApplyFailed } = await import('./run-lifecycle.service.js');
const { findStaleRuns, reconcileRun, reconcileAllStaleRuns } = await import('./reconciliation.service.js');

describe.skipIf(!canRunIntegrationTests)('reconciliation.service integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];

  const FIFTEEN_MIN_MS = 15 * 60 * 1000;
  const OLD_STARTED_AT = new Date(Date.now() - FIFTEEN_MIN_MS - 60_000); // 16 minutes ago

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r11-reconciliation-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R11',
        lastName: 'Reconciliation Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createRun(overrides: { status: InitializationRunStatus; startedAt: Date | null }) {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r11-test-${randomUUID()}`,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'test-fingerprint',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        executionMode: 'APPLY',
        status: overrides.status,
        startedAt: overrides.startedAt,
        initiatedBy: userId,
      },
    });
    createdRunIds.push(run.id);
    return run;
  }

  async function createRecord(params: {
    runId: string;
    entityType: InitializationEntityType;
    action: InitializationAction;
    rollbackStatus?: InitializationRollbackStatus;
  }) {
    const createdByRun = params.action === 'CREATED';
    const reusedExisting = params.action === 'REUSED';
    return prisma.initializationRecord.create({
      data: {
        initializationRunId: params.runId,
        manifestEntryKey: `entry-${randomUUID()}`,
        entityType: params.entityType,
        entityId: params.action === 'VALIDATED' ? null : randomUUID(),
        action: params.action,
        createdByRun,
        reusedExisting,
        resultingFingerprint: params.action === 'VALIDATED' ? null : 'fp',
        rollbackStatus: params.rollbackStatus,
        version: 1,
      },
    });
  }

  describe('findStaleRuns', () => {
    it('finds APPLYING/ROLLING_BACK runs older than the timeout, excludes recent ones', async () => {
      const staleApplying = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      const staleRollingBack = await createRun({ status: 'ROLLING_BACK', startedAt: OLD_STARTED_AT });
      const recent = await createRun({ status: 'APPLYING', startedAt: new Date() });

      const now = new Date();
      const stale = await findStaleRuns(now, FIFTEEN_MIN_MS);
      const staleIds = stale.map((r) => r.id);

      expect(staleIds).toContain(staleApplying.id);
      expect(staleIds).toContain(staleRollingBack.id);
      expect(staleIds).not.toContain(recent.id);
    });
  });

  describe('reconcileRun -- APPLYING', () => {
    it('only categories present (fully transitioned) reconciles to APPLY_FAILED, naming "units" as the first not-fully-transitioned type', async () => {
      const run = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });
      // No UNIT_OF_MEASURE / UNIT_CONVERSION rows at all.

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('APPLY_FAILED');
      expect(outcome.failureReason).toContain('units');
      expect(outcome.anomalyDetected).toBe(false);

      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('APPLY_FAILED');
    });

    it('all three types present and fully transitioned reconciles to APPLIED', async () => {
      const run = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });
      await createRecord({ runId: run.id, entityType: 'UNIT_OF_MEASURE', action: 'REUSED' });
      await createRecord({ runId: run.id, entityType: 'UNIT_CONVERSION', action: 'CREATED' });

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('APPLIED');
      expect(outcome.anomalyDetected).toBe(false);

      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('APPLIED');
    });

    it('a PARTIALLY transitioned type (anomaly case) reconciles to APPLY_FAILED naming that type, with anomalyDetected=true', async () => {
      const run = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });
      // units: one transitioned, one still VALIDATED -- should not be
      // possible given per-type transactional atomicity, but must be
      // handled, not silently normalized.
      await createRecord({ runId: run.id, entityType: 'UNIT_OF_MEASURE', action: 'CREATED' });
      await createRecord({ runId: run.id, entityType: 'UNIT_OF_MEASURE', action: 'VALIDATED' });

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('APPLY_FAILED');
      expect(outcome.failureReason).toContain('units');
      expect(outcome.anomalyDetected).toBe(true);
      expect(outcome.anomalyDetail).toBeTruthy();
      expect(outcome.anomalyDetail).toContain('units');

      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('APPLY_FAILED');
    });
  });

  describe('reconcileRun -- ROLLING_BACK', () => {
    it('every CREATED record ROLLED_BACK reconciles to ROLLED_BACK', async () => {
      const run = await createRun({ status: 'ROLLING_BACK', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED', rollbackStatus: 'ROLLED_BACK' });

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('ROLLED_BACK');
      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('ROLLED_BACK');
    });

    it('some CREATED records not yet ROLLED_BACK reconciles to ROLLBACK_PARTIAL, with a summarizing failureReason', async () => {
      const run = await createRun({ status: 'ROLLING_BACK', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED', rollbackStatus: 'ROLLED_BACK' });
      await createRecord({ runId: run.id, entityType: 'UNIT_OF_MEASURE', action: 'CREATED', rollbackStatus: 'ELIGIBLE' });

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('ROLLBACK_PARTIAL');
      expect(outcome.failureReason).toBeTruthy();
      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('ROLLBACK_PARTIAL');
    });
  });

  describe('untouched / read-only guarantees', () => {
    it('a run under the timeout is left completely untouched (byte-for-byte unchanged status/version)', async () => {
      const recentRun = await createRun({ status: 'APPLYING', startedAt: new Date() });
      const before = await prisma.initializationRun.findUniqueOrThrow({ where: { id: recentRun.id } });

      const outcomes = await reconcileAllStaleRuns(new Date(), FIFTEEN_MIN_MS);

      expect(outcomes.find((o) => o.runId === recentRun.id)).toBeUndefined();

      const after = await prisma.initializationRun.findUniqueOrThrow({ where: { id: recentRun.id } });
      expect(after).toEqual(before);
    });

    it('never writes to InitializationRecord -- record rows are byte-for-byte unchanged across a reconciliation pass', async () => {
      // (Spying directly on prisma.initializationRecord.update/create proved
      // unreliable to restore cleanly against the generated Prisma client's
      // proxy in this repo -- verified via the direct-source grep in the
      // task report instead. This test proves the behavioral guarantee that
      // actually matters: not a single byte of any InitializationRecord row
      // touched by this run changes across a full reconciliation pass.)
      const run = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });
      await createRecord({ runId: run.id, entityType: 'UNIT_OF_MEASURE', action: 'REUSED' });
      await createRecord({ runId: run.id, entityType: 'UNIT_CONVERSION', action: 'CREATED' });

      const before = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id }, orderBy: { id: 'asc' } });

      const outcome = await reconcileRun(run.id);
      expect(outcome.outcome).toBe('APPLIED');

      const after = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id }, orderBy: { id: 'asc' } });
      expect(after).toEqual(before);
      // Scoped-by-run count also unchanged (no row for this run added or removed).
      expect(after.length).toBe(before.length);
    });
  });

  describe('CAS conflict handling', () => {
    it('a run transitioned out from under reconciliation (before reconcileRun is even called) aborts as a distinct CONFLICT outcome, not an unhandled error', async () => {
      const run = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: run.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });

      // Simulate a concurrent process transitioning this run before our
      // reconciliation call ever reads it.
      await markApplyFailed({ runId: run.id, expectedVersion: run.version, failureReason: 'concurrent-transition-for-test' });

      const outcome = await reconcileRun(run.id);

      expect(outcome.outcome).toBe('CONFLICT');
      expect(outcome.conflictReason).toBeTruthy();

      // The concurrent transition's own result is untouched by reconciliation.
      const fresh = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(fresh.status).toBe('APPLY_FAILED');
      expect(fresh.failureReason).toBe('concurrent-transition-for-test');
    });

    it('reconcileAllStaleRuns processes a mixed batch (one reconcilable, one concurrently conflicting) without one blocking the other', async () => {
      const runA = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: runA.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });
      await createRecord({ runId: runA.id, entityType: 'UNIT_OF_MEASURE', action: 'CREATED' });
      await createRecord({ runId: runA.id, entityType: 'UNIT_CONVERSION', action: 'CREATED' });

      const runB = await createRun({ status: 'APPLYING', startedAt: OLD_STARTED_AT });
      await createRecord({ runId: runB.id, entityType: 'INVENTORY_CATEGORY', action: 'CREATED' });

      // Intercept the scan query used by findStaleRuns: capture the real
      // (still-APPLYING) snapshot, THEN simulate a concurrent process
      // finishing runB's transition before reconcileAllStaleRuns gets to
      // process it -- modeling the race without needing real concurrency.
      const originalFindMany = prisma.initializationRun.findMany.bind(prisma.initializationRun);
      const findManySpy = vi.spyOn(prisma.initializationRun, 'findMany');
      findManySpy.mockImplementationOnce((async (...args: Parameters<typeof originalFindMany>) => {
        const rows = await originalFindMany(...args);
        const freshB = await prisma.initializationRun.findUniqueOrThrow({ where: { id: runB.id } });
        await markApplyFailed({ runId: runB.id, expectedVersion: freshB.version, failureReason: 'concurrent-transition-for-test' });
        return rows;
      }) as typeof originalFindMany);

      const outcomes = await reconcileAllStaleRuns(new Date(), FIFTEEN_MIN_MS);
      findManySpy.mockRestore();

      const outcomeA = outcomes.find((o) => o.runId === runA.id);
      const outcomeB = outcomes.find((o) => o.runId === runB.id);

      expect(outcomeA?.outcome).toBe('APPLIED');
      expect(outcomeB?.outcome).toBe('CONFLICT');

      const freshA = await prisma.initializationRun.findUniqueOrThrow({ where: { id: runA.id } });
      expect(freshA.status).toBe('APPLIED');
    });
  });
});
