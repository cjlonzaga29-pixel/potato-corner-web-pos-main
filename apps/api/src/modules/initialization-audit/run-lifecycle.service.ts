import type { InitializationRun, InitializationRunStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  InvalidTransitionError,
  RunNotFoundError,
  StaleVersionError,
  isValidRunTransition,
  type MarkApplyFailedParams,
  type MarkRollbackPartialParams,
  type SimpleTransitionParams,
  type TransitionRunStatusParams,
} from './run-lifecycle.types.js';

/**
 * CR-009 "Run lifecycle" — the `InitializationRun.status` state machine.
 *
 * This module is purely the status state machine: it never writes to
 * `InitializationRecord` (R5), never takes an advisory lock (R6), and
 * never writes an AuditLog row (R12 wraps calls into this service to do
 * that). It only ever writes `InitializationRun.status`/`version` (plus
 * the handful of timestamp/failureReason columns the transition table
 * calls for) — never `InventoryCategory`/`UnitOfMeasure`/`UnitConversion`.
 *
 * CAS mechanics: every transition takes the caller's believed current
 * `version`; the update is scoped by `where: { id, version: expectedVersion
 * }` so a concurrent transition (which increments `version`) makes this
 * update affect zero rows. This is a SINGLE CAS attempt — no retry/backoff
 * loop. The invalid-transition check always happens first, against a
 * fresh read of the row's current status, and always throws before any
 * write is attempted.
 */

/**
 * Generic transition entry point — validates `fromStatus -> toStatus`
 * against the transition table, then performs a single optimistic-CAS
 * update scoped by `{ id: runId, version: expectedVersion }`.
 *
 * Throws `RunNotFoundError` if `runId` doesn't exist, `InvalidTransitionError`
 * (before any write) if the transition isn't in the table, and
 * `StaleVersionError` if the CAS update affects zero rows (the row moved
 * between this function's read and its write).
 */
export async function transitionRunStatus(params: TransitionRunStatusParams): Promise<InitializationRun> {
  const { runId, expectedVersion, toStatus, failureReason } = params;

  const current = await prisma.initializationRun.findUnique({ where: { id: runId } });
  if (!current) {
    throw new RunNotFoundError(runId);
  }

  if (!isValidRunTransition(current.status, toStatus)) {
    throw new InvalidTransitionError(current.status, toStatus);
  }

  const data: {
    status: InitializationRunStatus;
    version: { increment: number };
    startedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
    failureReason?: string;
  } = {
    status: toStatus,
    version: { increment: 1 },
  };

  if (toStatus === 'APPLYING') {
    data.startedAt = new Date();
  } else if (toStatus === 'APPLIED') {
    data.completedAt = new Date();
  } else if (toStatus === 'APPLY_FAILED') {
    data.failedAt = new Date();
    if (failureReason !== undefined) {
      data.failureReason = failureReason;
    }
  } else if (toStatus === 'ROLLBACK_PARTIAL' && failureReason !== undefined) {
    data.failureReason = failureReason;
  }

  const result = await prisma.initializationRun.updateMany({
    where: { id: runId, version: expectedVersion },
    data,
  });

  if (result.count === 0) {
    throw new StaleVersionError(runId, expectedVersion);
  }

  return prisma.initializationRun.findUniqueOrThrow({ where: { id: runId } });
}

// --- Named convenience wrappers, one per arrow in the transition table ---

export function markDryRunValidated(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'DRY_RUN_VALIDATED' });
}

export function startApplying(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'APPLYING' });
}

export function markApplied(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'APPLIED' });
}

export function markApplyFailed(params: MarkApplyFailedParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'APPLY_FAILED', failureReason: params.failureReason });
}

export function startRollbackAssessment(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'ROLLBACK_ASSESSING' });
}

export function markRollbackBlocked(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'ROLLBACK_BLOCKED' });
}

export function startRollingBack(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'ROLLING_BACK' });
}

export function markRolledBack(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'ROLLED_BACK' });
}

export function markRollbackPartial(params: MarkRollbackPartialParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'ROLLBACK_PARTIAL', failureReason: params.failureReason });
}

/** Any non-terminal state may transition to SUPERSEDED (documentation-only marker). */
export function supersede(params: SimpleTransitionParams): Promise<InitializationRun> {
  return transitionRunStatus({ ...params, toStatus: 'SUPERSEDED' });
}

export { InvalidTransitionError, RunNotFoundError, StaleVersionError, isValidRunTransition } from './run-lifecycle.types.js';
