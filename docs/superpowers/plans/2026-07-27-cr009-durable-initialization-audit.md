# CR-009 — Durable Initialization Audit Implementation Plan

**Planning only.** Authorizes no implementation, no schema change, no data write. Resolves Gate -1 of `docs/superpowers/plans/2026-07-27-cr006-phase-c0-canonical-reference-initialization.md` per the model decisions in `docs/decisions/CR-009-durable-initialization-audit.md` (read that first — this document sequences its implementation, it does not repeat its rationale).

**CR-009.1 corrective pass:** R1, R3, R5, R8, R11, and R13 below are updated to reflect the two boundaries CR-009.1 resolved — decimal fingerprint canonicalization and manifest-entry provenance identity (`manifestEntryKey` as primary identity, replacing target-row identity). No task was added or removed; task count is unchanged at 14 (R0–R13).

**CR-009.2 corrective pass:** R1, R3, R5, R8, R11, and R13 below are further updated to reflect the two boundaries CR-009.2 locked — the exact `manifestEntryKey` encoding/normalization and the `InitializationRecord` dry-run/apply lifecycle wording. No task was added or removed; task count is unchanged at 14 (R0–R13).

**For agentic workers:** use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. `- [ ]` checkboxes track progress.

## Global constraints

- No Prisma schema change, migration, source-code change, or database write occurs until each task below is individually executed in a later, separately-authorized session.
- Categories → units → conversions ordering (Phase C0 §10) is unchanged by this plan; this plan only adds the audit-row write inside those same transactions.
- Do not implement Phase C0's RC7/RC8 as part of this CR — this plan produces the audit substrate RC7/RC8 depend on; RC7/RC8 remain separate Phase C0 tasks, unblocked only after R13 validates.

## Tasks

### R0 — Existing audit/schema inspection

**Objective:** Confirm, at implementation time, that `AuditLog` (`apps/api/prisma/schema.prisma:1258`), `pg-lock.ts`, and `migration-batch.ts` still match the shapes this plan assumes (schemas drift between planning and execution).
**Files:** none created — read-only.
**Steps:** re-read `schema.prisma`'s `AuditLog` model and the two lib files; diff against CR-009 §"Audit integration"/"Concurrency strategy" assumptions; note any drift in R1's PR description.
**Tests:** N/A.
**Validation command:** manual diff review.
**Rollback:** N/A.
**Stop condition:** if `AuditLog`'s hash-chain fields were removed/renamed, stop — CR-009's audit-integration section needs re-approval first.
**Architectural reference:** CR-009 "Audit integration", "Concurrency strategy".

### R1 — Initialization enums and schema models

**Objective:** Add the two models and enums from CR-009 to `schema.prisma`.
**Files:** Modify `apps/api/prisma/schema.prisma`.
**Steps:** Add `InitializationType`, `InitializationExecutionMode`, `InitializationRunStatus`, `InitializationEntityType`, `InitializationAction`, `InitializationRollbackEligibility`, `InitializationRollbackStatus` enums; add `InitializationRun` and `InitializationRecord` models with exact fields/indexes/uniqueness from CR-009, including required `manifestEntryKey` (nullable `entityId`) and `@@unique(initializationRunId, manifestEntryKey)` as the model's primary identity; add the `initiatedBy → User` and `initializationRunId → InitializationRun` relations (restrict-delete, never cascade); add `fingerprintVersion`/`decimalCanonicalizationVersion` fields alongside stored fingerprints; lock the exact `manifestEntryKey` formats per CR-009 "`manifestEntryKey` encoding (locked, CR-009.2)" (`INVENTORY_CATEGORY:<normalized-category-name>`, `UNIT_OF_MEASURE:<normalized-unit-code>`, `UNIT_CONVERSION:<normalized-from-unit-code>-><normalized-to-unit-code>`); add a `manifestEntryKeyVersion` field/constant starting at `1`; document the reserved-character validation (`:`, `->`, ASCII control chars) and duplicate normalized-key rejection at manifest-validation time (schema-level documentation only — the normalization function itself is R3).
**Tests:** N/A (schema only).
**Validation command:** `pnpm --filter @potato-corner/api exec prisma validate`.
**Rollback:** revert the schema diff (no migration applied yet).
**Stop condition:** if expressing the primary `(initializationRunId, manifestEntryKey)` unique constraint requires anything beyond a standard Prisma `@@unique` — stop, that constraint must be expressible directly, it is not the partial-index case. Separately: the secondary resolved-target duplicate-protection index (`(initializationRunId, entityType, entityId) WHERE entityId IS NOT NULL`) is a genuine partial index Prisma can't express directly — implement it as a raw-SQL addition to the generated migration (documented inline), per CR-009 "Manifest-entry provenance identity (resolved)"; do not substitute a plain nullable composite unique for it, since Postgres null semantics would permit duplicates.
**Architectural reference:** CR-009 "Models", "Manifest-entry provenance identity (resolved)", "Schema-change analysis".

