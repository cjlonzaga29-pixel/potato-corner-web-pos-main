import type { InitializationRecord, InitializationRun, Prisma } from '@prisma/client';
import type { MarkApplyFailedParams, SimpleTransitionParams } from './run-lifecycle.types.js';
import type { TransitionRecordOnApplyParams } from './record-writer.service.js';
import { markApplied, markApplyFailed, startApplying } from './run-lifecycle.service.js';
import { transitionRecordOnApply } from './record-writer.service.js';
import { withInitializationLock } from './advisory-lock.js';

/**
 * CR-009 R8 "Apply transaction integration contract" — TYPES ONLY.
 *
 * This file does not implement Phase C0's RC7 (the actual apply
 * orchestration — out of scope here, not started). It exists solely so that
 * a future change to R4 (`run-lifecycle.service.ts`), R5
 * (`record-writer.service.ts`), or R6 (`advisory-lock.ts`) that alters their
 * exported function shapes becomes a `tsc` compile error IN THIS FILE,
 * before RC7 is ever built — see `apply-integration-contract.md` for the
 * full prose contract, including the documented lock/multi-transaction
 * tension this file does not attempt to resolve.
 *
 * How the check works: each `_check*` constant below assigns the REAL
 * exported function to a variable whose declared type is written out by
 * hand to match this contract's current understanding of that function's
 * shape. TypeScript structurally checks the assignment; if R4/R5/R6 change
 * a parameter type, add/remove a required parameter, or change a return
 * type, the assignment stops type-checking and `tsc --noEmit` fails here —
 * not silently, and not only at RC7's eventual (future, out-of-scope)
 * call sites.
 */

// --- R6: acquire lock ------------------------------------------------------

/**
 * R6's actual export. Only spans ONE `prisma.$transaction` — see the
 * markdown contract's "Architectural tension" section for why this cannot,
 * as built, span the whole multi-transaction apply sequence documented
 * below.
 */
const _checkWithInitializationLock: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> =
  withInitializationLock;
void _checkWithInitializationLock;

// --- R4: run-status transitions used by the apply sequence -----------------

/** R4's actual export used for step 2 (DRY_RUN_VALIDATED -> APPLYING). */
const _checkStartApplying: (params: SimpleTransitionParams) => Promise<InitializationRun> = startApplying;
void _checkStartApplying;

/** R4's actual export used for the final success transition (APPLYING -> APPLIED). */
const _checkMarkApplied: (params: SimpleTransitionParams) => Promise<InitializationRun> = markApplied;
void _checkMarkApplied;

/** R4's actual export used for the final failure transition (APPLYING -> APPLY_FAILED). */
const _checkMarkApplyFailed: (params: MarkApplyFailedParams) => Promise<InitializationRun> = markApplyFailed;
void _checkMarkApplyFailed;

// --- R5: per-manifest-entry record transition used inside each per-type tx --

/**
 * R5's actual export used inside each per-reference-type `prisma.$transaction`.
 * Note the first parameter: R5 requires a caller-supplied `tx`, never opens
 * its own transaction — this is exactly what the contract's per-type step
 * (below) composes into. Also note there is no `createDryRunRecord` here:
 * the apply sequence must never insert a second row for a manifest entry
 * already recorded during dry-run, only transition the existing one.
 */
const _checkTransitionRecordOnApply: (
  tx: Prisma.TransactionClient,
  params: TransitionRecordOnApplyParams,
) => Promise<InitializationRecord> = transitionRecordOnApply;
void _checkTransitionRecordOnApply;

// --- Contract shape: one reference-type's apply step ------------------------

/**
 * The shape a per-reference-type transaction callback needs, per the
 * markdown contract's sequence step 3: "one `prisma.$transaction` containing
 * both the target-table write(s) and R5's `transitionRecordOnApply` call(s)".
 *
 * Deliberately does NOT type the target-table write payload
 * (InventoryCategory / UnitOfMeasure / UnitConversion) — that belongs to
 * RC7's actual implementation, out of scope for this contract. This type
 * only pins down the provenance-recording half of each per-type transaction.
 */
export interface ReferenceTypeApplyStep {
  /** The single transaction client shared by the target-table write(s) and the record transition(s) below — never the root `prisma` singleton (R5 enforces this at runtime; see `assertNotRootClient`). */
  tx: Prisma.TransactionClient;
  /**
   * One entry per manifest entry being applied for this reference type in
   * this transaction. Each entry's `recordTransition` must reference the
   * SAME `(runId, manifestEntryKey)` pair whose row was created during
   * dry-run (R7) — `transitionRecordOnApply` only ever transitions an
   * existing row (see `RecordNotFoundError`), it never creates one.
   */
  entries: ReadonlyArray<{
    manifestEntryKey: string;
    recordTransition: TransitionRecordOnApplyParams;
  }>;
}

// --- Compile-time contract assertion: no duplicate provenance row -----------
//
// This is necessarily a documentation/type-level assertion, not a runtime
// one (see task brief) — there is no real apply orchestration to exercise
// yet. It works by structural exclusion: `TransitionRecordOnApplyParams`
// (the type this contract requires every apply-time record write to use)
// has no `entityType` field and no insert path, unlike
// `CreateDryRunRecordParams` (R5's dry-run-only insert, which DOES carry
// `entityType` because it creates the row). If a future refactor merged
// these two param shapes back into one type that also permitted inserting,
// this assertion would stop compiling, flagging the drift.

type RecordTransitionHasNoEntityTypeInsertField = 'entityType' extends keyof TransitionRecordOnApplyParams
  ? never
  : true;
const _applyStepNeverInsertsASecondRecordRow: RecordTransitionHasNoEntityTypeInsertField = true;
void _applyStepNeverInsertsASecondRecordRow;

/**
 * `TransitionRecordOnApplyParams` must carry both halves of the CAS identity
 * this contract relies on: `manifestEntryKey` (the primary identity shared
 * with the dry-run row) and `expectedVersion` (the optimistic-concurrency
 * token). If either were removed from R5's params type, this assertion
 * would stop compiling.
 */
type RecordTransitionCarriesCasIdentity = TransitionRecordOnApplyParams extends {
  manifestEntryKey: string;
  expectedVersion: number;
}
  ? true
  : never;
const _applyStepTransitionsExistingRecordByCas: RecordTransitionCarriesCasIdentity = true;
void _applyStepTransitionsExistingRecordByCas;
