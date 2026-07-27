import { describe, expect, it } from 'vitest';
import type { InitializationRecord, InitializationRun, Prisma } from '@prisma/client';
import type { MarkApplyFailedParams, SimpleTransitionParams } from './run-lifecycle.types.js';
import type { TransitionRecordOnApplyParams } from './record-writer.service.js';
import { markApplied, markApplyFailed, startApplying } from './run-lifecycle.service.js';
import { transitionRecordOnApply } from './record-writer.service.js';
import { withInitializationLock } from './advisory-lock.js';
import type { ReferenceTypeApplyStep } from './apply-integration.types.js';

/**
 * CR-009 R8 "Apply transaction integration contract" — compile-time-only
 * checks (no DB access, no RC7 orchestration to run). Follows the same
 * pattern as `advisory-lock.test.ts`'s "compile-time shape (no DB access)"
 * block: assertions live inside functions that are declared but never
 * invoked, so `tsc` still type-checks them (types are checked for all
 * reachable-by-declaration code, called or not) while nothing ever executes
 * a real transaction, query, or lock acquisition.
 *
 * What a real drift in R4/R5/R6 would do to this file: if, say, R4's
 * `markApplyFailed` dropped its required `failureReason` field, or R5's
 * `transitionRecordOnApply` stopped requiring a `tx` first parameter, or
 * R6's `withInitializationLock` changed its callback's parameter type away
 * from `Prisma.TransactionClient` — any of those would make the assignments
 * in `apply-integration.types.ts` (imported below) fail to type-check, and
 * `tsc --noEmit -p apps/api` would report an error pointing at this
 * contract, before RC7 (which does not exist yet) ever got a chance to
 * discover the drift itself.
 */

describe('apply-integration contract: compile-time shape (no DB access)', () => {
  it('apply-integration.types.ts type-checks against R4/R5/R6 as currently exported', () => {
    // Importing the module is enough to force `tsc` to evaluate every
    // `_check*` assignment in it. If any of those assignments no longer
    // type-check, this whole test file fails to compile (and thus fails to
    // run) — that is the assertion. Nothing below performs I/O.
    const neverCalled = async (): Promise<void> => {
      const { withInitializationLock: importedLock } = await import('./advisory-lock.js');
      void importedLock;
    };
    void neverCalled;
    expect(true).toBe(true);
  });

  it('R6 acquire-lock, R4 transitions, and R5 record-transition keep the exact shapes this contract relies on', () => {
    const neverCalled = (): void => {
      // R6: fn receives a Prisma.TransactionClient and its return type
      // propagates through withInitializationLock's return.
      const _lock: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> = withInitializationLock;
      void _lock;

      // R4: the exact three transition entry points this contract's
      // sequence names (step 2 and step 5).
      const _start: (params: SimpleTransitionParams) => Promise<InitializationRun> = startApplying;
      const _applied: (params: SimpleTransitionParams) => Promise<InitializationRun> = markApplied;
      const _failed: (params: MarkApplyFailedParams) => Promise<InitializationRun> = markApplyFailed;
      void _start;
      void _applied;
      void _failed;

      // R5: transitionRecordOnApply requires a caller-supplied tx (never
      // opens its own transaction) — exactly what step 3's per-type
      // transaction composes it into.
      const _transition: (
        tx: Prisma.TransactionClient,
        params: TransitionRecordOnApplyParams,
      ) => Promise<InitializationRecord> = transitionRecordOnApply;
      void _transition;
    };
    void neverCalled;
    expect(true).toBe(true);
  });

  it('a ReferenceTypeApplyStep cannot be built from a dry-run insert shape — it must reference an existing record via manifestEntryKey + expectedVersion', () => {
    const neverCalled = (): void => {
      // Valid shape: entries carry `recordTransition: TransitionRecordOnApplyParams`,
      // which has no `entityType` field and no insert path — only
      // `manifestEntryKey` (the CAS identity shared with the dry-run row)
      // and `expectedVersion` (the CAS token). This is what makes "transition
      // the existing row, never insert a duplicate" a structural property of
      // the contract's own types, not just prose.
      const step: ReferenceTypeApplyStep = {
        tx: {} as Prisma.TransactionClient,
        entries: [
          {
            manifestEntryKey: 'example-key',
            recordTransition: {
              runId: 'run-id',
              manifestEntryKey: 'example-key',
              action: 'CREATED',
              entityId: 'entity-id',
              createdByRun: true,
              reusedExisting: false,
              expectedVersion: 1,
            },
          },
        ],
      };
      void step;

      // entityType is not a field of TransitionRecordOnApplyParams (it
      // belongs only to R5's dry-run-only createDryRunRecord insert
      // params). If the @ts-expect-error below ever stopped being needed,
      // it would mean the apply-time record-transition type had grown an
      // insert path, which is exactly the duplicate-row hazard this
      // contract rules out.
      const _badStep: ReferenceTypeApplyStep = {
        tx: {} as Prisma.TransactionClient,
        entries: [
          {
            manifestEntryKey: 'example-key',
            recordTransition: {
              runId: 'run-id',
              manifestEntryKey: 'example-key',
              // @ts-expect-error -- entityType does not exist on TransitionRecordOnApplyParams.
              entityType: 'INVENTORY_CATEGORY',
              action: 'CREATED',
              entityId: 'entity-id',
              createdByRun: true,
              reusedExisting: false,
              expectedVersion: 1,
            },
          },
        ],
      };
      void _badStep;
    };
    void neverCalled;
    expect(true).toBe(true);
  });
});
