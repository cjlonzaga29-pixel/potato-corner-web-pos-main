import type { InitializationEntityType, InitializationRun, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hasDownstreamReference } from './rollback-assessment.service.js';
import { markRolledBack, markRollbackPartial } from './run-lifecycle.service.js';

/**
 * CR-009 "Rollback execution service" — the ONLY module in this CR that
 * actually deletes a real target-table row (InventoryCategory /
 * UnitOfMeasure / UnitConversion). Everything up to this task (R9's
 * assessment) only ever computed and stored `rollbackEligibility`; this
 * module is the one that acts on it.
 *
 * Stop condition (this task's own, from the brief): deletion must NEVER
 * happen without both (a) a FRESHLY re-read `rollbackEligibility ===
 * 'ELIGIBLE'` — re-read inside the transaction immediately before the
 * delete, never trusted from an earlier read — AND (b) an explicit,
 * per-row confirmation token supplied by the caller for that exact
 * `recordId`. A confirmation on a BLOCKED row never overrides eligibility;
 * eligibility with no confirmation never deletes either.
 *
 * --- Confirmation-token design (this task's judgment call) -------------
 *
 * `RollbackConfirmation = { recordId, confirmationToken }` is already
 * locked by the brief as per-row, never a batch-wide/type-wide boolean.
 * What was left open is the exact SHAPE of `confirmationToken`.
 *
 * Chosen design: `confirmationToken = buildConfirmationToken(recordId,
 * currentVerificationFingerprint)`, i.e. `${recordId}:${fingerprint}` where
 * `fingerprint` is the exact `InitializationRecord.currentVerificationFingerprint`
 * value R9's assessment wrote for that specific row (or the literal string
 * `'null'` if that field is null, which never happens for a row that ever
 * reaches ELIGIBLE — see R9's `assessOneRecord`, condition 2 must pass
 * first). Reasoning:
 *
 *   1. It is per-row by construction: a token embeds one specific
 *      `recordId`, so a single string cannot be handed to two different
 *      rows and match both — a caller CANNOT confirm "the whole batch"
 *      with one shared value, they must compute (or copy) a distinct
 *      token per row they intend to confirm.
 *   2. It also embeds a value that only exists BECAUSE R9's assessment
 *      ran for that row — the fingerprint is not something a caller could
 *      invent without having actually looked at that row's assessment
 *      result (or the row itself). This ties confirmation to "the operator
 *      reviewed THIS row's specific assessed state", not just "the
 *      operator knows this row's id" (which alone would be a weaker,
 *      almost-tautological check, since `recordId` is already a required
 *      field of `RollbackConfirmation` on its own).
 *   3. It requires no new secret, HMAC key, or out-of-band storage — the
 *      token is fully reconstructible from data the caller already has
 *      (the assessment result), which keeps this an internal
 *      operator-confirmation contract, not a cryptographic security
 *      boundary (authorization/auth is explicitly out of scope, deferred
 *      to R12 per R9's own docs).
 *
 * This is NOT a security token (it is not secret, not signed, and is
 * trivially reconstructible by anyone who can read the row) — it exists to
 * make ACCIDENTAL batch-wide reuse structurally awkward, not to resist a
 * malicious caller. Given R12 (authorization) is explicitly a separate,
 * later task, this is the right altitude for R10.
 */
export function buildConfirmationToken(recordId: string, currentVerificationFingerprint: string | null): string {
  return `${recordId}:${currentVerificationFingerprint ?? 'null'}`;
}

export interface RollbackConfirmation {
  recordId: string;
  confirmationToken: string;
}

export type RollbackRecordOutcome =
  | 'deleted'
  | 'skipped-not-eligible'
  | 'skipped-not-confirmed'
  | 'skipped-became-ineligible-at-execution'
  | 'failed';

export interface RollbackExecutionRecordResult {
  recordId: string;
  entityType: InitializationEntityType;
  outcome: RollbackRecordOutcome;
}

