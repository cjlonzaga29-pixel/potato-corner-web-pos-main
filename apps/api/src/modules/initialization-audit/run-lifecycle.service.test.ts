import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { InitializationRunStatus } from '@prisma/client';
import {
  RUN_TRANSITION_TABLE,
  TERMINAL_RUN_STATUSES,
  isValidRunTransition,
} from './run-lifecycle.types.js';

/**
 * Integration-style tests against the real dev database. CAS behavior
 * (row-count-based conflict detection) can't be meaningfully unit-tested
 * against a mock without re-implementing the mock's own bookkeeping, so
 * these tests create real `InitializationRun` rows.
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency, unlike the `*.integration.test.ts` files
 * elsewhere in this codebase that gate on both. Gating on TEST_REDIS_URL
 * here would make these tests permanently skip in environments (like this
 * worktree) that only set TEST_DATABASE_URL, losing all real coverage.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const {
  transitionRunStatus,
  markDryRunValidated,
  startApplying,
  markApplied,
  markApplyFailed,
  startRollbackAssessment,
  markRollbackBlocked,
  startRollingBack,
  markRolledBack,
  markRollbackPartial,
  supersede,
  InvalidTransitionError,
  StaleVersionError,
  RunNotFoundError,
} = await import('./run-lifecycle.service.js');

describe('isValidRunTransition (pure, no DB required)', () => {
  it('accepts exactly the arrows in the authoritative transition table', () => {
    expect(isValidRunTransition('PLANNED', 'DRY_RUN_VALIDATED')).toBe(true);
    expect(isValidRunTransition('DRY_RUN_VALIDATED', 'APPLYING')).toBe(true);
    expect(isValidRunTransition('APPLYING', 'APPLIED')).toBe(true);
    expect(isValidRunTransition('APPLYING', 'APPLY_FAILED')).toBe(true);
    expect(isValidRunTransition('APPLIED', 'ROLLBACK_ASSESSING')).toBe(true);
    expect(isValidRunTransition('ROLLBACK_ASSESSING', 'ROLLBACK_BLOCKED')).toBe(true);
    expect(isValidRunTransition('ROLLBACK_ASSESSING', 'ROLLING_BACK')).toBe(true);
    expect(isValidRunTransition('ROLLING_BACK', 'ROLLED_BACK')).toBe(true);
    expect(isValidRunTransition('ROLLING_BACK', 'ROLLBACK_PARTIAL')).toBe(true);
  });

  it('accepts any non-terminal state transitioning to SUPERSEDED', () => {
    expect(isValidRunTransition('PLANNED', 'SUPERSEDED')).toBe(true);
    expect(isValidRunTransition('DRY_RUN_VALIDATED', 'SUPERSEDED')).toBe(true);
    expect(isValidRunTransition('APPLYING', 'SUPERSEDED')).toBe(true);
    expect(isValidRunTransition('APPLIED', 'SUPERSEDED')).toBe(true);
    expect(isValidRunTransition('ROLLBACK_ASSESSING', 'SUPERSEDED')).toBe(true);
    expect(isValidRunTransition('ROLLING_BACK', 'SUPERSEDED')).toBe(true);
  });

  it('rejects transitions not in the table', () => {
    expect(isValidRunTransition('PLANNED', 'ROLLED_BACK')).toBe(false);
    expect(isValidRunTransition('APPLIED', 'APPLYING')).toBe(false);
    expect(isValidRunTransition('DRY_RUN_VALIDATED', 'APPLIED')).toBe(false);
    expect(isValidRunTransition('PLANNED', 'APPLYING')).toBe(false);
  });

  it('rejects every outgoing transition from every terminal state, including to SUPERSEDED', () => {
    const allStatuses = Object.keys(RUN_TRANSITION_TABLE) as InitializationRunStatus[];
    for (const terminal of TERMINAL_RUN_STATUSES) {
      for (const target of allStatuses) {
        expect(isValidRunTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('the transition table\'s terminal statuses match TERMINAL_RUN_STATUSES exactly', () => {
    const declaredTerminal = (Object.keys(RUN_TRANSITION_TABLE) as InitializationRunStatus[]).filter(
      (status) => RUN_TRANSITION_TABLE[status].length === 0,
    );
    expect(new Set(declaredTerminal)).toEqual(TERMINAL_RUN_STATUSES);
  });
});

describe.skipIf(!canRunIntegrationTests)('run-lifecycle.service integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r4-lifecycle-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R4',
        lastName: 'Lifecycle Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createRun(status: InitializationRunStatus): Promise<{ id: string; version: number }> {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r4-test-${randomUUID()}`,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'test-fingerprint',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        executionMode: 'DRY_RUN',
        status,
        initiatedBy: userId,
      },
    });
    createdRunIds.push(run.id);
    return { id: run.id, version: run.version };
  }

  describe('valid transitions succeed', () => {
    it('PLANNED -> DRY_RUN_VALIDATED via markDryRunValidated', async () => {
      const run = await createRun('PLANNED');
      const updated = await markDryRunValidated({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('DRY_RUN_VALIDATED');
      expect(updated.version).toBe(run.version + 1);
    });

    it('DRY_RUN_VALIDATED -> APPLYING via startApplying, sets startedAt', async () => {
      const run = await createRun('DRY_RUN_VALIDATED');
      const updated = await startApplying({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('APPLYING');
      expect(updated.startedAt).not.toBeNull();
    });

    it('APPLYING -> APPLIED via markApplied, sets completedAt', async () => {
      const run = await createRun('APPLYING');
      const updated = await markApplied({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('APPLIED');
      expect(updated.completedAt).not.toBeNull();
    });

    it('APPLYING -> APPLY_FAILED via markApplyFailed, sets failedAt and failureReason', async () => {
      const run = await createRun('APPLYING');
      const updated = await markApplyFailed({ runId: run.id, expectedVersion: run.version, failureReason: 'db unreachable' });
      expect(updated.status).toBe('APPLY_FAILED');
      expect(updated.failedAt).not.toBeNull();
      expect(updated.failureReason).toBe('db unreachable');
    });

    it('APPLIED -> ROLLBACK_ASSESSING via startRollbackAssessment', async () => {
      const run = await createRun('APPLIED');
      const updated = await startRollbackAssessment({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('ROLLBACK_ASSESSING');
    });

    it('ROLLBACK_ASSESSING -> ROLLBACK_BLOCKED via markRollbackBlocked', async () => {
      const run = await createRun('ROLLBACK_ASSESSING');
      const updated = await markRollbackBlocked({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('ROLLBACK_BLOCKED');
    });

    it('ROLLBACK_ASSESSING -> ROLLING_BACK via startRollingBack', async () => {
      const run = await createRun('ROLLBACK_ASSESSING');
      const updated = await startRollingBack({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('ROLLING_BACK');
    });

    it('ROLLING_BACK -> ROLLED_BACK via markRolledBack', async () => {
      const run = await createRun('ROLLING_BACK');
      const updated = await markRolledBack({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('ROLLED_BACK');
    });

    it('ROLLING_BACK -> ROLLBACK_PARTIAL via markRollbackPartial', async () => {
      const run = await createRun('ROLLING_BACK');
      const updated = await markRollbackPartial({ runId: run.id, expectedVersion: run.version, failureReason: 'partial rollback' });
      expect(updated.status).toBe('ROLLBACK_PARTIAL');
      expect(updated.failureReason).toBe('partial rollback');
    });

    it('a non-terminal state (e.g. PLANNED) -> SUPERSEDED via supersede', async () => {
      const run = await createRun('PLANNED');
      const updated = await supersede({ runId: run.id, expectedVersion: run.version });
      expect(updated.status).toBe('SUPERSEDED');
    });
  });

  describe('invalid transitions are rejected before any write', () => {
    it('PLANNED -> ROLLED_BACK throws InvalidTransitionError and leaves the row untouched', async () => {
      const run = await createRun('PLANNED');
      await expect(transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'ROLLED_BACK' })).rejects.toThrow(
        InvalidTransitionError,
      );

      const row = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe('PLANNED');
      expect(row.version).toBe(run.version);
    });

    it('APPLIED -> APPLYING throws InvalidTransitionError and leaves the row untouched', async () => {
      const run = await createRun('APPLIED');
      await expect(transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'APPLYING' })).rejects.toThrow(
        InvalidTransitionError,
      );

      const row = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe('APPLIED');
      expect(row.version).toBe(run.version);
    });

    it('DRY_RUN_VALIDATED -> APPLIED throws InvalidTransitionError', async () => {
      const run = await createRun('DRY_RUN_VALIDATED');
      await expect(transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'APPLIED' })).rejects.toThrow(
        InvalidTransitionError,
      );
    });

    it('a terminal state (APPLY_FAILED) rejects ANY outgoing transition, including to SUPERSEDED', async () => {
      const run = await createRun('APPLY_FAILED');
      await expect(transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'SUPERSEDED' })).rejects.toThrow(
        InvalidTransitionError,
      );
      await expect(
        transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'ROLLBACK_ASSESSING' }),
      ).rejects.toThrow(InvalidTransitionError);

      const row = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe('APPLY_FAILED');
      expect(row.version).toBe(run.version);
    });

    it('another terminal state (ROLLED_BACK) rejects outgoing transitions too', async () => {
      const run = await createRun('ROLLED_BACK');
      await expect(
        transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'SUPERSEDED' }),
      ).rejects.toThrow(InvalidTransitionError);
    });
  });

  describe('stale version is distinguishable from invalid transition', () => {
    it('a second transition using the pre-update version throws StaleVersionError, not InvalidTransitionError', async () => {
      const run = await createRun('PLANNED');

      // First call succeeds and bumps the version.
      const updated = await markDryRunValidated({ runId: run.id, expectedVersion: run.version });
      expect(updated.version).toBe(run.version + 1);

      // Second call reuses the now-stale `run.version` for a transition that
      // WOULD be structurally valid from the row's current status
      // (DRY_RUN_VALIDATED -> APPLYING) — proving the failure is purely a
      // version mismatch, not a table lookup rejection.
      await expect(startApplying({ runId: run.id, expectedVersion: run.version })).rejects.toThrow(StaleVersionError);

      try {
        await startApplying({ runId: run.id, expectedVersion: run.version });
        expect.unreachable('expected StaleVersionError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StaleVersionError);
        expect(error).not.toBeInstanceOf(InvalidTransitionError);
        expect((error as InstanceType<typeof StaleVersionError>).code).toBe('STALE_VERSION');
      }
    });

    it('InvalidTransitionError and StaleVersionError are distinguishable by instanceof and by .code, not just message', async () => {
      const run = await createRun('APPLIED');

      let invalidError: unknown;
      try {
        await transitionRunStatus({ runId: run.id, expectedVersion: run.version, toStatus: 'PLANNED' });
      } catch (error) {
        invalidError = error;
      }
      expect(invalidError).toBeInstanceOf(InvalidTransitionError);
      expect(invalidError).not.toBeInstanceOf(StaleVersionError);
      expect((invalidError as InstanceType<typeof InvalidTransitionError>).code).toBe('INVALID_TRANSITION');

      let staleError: unknown;
      try {
        await transitionRunStatus({ runId: run.id, expectedVersion: run.version + 999, toStatus: 'ROLLBACK_ASSESSING' });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toBeInstanceOf(StaleVersionError);
      expect(staleError).not.toBeInstanceOf(InvalidTransitionError);
    });
  });

  describe('RunNotFoundError', () => {
    it('throws RunNotFoundError for a runId that does not exist', async () => {
      await expect(
        transitionRunStatus({ runId: randomUUID(), expectedVersion: 1, toStatus: 'DRY_RUN_VALIDATED' }),
      ).rejects.toThrow(RunNotFoundError);
    });
  });
});
