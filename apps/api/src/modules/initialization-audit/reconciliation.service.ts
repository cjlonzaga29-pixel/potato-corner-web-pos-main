import type { InitializationEntityType, InitializationRun, InitializationRunStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { markApplied, markApplyFailed, markRollbackPartial, markRolledBack, StaleVersionError } from './run-lifecycle.service.js';

/**
 * CR-009 "Failure recovery and stale-run reconciliation" (R11).
 *
 * IMPORTANT — scope resolution (see task-R11-brief.md for the full
 * discussion): this module is STRICTLY READ-ONLY against
 * `InitializationRecord`. It only ever reads the existing `action`/
 * `rollbackStatus` values already sitting on those rows (however they got
 * there — that's R5's / a future apply-orchestration's job, not this
 * module's) to DERIVE what a stuck run's true status should be, and writes
 * ONLY `InitializationRun.status`, exclusively via R4's lifecycle service
 * (`markApplied`/`markApplyFailed`/`markRolledBack`/`markRollbackPartial`),
 * never a raw `prisma.initializationRun.update`. This module must never
 * call `.update()`/`.create()`/`.updateMany()` on `prisma.initializationRecord`
 * anywhere in this file — see the task's stop condition.
 */

/** Phase C0's fixed reference-type order: categories -> units -> conversions (unchanged, per CR-009's global constraint). */
const REFERENCE_TYPE_ORDER: readonly InitializationEntityType[] = ['INVENTORY_CATEGORY', 'UNIT_OF_MEASURE', 'UNIT_CONVERSION'];

/** Human-readable labels for failure-reason text, matching the plan's own example ("units"). */
const TYPE_LABELS: Record<InitializationEntityType, string> = {
  INVENTORY_CATEGORY: 'categories',
  UNIT_OF_MEASURE: 'units',
  UNIT_CONVERSION: 'conversions',
};

export type ReconciliationOutcomeStatus = 'APPLIED' | 'APPLY_FAILED' | 'ROLLED_BACK' | 'ROLLBACK_PARTIAL' | 'CONFLICT';

export interface ReconciliationOutcome {
  runId: string;
  outcome: ReconciliationOutcomeStatus;
  /** Present for APPLY_FAILED / ROLLBACK_PARTIAL outcomes -- the reason passed to R4's transition. */
  failureReason?: string;
  /**
   * Anomaly flag (this task's judgment call, documented in the report): set
   * true when a reference type was found PARTIALLY transitioned (some of
   * its records still `VALIDATED`, others not) -- something per-type
   * transactional atomicity says should never happen. The status
   * determination still conservatively treats this the same as "not fully
   * transitioned" (APPLY_FAILED, naming that type), but this flag/detail
   * surfaces the anomaly distinctly rather than silently normalizing it
   * away, since it may indicate a deeper data-integrity problem.
   */
  anomalyDetected: boolean;
  anomalyDetail?: string;
  /** Present only for CONFLICT outcomes -- why this run's reconciliation was aborted. */
  conflictReason?: string;
}

/**
 * Finds runs stuck in `APPLYING` or `ROLLING_BACK` whose `startedAt` is
 * older than `now - timeoutMs`. Both `now` and `timeoutMs` are explicit
 * parameters so tests never need to wait out a real timeout. Default
 * timeout per CR-009's own example is 15 minutes, but callers (the CLI
 * script) choose that; this function takes no default.
 *
 * A run with a null `startedAt` (should not happen for APPLYING/
 * ROLLING_BACK per R4, which always sets `startedAt` on entry to
 * `APPLYING`) is never matched by the `lt` comparison below, so it is
 * conservatively left alone rather than guessed at.
 */
export async function findStaleRuns(now: Date, timeoutMs: number): Promise<InitializationRun[]> {
  const cutoff = new Date(now.getTime() - timeoutMs);
  return prisma.initializationRun.findMany({
    where: {
      status: { in: ['APPLYING', 'ROLLING_BACK'] },
      startedAt: { lt: cutoff },
    },
  });
}

interface ApplyDetermination {
  status: 'APPLIED' | 'APPLY_FAILED';
  failureReason?: string;
  anomalyDetected: boolean;
  anomalyDetail?: string;
}

/**
 * Walks `REFERENCE_TYPE_ORDER`, reading (never writing) this run's
 * `InitializationRecord` rows per type, to find the first type that is NOT
 * fully transitioned (i.e. still has at least one `VALIDATED` row, or has
 * no rows at all for that type). "Fully transitioned" = every row for that
 * type has `action != 'VALIDATED'` (per-type target-write + record-
 * transition are atomic together, per CR-009's Transaction Boundary, so
 * "any transitioned" implies "all transitioned" in the non-anomalous case).
 *
 * A type with SOME rows `VALIDATED` and some not is the anomaly case
 * (shouldn't be possible given per-type atomicity) -- treated the same as
 * "not fully transitioned" for status purposes, but flagged distinctly.
 */
async function determineApplyOutcome(runId: string): Promise<ApplyDetermination> {
  for (const entityType of REFERENCE_TYPE_ORDER) {
    const records = await prisma.initializationRecord.findMany({
      where: { initializationRunId: runId, entityType },
      select: { action: true },
    });

    if (records.length === 0) {
      return {
        status: 'APPLY_FAILED',
        failureReason: `First not-fully-transitioned reference type: ${TYPE_LABELS[entityType]} (no InitializationRecord rows found for this type)`,
        anomalyDetected: false,
      };
    }

    const validatedCount = records.filter((r) => r.action === 'VALIDATED').length;

    if (validatedCount === 0) {
      // Fully transitioned -- move on to the next type.
      continue;
    }

    if (validatedCount === records.length) {
      // None of this type's records ever transitioned -- that type's
      // per-type transaction never committed.
      return {
        status: 'APPLY_FAILED',
        failureReason: `First not-fully-transitioned reference type: ${TYPE_LABELS[entityType]}`,
        anomalyDetected: false,
      };
    }

    // Anomaly: partially transitioned. Shouldn't be possible given
    // per-type transactional atomicity -- don't silently pick a side.
    return {
      status: 'APPLY_FAILED',
      failureReason: `First not-fully-transitioned reference type: ${TYPE_LABELS[entityType]} (partially transitioned: ${
        records.length - validatedCount
      }/${records.length} rows transitioned, ${validatedCount}/${records.length} still VALIDATED)`,
      anomalyDetected: true,
      anomalyDetail: `Reference type "${TYPE_LABELS[entityType]}" (${entityType}) has a partial transition for run "${runId}": ${
        records.length - validatedCount
      } of ${records.length} InitializationRecord rows transitioned out of VALIDATED, the rest did not. This should not be possible given per-type transactional atomicity and may indicate a deeper data-integrity problem worth investigating.`,
    };
  }

  // All three types fully transitioned -- the crash happened between the
  // last type's commit and the final run-status transition.
  return { status: 'APPLIED', anomalyDetected: false };
}

interface RollbackDetermination {
  status: 'ROLLED_BACK' | 'ROLLBACK_PARTIAL';
  failureReason?: string;
}

/**
 * Mirrors R10's own run-status determination logic (see
 * rollback-execution.service.ts's `executeRollback`): `ROLLED_BACK` iff
 * every `action = 'CREATED'` record in this run now has `rollbackStatus =
 * 'ROLLED_BACK'` (and at least one such record exists); otherwise
 * `ROLLBACK_PARTIAL`.
 */
async function determineRollbackOutcome(runId: string): Promise<RollbackDetermination> {
  const records = await prisma.initializationRecord.findMany({
    where: { initializationRunId: runId, action: 'CREATED' },
    select: { id: true, manifestEntryKey: true, rollbackStatus: true },
  });

  const notRolledBack = records.filter((r) => r.rollbackStatus !== 'ROLLED_BACK');
  const allRolledBack = records.length > 0 && notRolledBack.length === 0;

  if (allRolledBack) {
    return { status: 'ROLLED_BACK' };
  }

  const summary =
    records.length === 0
      ? 'no CREATED records found for this run'
      : `${notRolledBack.length} of ${records.length} CREATED record(s) not yet ROLLED_BACK: ${notRolledBack
          .map((r) => r.manifestEntryKey)
          .join(', ')}`;

  return { status: 'ROLLBACK_PARTIAL', failureReason: summary };
}

/**
 * Reconciles ONE stale run: re-derives its true status from durable
 * `InitializationRecord` rows (read-only) and writes the result ONLY via
 * R4's lifecycle service, using a version freshly re-read at the start of
 * this call (never a value trusted from an earlier read/caller).
 *
 * A run no longer sitting in `APPLYING`/`ROLLING_BACK` by the time this
 * function's own fresh read happens (e.g. a concurrent process already
 * reconciled or otherwise transitioned it since it was identified as
 * stale) is reported as a `CONFLICT` outcome, not treated as reconcilable
 * and not thrown. A genuine CAS race at the final write (R4's
 * `StaleVersionError`) is caught for the same reason -- either way, only
 * THIS run's outcome is affected; the caller (`reconcileAllStaleRuns`)
 * continues with the rest of the batch regardless.
 */
export async function reconcileRun(runId: string): Promise<ReconciliationOutcome> {
  const run = await prisma.initializationRun.findUnique({ where: { id: runId } });
  if (!run) {
    return { runId, outcome: 'CONFLICT', anomalyDetected: false, conflictReason: `InitializationRun "${runId}" not found` };
  }

  const startStatus: InitializationRunStatus = run.status;
  if (startStatus !== 'APPLYING' && startStatus !== 'ROLLING_BACK') {
    return {
      runId,
      outcome: 'CONFLICT',
      anomalyDetected: false,
      conflictReason: `Run status is "${startStatus}", no longer APPLYING/ROLLING_BACK -- likely already reconciled or transitioned by another process since this run was identified as stale`,
    };
  }

  try {
    if (startStatus === 'APPLYING') {
      const determination = await determineApplyOutcome(runId);

      if (determination.status === 'APPLIED') {
        await markApplied({ runId, expectedVersion: run.version });
        return { runId, outcome: 'APPLIED', anomalyDetected: false };
      }

      await markApplyFailed({ runId, expectedVersion: run.version, failureReason: determination.failureReason ?? 'reconciliation: not fully transitioned' });
      return {
        runId,
        outcome: 'APPLY_FAILED',
        failureReason: determination.failureReason,
        anomalyDetected: determination.anomalyDetected,
        anomalyDetail: determination.anomalyDetail,
      };
    }

    // ROLLING_BACK
    const determination = await determineRollbackOutcome(runId);

    if (determination.status === 'ROLLED_BACK') {
      await markRolledBack({ runId, expectedVersion: run.version });
      return { runId, outcome: 'ROLLED_BACK', anomalyDetected: false };
    }

    await markRollbackPartial({ runId, expectedVersion: run.version, failureReason: determination.failureReason });
    return { runId, outcome: 'ROLLBACK_PARTIAL', failureReason: determination.failureReason, anomalyDetected: false };
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return { runId, outcome: 'CONFLICT', anomalyDetected: false, conflictReason: error.message };
    }
    throw error;
  }
}

/**
 * Convenience batch wrapper: `findStaleRuns` then `reconcileRun` for each,
 * collecting every outcome (including CONFLICT outcomes). A conflicting or
 * otherwise-not-reconcilable run never stops the batch -- `reconcileRun`
 * never throws for the conditions it is documented to catch.
 */
export async function reconcileAllStaleRuns(now: Date, timeoutMs: number): Promise<ReconciliationOutcome[]> {
  const staleRuns = await findStaleRuns(now, timeoutMs);
  const outcomes: ReconciliationOutcome[] = [];
  for (const run of staleRuns) {
    outcomes.push(await reconcileRun(run.id));
  }
  return outcomes;
}