export interface RollbackExecutionResult {
  runId: string;
  runStatus: 'ROLLED_BACK' | 'ROLLBACK_PARTIAL';
  records: RollbackExecutionRecordResult[];
}

/**
 * Reverse-dependency execution order (CR-009 "Rollback transaction
 * strategy"): conversions are leaves (nothing references them), units are
 * next (InventoryItem/UnitConversion may reference them), categories are
 * roots (InventoryItem may reference them). Attempting deletes in this
 * order minimizes the chance of a live FK reference blocking a later step
 * — though see the per-type loop below: ALL three types are always
 * attempted regardless of an earlier type's outcome, per the brief.
 */
const TYPE_ORDER: readonly InitializationEntityType[] = ['UNIT_CONVERSION', 'UNIT_OF_MEASURE', 'INVENTORY_CATEGORY'];

/** Deletes the live target row for `entityType`/`entityId`, scoped to the caller's transaction client. */
async function deleteTargetRow(tx: Prisma.TransactionClient, entityType: InitializationEntityType, entityId: string): Promise<void> {
  switch (entityType) {
    case 'UNIT_CONVERSION':
      await tx.unitConversion.delete({ where: { id: entityId } });
      return;
    case 'UNIT_OF_MEASURE':
      await tx.unitOfMeasure.delete({ where: { id: entityId } });
      return;
    case 'INVENTORY_CATEGORY':
      await tx.inventoryCategory.delete({ where: { id: entityId } });
      return;
  }
}

/**
 * Executes one reference type's confirmed-and-still-eligible rollback
 * deletes inside a SINGLE `prisma.$transaction`. Every candidate record
 * for this type gets a fresh, in-transaction re-read of its
 * `rollbackEligibility` and a fresh, in-transaction re-run of R9's
 * `hasDownstreamReference` immediately before any delete is attempted —
 * neither check ever trusts a value computed before this transaction
 * opened. If a delete throws (e.g. a live FK violation, a race where the
 * row is already gone), the transaction rejects and Prisma rolls back
 * EVERYTHING attempted in it, including sibling rows' otherwise-successful
 * deletes in this same type — intentional per-type atomicity, not
 * per-row (CR-009 explicitly allows `ROLLBACK_PARTIAL` at the type level).
 *
 * Returns the outcome for every candidate record. On transaction success,
 * every candidate not resolved to a skip reason is `deleted`. On
 * transaction failure, every candidate not resolved to a skip reason
 * (i.e. every row that was or would have been attempted) is `failed`.
 */
async function executeTypeTransaction(
  candidates: Array<{ id: string; entityId: string | null }>,
  entityType: InitializationEntityType,
  confirmationMap: Map<string, string>,
): Promise<Map<string, RollbackRecordOutcome>> {
  const skipOutcomes = new Map<string, RollbackRecordOutcome>();
  let committed = false;

  try {
    await prisma.$transaction(async (tx) => {
      for (const candidate of candidates) {
        // (a) Fresh, in-transaction re-read -- never trust a value passed
        // in from an earlier call (R9's assessment, or this function's own
        // caller).
        const fresh = await tx.initializationRecord.findUniqueOrThrow({ where: { id: candidate.id } });

        if (fresh.rollbackEligibility !== 'ELIGIBLE') {
          skipOutcomes.set(candidate.id, 'skipped-not-eligible');
          continue;
        }

        const token = confirmationMap.get(candidate.id);
        const expectedToken = buildConfirmationToken(fresh.id, fresh.currentVerificationFingerprint);
        if (token === undefined || token !== expectedToken) {
          skipOutcomes.set(candidate.id, 'skipped-not-confirmed');
          continue;
        }

        const entityId = fresh.entityId;
        if (entityId === null) {
          // Should not happen for an ELIGIBLE row (ELIGIBLE requires
          // action=CREATED with a non-null entityId per R9), but guard
          // defensively rather than attempt a delete with no target.
          skipOutcomes.set(candidate.id, 'skipped-not-eligible');
          continue;
        }

        // (b) Fresh, in-transaction re-run of R9's live downstream-reference
        // check -- catches a reference created between R9's assessment and
        // this execution.
        if (await hasDownstreamReference(entityType, entityId, tx)) {
          skipOutcomes.set(candidate.id, 'skipped-became-ineligible-at-execution');
          continue;
        }

        // Both checks passed, live, inside this transaction: delete the
        // target row AND update InitializationRecord together.
        await deleteTargetRow(tx, entityType, entityId);
        await tx.initializationRecord.update({
          where: { id: candidate.id },
          data: { rollbackStatus: 'ROLLED_BACK', rolledBackAt: new Date() },
        });
      }
    });
    committed = true;
  } catch {
    committed = false;
  }

  const outcomes = new Map<string, RollbackRecordOutcome>();
  for (const candidate of candidates) {
    const skip = skipOutcomes.get(candidate.id);
    outcomes.set(candidate.id, skip ?? (committed ? 'deleted' : 'failed'));
  }
  return outcomes;
}