### R2 — Migration and Prisma validation

**Objective:** Generate and apply the additive migration against the verified local shadow DB only.
**Files:** new `apps/api/prisma/migrations/<timestamp>_add_initialization_audit/`.
**Steps:** verify `DIRECT_URL` target per `.claude/CLAUDE.md`'s three-URL rule before running anything; `prisma migrate dev --name add_initialization_audit`; confirm generated SQL is additive-only (two `CREATE TABLE`, enum creates, no `ALTER` on existing tables).
**Tests:** N/A.
**Validation command:** `pnpm --filter @potato-corner/api exec prisma migrate status`.
**Rollback:** `prisma migrate resolve --rolled-back <name>` if applied to the wrong target (per the Phase 18 incident this rule exists to prevent).
**Stop condition:** if the generated SQL touches any existing table — stop, re-check R1.
**Architectural reference:** `.claude/CLAUDE.md` "Database & Migration Safety"; CR-009 "Schema-change analysis".

### R3 — Fingerprint utility

**Objective:** Implement CR-009's canonical-JSON SHA-256 fingerprint function, versioned, plus the decimal canonicalization utility CR-009.1 resolved, plus the `manifestEntryKey` natural-key normalization/builder CR-009.2 locked.
**Files:** Create `apps/api/src/modules/initialization-audit/fingerprint.ts`, `fingerprint.test.ts`, `decimal-canonicalization.ts`, `decimal-canonicalization.test.ts`, `manifest-entry-key.ts`, `manifest-entry-key.test.ts`.
**Steps:** `canonicalizeDecimal(value: string | Prisma.Decimal): string` implementing CR-009.1's 10 rules (parse via `Prisma.Decimal`, reject invalid/`NaN`/`Infinity`, normalize `-0` to `0`, non-exponent base-10 string, strip insignificant trailing zeros and trailing decimal point, never round-trip through `Number`); manifest-side scientific-notation values are rejected at manifest validation, not expanded here. `computeFingerprint(entityType, fields, version): { hash: string; fingerprintVersion: number; decimalCanonicalizationVersion: number }` — canonical key-sorted JSON, decimal fields run through `canonicalizeDecimal` first, excludes `id`/timestamps per CR-009's field lists per entity type. `normalizeNaturalKeySegment(input: string): string` implementing CR-009.2's 13 normalization rules (NFC-normalize, trim, locale-independent lowercase, reject empty/control-chars/`:`/`->`, preserve internal spaces, no transliteration); per-entity key builders `buildInventoryCategoryKey`, `buildUnitOfMeasureKey`, `buildUnitConversionKey(fromCode, toCode)` (directed, never sorted) each returning the exact locked format; `validateManifestNoDuplicateKeys(entries)` rejecting a manifest whose normalized keys collide, run before any durable dry-run record is created.
**Tests:** same input → same hash regardless of key order; fingerprint changes when any rollback-relevant field changes, unchanged when a non-rollback-relevant field (e.g. `updatedAt`) changes; decimal-canonicalization unit tests covering CR-009.1's worked examples (`"1000"`/`"1000.0"`/`"1000.000000"` → identical fingerprint; `"0.001000"` → `"0.001"`; `"-0.000"` → `"0"`; `"1.2300400"` → `"1.23004"`; `1` vs `1.0001` remain distinct); negative-zero tests; scientific-notation values rejected at manifest validation (not silently expanded); no-JavaScript-`Number` precision test (a value exceeding `Number` safe-integer precision round-trips correctly through `Prisma.Decimal` only); manifest-vs-database normalization parity test (manifest string `"1000.000"` and a `Prisma.Decimal` read of `1000` from the database fingerprint identically); `manifestEntryKey` tests per CR-009.2 acceptance list — `" Flavor "` and `"flavor"` produce the same key; `"G"` and `"g"` produce the same unit key; `kg->g` and `g->kg` produce different keys; values containing `:` are rejected; values containing `->` are rejected; duplicate normalized keys fail validation; Unicode NFC equivalence; trimming and lowercase; reserved-character rejection; directed conversion-key tests.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/fingerprint.test.ts src/modules/initialization-audit/decimal-canonicalization.test.ts`.
**Rollback:** N/A — pure functions.
**Stop condition:** if a decimal canonicalization step is found relying on `Number` at any point — stop, that violates CR-009.1's rule 9.
**Architectural reference:** CR-009 "Fingerprint strategy", "Decimal fingerprint canonicalization (resolved)".

