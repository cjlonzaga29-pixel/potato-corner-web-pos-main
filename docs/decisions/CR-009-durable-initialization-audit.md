# CR-009 — Durable Initialization Audit Architecture

**Status:** PROPOSED (planning only — resolves Gate -1 of `docs/superpowers/plans/2026-07-27-cr006-phase-c0-canonical-reference-initialization.md`)

**CR-009.1 corrective pass:** resolves the two previously-rejected boundaries — decimal fingerprint canonicalization and manifest-entry provenance identity (now the primary `InitializationRecord` identity, replacing target-row identity). See "Decimal fingerprint canonicalization (resolved)", "Manifest-entry provenance identity (resolved)", and "Acceptance scenarios (CR-009.1)" below. All other sections are unchanged from the original CR-009 pass.

**CR-009.2 corrective pass:** locks the exact `manifestEntryKey` encoding (previously deferred to implementation) and the `InitializationRecord` dry-run/apply lifecycle wording (previously ambiguous "mutable-dry-run-reuse" phrasing). See "`manifestEntryKey` encoding (locked, CR-009.2)" and "Lifecycle model (locked, CR-009.2)" below. No other architecture changes.

**Supersedes:** the placeholder filename `docs/decisions/CR-008-durable-initialization-audit-model.md` named in that plan's Task RC0 — `CR-008` is already assigned to Universal Product Catalog (`docs/decisions/CR-008-universal-product-catalog.md`), so this CR is renumbered CR-009.

**Authority order:** CR-007 > CR-006 > approved Phase C0.1 plan > CR-008.2 > existing `AuditLog`/`pg-lock.ts` architecture. This CR does not redesign anything those documents already settled; it defines the two new models Gate -1 requires and reuses existing patterns (advisory-lock hashing in `apps/api/src/lib/pg-lock.ts`, batch-ID format in `apps/api/src/modules/inventory-migration/migration-batch.ts`, hash-chained `AuditLog`) rather than inventing new ones.

## Problem

An on-disk report cannot prove durable rollback provenance — it can be deleted, moved, or drift from the database. Gate -1 requires a database-backed model distinguishing created-by-run, reused-existing, changed-after-init, downstream-referenced, and rollback-eligible records before Phase C0's apply (RC7) or rollback (RC8) tooling may be built.

## Models

### `InitializationRun` (run-level)

One row per plan/apply/rollback execution attempt.

**Authoritative identity:** `migrationBatch` (unique) — never timestamps alone.

**Fields:** `id`, `migrationBatch` (unique, reuses `isValidMigrationBatchId`-style pattern generalized per-init-type), `initializationType` (`REFERENCE_DATA` — extensible string/enum for future reuse), `manifestVersion`, `manifestFingerprint`, `manifestSnapshot` (Json — normalized manifest, not a file-path dependency), `targetEnvironment`, `executionMode` (`DRY_RUN | APPLY | ROLLBACK`), `status` (lifecycle enum, below), `initiatedBy` (User FK), `startedAt`, `completedAt`, `failedAt`, `failureReason`, `dryRunReportFingerprint`, `applyReportFingerprint`, `rollbackReportFingerprint`, `version` (Int, optimistic concurrency), `createdAt`, `updatedAt`.

**Uniqueness:** `migrationBatch` unique. `manifestFingerprint` stored but not unique (same manifest legitimately reruns under a new batch — see Idempotency case 9). `targetEnvironment` explicit, never inferred.

**Relationships:** one-to-many `InitializationRecord`.

**Lifecycle:** see below. **Concurrency:** `version` column, optimistic CAS on every status transition; advisory lock (below) serializes concurrent apply attempts. **Archival:** no deletion — runs are permanent audit history; `SUPERSEDED` marks a run logically retired without removing it. **Indexes:** unique(`migrationBatch`); index(`targetEnvironment`, `status`); index(`manifestFingerprint`). **Retention:** indefinite — this table *is* the audit trail; no TTL.

### `InitializationRecord` (per-target-record provenance)

One row per manifest entry evaluated by a run.

