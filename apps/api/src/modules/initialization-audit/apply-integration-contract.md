# CR-009 R8 — Apply transaction integration contract

**Status:** documentation contract only. Describes the call sequence a
future Phase C0 task (RC7) must follow when it implements the real apply
orchestration. **RC7 is out of scope for this task and is not implemented
here** — no target-table (`InventoryCategory` / `UnitOfMeasure` /
`UnitConversion`) code exists in this repository yet, and this document does
not create any.

This document reflects R4/R5/R6's ACTUAL exported signatures as committed
today (see `run-lifecycle.service.ts`, `record-writer.service.ts`,
`advisory-lock.ts`). `apply-integration.types.ts` compile-time-checks this
document's assumptions against those real exports — see that file for how.

## The sequence RC7 must follow

1. **Acquire the lock (R6).** `withInitializationLock<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>`.
   Opens exactly one `prisma.$transaction`, takes `pg_advisory_xact_lock`
   inside it, then runs `fn(tx)`. The lock is transaction-scoped: it
   releases automatically when that one transaction commits or rolls back.
   **See "Architectural tension" below — this does not span the whole
   sequence described in steps 2–5.**

2. **Transition the run to `APPLYING` (R4).** `startApplying(params: SimpleTransitionParams): Promise<InitializationRun>`,
   i.e. `transitionRunStatus({ runId, expectedVersion, toStatus: 'APPLYING' })`
   under the hood. This call uses the root `prisma` client internally (it is
   not parameterized by a caller-supplied `tx`) and therefore cannot run
   inside step 1's transaction. It is, and must remain, its own separate
   call/transaction.

3. **For each reference type (categories, then units, then conversions), one
   `prisma.$transaction`** containing:
   - the target-table write(s) for that type (out of scope here — RC7's
     job, not typed by this contract beyond "happens in the same `tx`"), and
   - R5's `transitionRecordOnApply(tx, params: TransitionRecordOnApplyParams): Promise<InitializationRecord>`
     call(s), one per manifest entry of that type, using the SAME `tx` as
     the target-table write.

   `transitionRecordOnApply` transitions the *existing* `InitializationRecord`
   row for `(runId, manifestEntryKey)` created during dry-run (R7) — it never
   creates a new row (it throws `RecordNotFoundError` if no row exists yet
   for that key, and its params type has no `entityType`/insert path at all,
   unlike R5's dry-run-only `createDryRunRecord`). The identity governing
   which row is transitioned is `(initializationRunId, manifestEntryKey)`,
   never `entityId` — this is the same primary-identity rule R5 documents
   for dry-run and it does not change at apply time.

   Both halves (target-table write + record transition) must be in the SAME
   `prisma.$transaction` per CR-009's "Transaction boundary" requirement —
   this is exactly what R5's `tx`-accepting design (never opens its own
   transaction) was built to allow. Confirmed against R5 as committed: no
   redesign needed here (see task brief's stop condition).

4. **Transition run status between reference types.** CR-009's "Transaction
   Boundary" section requires this to be a separate, lightweight transaction
   — NOT folded into any per-type transaction from step 3.

   **Honest caveat about this step, reflecting R4 as it actually exists
   today:** R4's transition table (`RUN_TRANSITION_TABLE` in
   `run-lifecycle.types.ts`) has no distinct "in progress, moved on to the
   next reference type" status — `APPLYING` is a single status that covers
   the entire multi-type apply sequence, with only `APPLIED` and
   `APPLY_FAILED` as its outgoing arrows. R4 does not currently export any
   function that performs an inter-type "still applying, just checkpointing
   progress" transition; `transitionRunStatus`/`startApplying`/`markApplied`/
   `markApplyFailed` are the only exported transition entry points, and none
   of them models "between types, same status." If CR-009's decision doc
   intends a real progress-tracking write here (e.g. a heartbeat, or
   re-reading/advancing `version` without a status change), that mechanism
   does not exist in R4 today. This document does not invent one — it flags
   this as a second, smaller open question for whoever implements RC7,
   alongside the lock tension below.