export interface ExecuteRollbackParams {
  runId: string;
  confirmations: RollbackConfirmation[];
}

/**
 * CR-009 "Rollback execution service" — deletes every confirmed,
 * still-eligible `CREATED` target row for `runId`, in reverse-dependency
 * per-type transactions, then transitions the run to `ROLLED_BACK` (every
 * `CREATED` record ended up `ROLLED_BACK`) or `ROLLBACK_PARTIAL`
 * (otherwise), via R4's `markRolledBack`/`markRollbackPartial`.
 *
 * Callers are responsible for having already transitioned the run to
 * `ROLLING_BACK` (via R4's `startRollingBack`, itself preceded by
 * `startRollbackAssessment`) before calling this function — same
 * boundary R8 documented for its own "future orchestration" note. This
 * function only performs the `ROLLING_BACK -> ROLLED_BACK` /
 * `ROLLING_BACK -> ROLLBACK_PARTIAL` transition, nothing earlier.
 */
export async function executeRollback(params: ExecuteRollbackParams): Promise<RollbackExecutionResult> {
  const { runId, confirmations } = params;
  const confirmationMap = new Map(confirmations.map((c) => [c.recordId, c.confirmationToken]));

  const allRecords = await prisma.initializationRecord.findMany({
    where: { initializationRunId: runId, action: 'CREATED' },
  });

  const records: RollbackExecutionRecordResult[] = [];

  for (const entityType of TYPE_ORDER) {
    const candidates = allRecords.filter((r) => r.entityType === entityType);
    if (candidates.length === 0) {
      continue;
    }

    const outcomes = await executeTypeTransaction(candidates, entityType, confirmationMap);
    for (const candidate of candidates) {
      records.push({
        recordId: candidate.id,
        entityType,
        outcome: outcomes.get(candidate.id) ?? 'failed',
      });
    }
  }

  // Re-read every CREATED record's final rollbackStatus (fresh, post all
  // three type-transactions) to determine run status per the brief's exact
  // rule: ROLLED_BACK only if EVERY CREATED record in the run ended up
  // ROLLED_BACK.
  const finalRecords = await prisma.initializationRecord.findMany({
    where: { initializationRunId: runId, action: 'CREATED' },
    select: { rollbackStatus: true },
  });
  const allRolledBack = finalRecords.length > 0 && finalRecords.every((r) => r.rollbackStatus === 'ROLLED_BACK');

  const run = await prisma.initializationRun.findUniqueOrThrow({ where: { id: runId } });
  const transitionedRun: InitializationRun = allRolledBack
    ? await markRolledBack({ runId, expectedVersion: run.version })
    : await markRollbackPartial({ runId, expectedVersion: run.version });

  return {
    runId,
    runStatus: transitionedRun.status as 'ROLLED_BACK' | 'ROLLBACK_PARTIAL',
    records,
  };
}