**Fields:** `id`, `initializationRunId` (FK), `manifestEntryKey` (required — the authoritative manifest-entry identity, below), `entityType` (enum, below), `entityId` (nullable — populated only when a target row exists; `null` for `BLOCKED`/`SKIPPED`/`FAILED`), `action` (enum: `CREATED | REUSED | SKIPPED | BLOCKED | FAILED`), `createdByRun` (Boolean — true only when `action = CREATED`), `reusedExisting` (Boolean — true only when `action = REUSED`), `preexistingFingerprint` (nullable — set only on `REUSED`), `resultingFingerprint` (the fingerprint immediately after apply), `currentVerificationFingerprint` (recomputed at rollback-assessment time, nullable until assessed), `applyStatus` (`PENDING | COMMITTED | ROLLED_BACK_ATTEMPT_FAILED`), `rollbackEligibility` (enum, below, nullable until assessed), `rollbackStatus` (enum: `NOT_ASSESSED | ELIGIBLE | BLOCKED | ROLLED_BACK | ROLLBACK_FAILED`), `rollbackBlockedReason` (string, nullable), `rolledBackAt` (nullable), `version` (Int, optimistic concurrency), `createdAt`, `updatedAt`.

### Manifest-entry provenance identity (resolved)

**Authoritative identity:** `@@unique(initializationRunId, manifestEntryKey)` — not target-row identity. This is the primary uniqueness constraint on `InitializationRecord`; it holds regardless of whether a target row exists (`BLOCKED`/`SKIPPED`/`FAILED` all still have exactly one durable record per manifest entry per run).

`manifestEntryKey` is:

- required, deterministic, unique within the normalized manifest;
- stable across dry-run and apply for the same manifest version;
- independent of database-generated IDs.

### `manifestEntryKey` encoding (locked, CR-009.2)

**Format:** `<entityType>:<canonicalNaturalKey>`, exactly:

```text
INVENTORY_CATEGORY:<normalized-category-name>
UNIT_OF_MEASURE:<normalized-unit-code>
UNIT_CONVERSION:<normalized-from-unit-code>-><normalized-to-unit-code>
```

Examples:

```text
INVENTORY_CATEGORY:flavor
UNIT_OF_MEASURE:g
UNIT_CONVERSION:kg->g
```

**Natural-key normalization (applied to every natural-key segment, in order):**

1. Input must be a string.
2. Unicode-normalize using NFC.
3. Trim leading and trailing whitespace.
4. Convert using locale-independent lowercase.
5. Reject empty normalized values.
6. Reject ASCII control characters U+0000–U+001F and U+007F.
7. Reject the reserved character `:`.
8. Reject the reserved sequence `->`.
9. Preserve internal spaces unless the authoritative natural key forbids them.
10. Do not collapse internal whitespace.
11. Do not transliterate characters.
12. Do not use database-generated IDs.
13. Do not include mutable display labels when a stable code exists.

**Per-entity authoritative natural keys:**

- `InventoryCategory`: normalized category name — the current approved natural identity for initialization. Example: `" Flavor "` → `INVENTORY_CATEGORY:flavor`.
- `UnitOfMeasure`: normalized unit code, never the display name. Example: `code = " G "` → `UNIT_OF_MEASURE:g`.
- `UnitConversion`: the directed ordered pair `normalized-from-unit-code -> normalized-to-unit-code`. Direction is significant — `UNIT_CONVERSION:kg->g` and `UNIT_CONVERSION:g->kg` are different keys; codes are never sorted alphabetically.

**Duplicate rule:** after normalization, duplicate `manifestEntryKey` values within one manifest must fail manifest validation before any durable dry-run records are created.

**Versioning:** every manifest/record carries `manifestEntryKeyVersion = 1`. Any future encoding change requires a new version and must never silently reinterpret existing records.

**`entityId` nullability:** `entityId` is populated only for `CREATED`/`REUSED` outcomes; it remains `null` for `BLOCKED`/`SKIPPED`/`FAILED`, including when a later retry under a new run resolves the same manifest entry successfully — the failed run's record keeps `entityId = null` permanently, it is never backfilled.

**Resolved-target duplicate protection (secondary, optional):** where database support permits, an additional partial unique index — conceptually `@@unique(initializationRunId, entityType, entityId) where entityId is not null` — guards against two different manifest entries resolving to the same target row within one run. Prisma cannot express a partial unique index directly; enforce this as a migration-level raw SQL constraint (`CREATE UNIQUE INDEX ... WHERE "entityId" IS NOT NULL`) added after `prisma migrate dev` generates the additive migration, documented inline in the migration file. A plain nullable composite unique is **not** sufficient on its own — Postgres treats each `NULL` as distinct, so it would silently permit duplicate `BLOCKED`/`SKIPPED`/`FAILED` rows for the same manifest entry; the primary `(initializationRunId, manifestEntryKey)` constraint is what actually prevents that, this secondary index only protects against duplicate *resolved* targets.

