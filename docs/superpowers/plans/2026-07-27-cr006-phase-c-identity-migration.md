# CR-006 Phase C — Identity Migration Implementation Plan

**Status:** Planning only. No code, schema, or data changes performed by this
document. Governed by CR-007 (final authority) > CR-006 Phase B doc > Phase
A/B/B.1 approved implementation.

**Scope:** Controlled creation and mapping of `InventoryCategory`,
`UnitOfMeasure`, `InventoryItem`, `InventoryIdentityMapping` records from the
legacy `Ingredient`/`Flavor` sources documented in Phase B. Consumes
`DryRunReport` (apps/api/src/modules/inventory-migration/types.ts) as input.

**Explicitly excluded from Phase C** (separate future phases/CRs):
- `InventoryStock` initialization — CR-007 §14.1/§20 and the schema comment on
  `InventoryStock` ("Empty/zero-row in Phase A... nothing populates it yet...
  starting Phase G") place stock population at Phase G, not Phase C. No
  physical stock quantity is inferred from identity migration.
- `InventoryMovement` backfill — no CR-007 section assigns historical ledger
  backfill to Phase C; §14.2 reserves `OPENING_BALANCE` for "controlled
  imports" but does not mandate it here, and it is a distinct action from
  identity migration.
- `ProductComponent` migration — CR-007 §20.6 assigns rework of
  `ProductComponent` as its own deferred deliverable; the current
  `ProductComponent` schema comment says flavor-specific deduction "remains on
  the existing compatibility architecture... until a future option-component
  CR." Not Phase C.
- Flavor→`InventoryItem` direct resolution (`FLAVOR_IDENTITY` mapping method)
  — CR-007 §11.2 defers this to "a future option-component CR." Phase C only
  migrates `Ingredient` identities; `Flavor` rows are read-only context.
- Any manual-review UI. Phase C's apply mode auto-migrates only
  `SAFE_AUTO_MATCH_CANDIDATE`/`DISTINCT` groups with a fully resolved unit and
  category; it *records* (does not resolve) `AMBIGUOUS`/`UNKNOWN`/invalid
  cases for a later, separately-scoped review workflow (Task C9 defines the
  minimum operator command needed to flip a recorded row to
  `MANUALLY_MATCHED`, but building a review UI is out of scope).

---

## 1. Legacy sources → destination map

| Legacy source | Field(s) used | Destination | Field(s) populated |
|---|---|---|---|
| `Ingredient` (active, `deletedAt IS NULL`) | `id`, `name`, `unit`, `category`, `branchId` | `InventoryIdentityMapping` | `legacyIngredientId`, `legacyName`, `legacyUnit`, `mappingStatus`, `mappingMethod`, `migrationBatch`, `migratedAt` |
| `Ingredient` (via Phase B `IdentityCandidateGroup`) | normalized name + resolved unit + resolved category | `InventoryItem` | `name` (from group's representative raw name), `baseUnitId`, `categoryId`, `trackInventory=true` (default), `sku=null`, `barcode=null` |
| Phase B `UnitClassificationEntry.proposedCanonicalUnitName` | advisory string | `UnitOfMeasure` (read-only lookup) | resolved to `UnitOfMeasure.id` — never written to by Phase C (see §3) |
| Phase B `CategoryCandidate.proposedCategoryName` | advisory string | `InventoryCategory` (read-only lookup) | resolved to `InventoryCategory.id` — never written to by Phase C (see §4) |
| `Flavor` (via Phase B `FlavorLinkedCandidate`) | context only | none | Not written. Read for report annotation only — see exclusions above. |

Soft-deleted `Ingredient` rows (`deletedAt != null`) are excluded from
migration entirely, matching Phase B's `detectIdentityCollisions` exclusion.

## 2. Architectural conflict flagged for CR-007 sign-off

Neither CR-006 Phase A nor CR-007 seeds any `UnitOfMeasure` or
`InventoryCategory` rows — Phase A ships the tables empty, and Phase B's
`existingUnitOfMeasureCount`/`existingInventoryCategoryCount` may legitimately
be `0`. §3 and §4 below require an *exact, unambiguous, pre-existing*
configured match to resolve a unit or category. **If no canonical
`UnitOfMeasure`/`InventoryCategory` rows exist yet, Phase C's apply mode can
migrate nothing** — every group blocks on unresolved unit/category. Per the
"do not synthesize/guess" and "do not invent these values during planning"
constraints, this plan does not propose canonical seed values itself.

**Resolution required before Phase C apply mode can run against real data:**
a separate, explicitly operator-approved seed step (config data, not
"invented" by Phase C) must populate `UnitOfMeasure`/`InventoryCategory` with
the canonical set the business wants (candidate names are visible in Phase
B's `normalizedUnits`/`categoryCandidates` for a human to approve). This is
called out as Gate 0 in §10 and is the one open item blocking Phase C from
starting apply-mode execution; it does not block writing Phase C's code
(dry-run/plan mode has no such dependency).

## 3. Unit resolution strategy

`proposedCanonicalUnitName` is documented in `types.ts` as advisory-only —
never an existing identity. Resolution (pure function, no schema change):

1. Normalize the advisory name with the *existing* `normalizeInventoryName`-
   style fold (trim/collapse-whitespace/lowercase) — reuse, don't duplicate,
   `normalization.ts`'s fold logic.
2. Query all `UnitOfMeasure` rows (`id`, `code`, `name`, `isActive`).
3. Match by case-insensitive-folded `name` equality only. Never match against
   `code` (code is a distinct, human-assigned short identifier — matching it
   would be a second, undocumented resolution path) and never derive `code`
   from the advisory string.
4. Exactly one case-insensitive match on `name` → resolved
   (`resolvedUnitId`). Zero matches → `UNRESOLVED_UNIT`, blocks the group.
   More than one match (a configuration data-quality problem: two units with
   the same folded name) → `AMBIGUOUS_UNIT_MATCH`, blocks the group and is
   reported as a distinct error (not silently picking the first).
5. `isActive=false` units are still eligible resolution targets (a unit being
   deactivated for new *manual* entry doesn't invalidate a historical
   migration target) — flagged as a warning in the report, not a blocker.

Phase C **does not create `UnitOfMeasure` rows** — nothing in CR-006/CR-007
assigns "controlled canonical creation" to this phase, so per the prompt's
own constraint ("If Phase C is permitted to create... the plan must define
[source of code/name/dimension/...]" — permission is absent here), this path
is not designed. If a future CR grants it, it is new work, not an extension
of this plan.

## 4. Category resolution strategy

Mirrors §3 exactly, against `InventoryCategory.name` (no fixed enum — CR-007
§20 forbids one):

1. Normalize `proposedCategoryName` with the same fold.
2. Exact case-insensitive match on `InventoryCategory.name`. Zero matches →
   `UNRESOLVED_CATEGORY`, blocks. Multiple matches → `AMBIGUOUS_CATEGORY_MATCH`,
   blocks.
3. `CategoryCandidate.unresolved=true` (Phase B's `OTHER`/unmapped-legacy-
   category rows) is *always* blocked regardless of what `InventoryCategory`
   rows exist — an unresolved *proposal* is never auto-resolved just because
   a same-named configured row happens to exist; it requires the same manual
   review path as an ambiguous identity group. This distinguishes "Phase B
   couldn't confidently propose a name" from "Phase C couldn't find the
   proposed name" — both block, for different, separately-reported reasons.
4. Legacy category value (`Ingredient.category` raw enum member) is preserved
   in `InventoryIdentityMapping.notes` (e.g. `"legacyCategory=OTHER"`) so the
   original classification survives even though `InventoryItem` never stores
   it (`InventoryItem` has no legacy-category column, matching CR-007 §20.2).
5. Phase C **does not create `InventoryCategory` rows** — same reasoning as
   §3.

## 5. Identity-key strategy

The authoritative match key for "is this the same physical item" is the
**structured triple** `(normalizedName, resolvedBaseUnitId, resolvedCategoryId)`
— never a concatenated/delimited string (the codebase already avoids this
exact pitfall in `identity-collision.ts`'s `countDistinctUnitCategoryPairs`,
using a nested `Map` instead of a `"unit::category"` key; Phase C follows the
same discipline for the same reason: no field is guaranteed delimiter-free).

- A Phase B `SAFE_AUTO_MATCH_CANDIDATE` or `DISTINCT` `IdentityCandidateGroup`
  whose unit and category both resolve (§3, §4) becomes **exactly one**
  `InventoryItem`, using the group's first member's raw `name` (Phase B
  already guarantees all members share normalized name/unit/category for
  `SAFE_AUTO_MATCH_CANDIDATE`).
- Every `IdentityCandidateMember` in that group (one or more legacy
  `Ingredient` rows, potentially across branches) becomes **one
  `InventoryIdentityMapping` row each**, all pointing at that one
  `InventoryItem.id`. This is how a cross-branch duplicate ingredient
  collapses into one universal identity with N audit rows — exactly the
  "one `InventoryItem`, multiple `InventoryIdentityMapping` rows" shape
  required.
- Duplicate-creation prevention (branches, reruns, case/whitespace, legacy
  duplicates, concurrent runs) is enforced by:
  a. Normalization (case/whitespace) already collapses at the Phase B
     grouping step.
  b. A **Postgres advisory lock** (`pg_advisory_xact_lock`, keyed by a stable
     hash of the triple) held for the duration of the identity-group
     transaction — reusing the exact primitive CR-004 already established
     for deduction concurrency (CR-007 §2 "Locked baseline"), not a new
     concurrency mechanism.
  c. Inside that lock, a lookup (`InventoryItem` where `name` ilike
     normalizedName-equivalent raw name AND `baseUnitId` = resolved AND
     `categoryId` = resolved AND `deletedAt IS NULL`) before insert —
     check-then-create inside one transaction, not a bare unique constraint,
     since Phase A's schema has no unique index over
     `(name, baseUnitId, categoryId)` and adding one is a schema change this
     plan does not make (out of scope — planning only).
  d. `InventoryIdentityMapping.legacyIngredientId` already has
     `@@unique` (Phase A) — this is the hard DB-level guarantee against a
     second mapping row for the same legacy ingredient, independent of the
     advisory lock.

## 6. Mapping-status / mapping-method strategy

Only schema-existing enum values are used (`InventoryMappingStatus`:
`PENDING, AUTO_MATCHED, MANUALLY_MATCHED, AMBIGUOUS, REJECTED`;
`InventoryMappingMethod`: `NORMALIZED_NAME_UNIT_CATEGORY, FLAVOR_IDENTITY,
MANUAL, IMPORT`). `FLAVOR_IDENTITY` is **not used** by Phase C (§ Scope
exclusions) — it is reserved for the future Flavor→`InventoryItem` CR.

| Phase B input | Unit/category resolved? | Mapping outcome |
|---|---|---|
| `SAFE_AUTO_MATCH_CANDIDATE` / `DISTINCT` group | Yes, unambiguously | `mappingStatus=AUTO_MATCHED`, `mappingMethod=NORMALIZED_NAME_UNIT_CATEGORY`, `inventoryItemId` set, `migratedAt=now()`, `migrationBatch=<batch>`, `reviewedBy=null`, `reviewedAt=null` (no human reviewed an automatic match) |
| `SAFE_AUTO_MATCH_CANDIDATE` / `DISTINCT` group | No (unit/category unresolved/ambiguous) | `mappingStatus=PENDING`, `mappingMethod=null`, `inventoryItemId=null`, `notes` records which of unit/category blocked and why; no `InventoryItem` created |
| `AMBIGUOUS` group (Phase B) | n/a | `mappingStatus=AMBIGUOUS`, `mappingMethod=null`, `inventoryItemId=null`, `notes` records the conflicting unit/category values found |
| `INVALID` group (empty name) or Phase B `InvalidRecord` | n/a | `mappingStatus=REJECTED`, `mappingMethod=null`, `inventoryItemId=null`, `notes` = Phase B's `reason`/`InvalidRecord.reason` |
| A `PENDING`/`AMBIGUOUS`/`REJECTED` row later resolved by an **operator** running the explicit manual-approval command (Task C9) | n/a | `mappingStatus=MANUALLY_MATCHED`, `mappingMethod=MANUAL`, `reviewedBy=<operator id>`, `reviewedAt=now()`, `inventoryItemId` set by the operator to a specific existing or newly-approved `InventoryItem.id` |

`IMPORT` mapping method is reserved (unused by this plan) for a possible
future bulk-import path distinct from the live-DB migration described here —
noted, not implemented.

## 7. Idempotency

- **Rerun same batch ID:** `InventoryIdentityMapping` is upserted by its
  `@@unique([legacyIngredientId])` key. An already-`AUTO_MATCHED`/
  `MANUALLY_MATCHED`/`REJECTED` row is left untouched (its `migrationBatch`/
  `migratedAt` reflect the run that *first* resolved it, not every rerun) —
  this is what makes reruns safe against accidental double-processing. A
  `PENDING`/`AMBIGUOUS` row is re-evaluated (resolution inputs — e.g. newly
  seeded `UnitOfMeasure` rows per §2 — may have changed) and may transition
  to `AUTO_MATCHED` on a later run.
- **Rerun with a different batch ID:** identical behavior — the batch ID is
  metadata about *which run* resolved a row, not a scope filter on which rows
  are eligible for (re-)resolution.
- **Existing `InventoryItem` records:** looked up by the §5 triple before any
  create — never blindly inserted.
- **Existing `InventoryIdentityMapping` rows:** looked up by
  `legacyIngredientId` before any create (upsert, not insert).
- **Partially migrated identity groups** (e.g. process crashed after creating
  the `InventoryItem` but before all N mapping rows): the identity-group
  transaction (§8) means this cannot happen mid-group — the transaction
  either commits the item + all its group's mappings, or none of them.
- **Destination records created outside the migration:** the §5(c) lookup is
  unconditional (runs every time, not only when the migration created the
  row), so a same-triple `InventoryItem` created by any future path (once
  CR-007 §20 item 5 ships provisioning against `InventoryItem` directly) is
  found and reused, never duplicated.
- **Concurrent executions:** guarded at two levels — the per-triple advisory
  lock (§5b) for item creation, and a single coarse advisory lock
  (`pg_advisory_lock` on a fixed constant key, e.g.
  `hashtext('cr006-ingredient-migration-apply')`) held for the whole apply-
  mode run, so two operators cannot run apply mode concurrently against
  overlapping scope at all (Gate in §10).

## 8. Transaction strategy

**Chosen: identity-group transaction** (one `prisma.$transaction` per
`IdentityCandidateGroup`, wrapping the advisory lock, the `InventoryItem`
lookup-or-create, and all of that group's `InventoryIdentityMapping` upserts).

- **Full-batch transaction** rejected: one bad/unexpected row anywhere in a
  potentially large legacy dataset would abort the entire run, and a
  long-held single transaction defeats per-group advisory locking granularity
  (lock contention would serialize the whole batch behind one transaction).
- **Per-record transaction** rejected: it cannot express "these N legacy
  ingredients must all end up pointing at the *same* `InventoryItem` or none
  of them do" — creating the item in one transaction and mappings in others
  reopens exactly the orphan-item/partial-mapping-set risk the plan must
  avoid.
- Identity-group transaction is the smallest unit that keeps "one item + its
  full mapping set" atomic while still letting one group's failure
  (e.g. a race lost on the advisory lock, retried) not roll back unrelated
  groups.

This guarantees no orphan `InventoryItem` (never committed without its
group's mappings), no duplicate mappings (unique constraint + upsert), no
mapping without a valid destination (the item is created/found in the same
transaction before any mapping row referencing it commits), and no partially
created identity group (single transaction boundary = the group).

## 9. Rollback strategy

Keyed by `migrationBatch`.

- **Safe to delete:** `InventoryIdentityMapping` rows where
  `migrationBatch = <batch>` **and** `mappingStatus = AUTO_MATCHED` **and**
  `reviewedBy IS NULL` (never touched by a human). After deleting those,
  any `InventoryItem` that (a) was created in that same batch (tracked via a
  rollback-eligibility check: an item with **zero** remaining
  `InventoryIdentityMapping` rows after the above delete, and **zero**
  `InventoryStock`/`ProductComponent` rows referencing it — both should be
  zero in Phase C's own timeframe, but the check is unconditional, not
  assumed) is deleted.
- **Must NOT be deleted:** any `InventoryIdentityMapping` row with
  `mappingStatus = MANUALLY_MATCHED` or `reviewedBy` set (protected
  regardless of `migrationBatch` — a human decision is never silently
  reverted by an automated rollback), and any `InventoryItem` still
  referenced by a remaining mapping, `InventoryStock`, or `ProductComponent`
  row.
- **Deletion order:** `InventoryIdentityMapping` (child) before
  `InventoryItem` (parent) — matches the FK direction and the `onDelete:
  Cascade` already declared from mapping→item (so item deletion would cascade
  mappings anyway; deleting mappings first and re-checking item eligibility
  explicitly is more conservative and auditable than relying on cascade).
- **Rollback blockers:** any protected row found in the batch scope halts
  rollback for that batch with a report of what's protected and why — no
  partial silent rollback.
- **Verification steps:** pre/post row counts (mirroring the apply-mode
  report), confirms `InventoryIdentityMapping` count for the batch returns to
  `PENDING`/no-row state as appropriate, confirms no dangling
  `InventoryItem` FK references remain.
- Git revert is irrelevant here (Phase C writes data, not code) — rollback is
  exclusively the above data operation, run via its own CLI command (Task
  C8), never implied by reverting a commit.

## 10. Precondition gates (apply mode)

0. **(New, §2)** Canonical `UnitOfMeasure`/`InventoryCategory` seed rows exist
   and have been operator-approved (not part of Phase C's own writes — a
   prerequisite data-setup step). Without this, apply mode has nothing
   eligible to migrate; it is not an error, just zero-progress.
1. Phase B `migrationReadiness = true` (existing `readiness.ts` gate — no
   SKU/barcode collisions, no invalid records).
2. **Phase-C-specific stricter check layered on top of #1** (readiness.ts
   intentionally treats ambiguous groups/unknown units as warnings, not
   blockers, per its own comment — Phase C does not relax or redesign that;
   it adds its own narrower gate): every group Phase C intends to
   auto-migrate this run (`SAFE_AUTO_MATCH_CANDIDATE`/`DISTINCT`) must have
   both unit and category resolved per §3/§4. Groups that don't resolve are
   not blockers for the *whole run* — they're simply recorded as
   `PENDING`/`AMBIGUOUS` and skipped for item creation this run.
3. Destination uniqueness understood: no DB-level unique constraint exists
   on `(name, baseUnitId, categoryId)` (§5c) — the advisory lock + in-
   transaction lookup is the enforcement, and this gate confirms that lock
   key generation is deterministic before any writes proceed.
4. Migration target database explicitly identified and confirmed by the
   operator (project's existing `DATABASE_URL`/`DIRECT_URL` three-URL
   safety rule in `.claude/CLAUDE.md` applies unchanged — Phase C adds no
   new connection path).
5. Pre-migration row counts captured for `Ingredient`, `InventoryItem`,
   `InventoryIdentityMapping`, `UnitOfMeasure`, `InventoryCategory`.
6. Legacy source counts captured (reuse Phase B's `fetchSourceSummary`).
7. Migration batch ID supplied and validated (`isValidMigrationBatchId`,
   reusing `migration-batch.ts`) — apply mode never generates its own batch
   ID silently; it must be handed one (typically the dry-run/plan batch ID
   being promoted to apply).
8. Explicit operator confirmation flag/prompt supplied (§11) — separate from
   just invoking the command.
9. No concurrent migration holding the coarse advisory lock (§7).
10. Rollback procedure understood/available (this document) before the
    operator is allowed to confirm.
11. **Reconciliation gate (§13):** the dry-run report being promoted to apply
    must be regenerated (or its fingerprint confirmed unchanged) immediately
    before apply — stale dry-run data is rejected, not applied blind.

No additional CR-007 gates beyond the above were found; CR-007 §22 states no
open questions block *implementation start*, but §2's Gate 0 is a data-setup
dependency, not an architectural open question.

## 11. Write-safety design

**Dry-run / plan mode** (default, safe-by-construction):
- Pure function over Phase B's `DryRunReport` + resolved units/categories
  (read-only lookups only) → produces the *same* per-record decision the
  apply run would make, with zero writes. This is Phase C's own
  `MigrationPlan`, distinct from (built on top of) Phase B's `DryRunReport`.
- Deterministic: same `DryRunReport` + same `UnitOfMeasure`/
  `InventoryCategory` snapshot → same plan, always (no `Date.now()`/random
  in the decision logic; only the report envelope carries `generatedAt`).

**Apply mode** (separate command, never reachable from the plan/dry-run
command):
- Requires `--batch <id>` (validated) and an explicit `--confirm` flag (no
  default/implicit confirm; a bare re-run of the plan command never applies
  anything).
- Runs Gate 0-11 (§10) before touching the DB.
- Executes per-group transactions (§8).
- Emits the same structured report shape as plan mode, with the write
  columns populated (createdItemCount, reusedItemCount, etc. — §14), plus
  post-write counts.
- Idempotent (§7) — safe to re-invoke with the same or a later batch ID.
- Stops (does not partially continue past) the first *unexpected*
  divergence — e.g. a legacy `Ingredient` row present in the live query but
  absent from the promoted dry-run's fingerprint (§13) — rather than
  silently reconciling.

## 12. Auditability

Every migrated `Ingredient` gets exactly one permanent
`InventoryIdentityMapping` row (old ID/name/unit preserved verbatim in
`legacyIngredientId`/`legacyName`/`legacyUnit`, per CR-007 §20.2) regardless
of outcome (matched, ambiguous, rejected, pending) — nothing is silently
dropped from the audit trail. `notes` captures the specific resolution
reasoning (which classification/candidate drove the decision, or which gate
blocked it). Batch ID ties every row to the exact run that touched it.

## 13. Reconciliation against Phase B dry-run

Apply mode's report includes the `batchId` and a `dryRunFingerprint`
(deterministic hash over the promoted `MigrationPlan`'s per-record decisions
— same shape family as Phase B could add a fingerprint to `DryRunReport`,
computed the same way in both places so they're comparable). Before applying,
the operator-supplied plan is re-derived against live data and its fingerprint
compared to the one the operator reviewed; a mismatch blocks apply (Gate 11)
rather than applying a stale plan.

---

## Tasks

### Task C1 — Canonical-reference gap report (read-only)

**Objective:** Read-only tool that cross-references Phase B's
`normalizedUnits`/`categoryCandidates` proposals against live
`UnitOfMeasure`/`InventoryCategory` rows and reports exactly which proposed
names are unresolved (§2 Gate 0), so an operator can approve a seed list —
Phase C does not choose or insert the seed values itself.

**Files (future):** `apps/api/src/modules/inventory-migration/canonical-gap.ts`
(+ `.test.ts`).

**Steps:** Implement `findUnresolvedCanonicalNames(report: DryRunReport,
existingUnits: UnitOfMeasure[], existingCategories: InventoryCategory[]):
{ unresolvedUnitNames: string[]; unresolvedCategoryNames: string[] }` using
the exact-match rule of §3/§4. No writes.

**Tests:** proposed name with exact case-insensitive existing match → not
reported; no match → reported; two existing rows folding to the same name →
reported as ambiguous, not silently resolved.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/canonical-gap.test.ts`.

**Rollback:** N/A (read-only, no DB writes).

**Stop condition:** none — pure/read-only, always safe to build first.

**Architectural reference:** §2, §3, §4 above; CR-007 §20 (no fixed enum).

---

### Task C2 — Unit resolution function

**Objective:** Implement §3's resolution rule as a pure, unit-testable
function.

**Files (future):** `apps/api/src/modules/inventory-migration/unit-resolution.ts`
(+ `.test.ts`).

**Steps:** `resolveCanonicalUnit(proposedCanonicalUnitName: string | null,
existingUnits: { id: string; name: string }[]): UnitResolution` where
`UnitResolution` is a discriminated union: `{ status: 'RESOLVED';
unitOfMeasureId: string } | { status: 'UNRESOLVED_UNIT' } | { status:
'AMBIGUOUS_UNIT_MATCH'; matchedIds: string[] } | { status: 'NO_PROPOSAL' }`
(the last for `proposedCanonicalUnitName === null`, e.g. `ITEM_SPECIFIC_
PACKAGE_UNIT`/`UNKNOWN`/`INVALID` classifications from Phase B, which never
had a proposal to resolve).

**Tests:** exact case-insensitive single match → `RESOLVED`; no match →
`UNRESOLVED_UNIT`; two matches → `AMBIGUOUS_UNIT_MATCH` listing both ids;
`null` proposal → `NO_PROPOSAL`; never matches against `code`.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/unit-resolution.test.ts`.

**Rollback:** N/A (pure function).

**Stop condition:** if any existing test fixture requires matching on `code`
or synthesizing a name — stop, that contradicts §3 and needs a CR-007
clarification, not a workaround.

**Architectural reference:** §3.

---

### Task C3 — Category resolution function

**Objective:** Mirror C2 for `InventoryCategory`, including the "unresolved
proposal always blocks even if a same-named row exists" rule (§4.3).

**Files (future):** `apps/api/src/modules/inventory-migration/category-resolution.ts`
(+ `.test.ts`).

**Steps:** `resolveCanonicalCategory(candidate: CategoryCandidate,
existingCategories: { id: string; name: string }[]): CategoryResolution`
(same union shape as C2, plus the `candidate.unresolved === true` short-
circuit to `UNRESOLVED_CATEGORY` regardless of matches found).

**Tests:** resolved/unresolved/ambiguous cases as C2; additionally: a
`CategoryCandidate` with `unresolved: true` (e.g. legacy `OTHER`) never
resolves even when an `InventoryCategory` named "Other" exists.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/category-resolution.test.ts`.

**Rollback:** N/A.

**Stop condition:** same as C2.

**Architectural reference:** §4.

---

### Task C4 — Migration plan builder (pure, dry-run mode)

**Objective:** Combine Phase B's `DryRunReport` with C2/C3 resolutions into a
per-legacy-ingredient `MigrationPlan` — the full apply-mode decision set,
computed with zero DB writes. This *is* Phase C's dry-run mode.

**Files (future):** `apps/api/src/modules/inventory-migration/migration-plan.ts`
(+ `.test.ts`), extending `types.ts` with `MigrationPlanEntry`
(`legacyIngredientId`, `decision: 'CREATE_ITEM_AND_MAP' | 'REUSE_ITEM_AND_MAP'
| 'RECORD_PENDING' | 'RECORD_AMBIGUOUS' | 'RECORD_REJECTED'`,
`groupKey` (the §5 triple, structured — not a delimited string),
`resolvedUnitId`, `resolvedCategoryId`, `reason`) and `MigrationPlan`
(`batchId`, `entries`, counts, `dryRunFingerprint`).

**Steps:** Implement per §6's table exactly (one branch per Phase B input
classification × resolution outcome). Compute `dryRunFingerprint` as a stable
hash (e.g. SHA-256) over the sorted, serialized `entries` array.

**Tests:** one test per row of §6's table; determinism test (same inputs
twice → identical fingerprint); "same triple across two groups" cannot occur
by construction (Phase B already groups by normalized name) — test documents
this invariant instead of testing an impossible input.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/migration-plan.test.ts`.

**Rollback:** N/A (pure, no writes).

**Stop condition:** if a Phase B classification value appears that this
table doesn't cover (schema/Phase B drift) — stop and fail loudly rather than
defaulting it to any migration action.

**Architectural reference:** §5, §6, §11 (dry-run mode), §13 (fingerprint).

---

### Task C5 — Apply-mode repository and service (transactional writer)

**Objective:** The only code path in Phase C that writes to the database —
implements §7 (idempotency), §8 (identity-group transactions), §5b/§5c
(advisory lock + lookup-or-create).

**Files (future):**
`apps/api/src/modules/inventory-migration/migration-apply.repository.ts`,
`apps/api/src/modules/inventory-migration/migration-apply.service.ts`
(+ `.test.ts` each).

**Steps:**
1. Repository: `findInventoryItemByTriple(name, baseUnitId, categoryId)`,
   `createInventoryItem(...)`, `upsertIdentityMapping(...)` (by
   `legacyIngredientId`), each a thin Prisma call, no business logic.
2. Service: `applyMigrationPlan(plan: MigrationPlan, batchId: string):
   Promise<ApplyResult>` — for each `IdentityCandidateGroup` needing
   `CREATE_ITEM_AND_MAP`/`REUSE_ITEM_AND_MAP`: acquire the advisory lock
   (`pg_advisory_xact_lock(hashtext(triple))`) inside a `prisma.$transaction`,
   look up, create-if-absent, upsert every member's mapping row, commit. For
   `RECORD_PENDING`/`RECORD_AMBIGUOUS`/`RECORD_REJECTED` entries: upsert the
   mapping row alone (no item involved), independent per-entry transaction
   (no group-level atomicity needed since no shared item is at stake).
3. Acquire the coarse run-level advisory lock (§7) for the whole
   `applyMigrationPlan` call; release in a `finally`.

**Tests:** creates one item + N mappings for a 3-member
`SAFE_AUTO_MATCH_CANDIDATE` group in one transaction (mock Prisma
`$transaction`); reuses an existing item found by the triple instead of
creating a duplicate; two concurrent calls for the same triple (simulated
via lock-acquisition mock) — second waits/serializes rather than creating a
duplicate; rerun with an already-`AUTO_MATCHED` mapping is a no-op write;
`RECORD_REJECTED`/`RECORD_AMBIGUOUS` entries never call `createInventoryItem`.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/migration-apply.service.test.ts`.

**Rollback:** covered by Task C8; this task's writes are exactly what C8
must be able to undo per §9.

**Stop condition:** if a group's transaction fails partway (e.g. a mapping
upsert conflicts unexpectedly), the transaction rolls back atomically —
service must not catch-and-continue past that group silently; it records the
failure in `ApplyResult.errors` and continues to the *next independent*
group only.

**Architectural reference:** §5, §7, §8, CR-004 advisory-lock precedent
(CR-007 §2).

---

### Task C6 — CLI entrypoints (plan / apply / rollback)

**Objective:** Wire C4/C5/C8 into operator-facing commands, enforcing §11's
"apply never runs via the plain dry-run command" rule.

**Files (future):**
`apps/api/scripts/inventory-migration-plan.ts` (wraps C4; read-only, exit
non-zero if any `AMBIGUOUS`/unresolved entries exist, matching the existing
Phase B dry-run CLI convention),
`apps/api/scripts/inventory-migration-apply.ts` (wraps C5; requires
`--batch` + `--confirm`; runs Gates 0-11 from §10 before calling
`applyMigrationPlan`; refuses to run without both flags),
`apps/api/scripts/inventory-migration-rollback.ts` (wraps C8),
`apps/api/package.json` (+ `inventory:migration:plan`,
`inventory:migration:apply`, `inventory:migration:rollback` scripts).

**Steps:** Argument parsing only needs `--batch <id>` and `--confirm`
(boolean) for apply; no other new flags. Apply script prints the gate
checklist results before prompting/requiring `--confirm`.

**Tests:** apply script exits non-zero and performs no writes when
`--confirm` is omitted; exits non-zero when `--batch` is missing/invalid
(`isValidMigrationBatchId`); plan script never calls any write-capable
repository function (same "no write methods exist on mocked model" style
assertion Phase B's repository test already uses).

**Validation command:**
`pnpm --filter @potato-corner/api exec tsx scripts/inventory-migration-plan.ts`
(dry run against real read-only data is safe to actually execute — it writes
nothing); apply/rollback scripts validated only via their unit tests in
planning-adjacent work, never executed against a real target as part of
building this plan.

**Rollback:** N/A for the plan script; the apply script's own actions are
rolled back via the rollback script (C8), not by reverting this task's code.

**Stop condition:** if apply-mode code path is reachable without both
`--batch` and `--confirm` present — stop, that violates §11's core
requirement.

**Architectural reference:** §10, §11.

---

### Task C7 — Structured migration report

**Objective:** Emit the exact field set required (see plan intro's
Observability list) for both plan and apply runs.

**Files (future):**
`apps/api/src/modules/inventory-migration/migration-report.ts` (+ `.test.ts`),
extending `types.ts` with `MigrationReport`.

**Steps:** Pure function `buildMigrationReport(plan: MigrationPlan,
applyResult: ApplyResult | null, preCounts, postCounts):
MigrationReport` populating: `migrationBatch`, `generatedAt`,
`executionMode: 'PLAN' | 'APPLY'`, `sourceRecordCount`,
`destinationItemCount`, `mappingCount`, `reusedItemCount`,
`createdItemCount`, `unresolvedCount`, `ambiguousCount`, `skippedCount`,
`blockedCount`, `warnings`, `errors`, per-record decisions (from
`MigrationPlan.entries`), `preWriteCounts`, `postWriteCounts` (null in PLAN
mode), `rollbackEligible` (boolean, apply mode only),
`dryRunFingerprint`. No secrets/connection strings included anywhere in the
report (confirm no field carries `DATABASE_URL`/`DIRECT_URL` or raw env
values).

**Tests:** PLAN-mode report has null post-write counts and
`rollbackEligible=false`; APPLY-mode report's counts sum correctly
(`createdItemCount + reusedItemCount + unresolvedCount + ambiguousCount +
skippedCount + blockedCount === sourceRecordCount`, a structural invariant
worth asserting directly); no field contains a value matching an env-var-
shaped secret pattern (defensive test, not a runtime scan).

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/migration-report.test.ts`.

**Rollback:** N/A (read-only report builder).

**Stop condition:** none.

**Architectural reference:** Observability/Reporting requirements list; §13.

---

### Task C8 — Rollback tooling

**Objective:** Implement §9's rollback rules as an eligibility-checked
delete operation, scoped by `migrationBatch`.

**Files (future):**
`apps/api/src/modules/inventory-migration/migration-rollback.repository.ts`,
`apps/api/src/modules/inventory-migration/migration-rollback.service.ts`
(+ `.test.ts` each).

**Steps:**
1. `findRollbackEligibleMappings(batchId)`: `InventoryIdentityMapping` where
   `migrationBatch = batchId AND mappingStatus = 'AUTO_MATCHED' AND
   reviewedBy IS NULL`.
2. `findRollbackBlockedMappings(batchId)`: same batch, but
   `mappingStatus = 'MANUALLY_MATCHED' OR reviewedBy IS NOT NULL` — reported,
   never deleted.
3. `findOrphanableItems(mappingIdsBeingDeleted)`: `InventoryItem`s referenced
   only by the mappings about to be deleted, with zero
   `InventoryStock`/`ProductComponent` rows.
4. `rollbackBatch(batchId)`: if any blocked mappings exist, abort with a
   report (no deletes at all — all-or-nothing per batch, not partial). Else,
   in one transaction: delete eligible mappings, then delete now-orphaned
   items, return a rollback report (counts, per §9's verification steps).

**Tests:** batch with only `AUTO_MATCHED`/no-`reviewedBy` rows → full
rollback, item deleted; batch containing one `MANUALLY_MATCHED` row →
rollback aborts entirely, reports the blocker, deletes nothing; item shared
by mappings from two different batches → item survives rollback of one
batch (still referenced); item with an `InventoryStock` row (simulating a
later phase having populated stock) → item survives even if its mappings are
rolled back, and this is reported as a blocker requiring manual
intervention, not silently orphaning a stock row's FK.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/migration-rollback.service.test.ts`.

**Rollback (of this task itself):** N/A — this task builds the rollback
tool; there's no meta-rollback.

**Stop condition:** if any blocked row is found, the entire batch rollback
aborts — never partially rolls back around a protected row.

**Architectural reference:** §9.

---

### Task C9 — Manual-approval command (minimal, scoped)

**Objective:** The one operator-facing write path for turning a recorded
`PENDING`/`AMBIGUOUS` row into `MANUALLY_MATCHED` — required because §6's
table references it, but scoped to the minimum needed (a single-mapping CLI
command), not a review UI/dashboard (explicitly out of scope, see plan
intro).

**Files (future):**
`apps/api/scripts/inventory-migration-approve.ts`,
`apps/api/src/modules/inventory-migration/migration-approve.service.ts`
(+ `.test.ts`).

**Steps:** `approveMapping(legacyIngredientId: string, inventoryItemId:
string, reviewedBy: string, notes?: string)`: validates the mapping exists
and is `PENDING`/`AMBIGUOUS`/`REJECTED` (not already resolved — no silent
overwrite of an existing `AUTO_MATCHED`/`MANUALLY_MATCHED` row without a
separate explicit "re-approve" confirmation), validates `inventoryItemId`
exists and is not soft-deleted, sets `mappingStatus=MANUALLY_MATCHED`,
`mappingMethod=MANUAL`, `reviewedBy`, `reviewedAt=now()`, `notes`.

**Tests:** approves a `PENDING` row → status/method/reviewedBy/reviewedAt
set correctly; refuses to approve an already-`AUTO_MATCHED` row without an
explicit override flag; refuses an `inventoryItemId` that doesn't exist.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run
src/modules/inventory-migration/migration-approve.service.test.ts`.

**Rollback:** a `MANUALLY_MATCHED` row is permanently protected from
automated rollback (§9) — reverting a bad manual approval is itself a manual
operation (a further `approveMapping`-style correction or, if truly needed,
direct operator action outside this tool), not something Phase C automates.

**Stop condition:** none beyond the validation rules above.

**Architectural reference:** §6 (last row), §9 (protected-record rule).

---

## Test plan coverage map

| Required test | Covered by |
|---|---|
| advisory unit name resolves to one configured unit | C2 |
| missing unit blocks migration | C2, C4 |
| duplicate unit matches block migration | C2 |
| category resolution | C3 |
| missing category behavior | C3, C4 |
| safe-auto-match group creates one item | C5 |
| multiple legacy records create multiple mappings | C5 |
| ambiguous group performs no destination writes | C4, C5 |
| existing mapping is reused safely | C5 (rerun no-op) |
| conflicting mapping blocks execution | C5 (already-resolved guard), C9 |
| rerun is idempotent | C5, §7 |
| partial group failure rolls back its transaction | C5 |
| concurrent duplicate creation is prevented | C5 (advisory lock) |
| flavor-linked records remain schema-neutral | Scope exclusion — no code path touches `Flavor`/`ProductComponent`; enforced by C4/C5 simply never importing flavor-linked types |
| migration batch metadata is correct | C7 |
| dry-run performs no writes | C4, C6 |
| apply mode requires confirmation | C6 |
| rollback targets only eligible records | C8 |
| legacy data remains unchanged | All tasks — no task writes to `Ingredient`/`Flavor`/`ProductInventory`/legacy `InventoryMovement` tables; a repository-level assertion (same style as Phase B's `migration-source.repository.test.ts`) can assert no write methods are ever invoked on those Prisma models from any Phase C module |
