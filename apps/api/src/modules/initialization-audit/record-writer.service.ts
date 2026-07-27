import type { InitializationAction, InitializationEntityType, InitializationRecord } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * CR-009 "InitializationRecord write service" — the write path for the
 * per-manifest-entry provenance rows a future apply-transaction (Phase C0's
 * RC7, not built yet) will call during durable dry-run validation and apply.
 *
 * This module never touches `InitializationRun.status` (R4's
 * `run-lifecycle.service.ts` owns that), never takes an advisory lock (R6),
 * and never implements the apply orchestration itself (R8/RC7). It only
 * ever writes `InitializationRecord` rows, reconciled by the primary
 * identity `(initializationRunId, manifestEntryKey)` — never by target-row
 * identity (`entityId`).
 *
 * Both functions require a caller-supplied `Prisma.TransactionClient` (never
 * open their own transaction) so that the record write always lands in the
 * SAME transaction as the target-table write (InventoryCategory /
 * UnitOfMeasure / UnitConversion) a caller performs alongside it — this is
 * the CR-009 "Transaction boundary" requirement, enforced here at the type
 * level (see the `tx` parameter type) plus a defense-in-depth runtime guard
 * (`assertNotRootClient`) in case a caller's own types are loosened (e.g.
 * `any`) and the compile-time guarantee is bypassed.
 *
 * NOTE on the compile-time guarantee (see task brief for exact wording):
 * `Prisma.TransactionClient` is defined by prisma-client-js (v5.22.0) as
 * `Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' |
 * '$use' | '$extends'>`. Structurally, the root `PrismaClient` instance
 * (typed `PrismaClient`) is a strict superset of that shape — it has every
 * property `Prisma.TransactionClient` requires, plus the omitted ones.
 * TypeScript's structural typing allows a superset value to be passed where
 * a subset type is expected (excess-property checks only fire on object
 * *literals*, not on variables). Verified directly against this repo's
 * generated client types: passing the root `prisma` singleton where a
 * `tx: Prisma.TransactionClient` parameter is expected does NOT produce a
 * compile error. This is the "same structural type" case the brief warned
 * about, not a hypothetical — hence the runtime guard below is not optional
 * belt-and-suspenders, it is the only thing that actually catches this
 * mistake for the specific case of passing the singleton by name. It cannot
 * catch every possible way to construct a look-alike client, only the
 * concrete "passed the app's one root client" mistake.
 */
function assertNotRootClient(tx: Prisma.TransactionClient): void {
  if ((tx as unknown) === (prisma as unknown)) {
    throw new Error(
      'record-writer.service: tx must be a transaction client passed into a prisma.$transaction(...) callback, not the root prisma singleton',
    );
  }
}

// --- Error classes -----------------------------------------------------
//
// Follows the same distinguishability pattern as R4's run-lifecycle
// errors (`InvalidTransitionError`/`StaleVersionError`/`RunNotFoundError`):
// each condition gets its own class + a `.code` literal, so callers can
// branch with `instanceof` or `.code` rather than parsing messages.

/** Thrown when the requested action/entityId/createdByRun/reusedExisting combination violates the invariant rules. Thrown BEFORE any database access. */
export class InvariantViolationError extends Error {
  public readonly code = 'INVARIANT_VIOLATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

/** Thrown when `(runId, manifestEntryKey)` does not reference an existing InitializationRecord row. `transitionRecordOnApply` never creates a row — the dry-run row must already exist. */
export class RecordNotFoundError extends Error {
  public readonly code = 'RECORD_NOT_FOUND' as const;

  constructor(
    public readonly runId: string,
    public readonly manifestEntryKey: string,
  ) {
    super(`InitializationRecord for run "${runId}" / manifest entry "${manifestEntryKey}" not found`);
    this.name = 'RecordNotFoundError';
  }
}

/** Thrown when the optimistic-concurrency CAS update affected zero rows. Distinguishable from `RecordNotFoundError` via `instanceof` or `.code` — the row exists, but `expectedVersion` no longer matches. */
export class StaleRecordVersionError extends Error {
  public readonly code = 'STALE_RECORD_VERSION' as const;