**Required invariants:**

- `createdByRun = true` only when `action = CREATED`, `entityId` is not null, `reusedExisting = false`.
- `reusedExisting = true` only when `action = REUSED`, `entityId` is not null, `createdByRun = false`.
- For `BLOCKED`/`SKIPPED`/`FAILED`: `createdByRun = false`, `reusedExisting = false`, `entityId` may be null.

All enforced at the write-service layer (RC7/future R5), not left to convention.

**Lifecycle model (locked, CR-009.2):** one `InitializationRecord` exists per `InitializationRun` and `manifestEntryKey`. The record is first created during durable dry-run validation. The same record is transitioned during apply using optimistic CAS on `version`. Apply must not create a second `InitializationRecord` for the same run and `manifestEntryKey`.

Example: dry-run creates `action = VALIDATED, entityId = null, version = 1`. Apply then transitions the same row to one of: `action = CREATED, entityId = <new target ID>, version = 2`; `action = REUSED, entityId = <existing target ID>, version = 2`; or `action = BLOCKED, entityId = null, version = 2`. If apply fails before the target row exists, the row transitions to `action = FAILED, entityId = null`.

**Retry behavior:** a retry loads the existing row by `initializationRunId + manifestEntryKey` and transitions it using CAS — it never inserts another provenance row. A stale-version conflict aborts that entry and triggers reconciliation (R11). Historical transition detail remains represented through `AuditLog`; `InitializationRecord` represents only the latest durable state of that manifest entry for that run.

The record is therefore **mutable through controlled CAS lifecycle transitions** — not a bare mutable dry-run record reused arbitrarily, and not separate immutable per-attempt rows. This does not permit unrestricted mutation: only the approved lifecycle transitions above may update the row. A retry after `APPLY_FAILED` is still a **new run** (new `migrationBatch`, CR-009 "Run lifecycle") with its own `InitializationRecord` rows under the new `initializationRunId`, reconciled by `manifestEntryKey` against prior runs' records for matching (idempotency case 2) — never by mutating the prior run's row.

**Relationships:** many-to-one `InitializationRun`; `entityId` is a loose reference (not a Prisma relation) into `InventoryCategory`/`UnitOfMeasure`/`UnitConversion` — no FK, since a single polymorphic FK across three tables is unsafe (see Entity Support). **Lifecycle:** written once at apply time inside the same transaction as the target-table write (or the skip/block decision at dry-run/apply time); updated only by rollback-assessment (`currentVerificationFingerprint`, `rollbackEligibility`) and rollback-execution (`rollbackStatus`, `rolledBackAt`) — never by manual edit. **Archival:** none — permanent. **Indexes:** `@@unique(initializationRunId, manifestEntryKey)` (primary); the optional partial unique index above (secondary); index(`entityType`, `entityId`) for downstream/cross-run lookup; index(`rollbackEligibility`). **Retention:** indefinite.

## Entity-type strategy

Narrow Prisma enum `InitializationEntityType { INVENTORY_CATEGORY UNIT_OF_MEASURE UNIT_CONVERSION }` — database-enforced, not free text. Extending to a future entity type is an additive enum value in a later CR, never a free-text field. No polymorphic FK; no cascading delete — `entityId` is validated at the service layer against the correct table for its `entityType`, and rollback deletion is an explicit per-row service call, never an ORM cascade.

## Fingerprint strategy

SHA-256 over a canonical JSON serialization (keys sorted, no whitespace) of each entity type's rollback-relevant mutable fields:

- `InventoryCategory`: `name`, `code`, `description`, `isActive` (normalized via existing `normalizeCategory`, not raw strings).
- `UnitOfMeasure`: `code`, `name`, `dimension`, `isBaseUnit`, `isActive`.
- `UnitConversion`: `fromUnitId`, `toUnitId`, `factor` (as canonical decimal string, not float).

