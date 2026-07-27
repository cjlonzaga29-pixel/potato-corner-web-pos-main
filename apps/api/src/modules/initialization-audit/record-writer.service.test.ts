import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/**
 * Integration-style tests against the real dev database — same rationale
 * as R4's `run-lifecycle.service.test.ts`: CAS behavior (row-count-based
 * conflict detection) and real Postgres unique-constraint violations
 * (including the raw-SQL partial unique index from R2's migration) can't be
 * meaningfully unit-tested against a mock.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency. See R4's brief/test file for the same reasoning.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const {
  createDryRunRecord,
  transitionRecordOnApply,
  InvariantViolationError,
  RecordNotFoundError,
  StaleRecordVersionError,
  DuplicateManifestEntryError,
  DuplicateResolvedTargetError,
} = await import('./record-writer.service.js');

describe.skipIf(!canRunIntegrationTests)('record-writer.service integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r5-record-writer-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R5',
        lastName: 'Record Writer Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // InitializationRecord rows are removed by the FK-restrict-safe order:
    // records first (children), then runs, then the user.
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createRun(): Promise<{ id: string }> {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r5-test-${randomUUID()}`,
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

  describe('createDryRunRecord', () => {
    it('creates a VALIDATED row with entityId=null and version=1', async () => {
      const run = await createRun();
      const manifestEntryKey = `entry-${randomUUID()}`;

      const record = await prisma.$transaction((tx) =>
        createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'INVENTORY_CATEGORY' }),
      );

      expect(record.action).toBe('VALIDATED');
      expect(record.entityId).toBeNull();
      expect(record.version).toBe(1);
      expect(record.createdByRun).toBe(false);
      expect(record.reusedExisting).toBe(false);
    });

    it('a second call for the same (runId, manifestEntryKey) throws DuplicateManifestEntryError, not a raw Prisma error', async () => {
      const run = await createRun();
      const manifestEntryKey = `entry-${randomUUID()}`;

      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'INVENTORY_CATEGORY' }));

      await expect(
        prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'INVENTORY_CATEGORY' })),
      ).rejects.toThrow(DuplicateManifestEntryError);

      const rows = await prisma.initializationRecord.findMany({
        where: { initializationRunId: run.id, manifestEntryKey },
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('transitionRecordOnApply — invariant guard (throws before any write)', () => {
    it('action=REUSED with createdByRun=true throws InvariantViolationError before any DB access', async () => {
      const run = await createRun();
      const manifestEntryKey = `entry-${randomUUID()}`;
      // Deliberately no dry-run row created first — if the invariant guard
      // fired AFTER a DB read/write, this would instead throw
      // RecordNotFoundError. Getting InvariantViolationError proves the
      // check happens first, with zero DB access.
      await expect(
        prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey,
            action: 'REUSED',
            entityId: randomUUID(),
            createdByRun: true,
            reusedExisting: true,
            expectedVersion: 1,
          }),
        ),
      ).rejects.toThrow(InvariantViolationError);
    });

    it('action=CREATED with entityId=null throws InvariantViolationError', async () => {
      const run = await createRun();
      await expect(
        prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey: `entry-${randomUUID()}`,
            action: 'CREATED',
            entityId: null,
            createdByRun: true,
            reusedExisting: false,
            expectedVersion: 1,
          }),
        ),
      ).rejects.toThrow(InvariantViolationError);
    });

    it('action=BLOCKED with createdByRun=true throws InvariantViolationError', async () => {
      const run = await createRun();
      await expect(
        prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey: `entry-${randomUUID()}`,
            action: 'BLOCKED',
            entityId: null,
            createdByRun: true,
            reusedExisting: false,
            expectedVersion: 1,
          }),
        ),
      ).rejects.toThrow(InvariantViolationError);
    });
  });

  describe('transitionRecordOnApply — RecordNotFoundError vs StaleRecordVersionError distinguishability', () => {
    it('a non-existent (runId, manifestEntryKey) throws RecordNotFoundError', async () => {
      const run = await createRun();
      let error: unknown;
      try {
        await prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey: `never-created-${randomUUID()}`,
            action: 'BLOCKED',
            entityId: null,
            createdByRun: false,
            reusedExisting: false,
            expectedVersion: 1,
          }),
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RecordNotFoundError);
      expect(error).not.toBeInstanceOf(StaleRecordVersionError);
    });

    it('a stale expectedVersion throws StaleRecordVersionError, a DIFFERENT type from RecordNotFoundError', async () => {
      const run = await createRun();
      const manifestEntryKey = `entry-${randomUUID()}`;
      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'UNIT_OF_MEASURE' }));

      // Wrong version, but the row DOES exist -- proves this is purely a
      // version mismatch, not a missing-row condition.
      let error: unknown;
      try {
        await prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey,
            action: 'BLOCKED',
            entityId: null,
            createdByRun: false,
            reusedExisting: false,
            expectedVersion: 999,
          }),
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(StaleRecordVersionError);
      expect(error).not.toBeInstanceOf(RecordNotFoundError);
      expect((error as InstanceType<typeof StaleRecordVersionError>).code).toBe('STALE_RECORD_VERSION');

      const notFoundError = new RecordNotFoundError(run.id, manifestEntryKey);
      expect(notFoundError.code).toBe('RECORD_NOT_FOUND');
      expect(notFoundError).not.toBeInstanceOf(StaleRecordVersionError);
    });
  });

  describe('transitionRecordOnApply — same-row transitions, never a second insert', () => {
    it('called twice for the same entry updates the SAME row (id unchanged, version increments), never inserts a second row', async () => {
      const run = await createRun();
      const manifestEntryKey = `entry-${randomUUID()}`;
      const created = await prisma.$transaction((tx) =>
        createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'UNIT_CONVERSION' }),
      );
      expect(created.version).toBe(1);

      const entityId = randomUUID();
      const first = await prisma.$transaction((tx) =>
        transitionRecordOnApply(tx, {
          runId: run.id,
          manifestEntryKey,
          action: 'CREATED',
          entityId,
          createdByRun: true,
          reusedExisting: false,
          expectedVersion: 1,
          resultingFingerprint: 'fp-1',
        }),
      );
      expect(first.id).toBe(created.id);
      expect(first.version).toBe(2);
      expect(first.action).toBe('CREATED');

      // Second transition on the SAME entry (e.g. a later re-verification
      // pass) -- must update the same row again, not insert a new one.
      const second = await prisma.$transaction((tx) =>
        transitionRecordOnApply(tx, {
          runId: run.id,
          manifestEntryKey,
          action: 'CREATED',
          entityId,
          createdByRun: true,
          reusedExisting: false,
          expectedVersion: 2,
          resultingFingerprint: 'fp-2',
        }),
      );
      expect(second.id).toBe(created.id);
      expect(second.version).toBe(3);
      expect(second.resultingFingerprint).toBe('fp-2');

      const rows = await prisma.initializationRecord.findMany({
        where: { initializationRunId: run.id, manifestEntryKey },
      });
      expect(rows).toHaveLength(1);
      expect(rows.at(0)?.id).toBe(created.id);
    });
  });

  describe('BLOCKED/SKIPPED/FAILED vs CREATED/REUSED distinguishability', () => {
    it('BLOCKED/SKIPPED/FAILED writes with entityId=null succeed and are distinguishable from CREATED/REUSED', async () => {
      const run = await createRun();

      const actions = ['BLOCKED', 'SKIPPED', 'FAILED'] as const;
      for (const action of actions) {
        const manifestEntryKey = `entry-${action}-${randomUUID()}`;
        await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey, entityType: 'INVENTORY_CATEGORY' }));
        const result = await prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey,
            action,
            entityId: null,
            createdByRun: false,
            reusedExisting: false,
            expectedVersion: 1,
          }),
        );
        expect(result.action).toBe(action);
        expect(result.entityId).toBeNull();
        expect(result.createdByRun).toBe(false);
        expect(result.reusedExisting).toBe(false);
      }

      // CREATED and REUSED, for contrast: both require a non-null entityId
      // and exactly one of createdByRun/reusedExisting set.
      const createdKey = `entry-created-${randomUUID()}`;
      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey: createdKey, entityType: 'INVENTORY_CATEGORY' }));
      const createdResult = await prisma.$transaction((tx) =>
        transitionRecordOnApply(tx, {
          runId: run.id,
          manifestEntryKey: createdKey,
          action: 'CREATED',
          entityId: randomUUID(),
          createdByRun: true,
          reusedExisting: false,
          expectedVersion: 1,
        }),
      );
      expect(createdResult.action).toBe('CREATED');
      expect(createdResult.createdByRun).toBe(true);
      expect(createdResult.reusedExisting).toBe(false);
      expect(createdResult.entityId).not.toBeNull();

      const reusedKey = `entry-reused-${randomUUID()}`;
      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey: reusedKey, entityType: 'INVENTORY_CATEGORY' }));
      const reusedResult = await prisma.$transaction((tx) =>
        transitionRecordOnApply(tx, {
          runId: run.id,
          manifestEntryKey: reusedKey,
          action: 'REUSED',
          entityId: randomUUID(),
          createdByRun: false,
          reusedExisting: true,
          expectedVersion: 1,
        }),
      );
      expect(reusedResult.action).toBe('REUSED');
      expect(reusedResult.createdByRun).toBe(false);
      expect(reusedResult.reusedExisting).toBe(true);
      expect(reusedResult.entityId).not.toBeNull();
    });
  });

  describe('secondary partial-index guard — DuplicateResolvedTargetError distinct from DuplicateManifestEntryError', () => {
    it('a second manifest entry resolving to the same entityId within one run throws DuplicateResolvedTargetError', async () => {
      const run = await createRun();
      const sharedEntityId = randomUUID();

      const firstKey = `entry-a-${randomUUID()}`;
      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey: firstKey, entityType: 'INVENTORY_CATEGORY' }));
      await prisma.$transaction((tx) =>
        transitionRecordOnApply(tx, {
          runId: run.id,
          manifestEntryKey: firstKey,
          action: 'CREATED',
          entityId: sharedEntityId,
          createdByRun: true,
          reusedExisting: false,
          expectedVersion: 1,
        }),
      );

      const secondKey = `entry-b-${randomUUID()}`;
      await prisma.$transaction((tx) => createDryRunRecord(tx, { runId: run.id, manifestEntryKey: secondKey, entityType: 'INVENTORY_CATEGORY' }));

      let error: unknown;
      try {
        await prisma.$transaction((tx) =>
          transitionRecordOnApply(tx, {
            runId: run.id,
            manifestEntryKey: secondKey,
            action: 'REUSED',
            entityId: sharedEntityId,
            createdByRun: false,
            reusedExisting: true,
            expectedVersion: 1,
          }),
        );
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(DuplicateResolvedTargetError);
      expect(error).not.toBeInstanceOf(DuplicateManifestEntryError);
      expect((error as InstanceType<typeof DuplicateResolvedTargetError>).code).toBe('DUPLICATE_RESOLVED_TARGET');

      // For contrast: DuplicateManifestEntryError is a distinct class/code,
      // proven separately in the createDryRunRecord describe block above.
      const manifestConflict = new DuplicateManifestEntryError(run.id, secondKey);
      expect(manifestConflict.code).toBe('DUPLICATE_MANIFEST_ENTRY');
      expect(manifestConflict).not.toBeInstanceOf(DuplicateResolvedTargetError);
    });
  });

  describe('root-client runtime guard (defense-in-depth for the tx typing)', () => {
    it('passing the root prisma client instead of a tx throws at runtime', async () => {
      const run = await createRun();
      await expect(
        createDryRunRecord(prisma as unknown as Prisma.TransactionClient, {
          runId: run.id,
          manifestEntryKey: `entry-${randomUUID()}`,
          entityType: 'INVENTORY_CATEGORY',
        }),
      ).rejects.toThrow(/root prisma singleton/);
    });
  });
});

describe('compile-time tx typing (type-only assertions, no DB access)', () => {
  it('createDryRunRecord requires a tx argument — omitting it is a compile-time error', () => {
    // @ts-expect-error -- `tx` (a Prisma.TransactionClient) is required; calling
    // with only the params object must fail to type-check. If this stops being
    // a type error, the compile-time transaction-boundary guarantee has been lost.
    // The call is caught/swallowed at runtime (it throws synchronously inside
    // the async function, producing a rejected promise) -- this test only
    // exercises the TYPE CHECKER, not runtime behavior.
    void createDryRunRecord({ runId: 'x', manifestEntryKey: 'y', entityType: 'INVENTORY_CATEGORY' }).catch(() => {});
    expect(true).toBe(true);
  });
});