  constructor(
    public readonly runId: string,
    public readonly manifestEntryKey: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Stale version for InitializationRecord (run "${runId}", manifest entry "${manifestEntryKey}"): expected version ${expectedVersion} no longer matches the current row`,
    );
    this.name = 'StaleRecordVersionError';
  }
}

/** Thrown when a second row is attempted for the same `(initializationRunId, manifestEntryKey)` — the primary-identity unique constraint from R1/R2. Distinguishable from `DuplicateResolvedTargetError` via `instanceof` or `.code`. */
export class DuplicateManifestEntryError extends Error {
  public readonly code = 'DUPLICATE_MANIFEST_ENTRY' as const;

  constructor(
    public readonly runId: string,
    public readonly manifestEntryKey: string,
  ) {
    super(`InitializationRecord already exists for run "${runId}" / manifest entry "${manifestEntryKey}"`);
    this.name = 'DuplicateManifestEntryError';
  }
}

/** Thrown when a second manifest entry within the same run resolves to the same `(entityType, entityId)` — the secondary partial-unique-index guard added as raw SQL in R2's migration. Distinguishable from `DuplicateManifestEntryError` via `instanceof` or `.code`. */
export class DuplicateResolvedTargetError extends Error {
  public readonly code = 'DUPLICATE_RESOLVED_TARGET' as const;

  constructor(
    public readonly runId: string,
    public readonly entityType: InitializationEntityType,
    public readonly entityId: string | null,
  ) {
    super(`InitializationRecord already resolved run "${runId}" entity ${entityType}/${String(entityId)} from a different manifest entry`);
    this.name = 'DuplicateResolvedTargetError';
  }
}

// --- Params --------------------------------------------------------------

export interface CreateDryRunRecordParams {
  runId: string;
  manifestEntryKey: string;
  entityType: InitializationEntityType;
}

/** Actions valid for `transitionRecordOnApply` — everything except the dry-run-only `VALIDATED`, which only `createDryRunRecord` ever writes. */
export type ApplyAction = Exclude<InitializationAction, 'VALIDATED'>;

export interface TransitionRecordOnApplyParams {
  runId: string;
  manifestEntryKey: string;
  action: ApplyAction;
  entityId: string | null;
  createdByRun: boolean;
  reusedExisting: boolean;
  expectedVersion: number;
  preexistingFingerprint?: string | null;
  resultingFingerprint?: string | null;
}

// --- Invariant guard -------------------------------------------------------

/**
 * Enforces the CR-009 required invariants for a `(action, entityId,
 * createdByRun, reusedExisting)` combination. Throws `InvariantViolationError`
 * before any database access if violated:
 *
 *   - createdByRun=true  only when action=CREATED, entityId!=null, reusedExisting=false
 *   - reusedExisting=true only when action=REUSED,  entityId!=null, createdByRun=false
 *   - BLOCKED/SKIPPED/FAILED: createdByRun=false, reusedExisting=false (entityId may be null)
 */
function assertValidActionInvariants(
  action: ApplyAction,
  entityId: string | null,
  createdByRun: boolean,
  reusedExisting: boolean,
): void {
  if (createdByRun && reusedExisting) {
    throw new InvariantViolationError(
      `createdByRun and reusedExisting cannot both be true (action=${action})`,
    );
  }

  switch (action) {
    case 'CREATED':
      if (!createdByRun || reusedExisting || entityId === null) {
        throw new InvariantViolationError(
          `action=CREATED requires createdByRun=true, reusedExisting=false, and a non-null entityId (got createdByRun=${createdByRun}, reusedExisting=${reusedExisting}, entityId=${String(entityId)})`,
        );
      }
      break;
    case 'REUSED':
      if (!reusedExisting || createdByRun || entityId === null) {
        throw new InvariantViolationError(
          `action=REUSED requires reusedExisting=true, createdByRun=false, and a non-null entityId (got createdByRun=${createdByRun}, reusedExisting=${reusedExisting}, entityId=${String(entityId)})`,
        );
      }
      break;
    case 'BLOCKED':
    case 'SKIPPED':
    case 'FAILED':
      if (createdByRun || reusedExisting) {
        throw new InvariantViolationError(
          `action=${action} requires createdByRun=false and reusedExisting=false (got createdByRun=${createdByRun}, reusedExisting=${reusedExisting})`,
        );
      }
      break;
  }
}

// --- Service functions -----------------------------------------------------

/**
 * Creates the durable dry-run row for one manifest entry: `action =
 * VALIDATED`, `entityId = null`, `version = 1`. This is the first and only
 * insert for a given `(runId, manifestEntryKey)` — `transitionRecordOnApply`
 * later transitions this same row in place, it never inserts a second one.
 *
 * Throws `DuplicateManifestEntryError` (never a raw
 * `Prisma.PrismaClientKnownRequestError`) if a row already exists for this
 * `(runId, manifestEntryKey)`.
 */
export async function createDryRunRecord(
  tx: Prisma.TransactionClient,
  params: CreateDryRunRecordParams,
): Promise<InitializationRecord> {
  assertNotRootClient(tx);
  const { runId, manifestEntryKey, entityType } = params;

  try {
    return await tx.initializationRecord.create({
      data: {
        initializationRunId: runId,
        manifestEntryKey,
        entityType,
        entityId: null,
        action: 'VALIDATED',
        createdByRun: false,
        reusedExisting: false,
        version: 1,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DuplicateManifestEntryError(runId, manifestEntryKey);
    }
    throw error;
  }
}

/**
 * Transitions the existing dry-run row for `(runId, manifestEntryKey)` to
 * `CREATED`/`REUSED`/`BLOCKED`/`SKIPPED`/`FAILED`, via a single optimistic-CAS
 * update scoped by `{ id, version: expectedVersion }` — mirroring R4's
 * `transitionRunStatus` CAS mechanics (single attempt, no retry/backoff
 * loop). Never inserts a second row for this `(runId, manifestEntryKey)`.
 *
 * Throws (in order, each before any further write):
 *   - `InvariantViolationError` if the action/entityId/createdByRun/reusedExisting
 *     combination is invalid — checked before any database access at all.
 *   - `RecordNotFoundError` if no row exists yet for `(runId, manifestEntryKey)`
 *     (this function only transitions an existing row, it never creates one).
 *   - `StaleRecordVersionError` if the CAS update affects zero rows (the row
 *     moved between this function's read and its write).
 *   - `DuplicateResolvedTargetError` if the update would violate the secondary
 *     partial unique index `(initializationRunId, entityType, entityId) WHERE
 *     entityId IS NOT NULL` (a different manifest entry in this run already
 *     resolved to the same target row).
 */
export async function transitionRecordOnApply(
  tx: Prisma.TransactionClient,
  params: TransitionRecordOnApplyParams,
): Promise<InitializationRecord> {
  assertNotRootClient(tx);
  const {
    runId,
    manifestEntryKey,
    action,
    entityId,
    createdByRun,
    reusedExisting,
    expectedVersion,
    preexistingFingerprint,
    resultingFingerprint,
  } = params;

  assertValidActionInvariants(action, entityId, createdByRun, reusedExisting);

  const existing = await tx.initializationRecord.findUnique({
    where: { initializationRunId_manifestEntryKey: { initializationRunId: runId, manifestEntryKey } },
  });
  if (!existing) {
    throw new RecordNotFoundError(runId, manifestEntryKey);
  }

  try {
    const result = await tx.initializationRecord.updateMany({
      where: { id: existing.id, version: expectedVersion },
      data: {
        action,
        entityId,
        createdByRun,
        reusedExisting,
        preexistingFingerprint: preexistingFingerprint ?? null,
        resultingFingerprint: resultingFingerprint ?? null,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new StaleRecordVersionError(runId, manifestEntryKey, expectedVersion);
    }
  } catch (error) {
    if (error instanceof StaleRecordVersionError) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DuplicateResolvedTargetError(runId, existing.entityType, entityId);
    }
    throw error;
  }

  return tx.initializationRecord.findUniqueOrThrow({ where: { id: existing.id } });
}