### R4 — Run lifecycle service

**Objective:** Implement the state machine and its transition table.
**Files:** Create `apps/api/src/modules/initialization-audit/run-lifecycle.service.ts`, `.test.ts`, `run-lifecycle.types.ts`.
**Steps:** explicit transition table per CR-009 "Run lifecycle"; every transition call takes the run's current `version`, does an optimistic CAS update, throws on mismatch or invalid-transition.
**Tests:** each valid transition succeeds; each invalid transition (e.g. `PLANNED → ROLLED_BACK`) throws before any write; stale-version CAS failure throws distinctly from invalid-transition.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/run-lifecycle.service.test.ts`.
**Rollback:** N/A — logic only, no target-table writes.
**Stop condition:** if a transition needs to bypass CAS to "fix" a stuck run — stop, that's R11's job via explicit reconciliation, never an ad hoc bypass.
**Architectural reference:** CR-009 "Run lifecycle".

### R5 — InitializationRecord write service

**Objective:** Implement the write path that a future RC7 apply-transaction calls, enforcing the `CREATED`/`REUSED` mutual-exclusivity invariant and reconciling by `(runId, manifestEntryKey)` rather than target-row identity.
**Files:** Create `apps/api/src/modules/initialization-audit/record-writer.service.ts`, `.test.ts`.
**Steps:** `createDryRunRecord(tx, { runId, manifestEntryKey, entityType })` creates the row during durable dry-run validation (`action = VALIDATED`, `entityId = null`, `version = 1`) — the first and only insert for that `(runId, manifestEntryKey)`. `transitionRecordOnApply(tx, { runId, manifestEntryKey, action, entityId, expectedVersion, ...fingerprints })` loads the existing row by `(runId, manifestEntryKey)` and transitions it in place via CAS on `version` to `CREATED`/`REUSED`/`BLOCKED`/`FAILED` — it must never insert a second row for the same run and `manifestEntryKey`; both functions must be called with an existing Prisma transaction client (`tx`), never open their own transaction (enforces "same transaction as target write" from CR-009); if the optional resolved-target partial index is violated, catches and surfaces it as a typed error distinct from the primary-identity conflict.
**Tests:** `action: REUSED` with `createdByRun: true` throws (invariant guard); a second `createDryRunRecord` call for the same `(runId, manifestEntryKey)` throws via the primary unique constraint, caught and surfaced as a typed error; `transitionRecordOnApply` on a non-existent `(runId, manifestEntryKey)` throws (dry-run row must exist first); `transitionRecordOnApply` called twice for the same entry updates the same row (`version` increments), never creates a second row; a stale `expectedVersion` throws a CAS-conflict error distinct from a not-found error; `BLOCKED`/`SKIPPED`/`FAILED` writes with `entityId = null` succeed and are distinguishable from `CREATED`/`REUSED` writes; a second manifest entry resolving to the same `entityId` within one run is caught by the secondary partial index (or service-layer check, per R1's chosen strategy); a call without a `tx` parameter is a type error (compile-time, not runtime, guard).
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/record-writer.service.test.ts`.
**Rollback:** N/A — writes only occur inside a caller-supplied transaction that the caller (future RC7) controls.
**Stop condition:** if a test requires this service to open its own transaction — stop, that violates the shared-transaction requirement.
**Architectural reference:** CR-009 "Transaction boundary", "Models" (`InitializationRecord`), "Manifest-entry provenance identity (resolved)".

### R6 — Concurrency and locking

