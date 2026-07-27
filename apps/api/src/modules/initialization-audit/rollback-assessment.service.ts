import type { InitializationEntityType, InitializationRecord, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { computeFingerprint, FINGERPRINT_VERSION } from './fingerprint.js';

/** Either the root `prisma` singleton or a `Prisma.TransactionClient` passed into a `prisma.$transaction(...)` callback -- accepted so callers (e.g. R10's rollback-execution.service.ts) can re-run this exact check LIVE, inside their own transaction, immediately before a delete. */
type PrismaClientOrTx = typeof prisma | Prisma.TransactionClient;

/**
 * CR-009 "Rollback assessment service" — computes (but never acts on)
 * `InitializationRecord.rollbackEligibility` for every record in a run.
 *
 * This module is ASSESSMENT ONLY: it never deletes a target row, never
 * writes to InventoryCategory/UnitOfMeasure/UnitConversion, and never
 * touches `InitializationRun.status` (R4 owns that) or takes the advisory
 * lock (R6). It only ever writes `InitializationRecord.currentVerification
 * Fingerprint` / `.rollbackEligibility` / `.rollbackBlockedReason`, one row
 * at a time, via an optimistic-CAS update scoped by the record's own
 * `version` — the same pattern R4/R5 use for their writes.
 *
 * Deliberately excluded (see task brief "Explicitly out of scope"):
 * authorization (R12), per-row confirmation (R10), `targetEnvironment`
 * matching, and the rollback transaction itself succeeding (R10). None of
 * these are optional to skip under a flag — they simply are not this
 * function's job.
 */

// --- Reason tokens ---------------------------------------------------------
//
// The two CR-009-given tokens are reproduced verbatim; the other two are
// this task's own choice (documented in the task report), deliberately
// following the same SCREAMING_SNAKE_CASE, self-describing style.

/** CR-009-locked token: a `REUSED` record is never eligible, unconditionally (condition 1). */
export const REUSED_RECORD_NEVER_ELIGIBLE = 'REUSED_RECORD_NEVER_ELIGIBLE';

/**
 * CR-009-locked token (named explicitly in the decision doc): the live
 * target row's recomputed fingerprint no longer matches
 * `resultingFingerprint` (condition 2). Also used for the "row was deleted
 * out-of-band" sub-case — a missing row can't be verified, and a deletion
 * is itself a form of "modified after initialization" (documented choice,
 * see task report — no separate token was introduced for this sub-case).
 */
export const TARGET_MODIFIED_AFTER_INITIALIZATION = 'TARGET_MODIFIED_AFTER_INITIALIZATION';

/** CR-009-locked token: a live row elsewhere still references this entity by FK (condition 3). */
export const DOWNSTREAM_REFERENCE_EXISTS = 'DOWNSTREAM_REFERENCE_EXISTS';

/** This task's own choice of token (CR-009 does not lock an exact string for this case): another run's REUSED record depends on this same entityId (condition 4). */
export const CROSS_RUN_DEPENDENCY_EXISTS = 'CROSS_RUN_DEPENDENCY_EXISTS';

// --- Errors -----------------------------------------------------------------

/** Thrown when the per-record optimistic-CAS write-back affects zero rows (the record moved between read and write). Mirrors R4/R5's Stale*VersionError pattern. */
export class StaleAssessmentVersionError extends Error {
  public readonly code = 'STALE_ASSESSMENT_VERSION' as const;

  constructor(
    public readonly recordId: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Stale version for InitializationRecord "${recordId}": expected version ${expectedVersion} no longer matches the current row`,
    );
    this.name = 'StaleAssessmentVersionError';
  }
}

// --- Per-entity-type plumbing ------------------------------------------------

/** Maps the `InitializationEntityType` enum to R3's `computeFingerprint` entity-type keys. */
const FINGERPRINT_ENTITY_TYPE: Record<InitializationEntityType, string> = {
  INVENTORY_CATEGORY: 'InventoryCategory',
  UNIT_OF_MEASURE: 'UnitOfMeasure',
  UNIT_CONVERSION: 'UnitConversion',
};

/** Fetches the live target row's fingerprint-relevant fields, or `null` if the row no longer exists. */
async function fetchLiveEntityFields(
  entityType: InitializationEntityType,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  switch (entityType) {
    case 'INVENTORY_CATEGORY':
      return prisma.inventoryCategory.findUnique({ where: { id: entityId } });
    case 'UNIT_OF_MEASURE':
      return prisma.unitOfMeasure.findUnique({ where: { id: entityId } });
    case 'UNIT_CONVERSION':
      return prisma.unitConversion.findUnique({ where: { id: entityId } });
  }
}

/**
 * Condition 3, "Live downstream reference" — per `entityType`:
 *  - INVENTORY_CATEGORY: any InventoryItem.categoryId = entityId.
 *  - UNIT_OF_MEASURE: any InventoryItem.baseUnitId = entityId, OR any
 *    UnitConversion.fromUnitId/toUnitId = entityId.
 *  - UNIT_CONVERSION: nothing in the current schema references a
 *    UnitConversion row by FK — this check always passes (no downstream
 *    reference possible) for this entity type. This is an explicit,
 *    considered no-op, not an omission.
 *
 * Exported (R10 addition) so the rollback-execution service can re-run this
 * EXACT logic live, inside its own per-type `prisma.$transaction(...)`
 * callback, immediately before each delete — passing its `tx` client via
 * the optional `client` parameter rather than reimplementing the check.
 * Defaults to the root `prisma` singleton so R9's own call sites (and R9's
 * existing tests) are unaffected.
 */
export async function hasDownstreamReference(
  entityType: InitializationEntityType,
  entityId: string,
  client: PrismaClientOrTx = prisma,
): Promise<boolean> {
  switch (entityType) {
    case 'INVENTORY_CATEGORY': {
      // deletedAt: null excludes soft-deleted InventoryItem rows -- a
      // soft-deleted item is not a "live" reference (see this codebase's
      // established soft-delete convention, e.g. product-inventory.repository.ts).
      const count = await client.inventoryItem.count({ where: { categoryId: entityId, deletedAt: null } });
      return count > 0;
    }
    case 'UNIT_OF_MEASURE': {
      const [itemCount, conversionCount] = await Promise.all([
        client.inventoryItem.count({ where: { baseUnitId: entityId, deletedAt: null } }),
        // UnitConversion has no soft-delete field -- every row is live.
        client.unitConversion.count({ where: { OR: [{ fromUnitId: entityId }, { toUnitId: entityId }] } }),
      ]);
      return itemCount > 0 || conversionCount > 0;
    }
    case 'UNIT_CONVERSION':
      return false;
  }
}

/**
 * Condition 4, "Cross-run dependency" — another run's InitializationRecord
 * resolved (action=REUSED) to this same (entityType, entityId): deleting
 * this run's row now would orphan that later run's provenance.
 */
async function hasCrossRunDependency(
  runId: string,
  entityType: InitializationEntityType,
  entityId: string,
): Promise<boolean> {
  const dependent = await prisma.initializationRecord.findFirst({
    where: {
      initializationRunId: { not: runId },
      entityType,
      entityId,
      action: 'REUSED',
    },
    select: { id: true },
  });
  return dependent !== null;
}

// --- Per-record assessment ---------------------------------------------------

interface Assessment {
  currentVerificationFingerprint: string | null;
  rollbackEligibility: 'ELIGIBLE' | 'BLOCKED' | null;
  rollbackBlockedReason: string | null;
}

/**
 * Assesses a single record against the five conditions from CR-009's
 * "Exact eligibility rules", in order, short-circuiting on the first
 * failing condition.
 *
 * Only `action = CREATED` and `action = REUSED` records are meaningfully
 * assessable in the "may be deleted" sense (out-of-scope note in the task
 * brief). For `VALIDATED`/`BLOCKED`/`SKIPPED`/`FAILED` records (no
 * entityId, nothing to roll back), this function is never called — the
 * caller filters them out and leaves them at `rollbackEligibility = null`
 * (documented decision: "skip entirely" rather than "mark ineligible",
 * since there's nothing to be ineligible ABOUT — no target row exists).
 */
async function assessOneRecord(runId: string, record: InitializationRecord): Promise<Assessment> {
  // Condition 1: REUSED is never eligible, unconditionally. Short-circuits
  // before any other check — a REUSED record with a live target row whose
  // fingerprint matches and zero downstream references must STILL block.
  if (record.reusedExisting || record.action === 'REUSED') {
    return {
      currentVerificationFingerprint: null,
      rollbackEligibility: 'BLOCKED',
      rollbackBlockedReason: REUSED_RECORD_NEVER_ELIGIBLE,
    };
  }

  // From here on, action === 'CREATED' with a non-null entityId (the only
  // other case this function is invoked for — see the caller's filter).
  const entityId = record.entityId as string;

  // Condition 2: fingerprint match.
  const liveFields = await fetchLiveEntityFields(record.entityType, entityId);
  if (liveFields === null) {
    // The live row was deleted out-of-band. Can't verify a fingerprint
    // against a row that isn't there — treated as a mismatch, reusing
    // TARGET_MODIFIED_AFTER_INITIALIZATION since deletion is a form of
    // "modified after initialization" (documented choice, see task report).
    return {
      currentVerificationFingerprint: null,
      rollbackEligibility: 'BLOCKED',
      rollbackBlockedReason: TARGET_MODIFIED_AFTER_INITIALIZATION,
    };
  }

  const currentVerificationFingerprint = computeFingerprint(
    FINGERPRINT_ENTITY_TYPE[record.entityType],
    liveFields,
    FINGERPRINT_VERSION,
  ).hash;

  if (currentVerificationFingerprint !== record.resultingFingerprint) {
    return {
      currentVerificationFingerprint,
      rollbackEligibility: 'BLOCKED',
      rollbackBlockedReason: TARGET_MODIFIED_AFTER_INITIALIZATION,
    };
  }

  // Condition 3: live downstream reference.
  if (await hasDownstreamReference(record.entityType, entityId)) {
    return {
      currentVerificationFingerprint,
      rollbackEligibility: 'BLOCKED',
      rollbackBlockedReason: DOWNSTREAM_REFERENCE_EXISTS,
    };
  }

  // Condition 4: cross-run dependency.
  if (await hasCrossRunDependency(runId, record.entityType, entityId)) {
    return {
      currentVerificationFingerprint,
      rollbackEligibility: 'BLOCKED',
      rollbackBlockedReason: CROSS_RUN_DEPENDENCY_EXISTS,
    };
  }

  // Condition 5: all pass.
  return {
    currentVerificationFingerprint,
    rollbackEligibility: 'ELIGIBLE',
    rollbackBlockedReason: null,
  };
}

/**
 * Writes the computed assessment back to the record's row via a single
 * optimistic-CAS update scoped by `{ id, version: expectedVersion }` —
 * idempotent/re-runnable, so unlike R4/R5's writes this one tolerates being
 * invoked repeatedly, but still uses the same CAS mechanics for consistency
 * and to avoid clobbering a concurrent write blindly.
 *
 * Throws `StaleAssessmentVersionError` if the CAS update affects zero rows.
 */
async function writeAssessment(record: InitializationRecord, assessment: Assessment): Promise<InitializationRecord> {
  const result = await prisma.initializationRecord.updateMany({
    where: { id: record.id, version: record.version },
    data: {
      currentVerificationFingerprint: assessment.currentVerificationFingerprint,
      rollbackEligibility: assessment.rollbackEligibility,
      rollbackBlockedReason: assessment.rollbackBlockedReason,
      version: { increment: 1 },
    },
  });

  if (result.count === 0) {
    throw new StaleAssessmentVersionError(record.id, record.version);
  }

  return prisma.initializationRecord.findUniqueOrThrow({ where: { id: record.id } });
}

/**
 * CR-009 "Rollback assessment service" — assesses rollback eligibility for
 * every assessable `InitializationRecord` row belonging to `runId`, writes
 * the result back to each row, and returns the full (post-write) set of
 * records for the run (assessed and skipped alike).
 *
 * Only `action = CREATED` and `action = REUSED` records are assessed.
 * `VALIDATED`/`BLOCKED`/`SKIPPED`/`FAILED` records have no entityId and
 * nothing to roll back — they are left untouched at their existing
 * `rollbackEligibility` (null until ever assessed), per this task's
 * documented decision.
 *
 * Read/assess only: never deletes a target row, never mutates
 * InventoryCategory/UnitOfMeasure/UnitConversion/InventoryItem, never
 * touches InitializationRun.status.
 */
export async function assessRollbackEligibility(runId: string): Promise<InitializationRecord[]> {
  const records = await prisma.initializationRecord.findMany({ where: { initializationRunId: runId } });

  const results: InitializationRecord[] = [];
  for (const record of records) {
    const isAssessable = record.action === 'CREATED' || record.action === 'REUSED';
    if (!isAssessable) {
      results.push(record);
      continue;
    }

    const assessment = await assessOneRecord(runId, record);
    const written = await writeAssessment(record, assessment);
    results.push(written);
  }

  return results;
}