5. **Final transition (R4):** `markApplied(params: SimpleTransitionParams): Promise<InitializationRun>`
   on full success, or `markApplyFailed(params: MarkApplyFailedParams): Promise<InitializationRun>`
   (which requires `failureReason: string`) on failure. Same root-`prisma`
   caveat as step 2 — its own call, not nested in any per-type transaction.

6. **Release the lock.** Automatic, per R6's design, whenever the
   `prisma.$transaction` opened in step 1 commits or rolls back — there is no
   separate explicit "release" call.

## Architectural tension: the lock does not span the whole sequence

This is a real, currently-unresolved design gap. It is documented here
honestly, as an open question for RC7's implementation to resolve — this
task does not resolve it, and does not redesign R4 or R6 to attempt a
resolution.

`withInitializationLock` (R6) wraps exactly **one** `prisma.$transaction`.
Its `pg_advisory_xact_lock` is transaction-scoped and releases automatically
when that single transaction commits or rolls back. This was a deliberate,
user-approved deviation from CR-009's literal "session-scoped
`pg_advisory_lock` held for the whole apply-or-rollback call" wording,
because a session-scoped lock is unsafe under this project's PgBouncer
transaction-pooling `DATABASE_URL` (a bare session lock has no guarantee a
later query, or the eventual unlock, lands on the same physical backend
connection — see R6's own doc comment for the full explanation).

But the sequence documented above spans **multiple separate transactions**:
the `APPLYING` transition (step 2, via R4's root-`prisma`-client call, not
composable inside any transaction), then N per-reference-type transactions
(step 3), then inter-type status transitions (step 4, required by CR-009 to
be separate from step 3's transactions), then a final `APPLIED`/
`APPLY_FAILED` transition (step 5).

**As built, `withInitializationLock` cannot hold a lock across that entire
multi-transaction sequence.** If RC7 called `withInitializationLock(fn)`
with `fn` doing "everything," the lock would only actually cover whatever
runs inside the ONE `prisma.$transaction` that `withInitializationLock`
itself opens — but R4's transition functions (`startApplying`,
`markApplied`, `markApplyFailed`) each use the root `prisma` client directly
and cannot run inside a caller-supplied `tx` at all, so they could not be
*inside* that one transaction even if RC7 tried. A literal "lock spans the
whole apply call," as CR-009's original wording asks for, is **not
achievable** with R6's current primitive plus R4's current transition-
function design.

**This document takes no position on which resolution is correct.** That
decision belongs to whoever implements RC7, with its own authorization and
review. Plausible resolutions worth naming, as options for that future task
to choose between (not a decision made here):

- RC7 acquires and releases the lock manually around the whole sequence
  using a raw session-level connection outside Prisma's pool. This
  reintroduces the exact PgBouncer session-lock hazard R6 was built to
  avoid, so it is probably the wrong choice — named here only for
  completeness.
- R4 gains `tx`-accepting variants of its transition functions, so a status
  transition could run inside the same held lock/transaction as everything
  else. This is a schema/service design change beyond this task's scope.
- Accept that the lock only covers part of the sequence (most plausibly:
  each per-type transaction individually, or the whole thing except the
  root-`prisma` status transitions), and rely on the "layered" defense-in-
  depth CR-009's own "Concurrency strategy" section already describes:
  the coarse `migrationBatch` uniqueness, `InitializationRecord`'s own
  unique constraints (primary identity + the secondary partial-unique
  resolved-target index), and `InitializationRun.version` CAS. CR-009's own
  language calls these three mechanisms "layered" together, not "the lock
  alone is sufficient" — so this option is arguably already consistent with
  the CR's own stated design, but this document does not decide that; it is
  RC7's call.

## What this task does NOT do

- Does not implement RC7's actual apply orchestration.
- Does not write any code touching `InventoryCategory`, `UnitOfMeasure`, or
  `UnitConversion`.
- Does not modify R4, R5, or R6.
- Does not resolve the lock/multi-transaction tension above.
