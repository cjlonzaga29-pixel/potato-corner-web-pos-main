import type { InitializationRunStatus } from '@prisma/client';

/**
 * CR-009 "Run lifecycle" — the authoritative transition table for
 * `InitializationRun.status`.
 *
 * Valid transitions, exactly these arrows, nothing else:
 *
 *   PLANNED            -> DRY_RUN_VALIDATED
 *   DRY_RUN_VALIDATED  -> APPLYING
 *   APPLYING           -> APPLIED
 *   APPLYING           -> APPLY_FAILED
 *   APPLIED            -> ROLLBACK_ASSESSING
 *   ROLLBACK_ASSESSING -> ROLLBACK_BLOCKED
 *   ROLLBACK_ASSESSING -> ROLLING_BACK
 *   ROLLING_BACK       -> ROLLED_BACK
 *   ROLLING_BACK       -> ROLLBACK_PARTIAL
 *
 * Additionally, any NON-terminal state may transition to `SUPERSEDED`
 * (documentation-only marker — no data effect beyond the status/version
 * columns themselves).
 *
 * Terminal states (no outgoing transitions, ever): APPLY_FAILED,
 * ROLLBACK_BLOCKED, ROLLED_BACK, ROLLBACK_PARTIAL, SUPERSEDED.
 * `APPLY_FAILED` is retried only as a brand-new `InitializationRun` row
 * with a new `migrationBatch` — never resumed in place. That's out of
 * scope here; this module only refuses `APPLY_FAILED -> anything`.
 */
export const RUN_TRANSITION_TABLE: Readonly<Record<InitializationRunStatus, readonly InitializationRunStatus[]>> = {
  PLANNED: ['DRY_RUN_VALIDATED'],
  DRY_RUN_VALIDATED: ['APPLYING'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
  APPLIED: ['ROLLBACK_ASSESSING'],
  ROLLBACK_ASSESSING: ['ROLLBACK_BLOCKED', 'ROLLING_BACK'],
  ROLLING_BACK: ['ROLLED_BACK', 'ROLLBACK_PARTIAL'],
  APPLY_FAILED: [],
  ROLLBACK_BLOCKED: [],
  ROLLED_BACK: [],
  ROLLBACK_PARTIAL: [],
  SUPERSEDED: [],
};

/** Terminal statuses never transition anywhere, including to SUPERSEDED. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<InitializationRunStatus> = new Set([
  'APPLY_FAILED',
  'ROLLBACK_BLOCKED',
  'ROLLED_BACK',
  'ROLLBACK_PARTIAL',
  'SUPERSEDED',
]);

export interface TransitionRunStatusParams {
  runId: string;
  expectedVersion: number;
  toStatus: InitializationRunStatus;
  /** Required (by the caller's own contract) when transitioning to APPLY_FAILED. */
  failureReason?: string;
}

export interface SimpleTransitionParams {
  runId: string;
  expectedVersion: number;
}

export interface MarkApplyFailedParams extends SimpleTransitionParams {
  failureReason: string;
}

export interface MarkRollbackPartialParams extends SimpleTransitionParams {
  failureReason?: string;
}

/**
 * Thrown when the requested transition is not in `RUN_TRANSITION_TABLE`
 * (or the source status is terminal). Thrown BEFORE any database write.
 * Distinguishable from `StaleVersionError` via `instanceof` or `.code`.
 */
export class InvalidTransitionError extends Error {
  public readonly code = 'INVALID_TRANSITION' as const;

  constructor(
    public readonly fromStatus: InitializationRunStatus,
    public readonly toStatus: InitializationRunStatus,
  ) {
    super(`Invalid InitializationRun transition: ${fromStatus} -> ${toStatus}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Thrown when the optimistic-concurrency CAS update affected zero rows —
 * the row's `version` (and/or `status`) changed between the read and the
 * write, meaning another caller transitioned it first. Distinguishable
 * from `InvalidTransitionError` via `instanceof` or `.code`.
 */
export class StaleVersionError extends Error {
  public readonly code = 'STALE_VERSION' as const;

  constructor(
    public readonly runId: string,
    public readonly expectedVersion: number,
  ) {
    super(`Stale version for InitializationRun "${runId}": expected version ${expectedVersion} no longer matches the current row`);
    this.name = 'StaleVersionError';
  }
}

/** Thrown when `runId` does not reference an existing InitializationRun row at all. */
export class RunNotFoundError extends Error {
  public readonly code = 'RUN_NOT_FOUND' as const;

  constructor(public readonly runId: string) {
    super(`InitializationRun "${runId}" not found`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * True iff `toStatus` is a legal next state for a run currently in
 * `fromStatus`, per `RUN_TRANSITION_TABLE` plus the "any non-terminal may
 * go to SUPERSEDED" rule. Pure and DB-free — used both by the service
 * (before any write) and directly by tests.
 */
export function isValidRunTransition(fromStatus: InitializationRunStatus, toStatus: InitializationRunStatus): boolean {
  if (TERMINAL_RUN_STATUSES.has(fromStatus)) {
    return false;
  }
  if (toStatus === 'SUPERSEDED') {
    return true;
  }
  return RUN_TRANSITION_TABLE[fromStatus].includes(toStatus);
}