**Objective:** Implement the coarse advisory-lock wrapper reusing `hashToLockId`.
**Files:** Create `apps/api/src/modules/initialization-audit/advisory-lock.ts`, `.test.ts`.
**Steps:** `withInitializationLock(fn: () => Promise<T>): Promise<T>` — acquires `pg_advisory_lock(hashToLockId('cr009-reference-init-apply'))`, releases in `finally`, per CR-009 "Concurrency strategy".
**Tests:** lock acquired before `fn` runs, released after `fn` resolves or throws (simulated failure case); a second concurrent call blocks until the first releases (integration-style test against a real local Postgres, or a mocked-client sequencing test if no live DB in this test tier — mirror whatever tier Phase C0's own advisory-lock tests use).
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/advisory-lock.test.ts`.
**Rollback:** N/A.
**Stop condition:** if the lock isn't released on a thrown error in testing — stop, fix the `finally` before proceeding.
**Architectural reference:** CR-009 "Concurrency strategy"; `apps/api/src/lib/pg-lock.ts`.

### R7 — Dry-run integration contract

**Objective:** Define (not implement Phase C0's own RC6) the interface `InitializationRun`/`InitializationRecord` expose for a `DRY_RUN` execution mode — a dry-run creates a `PLANNED`→`DRY_RUN_VALIDATED` run row with zero `InitializationRecord` rows (dry-run proposes, never commits provenance) and stores `dryRunReportFingerprint`.
**Files:** Create `apps/api/src/modules/initialization-audit/dry-run-contract.ts` (types + a `recordDryRunRun(...)` helper), `.test.ts`.
**Steps:** implement the narrow run-row-only write (no `InitializationRecord` rows at this stage, per CR-009's run/record split — dry-run has no created/reused rows yet).
**Tests:** dry-run call creates exactly one `InitializationRun` row in `DRY_RUN_VALIDATED`, zero `InitializationRecord` rows.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/dry-run-contract.test.ts`.
**Rollback:** N/A — dry-run never writes target-table data.
**Stop condition:** if a dry-run path is found writing any `InitializationRecord` row — stop, that's an apply-time-only write.
**Architectural reference:** CR-009 "Run lifecycle"; Phase C0 §7 (dry-run mode, unchanged).

### R8 — Apply transaction integration

**Objective:** Define the exact call sequence a future Phase C0 RC7 must follow to satisfy CR-009 (this task does not implement RC7 itself — RC7 remains a Phase C0 task, now unblockable only after this plan's R13 validates).
**Files:** Create `apps/api/src/modules/initialization-audit/apply-integration-contract.md` (a short interface contract document, not code) plus a typed interface file `apply-integration.types.ts`.
**Steps:** document: acquire lock (R6) → transition run to `APPLYING` (R4) → for each reference type, one `prisma.$transaction` containing both the target-table write(s) and the R5 `transitionRecordOnApply` call(s), which transitions the *same* `InitializationRecord` row created during dry-run for that `(runId, manifestEntryKey)` via CAS rather than creating a second row → transition run status between types (separate lightweight transaction, R4) → final `APPLIED`/`APPLY_FAILED` transition, release lock.
**Tests:** a type-level contract test asserting `apply-integration.types.ts`'s exported function signatures match what R5/R4/R6 actually export (compile-time integration check, catches drift between this plan and RC7's eventual implementation); a contract assertion that the documented apply sequence transitions the dry-run-created record by `(runId, manifestEntryKey)` via CAS and never inserts a duplicate provenance row for one manifest entry within a run.
**Validation command:** `pnpm --filter @potato-corner/api exec tsc --noEmit -p apps/api` (type-check only).
**Rollback:** N/A — contract/types only.
**Stop condition:** if satisfying this contract would require R5's writer to open its own transaction — stop, re-resolve against R5's design instead.
**Architectural reference:** CR-009 "Transaction boundary".

### R9 — Rollback assessment service

**Objective:** Implement `assessRollbackEligibility(runId)` — recomputes `currentVerificationFingerprint` per created record, checks live downstream references, checks cross-run dependency, writes `rollbackEligibility` back per CR-009's rules. This is assessment only — no deletion.
**Files:** Create `apps/api/src/modules/initialization-audit/rollback-assessment.service.ts`, `.test.ts`.
**Steps:** implement each eligibility condition from CR-009 "Rollback eligibility rules" as a separate checked predicate, composed with short-circuit (first failing condition sets the `rollbackBlockedReason`).
**Tests:** matches CR-009's three worked examples verbatim — reused record never eligible; modified record → `BLOCKED`/`TARGET_MODIFIED_AFTER_INITIALIZATION`; downstream-referenced record → `BLOCKED`/`DOWNSTREAM_REFERENCE_EXISTS`; all-conditions-pass record → `ELIGIBLE`.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/rollback-assessment.service.test.ts`.
**Rollback:** N/A — read/assess only, no deletion.
**Stop condition:** if any condition is found to be skippable under a flag — stop, all conditions in CR-009 are mandatory, none optional.
**Architectural reference:** CR-009 "Rollback eligibility rules".

### R10 — Rollback execution service

**Objective:** Implement the actual per-row deletion, gated on R9's assessment and per-row operator confirmation, in reverse-dependency-order per-type transactions.
**Files:** Create `apps/api/src/modules/initialization-audit/rollback-execution.service.ts`, `.test.ts`.
**Steps:** conversions → units → categories order; one transaction per type containing both the target-table delete and the `InitializationRecord.rollbackStatus/rolledBackAt` update; requires an explicit per-row confirmation token, never a batch-wide flag; run transitions to `ROLLED_BACK` or `ROLLBACK_PARTIAL` per CR-009.
**Tests:** an `ELIGIBLE` row without an explicit confirmation is not deleted; a `BLOCKED` row is never deleted regardless of confirmation; a mixed batch (some eligible, some blocked) yields `ROLLBACK_PARTIAL` with per-row outcomes reported; deletion and record-status-update happen in the same transaction (simulated failure of one leaves neither committed).
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/rollback-execution.service.test.ts`.
**Rollback (of this task's own writes):** N/A — this task *is* the rollback path; there is no further rollback of a rollback in this CR's scope.
**Stop condition:** if a code path deletes without both R9's `ELIGIBLE` status and an explicit per-row confirmation present — stop.
**Architectural reference:** CR-009 "Rollback transaction strategy", "Rollback eligibility rules".

### R11 — Failure recovery and stale-run reconciliation

**Objective:** Implement the explicit, operator-triggered reconciliation command that re-derives a stuck run's true status from durable `InitializationRecord` rows — never a manual provenance edit.
**Files:** Create `apps/api/src/modules/initialization-audit/reconciliation.service.ts`, `.test.ts`, `apps/api/scripts/initialization-reconcile.ts`.
**Steps:** find runs in `APPLYING`/`ROLLING_BACK` past the documented timeout; for each, query which reference-type transactions actually committed (by presence of their `InitializationRecord` rows, matched by `manifestEntryKey` against the manifest snapshot — not by counting rows or by `entityId`, since `BLOCKED`/`FAILED` entries have no `entityId`) and set the run's true status accordingly via R4's lifecycle service (never a raw `UPDATE`); reconciliation itself loads existing `InitializationRecord` rows by `initializationRunId + manifestEntryKey` and transitions `VALIDATED` to `CREATED`/`REUSED`/`BLOCKED`/`FAILED` via CAS, never inserting a new row for a run already in progress; a stale-version CAS conflict encountered during reconciliation aborts that entry and is reported, not silently overwritten; a retried run (new `migrationBatch`) reconciles its own records against prior runs' records for the same `manifestEntryKey` values by transitioning only its own rows, never the stale run's row.
**Tests:** a run stuck in `APPLYING` with only categories' records present is reconciled to `APPLY_FAILED` naming units as the failed type; a run with all three types' records present but still `APPLYING` (crash before final transition) is reconciled to `APPLIED`; a run under the timeout is left untouched (not falsely flagged); reconciliation loading by `initializationRunId + manifestEntryKey` transitions the existing row rather than inserting a new one; a stale-version conflict during reconciliation aborts that entry and triggers the reported-conflict path rather than overwriting.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/reconciliation.service.test.ts`.
**Rollback:** N/A — reconciliation only corrects run-status metadata, never target-table data.
**Stop condition:** if reconciliation is found mutating any `InitializationRecord`'s `action`/fingerprints (vs. only the run's `status`) — stop, that rewrites history rather than reconciling it.
**Architectural reference:** CR-009 "Failure-recovery strategy", "Run lifecycle".