Excludes: database-generated `id` (external identity is the manifest key, not the row id), `createdAt`/`updatedAt` (volatile, not rollback-relevant). Includes a `fingerprintVersion` field alongside every stored fingerprint so a future field-set change doesn't silently invalidate historical comparisons. Manifest-level and manifest-entry-level fingerprints use the same canonicalization over the manifest's own declared fields. Fingerprints prove *state comparison* (was this row's rollback-relevant state at time A equal to time B) only when paired with a durable `InitializationRecord` row — a fingerprint alone never proves authorship.

### Decimal fingerprint canonicalization (resolved)

Applies initially to `UnitConversion.factor`. Numerically equivalent decimal values must fingerprint identically; non-equivalent values must remain distinct.

**Canonicalization rules, applied before canonical JSON serialization and hashing, never through `Number`:**

1. Parse using `Prisma.Decimal`, never `Number`.
2. Reject invalid decimal strings.
3. Reject `NaN` and `Infinity`.
4. Normalize negative zero (`-0`, `-0.000`) to `0`.
5. Convert to a non-exponent, base-10 string.
6. Strip insignificant trailing fractional zeros.
7. Strip the decimal point when no fractional digits remain.
8. Preserve all significant digits — no precision loss.
9. Never round-trip through JavaScript `Number` at any step.
10. Apply this normalization before canonical JSON serialization and SHA-256 hashing.

**Worked examples:**

```text
"1000"         → "1000"
"1000.0"       → "1000"
"1000.000000"  → "1000"
"0.001000"     → "0.001"
"-0.000"       → "0"
"1.2300400"    → "1.23004"
```

`1000`, `1000.0`, `1000.000000` fingerprint identically. `1` and `1.0001` remain distinct.

**Scientific-notation policy (final):** rejected at manifest validation. A manifest `factor` written in scientific notation (e.g. `"1e3"`) fails validation before fingerprinting — this avoids a second, hidden expansion step that could silently disagree with the canonicalizer. Chosen over parse-and-expand for reviewability: a rejected manifest value is visible at validation time, not buried in a canonicalization diff.

**Database-read policy:** database values are always read through `Prisma.Decimal` and normalized with this same utility — a driver-formatted decimal string is never fingerprinted directly, since driver formatting (trailing zeros, exponent form) is not guaranteed to match the manifest's canonical form.

**Versioning:** every stored fingerprint carries both `fingerprintVersion` (existing) and `decimalCanonicalizationVersion` (new), both starting at `1`. A future change to decimal canonicalization rules requires bumping `decimalCanonicalizationVersion` — it must never silently reinterpret fingerprints computed under an earlier version.

## Run lifecycle

`PLANNED → DRY_RUN_VALIDATED → APPLYING → APPLIED | APPLY_FAILED`, then optionally `→ ROLLBACK_ASSESSING → ROLLBACK_BLOCKED | ROLLING_BACK → ROLLED_BACK | ROLLBACK_PARTIAL`. Any non-terminal state may transition to `SUPERSEDED` when a newer run for the same `manifestFingerprint` supersedes it (documentation-only marker, no data effect).

**Valid transitions:** exactly the arrows above; any other transition is rejected at the service layer via a lookup table, not inferred. **Invalid transition rejection:** service throws before any write; `version` CAS additionally guards against a stale in-memory run object attempting a transition. **Who may transition:** apply-service only moves `PLANNED→DRY_RUN_VALIDATED→APPLYING→APPLIED/APPLY_FAILED`; rollback-service only moves `*→ROLLBACK_ASSESSING→...`; no transition is triggered by a bare CLI flag without going through the corresponding service. **Retry:** `APPLY_FAILED` may be retried only as a **new** `InitializationRun` with a new `migrationBatch` referencing the same `manifestFingerprint` — a failed run is never resumed in place. **Recovery after process failure:** see Failure Recovery. **Stale `APPLYING`/`ROLLING_BACK` detection:** a run whose `status` is `APPLYING` or `ROLLING_BACK` with `startedAt` older than a documented timeout (e.g. 15 minutes) is flagged by a reconciliation check as `STALE_SUSPECTED` (surfaced in tooling output, never auto-transitioned) — an operator must run the explicit reconciliation command (R11) to resolve it, per-transaction-boundary rules below. **Partial-run handling:** `ROLLBACK_PARTIAL` is a legitimate terminal state, not an error to be silently retried.

## Transaction boundary (reconciles with approved Phase C0 §10)

Phase C0 already commits one `prisma.$transaction` per reference type (categories, then units, then conversions). This CR adds: **the target-table write and its corresponding `InitializationRecord` row(s) occur inside that same transaction** — never as a separate follow-up write. `InitializationRun.status` updates happen in their own lightweight transaction *between* reference-type transactions (never inside one), so a crash between reference-type transactions leaves the run's status accurately reflecting the last *fully committed* type.

- One reference type succeeds, next fails: that type's transaction (target rows + `InitializationRecord` rows) commits atomically; the failing type's transaction rolls back atomically (data and its records together); `InitializationRun.status → APPLY_FAILED` with `failureReason` naming the failing type, in the following lightweight transaction.
- Process crashes after a type's data commit but before the run-status update: run is left in `APPLYING` past its timeout → `STALE_SUSPECTED`; reconciliation (R11) re-derives true status from the `InitializationRecord` rows that actually exist (a crash cannot leave data committed without its paired records, since they share a transaction) — no ambiguity is possible about *that* type, only about whether the *next* type ran.
- Audit write fails but target data would have failed too: impossible by construction — same transaction, so failure of either fails both.

## Idempotency

| Case | Behavior |
|---|---|
| 1. Same manifest, same env, already applied | Run lookup by `migrationBatch` finds `APPLIED`; apply script reports no-op, zero writes. |
| 2. Same manifest after partial failure | New `migrationBatch` required (a failed run is not resumed); matcher (Phase C0 §8) finds prior type's committed rows and reuses them — `REUSED`, never duplicated. |
| 3. Same manifest after safe rollback | New run; matcher finds no live rows (rolled back) → recreated as `CREATED` under the new run's own `InitializationRecord` rows; the old run's records remain historical, untouched. |
| 4. Changed manifest, new version | New rows evaluated fresh; previously created rows matched and `REUSED`. |
| 5. Existing compatible target record | `REUSED`, `createdByRun=false` — never deleted by this run's own future rollback. |
| 6. Existing incompatible target record | `BLOCKED` (Phase C0 §8's `BLOCKED_INCOMPATIBLE`); recorded with `rollbackEligibility` irrelevant (nothing was created). |
| 7. Existing run in `APPLYING` | Advisory lock blocks a second apply for the same lock key; a second apply for a *different* manifest still serializes on the same coarse lock (Phase C0 §9's chosen coarse-lock scope). |
| 8. Duplicate `migrationBatch` | Rejected at insert by the unique constraint before any target write. |
| 9. Same fingerprint, different batch | Allowed (case 3/4) — `migrationBatch` is run identity, `manifestFingerprint` is content identity; they are intentionally decoupled. |
| 10. Manual target-data modification after apply | Detected at rollback-assessment time via `currentVerificationFingerprint ≠ resultingFingerprint` → `rollbackEligibility = BLOCKED`, reason `TARGET_MODIFIED_AFTER_INITIALIZATION`. |

No duplicate categories/units/conversions or provenance rows are possible: target-table uniqueness (existing schema constraints) plus `InitializationRecord`'s own unique constraint plus the coarse advisory lock jointly enforce this.

## Concurrency strategy

Single coarse Postgres advisory lock, same derivation as `apps/api/src/lib/pg-lock.ts` (`hashToLockId` over a fixed string, e.g. `'cr009-reference-init-apply'`), held for the whole apply-or-rollback call and released in a `finally` — identical pattern already approved in Phase C0 §9. Layered with: `migrationBatch` DB-uniqueness (duplicate-run rejection), `InitializationRun.version` optimistic CAS (stale in-memory transition rejection), `InitializationRecord`'s unique constraint (duplicate-record rejection even under a lock-acquisition race). Apply and rollback share the *same* lock key so they cannot run simultaneously against the same initialization surface. Manual edits during apply are not lockable (outside this system's control) — caught after the fact via fingerprint mismatch at rollback-assessment, never assumed impossible.

## Rollback eligibility rules

A `CREATED` record may be automatically deleted only when **all** hold: durable `InitializationRecord.createdByRun = true` for this run; `currentVerificationFingerprint = resultingFingerprint`; no downstream reference (see below); no later run's `InitializationRecord` references this `entityId` as a dependency; no manual modification detected (implied by the fingerprint match); authorization valid (see Authorization); rollback explicitly confirmed per-row; `targetEnvironment` matches the run; the rollback transaction itself succeeds. A `REUSED` record (`reusedExisting = true`) is never eligible, unconditionally. A record whose fingerprint mismatches is `BLOCKED` with `TARGET_MODIFIED_AFTER_INITIALIZATION` — never silently restored or deleted; no auto-restoration policy exists in this CR.

## Rollback transaction strategy

One transaction per reference type at rollback time, **reverse dependency order**: conversions first, then units, then categories (child-before-parent by FK direction) — mirrors Phase C0 §11's advisory ordering but now executable, not merely assessed. Deletion stops or skips safely per-row when a live dependency exists (checked live, per Phase C0 §11 — not from a stale report). **Chosen strategy: one transaction per reference type, with partial run-level outcome permitted and fully reported** — `ROLLBACK_PARTIAL` is a valid terminal `InitializationRun.status` when e.g. conversions roll back but a unit is blocked by a downstream reference; each type's rollback transaction also writes its `InitializationRecord.rollbackStatus`/`rolledBackAt` updates in the same transaction as the deletion.

## Reused-record behavior

Manifest requests a `Flavor` category; an exact compatible row already exists → `InitializationRecord{action: REUSED, createdByRun: false, reusedExisting: true}`. Rollback of this run never considers this row a candidate, regardless of reference count.

## Modified-after-apply behavior

A `gram` unit created by a run has its `name` changed by an administrator afterward. Rollback assessment recomputes `currentVerificationFingerprint`, finds it differs from `resultingFingerprint`, sets `rollbackEligibility = BLOCKED`, reason `TARGET_MODIFIED_AFTER_INITIALIZATION`. No automatic delete or overwrite occurs.

## Downstream-reference behavior

A run creates `UnitOfMeasure g`; a later phase links `InventoryItem.baseUnitId` to it. Rollback assessment's live-reference check (Phase C0 §11, RC8) finds the reference → `rollbackEligibility = BLOCKED`, reason `DOWNSTREAM_REFERENCE_EXISTS`. No cascading deletion is ever performed — `InitializationRecord` has no cascade-capable FK into target tables by design (see Entity Support).

## Manifest and report storage

Store a **normalized manifest snapshot** (`InitializationRun.manifestSnapshot: Json`) plus its fingerprint — not a bare file path. The source-controlled manifest file remains the human-editable origin; the snapshot is the durable, run-scoped copy a future audit cannot lose to a file move/edit. Dry-run/apply/rollback report *fingerprints* are stored on the run (`dryRunReportFingerprint`, etc.); the full reports themselves may remain on-disk/external (Phase C0 §7's existing convention) since their durable identity (fingerprint) is recorded in the database regardless of file survival.

## Audit integration

`InitializationRecord` provides **domain provenance** (what happened to this specific category/unit/conversion, by which run). The existing hash-chained `AuditLog` (`apps/api/prisma/schema.prisma:1258`) provides **actor/action history** (who ran the apply/rollback command, when, from where) — one `AuditLog` row per significant lifecycle transition (`RUN_CREATED`, `RUN_APPLIED`, `RUN_ROLLBACK_EXECUTED`, etc.), `entityType: 'InitializationRun'`, `entityId: run.id`, `actorId` from the initiating operator's JWT. The two are not interchangeable and neither substitutes for the other — reconciliation and rollback-eligibility logic reads `InitializationRecord`; "who did it" reads `AuditLog`.

## Authorization boundary

Reuses the existing JWT-role architecture (`.claude/CLAUDE.md` JWT structure) — no new permission system. Creating a dry-run record, executing apply, retrying a failed run, initiating rollback assessment, confirming rollback, executing rollback, and viewing run details are all restricted to the Super Admin role, consistent with this being a cross-branch reference-data operation outside any single branch's scope. Overriding a rollback block requires a separate, explicitly-approved policy not created by this CR — no override path exists yet. Ordinary branch users (Supervisor/Staff) have no access to any initialization endpoint or CLI.

## Failure-recovery strategy

Validation failure before writes: reject before any transaction opens, run never reaches `APPLYING`. Reference-type transaction failure: that type rolls back atomically (data + records together, same transaction — see Transaction Boundary), run marked `APPLY_FAILED` with `failureReason`. Audit-row failure: impossible in isolation from a target-data failure (same transaction). Process crash after commit: next reconciliation run (R11) derives true state from committed `InitializationRecord` rows, never from memory. Status-update failure: retried by the same idempotent status-update call (it's a simple CAS write, safely retryable). Rollback failure/partial rollback: `ROLLBACK_PARTIAL` recorded, remaining eligible rows retryable via a new rollback-assessment pass. Stale `APPLYING`/`ROLLING_BACK`: flagged `STALE_SUSPECTED` past timeout, resolved only via an explicit reconciliation CLI command that re-derives status from durable records — **no operator ever hand-edits a provenance row**.

## Schema-change analysis (not implemented by this CR)

- **New models:** 2 (`InitializationRun`, `InitializationRecord`).
- **New enums:** 6 — `InitializationType`, `InitializationExecutionMode`, `InitializationRunStatus`, `InitializationEntityType`, `InitializationAction`, `InitializationRollbackEligibility`/`InitializationRollbackStatus` (rollback fields may share one enum or use two — final choice deferred to implementation, not a planning blocker).
- **Indexes:** unique(`migrationBatch`); index(`targetEnvironment`,`status`); index(`manifestFingerprint`) on `InitializationRun`. `@@unique(initializationRunId, manifestEntryKey)` (primary identity); optional partial-unique raw-SQL index on `(initializationRunId, entityType, entityId) WHERE entityId IS NOT NULL` (secondary, resolved-target duplicate protection); index(`entityType`,`entityId`); index(`rollbackEligibility`) on `InitializationRecord`.
- **Foreign keys:** `InitializationRecord.initializationRunId → InitializationRun.id` (restrict/no-cascade delete — runs are never deleted); `InitializationRun.initiatedBy → User.id`. No FK from `InitializationRecord` into `InventoryCategory`/`UnitOfMeasure`/`UnitConversion` (loose `entityId` reference, by design — see Entity Support).
- **Decimal/JSON:** `manifestSnapshot: Json`; fingerprints as `String` (hex digest) alongside `fingerprintVersion` and `decimalCanonicalizationVersion` (both `Int`, starting at `1`); no `Decimal` fields introduced (fingerprint canonicalizes `UnitConversion.factor` as a string via `Prisma.Decimal`, doesn't store a second copy of the decimal).
- **Version fields:** `version: Int` on both models for optimistic concurrency.
- **Timestamps:** standard `createdAt`/`updatedAt` on both; run additionally carries `startedAt`/`completedAt`/`failedAt`/`rolledBackAt`-equivalent lifecycle timestamps.
- **Migration safety:** purely additive (two new tables, no existing-table alteration) — low risk, standard `prisma migrate dev` against the verified local shadow DB per `.claude/CLAUDE.md`'s three-URL rule, whenever implementation begins.

## Acceptance scenarios (CR-009.1)

**A — Blocked before target creation.** Manifest entry `UNIT_OF_MEASURE:g`; database has a conflicting incompatible unit. Result: `manifestEntryKey = UNIT_OF_MEASURE:g`, `action = BLOCKED`, `entityId = null`. Exactly one durable outcome exists for this entry in this run.

**B — Failed conversion creation.** Manifest entry `UNIT_CONVERSION:kg->g`; the transaction fails before the target row is created. Result: `action = FAILED`, `entityId = null`. A retry reconciles using the same `manifestEntryKey` under a new run.

**C — Reused target.** Manifest entry `INVENTORY_CATEGORY:flavor`; a compatible target exists. Result: `action = REUSED`, `entityId = <existing ID>`, `createdByRun = false`, `reusedExisting = true`.

**D — Created target.** Manifest entry `UNIT_OF_MEASURE:g`; no target exists. Result: `action = CREATED`, `entityId = <new ID>`, `createdByRun = true`, `reusedExisting = false`.

**E — Decimal parity.** Manifest `factor = "1000.000"`; database `factor = Decimal("1000")`. Expected: same canonical value, same rollback-relevant fingerprint.

## Phase C0 / Phase C dependency conclusion

Phase C0 apply-mode (RC7) and rollback tooling (RC8) remain **blocked** until this CR is approved, implemented, migrated, and validated. Phase C's identity migration remains blocked until canonical references are successfully applied under the resulting durable model. This CR itself performs none of that work.