### R12 — Authorization and audit integration

**Objective:** Wire Super-Admin-only route/CLI guards and the `AuditLog` side-writes for every lifecycle transition.
**Files:** Modify existing auth-middleware usage points for any future initialization-audit routes (none exist yet — this task adds the guard helper for RC9/future routes to consume); Create `apps/api/src/modules/initialization-audit/audit-integration.ts`, `.test.ts`.
**Steps:** a `requireSuperAdmin` guard reused from existing middleware (not reinvented); `writeInitAuditLogEntry(action, run)` producing one `AuditLog` row per lifecycle transition, `entityType: 'InitializationRun'`.
**Tests:** guard rejects non-Super-Admin JWTs; every R4 transition triggers exactly one `AuditLog` row with the correct `entityType`/`entityId`/`actorId`.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/audit-integration.test.ts`.
**Rollback:** N/A — additive audit rows only, `AuditLog` is append-only by existing design (hash chain).
**Stop condition:** if a route is found reachable without the Super-Admin guard — stop.
**Architectural reference:** CR-009 "Authorization boundary", "Audit integration".

### R13 — End-to-end validation

**Objective:** Full-cycle test: dry-run → apply → verify records → simulate downstream reference → attempt rollback → confirm blocked → remove reference → confirm eligible → rollback → confirm `InitializationRecord.rollbackStatus = ROLLED_BACK`. This is the gate that unblocks Phase C0's RC7/RC8.
**Files:** Create `apps/api/src/modules/initialization-audit/e2e.test.ts` (against a real local Postgres shadow DB, per project convention for integration-tier tests).
**Steps:** run the full scenario above using R3–R11's services together; assert every CR-009 worked example (reused/modified/downstream) end-to-end, not just unit-mocked; additionally assert CR-009.1's Scenarios A–E (blocked-before-creation, failed-conversion-with-retry, reused-target, created-target, decimal-parity) end-to-end; additionally assert CR-009.2's manifestEntryKey/lifecycle acceptance list end-to-end.
**Tests:** the scenario itself; a concurrency test (two simulated concurrent applies for the same manifest, asserting the second serializes and reuses); Scenario A (`UNIT_OF_MEASURE:g` blocked by incompatible existing unit → `entityId = null`, exactly one durable record); Scenario B (`UNIT_CONVERSION:kg->g` fails before row creation → `action = FAILED`, `entityId = null`, retry under a new run reconciles by the same `manifestEntryKey`); Scenario C (`INVENTORY_CATEGORY:flavor` reused → `createdByRun = false`, `reusedExisting = true`); Scenario D (`UNIT_OF_MEASURE:g` created fresh → `createdByRun = true`, `reusedExisting = false`); Scenario E (manifest `factor = "1000.000"` vs. database `Decimal("1000")` → identical canonical value and fingerprint); CR-009.2 acceptance tests: `" Flavor "` and `"flavor"` produce the same key; `"G"` and `"g"` produce the same unit key; `kg->g` and `g->kg` produce different keys; values containing `:` are rejected; values containing `->` are rejected; duplicate normalized keys fail validation; dry-run and apply use the same `InitializationRecord` ID (row identity verified unchanged across the transition); apply retry does not create a second row.
**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/initialization-audit/e2e.test.ts` (against verified local `DIRECT_URL` only, per `.claude/CLAUDE.md`).
**Rollback:** test-only writes against the local shadow DB; no production data touched.
**Stop condition:** if this suite requires touching anything other than the local shadow DB — stop, re-verify `DIRECT_URL` before running.
**Architectural reference:** all of CR-009; unblocks Phase C0 RC7/RC8.

## Self-review

- Every CR-009 section (models, entity-type strategy, fingerprint strategy, lifecycle, transaction boundary, idempotency, concurrency, rollback eligibility/transaction, reused/modified/downstream behavior, manifest storage, audit integration, authorization, failure recovery) maps to at least one task (R1–R13).
- No task authorizes itself to run outside this planning session — every "Validation command" is listed for later execution, not run here.
- R7/R8 are explicitly contracts/dry-run-only, not RC7 itself — RC7/RC8 remain Phase C0 tasks, gated on R13.

Task count: 14 (R0–R13). No implementation occurred.
