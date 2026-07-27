# CR-006 Phase C0 — Canonical Reference Initialization Implementation Plan

> **Revised by Phase C0.1 corrective pass (2026-07-27):** two defects fixed — (1) evidence was over-classified as `LEGACY_OBSERVED`/`RECIPE_OBSERVED` from classifier source code and unverified prompt prose rather than actual legacy records or an inspected recipe file; (2) rollback relied solely on a deletable on-disk report with no durable provenance. See the new **Gate -1** section (after §11) and the corrected §0/§2/§3 evidence tables. No implementation, schema change, or data write occurred in this corrective pass either.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Planning only — this document authorizes no implementation, no schema change, no data write.**

**Goal:** Build the controlled, auditable, idempotent mechanism that will populate `InventoryCategory` and `UnitOfMeasure` (and, only where justified, `UnitConversion`) canonical rows — resolving CR-006 Phase C's own documented **Gate 0** blocker — without inventing business values and without touching Phase C's identity migration.

**Architecture:** A version-controlled manifest (data, not code) describes proposed reference rows, each tagged with a source classification and an approval status. A dry-run tool validates the manifest against live data with zero writes. A separate apply tool, gated behind an explicit batch ID + confirmation, writes only operator-approved rows inside one transaction per run, and emits a structured audit report. A rollback tool consumes that report to undo an unreferenced run. No Prisma schema change is required or made — all three destination tables already exist and are empty.

**Tech Stack:** TypeScript, Prisma (existing schema only, no migration), Vitest, existing `apps/api/src/modules/inventory-migration/*` normalization/report conventions.

## Global Constraints

- No database writes, migrations, schema changes, seed execution, or fake data as part of this plan or its planning process.
- No `InventoryItem`, `InventoryStock`, `InventoryIdentityMapping`, `ProductComponent`, or `InventoryMovement` row is initialized here — those are Phase C/Phase G/later, unchanged.
- No food-specific enum or column is introduced. `InventoryCategory`/`UnitOfMeasure` stay configurable lookup tables per CR-007 §20.
- No canonical row is proposed without a cited source; unsourced proposals are recorded as `UNRESOLVED`, never silently included.
- No `UnitOfMeasure.code` or `InventoryCategory.code` is derived by uppercasing or otherwise transforming a name — every code must be explicit, operator-approved, or drawn from a cited authoritative standard.
- Governs strictly beneath CR-007 > CR-006 (Phase B doc) > approved Phase A > approved Phase B/B.1 > the existing (not-yet-executed) `docs/superpowers/plans/2026-07-27-cr006-phase-c-identity-migration.md` Phase C plan, whose §2 "Architectural conflict flagged for CR-007 sign-off" is the direct trigger for this document.

---

## 0. Source-of-truth inventory (what was actually inspected)

| Source | Location | What it provided |
|---|---|---|
| CR-007 | `docs/decisions/CR-007-universal-inventory-domain-finalization.md` | §20 forbids fixed category enum; final naming map; locked architecture this plan must not redesign |
| CR-006 Phase B doc | `docs/decisions/CR-006-phase-b-migration-source-inventory.md` | Legacy `Ingredient.category` 6-value enum; confirms no prior seed tooling exists |
| CR-006 Phase C plan | `docs/superpowers/plans/2026-07-27-cr006-phase-c-identity-migration.md` | §2 explicitly states Phase C creates neither `UnitOfMeasure` nor `InventoryCategory` rows and names the Gate-0 dependency this plan resolves |
| Prisma schema | `apps/api/prisma/schema.prisma:781-838` (`InventoryCategory`, `UnitOfMeasure`, `UnitConversion`) | Exact columns available: category has `name`, optional `code`, `description`, `isActive` — **no precision/decimal-precision column exists on either table**; unit has `code` (unique, required), `name`, `dimension` (`WEIGHT\|VOLUME\|COUNT`), `isBaseUnit`, `isActive`; conversion has `fromUnitId`, `toUnitId`, `factor @db.Decimal(18,8)` |
| Prisma schema | `apps/api/prisma/schema.prisma:142-149` (`IngredientCategory` enum) | Legacy category values: `RAW, FLAVOR, CUP, BAG, PACKAGING, OTHER` |
| Phase B code | `apps/api/src/modules/inventory-migration/category-classification.ts` | `CATEGORY_CANDIDATE_MAP` — the only existing, already-reviewed proposal of legacy-category → canonical-category-name |
| Phase B code | `apps/api/src/modules/inventory-migration/unit-classification.ts` | `KNOWN_GLOBAL_UNIT_SYNONYMS` (gram/kilogram/liter/milliliter/piece) and `KNOWN_PACKAGE_UNITS` (bag, sachet, box, pack, …) — the only existing, already-reviewed unit proposals |
| Phase B code | `apps/api/src/modules/inventory-migration/normalization.ts` | Fold rules (`normalizeInventoryName`, `normalizeCategory`, `normalizeLegacyUnit`) this plan must reuse, not reimplement |
| Repository search | full-tree search for recipe sheet files (`*.csv`, `*.xlsx`, "recipe", "kraft", "tablespoon", "sachet", "loopy") | **No recipe spreadsheet file exists in this repository.** The fries/Chicken Pop/Loopy/tablespoon/kraft-bag/cup/tissue facts used below come only from the current task instructions' own description of that sheet — the underlying file was not found and could not be independently verified. This is recorded as a sourcing gap, not treated as filesystem-confirmed data. |
| Live database | `inventory_categories`, `units_of_measure`, `unit_conversions` | Not queried — this session has no live-DB access and Phase C0 is planning-only regardless. Confirmed empty by the task prompt and consistent with Phase A shipping them empty (Phase C plan §2). |

No "business-approved operating standards" document (e.g., a unit-code standard) was found anywhere in the repository. Every unit/category `code` value in the manifest below is therefore `UNRESOLVED` pending explicit operator input — this plan does not propose codes.

**C0.1 correction — evidence classification:** the original version of this plan classified every candidate in `category-classification.ts`/`unit-classification.ts` as `LEGACY_OBSERVED` merely because it appears in that classifier source code. That is incorrect: source code, normalization maps, and prompt prose are not legacy database records. The only evidence actually verified against real legacy data (per Phase B) is:

- Legacy category observed: `FLAVOR`
- Legacy unit observed: `grams`

Every other candidate below is downgraded to `UNRESOLVED` unless a stronger, independently verified source is cited. Allowed classifications for every manifest entry are exactly: `ARCHITECTURE_REQUIRED`, `LEGACY_OBSERVED`, `RECIPE_OBSERVED`, `OPERATOR_APPROVED`, `UNRESOLVED`. `RECIPE_OBSERVED` requires an actually-inspected recipe file; since §0 above confirms no such file exists in this repository, **no entry in this plan qualifies as `RECIPE_OBSERVED`** — the prompt's recipe-sheet description is recorded as unverified operator-provided prose, not filesystem-confirmed evidence, and does not by itself justify any classification above `UNRESOLVED`.

---

## 1. Phase C0 scope

**In scope:**
1. Design (not populate) the canonical manifest format for `InventoryCategory` and `UnitOfMeasure`, with `UnitConversion` entries only where a universal, non-item-specific conversion is justified by the schema's own stated design (kg↔g, L↔mL — see `schema.prisma:820-822`).
2. Build dry-run and apply tooling around that manifest (this plan defines the tasks; execution is out of scope for this document per "planning only").
3. Classify every candidate value per the C0.1-corrected evidence rules (§0/§2/§3): classifier source code alone is not `LEGACY_OBSERVED`; the task prompt's recipe-sheet description is unverified context, not `RECIPE_OBSERVED` evidence, since no such file exists in this repository.
4. Produce the required operator-decision sections for fractional kraft-bag packaging and tablespoon handling.
5. Define matching/duplicate, idempotency, transaction, and rollback rules for reference-data initialization specifically (distinct from Phase C's identity-migration rules, which govern a different table set).

**Explicitly excluded (confirmed against the prompt's exclusion list):**
- No `InventoryItem`, `InventoryStock`, `InventoryIdentityMapping`, `ProductComponent`, or `InventoryMovement` row.
- No Phase C identity migration start.
- No schema/migration change — all three destination tables exist today.
- No seeding at application startup.
- No fake/synthetic data — every manifest row must resolve to `ARCHITECTURE_REQUIRED`, `LEGACY_OBSERVED`, `RECIPE_OBSERVED`, or `OPERATOR_APPROVED`, or it stays `UNRESOLVED` and is excluded from apply eligibility.

---

## 2. Category manifest (proposed, pending operator approval — none created by this document)

Per the C0.1 correction (§0): appearing in `category-classification.ts` is classifier-source-code evidence, not a legacy database record, and does not on its own justify `LEGACY_OBSERVED`. Only `FLAVOR` is verified against actual legacy data (Phase B). Every entry below states its evidence classification, exact evidence source, evidence location, approval status, and blocker status as separate fields.

| Proposed value | Evidence classification | Exact evidence source | Evidence location | Approval status | Blocker status |
|---|---|---|---|---|---|
| Raw Material | **UNRESOLVED** | `category-classification.ts` `CATEGORY_CANDIDATE_MAP` proposes `IngredientCategory.RAW` → `"Raw Material"` — this is classifier source code, not a verified legacy record | `apps/api/src/modules/inventory-migration/category-classification.ts:9` | UNRESOLVED | Not apply-eligible; needs operator approval or a verified legacy-data report before any classification above UNRESOLVED |
| Flavor | **LEGACY_OBSERVED** | Phase B verified-evidence list: legacy category `FLAVOR` observed in actual legacy data | `docs/decisions/CR-006-phase-b-migration-source-inventory.md` (Phase B verified evidence); also proposed in `category-classification.ts:10` | UNRESOLVED (evidence classification alone is not approval) | Not apply-eligible until operator approval |
| Packaging | **UNRESOLVED** | `category-classification.ts` proposes `CUP`, `BAG`, `PACKAGING` → `"Packaging"` — classifier source code, not a verified legacy record | `apps/api/src/modules/inventory-migration/category-classification.ts:11-13` | UNRESOLVED | Not apply-eligible; categorization of cups/tissues as Packaging vs. a separate Consumable bucket is additionally undecided (§5) |
| Other | **UNRESOLVED** | `category-classification.ts` proposes `IngredientCategory.OTHER` → `"Other"`, and the code itself sets `unresolved: true` on this candidate | `apps/api/src/modules/inventory-migration/category-classification.ts:14` | UNRESOLVED | Not apply-eligible; Phase B's own code already marks this unresolved — do not auto-promote |
| Consumable | **UNRESOLVED** | No legacy category, no classifier-code proposal, no verified recipe file maps to this value — the prompt names it only as an illustrative example | None found | N/A | **NOT PROPOSED** — no evidence exists to justify creating this row now |

No category row above is ready for apply. Only `Flavor` carries `LEGACY_OBSERVED` status; the rest are `UNRESOLVED` and require either explicit `OPERATOR_APPROVED` sign-off or a verified legacy-data report before they may advance. None was invented by this document, and no `UNRESOLVED`/`RECIPE_OBSERVED` entry may be silently promoted to `OPERATOR_APPROVED` by tooling — promotion happens only via a recorded operator decision (see Gate -1 and Task RC1).

---

## 3. Unit manifest (proposed, pending operator approval — none created by this document)

Same C0.1 correction as §2 applies: appearing in `unit-classification.ts` is classifier source code, not a verified legacy record. Only `grams` is verified against actual legacy data (Phase B). No recipe file was found or inspected (§0), so **no entry qualifies as `RECIPE_OBSERVED`** — prompt-described recipe usage is recorded as unverified context only, not evidence.

| Proposed value | Dimension | `isBaseUnit` | Code | Evidence classification | Exact evidence source | Evidence location | Approval status | Blocker status |
|---|---|---|---|---|---|---|---|---|
| gram | WEIGHT | true | **UNRESOLVED** | **LEGACY_OBSERVED** | Phase B verified-evidence list: legacy unit `grams` observed in actual legacy data; also proposed in `unit-classification.ts:5-6` | `docs/decisions/CR-006-phase-b-migration-source-inventory.md`; `apps/api/src/modules/inventory-migration/unit-classification.ts:5-6` | UNRESOLVED | Not apply-eligible — no `code` supplied (schema requires unique, non-null, non-derived) |
| kilogram | WEIGHT | false | **UNRESOLVED** | **UNRESOLVED** | `unit-classification.ts` proposes `kilogram`/`kg` — classifier source code only, no verified legacy record | `apps/api/src/modules/inventory-migration/unit-classification.ts:8-10` | UNRESOLVED | Not apply-eligible |
| liter | VOLUME | true | **UNRESOLVED** | **UNRESOLVED** | `unit-classification.ts` proposes `liter`/`litre`/`l` — classifier source code only | `apps/api/src/modules/inventory-migration/unit-classification.ts:11-15` | UNRESOLVED | Not apply-eligible |
| milliliter | VOLUME | false | **UNRESOLVED** | **UNRESOLVED** | `unit-classification.ts` proposes `milliliter`/`ml` — classifier source code only | `apps/api/src/modules/inventory-migration/unit-classification.ts:16-18` | UNRESOLVED | Not apply-eligible |
| piece | COUNT | true | **UNRESOLVED** | **UNRESOLVED** | `unit-classification.ts` proposes `piece`/`pieces`/`pc`/`pcs` — classifier source code only; prompt's cups/tissues-as-pieces description is unverified | `apps/api/src/modules/inventory-migration/unit-classification.ts:19-22` | UNRESOLVED | Not apply-eligible |
| tablespoon | UNRESOLVED | — | — | **UNRESOLVED — and blocked** | Not present in `KNOWN_GLOBAL_UNIT_SYNONYMS` or `KNOWN_PACKAGE_UNITS`; Phase B's own code classifies it `UNKNOWN`. Prompt's flavor-tablespoon description is unverified operator prose, not a repository-confirmed source | `apps/api/src/modules/inventory-migration/unit-classification.ts` (absence confirmed); no recipe file found (§0) | UNRESOLVED | **BLOCKED — NOT PROPOSED for creation in Phase C0** (see §6) |
| kraft bag (any fraction) | UNRESOLVED | — | — | **UNRESOLVED — and blocked** | `unit-classification.ts:25-29` classifies `bag`/`bags` as `ITEM_SPECIFIC_PACKAGE_UNIT`, explicitly blocked with reason "requires an explicit per-item conversion; none is created in Phase B"; the 1/2, 1/4, 1/8 fractional description is unverified operator prose | `apps/api/src/modules/inventory-migration/unit-classification.ts:25-29`; no recipe file found (§0) | UNRESOLVED | **BLOCKED — NOT PROPOSED for creation in Phase C0** (see §5) |
| sachet | UNRESOLVED | — | — | **UNRESOLVED unless verified legacy evidence exists** | `unit-classification.ts:27` lists `sachet`/`sachets` in `KNOWN_PACKAGE_UNITS` — classifier source code only; no confirmed `Ingredient.unit` occurrence, no live-DB access this session | `apps/api/src/modules/inventory-migration/unit-classification.ts:27` | UNRESOLVED | **NOT PROPOSED** — illustrative only, no confirmed occurrence |

No unit row above is ready for apply. Only `gram` carries `LEGACY_OBSERVED` status; every other row is `UNRESOLVED`, and `tablespoon`/kraft-bag units are additionally blocked pending §5/§6 operator decisions. **Every unit additionally lacks a `code`** — the schema requires `UnitOfMeasure.code` to be unique and non-null, and this plan is barred from deriving one by uppercase transform or by guessing from the name. An operator must supply codes explicitly (e.g., against a named standard, or an arbitrary but declared internal convention) before any unit manifest entry is apply-eligible. No `UNRESOLVED` entry may be silently promoted to `OPERATOR_APPROVED` by tooling.

**Precision note:** the prompt asks for "decimal precision" per unit. `UnitOfMeasure` has no precision/scale column in the current schema (`schema.prisma:802-818`) — only `UnitConversion.factor` carries an explicit `@db.Decimal(18,8)`. Rounding/precision for entered quantities is therefore not a `UnitOfMeasure` schema concern today; if the business needs per-unit input precision, that is a schema gap outside Phase C0's authority to add (would require a migration, explicitly out of scope) and is recorded as **UNRESOLVED / architectural gap for a future CR**, not worked around here.

---

## 4. Fractional packaging review (required operator decision — not resolved by this plan)

The recipe-sheet description (unverified file) states kraft bag quantities of 1/2, 1/4, 1/8. Per the prompt's own five candidate interpretations, evidence found in this repository is insufficient to choose among them:

| Candidate interpretation | Evidence for | Evidence against |
|---|---|---|
| 1. Actual fractional consumption of one inventory item | Matches how `ProductFlavorSlot.flavorQty`/`unit` and `ProductInventory.quantityRequired`/`unit` already store arbitrary decimal quantities against a `unit` string (`schema.prisma:660-670`, `706-722`) — the schema has no structural objection to a fractional `ProductComponent` quantity once that model is reworked (CR-007 §20.6, not Phase C0) | No confirmed base unit for "1 kraft bag" (grams? pieces?) exists anywhere in schema or code |
| 2. One bag shared across multiple orders | No supporting code/schema evidence found (no shared-resource or partial-consumption-tracking concept exists anywhere in the inventory domain) | — |
| 3. Packaging bundle with its own item identity | Plausible under CR-007's `InventoryItem` model (any physical thing can be its own item), but nothing in Phase B/Phase C documents proposes splitting kraft bags into sub-units | — |
| 4. Data-entry convention requiring conversion | `unit-classification.ts:90-97` already flags `bag` as `ITEM_SPECIFIC_PACKAGE_UNIT` requiring "an explicit per-item conversion" — consistent with this candidate, but the actual gram-or-piece weight of "1 kraft bag" is not present anywhere in the repository | — |
| 5. Unresolved business logic | Directly supported: no CR, schema comment, or code path resolves this; Phase B explicitly declines to guess (`blockingReason` on `ITEM_SPECIFIC_PACKAGE_UNIT`) | — |

**Decision required from the operator before Phase C0 apply mode may include any kraft-bag-related unit or conversion:** which of the five interpretations applies, and if (1) or (4), the exact base unit and per-bag conversion factor from an authoritative source (a supplier spec sheet, a measured weight, or an explicit business decision — not inferred). **No conversion or unit is created to paper over this gap.** Until answered, kraft-bag-related `ProductComponent` rows (a later phase, not Phase C0) remain blocked on an `InventoryItem` that itself cannot be created because its `baseUnit` is undetermined.

---

## 5. Tablespoon review (required operator decision — not resolved by this plan)

The prompt's unverified recipe-sheet description (no such file exists in this repository — §0) of tablespoon-based flavor quantities presents the same three options the prompt lists:

- **Canonical volume unit** — defensible only if every flavor powder is assumed to have the same density, which is not demonstrated anywhere in this repository and is explicitly the wrong assumption per the prompt ("do not assume that one tablespoon has the same gram weight for every flavor powder").
- **Converted to grams via flavor-specific `UnitConversion`** — `UnitConversion` as currently modeled (`schema.prisma:824-838`) is a **global, unqualified** `fromUnitId`/`toUnitId`/`factor` table with **no item/flavor-scoping column** (no `inventoryItemId` FK). Storing a flavor-specific tablespoon→gram factor here would silently apply that one flavor's density to *every* tablespoon-to-gram conversion platform-wide — the schema's own comment (`schema.prisma:820-822`) says this table "does NOT model variable packaging conversions... those have no universal factor and belong on a future item-specific... attach point, not here." The same reasoning applies to a flavor-specific density factor. **This plan does not create a `UnitConversion` row for tablespoon→gram for this reason**, independent of whether a specific flavor's weight is known.
- **Treated as unresolved until measured weight standards are approved** — the only option consistent with current schema capability and the "no item-specific conversions as universal" constraint.

**Decision required from the operator:** either (a) commission or supply per-flavor measured tablespoon gram weights and route them through a future item-specific conversion mechanism (schema change, out of scope here), or (b) record tablespoon as a `UnitOfMeasure` with `dimension=VOLUME` for authoring convenience only, with explicit acknowledgment that no automatic gram conversion exists and recipe/`ProductComponent` authoring for flavor slots must enter grams directly until (a) is resolved. **Neither is decided by this document.** No `tablespoon` row is included in the apply-eligible unit manifest (§3).

---

## 6. UnitConversion recommendation

| From | To | Factor | Universal / item-specific | Evidence classification | Exact evidence source | Precision | Rounding | Approval status |
|---|---|---|---|---|---|---|---|---|
| kilogram | gram | 1000 | Universal | **ARCHITECTURE_REQUIRED** | Schema comment `schema.prisma:799-801,820-822` explicitly names kg↔g as the intended universal-conversion use case; arithmetic fact, not business data | `Decimal(18,8)` column, value `1000.00000000` | None needed (exact) | **UNRESOLVED pending §3's kilogram/gram unit approval** — conversion cannot be created before both units exist |
| liter | milliliter | 1000 | Universal | **ARCHITECTURE_REQUIRED** | Same schema comment; arithmetic fact | `Decimal(18,8)`, `1000.00000000` | None needed (exact) | **UNRESOLVED pending §3's liter/milliliter unit approval** |
| tablespoon | gram | — | Item-specific (if ever created) | **UNRESOLVED — blocked** | No authoritative measured value found in this repository | n/a | n/a | **BLOCKED — see §5, not created in Phase C0** |
| any → kraft bag / kraft bag → any | — | — | Item-specific (if ever created) | **UNRESOLVED — blocked** | No authoritative measured value found | n/a | n/a | **BLOCKED — see §4, not created in Phase C0** |

Only the two universal, dimensionally-exact conversions are even candidates for Phase C0 apply mode, and both remain gated behind their prerequisite unit rows being operator-approved first — this document creates neither the units nor the conversions itself.

---

## 7. Initialization mechanism design

A new module, **not** the existing `inventory-migration` module (that module owns legacy `Ingredient`→`InventoryItem` migration per Phase B/C; reference-data initialization is a distinct concern with a distinct lifecycle and must not be conflated with it):

`apps/api/src/modules/inventory-reference-init/`

- `manifest.schema.ts` — Zod schema for the manifest file shape (versioned).
- `manifests/v1.manifest.json` — the actual proposed-row data (created empty/draft in this plan; populated with operator-approved values only after this document is approved — **not populated by this plan**).
- `manifest-loader.ts` — loads + validates a manifest file against the Zod schema; rejects on schema violation or duplicate normalized names within the file itself.
- `category-matcher.ts` / `unit-matcher.ts` — pure functions implementing §9's duplicate-detection rules against live rows.
- `reference-init-plan.service.ts` — dry-run: pure function producing a `ReferenceInitPlan` (creates/reuses/conflicts/blockers), zero writes.
- `reference-init-apply.repository.ts` / `.service.ts` — the only write path; implements §11/§12.
- `reference-init-rollback.service.ts` — implements §13.
- `reference-init-report.ts` — structured report shared by plan/apply/rollback, written to `apps/api/reports/reference-init/<batchId>.json` (git-ignored, not committed — an audit artifact, not source).
- CLI scripts: `inventory-reference:plan`, `inventory-reference:apply`, `inventory-reference:rollback` in `apps/api/package.json`, mirroring the existing `inventory:migration:*` script family's flag conventions (`--batch`, `--confirm`).

**Dry-run mode:** read-only; loads manifest + live `InventoryCategory`/`UnitOfMeasure`/`UnitConversion` rows; for each manifest entry, classifies as `WILL_CREATE`, `WILL_REUSE` (exact compatible match found), `BLOCKED_AMBIGUOUS` (>1 compatible match), or `BLOCKED_INCOMPATIBLE` (same name/code, incompatible dimension/description); zero writes; deterministic given the same manifest + live-row snapshot.

**Apply mode:** requires `--manifest-version <v>`, `--batch <id>` (same `isValidMigrationBatchId`-style validator reused from `migration-batch.ts`, generalized or duplicated with an equivalent rule — not redefined ad hoc), `--target <db-alias>` (explicit, cross-checked against the project's existing three-URL safety rule in `.claude/CLAUDE.md`), and `--confirm`. Refuses to run with any manifest entry whose `approvalStatus` (a manifest-file field, not a DB column) is not `APPROVED`. Never reachable from the plan command.

---

## 8. Matching and duplicate rules

**`InventoryCategory`:**
- Normalize with `normalizeCategory` (trim, collapse whitespace, lowercase — reuse `normalization.ts`, do not reimplement).
- Reuse only if exactly one existing active-or-inactive row's normalized `name` matches.
- Block (do not reuse, do not create) if two or more existing rows fold to the same normalized name — a pre-existing data-quality problem, reported not resolved.
- Block if a same-normalized-name row exists but its `description` materially conflicts with the manifest's declared description in a way the operator flagged as incompatible in the manifest (manifest carries an explicit `incompatibleIfDescriptionDiffers: boolean` per row — default `false`, meaning description drift alone is not blocking unless the operator says it should be for that row).
- `code`, where present on both sides, must match exactly if both are non-null; a non-null-vs-null code on an otherwise-matching row is a warning, not a blocker (code is optional on this table per schema).

**`UnitOfMeasure`:**
- Primary identity is `code` (unique, required, authoritative) — never match on `name` alone, per this plan's own §3 constraint and the same discipline Phase C's `unit-resolution.ts` applies to *lookup* (this module governs *creation*, a different function, but the same "code over name" discipline applies since code is the DB-enforced unique key here).
- Exact `code` match → reuse only if `dimension` also matches; a same-code-different-dimension row is `BLOCKED_INCOMPATIBLE` (a genuine data-integrity conflict, never silently overwritten).
- No `code` match but `name` folds identically to an existing row → `BLOCKED_AMBIGUOUS` (surfaced for operator review, not auto-created under a different code, since two same-named units would be confusing even if technically distinct rows).
- `isBaseUnit` and `isActive` differences between manifest and an existing matched row are reported as warnings, never silently overwritten by apply mode (apply mode only **creates** missing rows or **reuses** exact matches; it never mutates an existing row's fields — an update is a separate, explicitly different operation this plan does not build).

**`UnitConversion`:**
- Identity is the `(fromUnitId, toUnitId)` pair (already `@@unique` in schema). Reuse if an exact pair exists regardless of stored `factor`; a manifest `factor` that disagrees with an existing row's `factor` is `BLOCKED_INCOMPATIBLE` (never silently overwritten — a factor correction is a distinct, explicitly-reviewed operation, not an implicit reference-init side effect).

Prefer the schema's own unique constraints (`UnitOfMeasure.code`, `UnitConversion.(fromUnitId, toUnitId)`) as the enforcement backstop; the matcher logic above is the *pre-check* that produces a clean report before relying on the DB constraint to catch anything the pre-check missed (e.g., a race).

---

## 9. Idempotency

| Scenario | Behavior |
|---|---|
| First execution | Creates all `APPROVED` manifest rows with no existing match; records each as `created` in the report |
| Rerun, same manifest version, same batch ID | Every previously-created row is found by exact match (§9) and marked `reused`; zero duplicate rows; report shows `created: 0` |
| Rerun, same manifest version, different batch ID | Identical outcome to above — batch ID is run metadata, not a scope filter (mirrors Phase C's own §7 principle for the identity migration) |
| Rerun with a different (newer) manifest version | New rows added by the new version are evaluated fresh (create/reuse/block per §9); rows already created by a prior version's apply are found and reused, never duplicated, since matching is by category/unit identity, not by manifest version |
| Existing compatible row (created outside this tool, e.g. manually) | Reused, never duplicated, never flagged as an error — §9's matcher runs unconditionally, not only against rows this tool itself created |
| Existing incompatible row (e.g. same unit code, different dimension) | `BLOCKED_INCOMPATIBLE`; that single manifest entry fails, its transaction (per §10) rolls back independently, other entries proceed |
| Partially applied initialization (process killed mid-run) | Per §10's per-reference-type transaction boundary, at most one reference type (categories, or units, or conversions) is left incomplete; a rerun of the same manifest+batch resumes cleanly because every already-committed row is found and reused |
| Concurrent execution | A single coarse Postgres advisory lock (`pg_advisory_lock(hashtext('cr006-reference-init-apply'))`), held for the whole apply run and released in a `finally` — identical pattern to Phase C plan §7's coarse lock — serializes concurrent apply invocations entirely; the second waits, then finds everything already created and reuses it (a safe, idempotent no-op) |

---

## 10. Transaction strategy

**Chosen: one transaction per reference type** (all category rows in one `prisma.$transaction`, then all unit rows in one, then all conversion rows in one — never per-record, never one single transaction spanning all three types).

- **Full-manifest single transaction rejected:** conversions depend on units existing (a `UnitConversion` needs both `fromUnitId`/`toUnitId` already resolved), so categories/units must commit before conversions can even be evaluated against live IDs within the same run — a single all-encompassing transaction can't express "resolve units, then use their real IDs for conversions" without either two round-trips inside one transaction (fine) or artificially deferring conversion evaluation to a second invocation (worse). Splitting by type keeps this dependency explicit and lets a units failure abort before conversions are attempted, without an artificial two-invocation workflow.
- **Per-record transaction rejected:** would allow "3 of 4 categories created, 4th failed" to persist as final state with no atomic all-or-nothing guarantee at the type level, contradicting the prompt's explicit "avoid leaving categories initialized but required units missing unless explicitly recoverable and reported" — per-type atomicity means a units failure is reported as a whole (recoverable: rerun after fixing the manifest) rather than as a partial, hard-to-diagnose subset.
- Per-reference-type is the smallest boundary that (a) guarantees "all approved categories exist, or none of this run's new ones do" as one atomic fact, (b) still allows categories to succeed independently of a units failure (explicitly recoverable and reported, satisfying the prompt's stated exception), and (c) respects the units-before-conversions dependency without a multi-invocation workaround.

---

## 11. Rollback strategy

**C0.1 correction:** the previous version of this section scoped rollback entirely by an on-disk audit report (§7) written under `apps/api/reports/reference-init/<batchId>.json`. That file can be deleted, moved, altered, or become inconsistent with the database — it is not a durable provenance record, so it cannot ground a claim of *guaranteed* automatic rollback. This plan now names one explicit strategy rather than presenting the old on-disk-report design as if it gave the same guarantee as durable provenance.

**Chosen strategy: Durable Initialization Audit Model, via a separate approved CR.** See the **Gate -1** section immediately below for the full rationale, the conceptual `InitializationRun`/`InitializationRecord` design, and the blocking rule. Until that CR is approved and implemented:

- **Automatic rollback is NOT supported.** No tool built under this plan may claim batch-scoped automatic rollback.
- The on-disk report described in §7 may still be produced (it is a useful diagnostic), but any tool that reads it for deletion purposes must be named **rollback assessment** or **rollback assistance**, never "rollback," and must operate under every restriction below.
- **Rollback-assistance rules (interim, until Gate -1 is resolved):**
  - A retained, signed audit artifact is required as an assistance input — an on-disk report alone, with no signature/fingerprint and no durability guarantee, is not sufficient basis for deletion.
  - Manual database verification is required before any deletion — the assistance tool proposes candidates, it does not execute unattended deletion.
  - Live dependency checks are required at assistance time: any row referenced by `InventoryItem.categoryId` / `InventoryItem.baseUnitId` / `UnitConversion.fromUnitId` / `UnitConversion.toUnitId`, checked against current data, not the stale report.
  - Deletion is prohibited whenever provenance cannot be proven (e.g., the report is missing, unsigned, or disagrees with a live re-scan).
  - Deletion of a row the assistance tool determines was `reused` (i.e., pre-existed before the run) is prohibited, regardless of current reference count.
  - Deletion of any row with a live downstream reference is prohibited.
  - Operator confirmation is required per deletion, individually — never a single batch-wide confirmation standing in for every row.
  - No tool, script, CLI help text, or task description may say "automatic rollback," "batch-scoped rollback," or otherwise imply an unattended, guaranteed undo.
- **Dependency/ordering guidance carried forward for the assistance tool** (unchanged from the prior draft, now explicitly advisory rather than a guarantee): conversions checked first (nothing depends on a `UnitConversion` row), then units, then categories — child-before-parent by FK direction. Deletion order within a type is irrelevant; each type's proposed deletions are still grouped for review, not executed automatically.
- Git revert is insufficient once rows are written (data, not code); rollback assistance is exclusively a data operation, run via its own CLI command, never implied by reverting a commit.

**Task-plan effect:** Task RC7 (apply-mode write path, formerly RC6) and Task RC8 (rollback tooling, formerly RC7) may not be implemented until Gate -1 resolves per one of its two branches. See the renumbered task list.

---

## Gate -1 — Durable provenance decision (blocks Phase C0 apply implementation)

**Status: unresolved. This gate must pass before any Phase C0 apply-mode or rollback-mode code (Tasks RC7, RC8) is written.**

The insufficiency this gate addresses: relying solely on the on-disk audit report from §7 to identify which rows a given run created means rollback correctness depends on a file that can be deleted, moved, edited, or drift from the database — no automatic, guaranteed-correct rollback can be built on that foundation alone.

**Preferred strategy — Durable Initialization Audit Model (recommended):**

Before Phase C0 apply-mode tooling (RC7) or rollback tooling (RC8) is implemented, a separate architectural change request must be raised and approved, proposing durable, database-backed provenance tables. Conceptual shape (names and fields are conceptual — no Prisma schema change is made by this plan or by raising the CR):

`InitializationRun`:
- `id`
- `migrationBatch`
- `manifestVersion`
- `targetEnvironment`
- `executionMode`
- `status`
- `startedAt`
- `completedAt`
- `initiatedBy`
- `reportFingerprint`

`InitializationRecord`:
- `id`
- `initializationRunId`
- `entityType`
- `entityId`
- `action`
- `createdByRun`
- `reusedExisting`
- `preexistingFingerprint`
- `resultingFingerprint`
- `rollbackStatus`
- `rolledBackAt`

This gives rollback a queryable, durable source of truth instead of a deletable file, and lets "was this row created by this run, and is it still unreferenced" be answered from the database itself.

**Alternative strategy — No automatic rollback (fallback only, not chosen unless stakeholders reject the above):**

If no durable audit model is ever introduced, the plan must instead: state plainly that automatic rollback is unsupported; rename all rollback tooling to rollback assessment / rollback assistance; require a retained signed audit artifact; require manual database verification; require live dependency checks; require operator confirmation per deletion; prohibit deletion when provenance cannot be proven; prohibit deletion of compatible reused records; prohibit deletion of records with downstream references; and never claim batch-scoped automatic rollback anywhere in code, CLI help text, or documentation.

**These two strategies are not mixed.** Exactly one governs. This plan's preferred choice is the durable audit model above; the interim §11 rules apply only until that CR is approved and implemented, at which point RC7/RC8 are built against the durable model instead of the report-only design.

**Gate -1 passes when either:**
- **(A)** the durable initialization audit architecture above is proposed as its own CR and approved, or
- **(B)** stakeholders explicitly approve "no automatic rollback" and sign off on manual-only rollback-assistance per the alternative strategy.

Neither (A) nor (B) has occurred as of this corrective pass. Gate -1 is **open**.

---

## 12. Pre-apply gates

**-1. Gate -1 (durable provenance decision) has passed** — see the Gate -1 section above. Apply mode (RC7) is not reachable while Gate -1 is open, independent of gates 0–16 below.

0. Manifest file loaded and schema-valid (§7's Zod schema) with an explicit `manifestVersion`.
1. Every manifest row has `approvalStatus: "APPROVED"` set by an operator — rows left `UNRESOLVED`/`PENDING` in the manifest are skipped for this run, not defaulted to approved.
2. Every proposed category has a cited `source` and `evidence` field populated (schema-enforced — a row without both fails manifest validation, not just a lint warning).
3. Every proposed unit has an authoritative `code` supplied (non-derived, per Global Constraints) and a `dimension` supplied.
4. No unresolved duplicate identity: dry-run (§7) has been run against the exact manifest+batch being applied and reports zero `BLOCKED_AMBIGUOUS`/`BLOCKED_INCOMPATIBLE` entries among the rows being applied.
5. No unapproved `UnitConversion` entries are present with `approvalStatus != "APPROVED"`.
6. Fractional-packaging interpretation (§4) is explicitly resolved-or-excluded in the manifest (no kraft-bag-related unit is present unless §4 has a recorded decision reference).
7. Tablespoon strategy (§5) is explicitly resolved-or-deferred in the manifest (no tablespoon-to-gram conversion is present under any circumstance per §5; a bare `tablespoon` volume unit is only present if the manifest records the explicit acknowledgment required by §5(b)).
8. Explicit `--target` database alias supplied and cross-checked against `.claude/CLAUDE.md`'s three-URL rule.
9. Pre-apply row counts captured for all three destination tables.
10. `--batch <id>` supplied and passes the batch-ID validator.
11. `--manifest-version` supplied and matches the loaded manifest file's own declared version (protects against applying a stale in-memory copy against a newer on-disk manifest).
12. Explicit `--confirm` flag present (no default/implicit confirm).
13. No unresolved duplicate identities (restates #4 for the required-list format) — zero blockers in the freshly-regenerated dry-run.
14. No concurrent reference-init process holding the coarse advisory lock (§9).
15. Rollback procedure (§11) available/understood before the operator is allowed to pass `--confirm` (documentation gate, enforced by the CLI printing the rollback command and requiring a second explicit acknowledgment flag, e.g. `--acknowledge-rollback-reviewed`).
16. Pre-apply gate report printed and logged before any write begins.

---

## 13. Recipe coverage cross-check (context only — no `ProductComponent` rows created)

Per the prompt's own description of the recipe sheet (file unverified — see §0), the following component-unit patterns are recorded so the category/unit manifest is checked for forward-compatibility with the later product-recipe phase. **None of the rows below are created by Phase C0.**

| Recipe component pattern | Unit needed | Category needed | Manifest coverage today |
|---|---|---|---|
| Fries, measured in grams | gram | Raw Material (or Flavor, if flavor-coated) | Covered by §3/§2 proposed rows, pending approval |
| Chicken Pops, measured in grams | gram | Raw Material | Same |
| Loopys, measured in grams | gram | Raw Material | Same |
| Flavor powder quantities, measured in tablespoon fractions | tablespoon | Flavor | **Not covered** — blocked on §5 |
| Cups, measured as pieces | piece | Packaging (or Consumable — undecided, §2) | Covered for unit; category bucket undecided |
| Tissues, measured as pieces | piece | Packaging (or Consumable — undecided, §2) | Same |
| Kraft bag quantities, currently fractional | **undetermined** | Packaging | **Not covered** — blocked on §4 |

This table exists to demonstrate the manifest's proposed scope is sufficient for the *known* non-blocked patterns and to make the two open blockers (§4, §5) visible against real product context. It is unverified context to inform the operator decisions in §4/§5 (Task RC1) — not verified evidence, and not a specification of `ProductComponent` rows.

---

## 14. Test plan

All tests are pure-function/unit tests against the new `inventory-reference-init` module; none require a live database (mocked Prisma client, same convention as `apps/api/src/modules/inventory-migration/*.test.ts`).

| Required test | Covered by task |
|---|---|
| Compatible category creation (no existing match) → `WILL_CREATE` | RC6 |
| Compatible category reuse (exact normalized-name match) → `WILL_REUSE` | RC6 |
| Ambiguous category block (two existing rows fold to same name) → `BLOCKED_AMBIGUOUS` | RC4, RC6 |
| Incompatible category block (operator-flagged description conflict) → `BLOCKED_INCOMPATIBLE` | RC4, RC6 |
| Compatible unit creation → `WILL_CREATE` | RC5, RC6 |
| Compatible unit reuse (exact code match, same dimension) → `WILL_REUSE` | RC5, RC6 |
| Duplicate unit code block (code matches, dimension differs) → `BLOCKED_INCOMPATIBLE` | RC5 |
| Unit dimension conflict block | RC5 |
| Unit precision conflict block | RC5 — asserts no precision field is read/written (schema has none, §3); test documents this as an intentional no-op rather than a silent gap |
| No synthesized unit codes | RC2 — manifest schema rejects a row whose `code` field is auto-derived (test constructs a loader call with `code` omitted and asserts a validation error, never a fallback-generated code) |
| Unresolved manifest entries block apply | RC2, RC7 |
| Dry-run performs zero writes | RC6 — asserts no write-capable Prisma method is ever invoked from the dry-run module (same style as Phase C's C6 test / Phase B's migration-source repository test) |
| Apply requires explicit confirmation | RC9 |
| Rerun is idempotent | RC7 |
| Partial failure rolls back (one reference type's transaction fails, others' results are independently reported) | RC7 |
| Concurrent duplicate initialization is prevented | RC7 (advisory lock, simulated) |
| Pre-existing records are never marked as created | RC6, RC7 |
| Rollback deletes only eligible created records | RC8 |
| Referenced canonical records cannot be deleted | RC8 |
| Recipe-described units are reported but not automatically approved | RC3 — a unit appearing only in the recipe-coverage cross-check (§13) with no `LEGACY_OBSERVED`/`ARCHITECTURE_REQUIRED` evidence is reported as a gap, never auto-added to the manifest with `approvalStatus: "APPROVED"` |
| RC7/RC8 write paths are not reachable while Gate -1 is open | RC0, RC7, RC8 — a structural/import-graph or CI check asserting apply-mode and rollback-mode entrypoints refuse to run (or are unimplemented) until Gate -1 records an (A)/(B) resolution |

---

## Tasks

Task order changed by the C0.1 corrective pass: provenance architecture (RC0) and manifest finalization (RC1) now precede all schema/tooling tasks, since write-path tasks (RC7, RC8) cannot begin until RC0's Gate -1 resolves, and no manifest entry is apply-eligible until RC1 records operator approval.

### Task RC0 — Resolve durable provenance architecture

**Objective:** Produce and route for approval the separate CR proposing the durable `InitializationRun`/`InitializationRecord` audit model described in the Gate -1 section, OR obtain explicit stakeholder sign-off on the "no automatic rollback" alternative. This task is documentation/CR-drafting only — no Prisma schema change, no code, no data write.

**Files:**
- Create: `docs/decisions/CR-008-durable-initialization-audit-model.md` (draft CR, status `PROPOSED`; conceptual `InitializationRun`/`InitializationRecord` fields per the Gate -1 section; no Prisma migration attached)

**Steps:**
1. Draft the CR with the conceptual field list from Gate -1, its rationale (on-disk reports are deletable/alterable and cannot ground automatic rollback), and its relationship to Phase C0's existing report-based design (superseding it, not layering on top of it).
2. Route the CR for stakeholder approval outside this document's authority (a human act, not a plan step this task can complete itself).
3. Record the outcome — approved as durable audit model (A), or stakeholders explicitly chose manual-only rollback-assistance (B) — as the resolution of Gate -1. Update the Gate -1 section's "Status" line to reflect the resolution once it occurs (a documentation update, not part of this task's initial execution).

**Tests:** N/A (documentation/CR artifact, not code).

**Validation command:** manual review — confirm the CR names both `InitializationRun` and `InitializationRecord` conceptual field lists verbatim from Gate -1, and that its status is `PROPOSED` (not silently marked `APPROVED` by this task itself).

**Rollback consideration:** N/A — a document, not a data write.

**Stop condition:** if this task attempts to write a Prisma migration, mark the CR `APPROVED` unilaterally, or implement any part of RC7/RC8 before Gate -1 resolves — stop, that violates Gate -1's blocking rule.

**Architectural reference:** Gate -1 section; §11.

---

### Task RC1 — Finalize operator-approved canonical manifest

**Objective:** Obtain explicit operator review of every §2/§3/§6 manifest entry's evidence classification, and record the two open decisions (§4 fractional kraft-bag packaging, §5 tablespoon handling) in a durable, dated decision document. Supersedes and subsumes the former "operator decision record" task — no entry may be promoted to `OPERATOR_APPROVED` except by an explicit, attributed operator action recorded here.

**Files:**
- Create: `docs/decisions/CR-006-phase-c0-operator-decisions.md` (template only — decision fields left blank/`PENDING` by this task; an operator fills them in as a separate, later act, not part of this plan's execution)

**Steps:**
1. Decision-record template contains, per §4 and §5: the five/three candidate options verbatim, a `Decision:` field (blank), a `Decided by:` field (blank), a `Decided on:` field (blank), and a `Supporting evidence:` field (blank, for whatever authoritative source — supplier spec, measured weight, business ruling — backs the decision). No option is pre-selected or defaulted.
2. For each §2/§3/§6 manifest row currently `UNRESOLVED`, the operator records, per row: approve (→ `OPERATOR_APPROVED`, with a named approver and date) or decline (stays `UNRESOLVED`/`NOT PROPOSED`). This plan does not perform this promotion itself — RC1 only creates the recording mechanism and the initial blank state.
3. No tooling built in RC2 onward may auto-promote a `RECIPE_OBSERVED`/`UNRESOLVED` entry to `OPERATOR_APPROVED` — approval is a manifest-file field an operator sets directly, never inferred or defaulted by any script.

**Tests:** N/A (documentation artifact, not code) — validation is a human review confirming no field was pre-filled with a guessed answer or silently defaulted to approved.

**Validation command:** manual review — grep the created file for `Decision:` and confirm every instance is followed by `PENDING`, never a filled-in value; grep the manifest for `OPERATOR_APPROVED` and confirm each occurrence has a paired named approver, never introduced by this task itself.

**Rollback consideration:** N/A — a document, not a data write; deleting the file if unwanted requires no data rollback.

**Stop condition:** if drafting this template requires pre-selecting an answer to make the rest of the plan coherent — stop; the plan must remain coherent with all decision fields open (it does, since §2/§3/§13 already treat unresolved/blocked entries as `NOT PROPOSED`/`UNRESOLVED`).

**Architectural reference:** §2, §3, §4, §5.

---

### Task RC2 — Manifest schema and validator

**Objective:** Define the versioned manifest file shape and its Zod validator, enforcing Global Constraints structurally (no auto-derived codes, required source/evidence fields, required approval status).

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/manifest.schema.ts`
- Create: `apps/api/src/modules/inventory-reference-init/manifest.schema.test.ts`
- Create: `apps/api/src/modules/inventory-reference-init/types.ts` (`CanonicalReferenceManifest`, `ManifestCategoryEntry`, `ManifestUnitEntry`, `ManifestConversionEntry`, `ApprovalStatus = 'APPROVED' | 'UNRESOLVED'`, `SourceClassification = 'ARCHITECTURE_REQUIRED' | 'LEGACY_OBSERVED' | 'RECIPE_OBSERVED' | 'OPERATOR_APPROVED'`)

**Steps:**
1. Define `ManifestCategoryEntry`: `name`, `code: string | null`, `description`, `isActive`, `source: SourceClassification`, `evidence: string` (required, min length 1), `approvalStatus: ApprovalStatus`, `incompatibleIfDescriptionDiffers: boolean`.
2. Define `ManifestUnitEntry`: `name`, `code: string` (required — schema-level required, no default/derivation), `dimension: 'WEIGHT' | 'VOLUME' | 'COUNT'`, `isBaseUnit`, `isActive`, `source`, `evidence`, `approvalStatus`.
3. Define `ManifestConversionEntry`: `fromUnitCode`, `toUnitCode` (references by code, not id — ids don't exist until units are applied), `factor: string` (decimal-safe string, not `number`), `source`, `evidence`, `approvalStatus`.
4. Zod-validate: `evidence` non-empty; `code` on units non-empty and not equal to `name.toUpperCase()`/`name.toLowerCase()` transformed trivially (a heuristic guard against the "derived by uppercasing" mistake — flags, does not silently fix); no two entries of the same type share a normalized name or code within the file itself.

**Tests:** valid manifest parses; missing `evidence` on any entry fails; a unit `code` equal to the uppercased `name` fails with the derived-code guard; two categories with the same folded name in one file fails; `approvalStatus` missing defaults to nothing (must be explicit — no default value in the schema).

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/manifest.schema.test.ts`

**Rollback consideration:** N/A — schema/type definitions only, no writes.

**Stop condition:** if any test requires allowing a code to be silently derived from a name — stop, that violates the Global Constraints and needs explicit re-scoping, not a workaround.

**Architectural reference:** Global Constraints; §3, §7.

---

### Task RC3 — Draft manifest assembly report (read-only)

**Objective:** Cross-reference Phase B's own classification functions (`classifyLegacyCategories`, `classifyLegacyUnits`) against this plan's §2/§3 tables to produce a `DraftManifestGapReport` — what's sourced-and-ready-for-operator-review vs. what has zero evidence — without writing an approved manifest file (that remains a manual, operator-driven step).

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/draft-gap-report.ts`
- Create: `apps/api/src/modules/inventory-reference-init/draft-gap-report.test.ts`

**Steps:** Implement `buildDraftGapReport(categoryCandidates: CategoryCandidate[], unitClassifications: UnitClassificationEntry[]): DraftManifestGapReport` (importing types from `../inventory-migration/types.js` — read dependency only, no write coupling) producing: `sourcedCategoryProposals` (name + evidence pointer, `approvalStatus: 'UNRESOLVED'` always — this function never sets `APPROVED`), `sourcedUnitProposals` (same), `noEvidenceNames` (recipe-only terms like `tablespoon`/`kraft bag` with no Phase B classification backing — explicitly separated so they are never conflated with sourced proposals).

**Tests:** a `CategoryCandidate` with `unresolved: true` (Phase B's `OTHER`) appears in `sourcedCategoryProposals` but always with `approvalStatus: 'UNRESOLVED'` (never `APPROVED`, regardless of confidence); a `UnitClassificationEntry` with classification `ITEM_SPECIFIC_PACKAGE_UNIT` or `UNKNOWN` is routed to a `blockedUnitProposals` list, never `sourcedUnitProposals`; recipe-only terms not present in any Phase B classification list appear only in `noEvidenceNames`.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/draft-gap-report.test.ts`

**Rollback consideration:** N/A — pure/read-only.

**Stop condition:** if producing this report requires guessing an evidence pointer for a term absent from Phase B's classification code — stop and list it in `noEvidenceNames` instead.

**Architectural reference:** §0, §2, §3.

---

### Task RC4 — Category duplicate/normalization matcher

**Objective:** Implement §8's category matching rules as a pure function.

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/category-matcher.ts`
- Create: `apps/api/src/modules/inventory-reference-init/category-matcher.test.ts`

**Steps:** `matchCategory(entry: ManifestCategoryEntry, existing: { id: string; name: string; code: string | null; description: string | null }[]): CategoryMatchResult` (`{ status: 'WILL_CREATE' } | { status: 'WILL_REUSE'; existingId: string } | { status: 'BLOCKED_AMBIGUOUS'; matchedIds: string[] } | { status: 'BLOCKED_INCOMPATIBLE'; existingId: string; reason: string }`), using `normalizeCategory` from `../inventory-migration/normalization.js` (import, do not reimplement).

**Tests:** zero existing rows → `WILL_CREATE`; one folded match → `WILL_REUSE`; two folded matches → `BLOCKED_AMBIGUOUS` listing both; one folded match with `incompatibleIfDescriptionDiffers: true` and a differing description → `BLOCKED_INCOMPATIBLE`; one folded match with `incompatibleIfDescriptionDiffers: false` (default) and a differing description → `WILL_REUSE` (description drift alone is not blocking by default).

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/category-matcher.test.ts`

**Rollback consideration:** N/A — pure function.

**Stop condition:** if a test requires matching on anything other than the normalized `name` fold — stop, that contradicts §8.

**Architectural reference:** §8.

---

### Task RC5 — Unit duplicate/code matcher

**Objective:** Implement §8's unit matching rules (code-primary, dimension-checked) as a pure function.

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/unit-matcher.ts`
- Create: `apps/api/src/modules/inventory-reference-init/unit-matcher.test.ts`

**Steps:** `matchUnit(entry: ManifestUnitEntry, existing: { id: string; code: string; name: string; dimension: 'WEIGHT' | 'VOLUME' | 'COUNT' }[]): UnitMatchResult` (same result union shape as RC4). Match order: (1) exact `code` match — check `dimension` agreement, `BLOCKED_INCOMPATIBLE` on mismatch, else `WILL_REUSE`; (2) no code match, but `normalizeInventoryName`-folded `name` matches an existing row → `BLOCKED_AMBIGUOUS`; (3) no match at all → `WILL_CREATE`.

**Tests:** exact code + matching dimension → `WILL_REUSE`; exact code + different dimension → `BLOCKED_INCOMPATIBLE`; no code match but folded name matches → `BLOCKED_AMBIGUOUS`; no match at all → `WILL_CREATE`; never matches on name when a code match already resolved the entry (test asserts code check runs first and short-circuits).

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/unit-matcher.test.ts`

**Rollback consideration:** N/A — pure function.

**Stop condition:** if any test requires falling back to a name-only match when no code is supplied — stop; per Global Constraints every unit manifest entry has a required `code`, so this input shape should be structurally impossible (RC2's schema already enforces it) and the test instead documents that impossibility.

**Architectural reference:** §8, §3.

---

### Task RC6 — Dry-run plan builder

**Objective:** Combine a loaded manifest with live-row snapshots (queried, not written) through RC4/RC5 into a full `ReferenceInitPlan` — Phase C0's dry-run mode.

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-plan.service.ts`
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-plan.service.test.ts`

**Steps:** `buildReferenceInitPlan(manifest: CanonicalReferenceManifest, existingCategories: [...], existingUnits: [...], existingConversions: [...]): ReferenceInitPlan` — skips any entry with `approvalStatus !== 'APPROVED'` (recorded as `SKIPPED_UNAPPROVED`, not silently dropped from the report); for `APPROVED` entries, runs RC3/RC4 matchers; for conversion entries, additionally resolves `fromUnitCode`/`toUnitCode` against the plan's own just-computed unit decisions (a conversion referencing a unit that is itself `BLOCKED_*` is `BLOCKED_INCOMPATIBLE` with a reason citing the blocked unit) before checking the `(fromUnitId, toUnitId)` pair against existing conversions.

**Tests:** unapproved entry → `SKIPPED_UNAPPROVED`, not counted as create/reuse/block; conversion whose `fromUnitCode` matches a `BLOCKED_AMBIGUOUS` unit entry → itself blocked with a citing reason; full plan run touches zero write-capable Prisma methods (repository-level assertion mirroring `migration-source.repository.test.ts`'s style — the plan builder takes plain arrays, not a live Prisma client, making this structurally true, and the test documents that design choice); deterministic — same manifest + same existing-row snapshot → identical plan twice.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/reference-init-plan.service.test.ts`

**Rollback consideration:** N/A — pure function, no writes; the plan builder never accepts a live Prisma client, only arrays, as the structural guarantee against accidental writes.

**Stop condition:** if a conversion's unit dependency can't be resolved within the plan (e.g., ordering bug) — stop, do not default to `WILL_CREATE`.

**Architectural reference:** §7 (dry-run mode), §8, §10 (type-ordering dependency).

---

### Task RC7 — Apply-mode repository and service

**BLOCKED until Gate -1 resolves (see RC0).** This is the only write path in Phase C0 and may not be implemented while Gate -1 is open.

**Objective:** The only code path in Phase C0 that writes to the database — implements §10 (per-reference-type transactions), §9 (idempotent upsert-by-match), and the coarse advisory lock.

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-apply.repository.ts`
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-apply.service.ts`
- Create: matching `.test.ts` for each

**Steps:**
1. Repository: thin Prisma calls only — `createInventoryCategory`, `createUnitOfMeasure`, `createUnitConversion`, each taking already-validated fields, no business logic.
2. Service: `applyReferenceInitPlan(plan: ReferenceInitPlan, batchId: string): Promise<ApplyResult>` — acquire the coarse lock (`pg_advisory_lock(hashtext('cr006-reference-init-apply'))`) for the whole call, in a `finally`-released block; inside, run three sequential `prisma.$transaction` blocks in order (categories, then units, then conversions — per §10's dependency ordering), each committing all of that type's `WILL_CREATE` entries or rolling back that type alone on any failure within it; entries already `WILL_REUSE` are not written, only recorded in the result with their existing id.
3. On completion, write the audit report (RC8 dependency; or, once Gate -1 resolves to the durable model, write `InitializationRun`/`InitializationRecord` rows) recording exactly which category/unit/conversion IDs were `created` vs `reused` this run, keyed by `batchId`.

**Tests:** three approved categories with no existing match → one transaction, three creates, report lists all three as `created`; a units-transaction failure (simulated) leaves the already-committed categories transaction intact and reports the units failure distinctly; rerun with the same batch and manifest → zero creates, all `reused`; a `WILL_REUSE` entry never triggers a create call (mock assertion); concurrent calls (simulated via lock-acquisition mock) — second waits, then finds everything reused.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/reference-init-apply.service.test.ts`

**Rollback consideration:** covered by RC8's rollback-assistance tooling; this task's writes are exactly what RC8 must be able to identify (never automatically undo) per §11.

**Stop condition:** if a category-type transaction failure is found to also roll back an already-committed units transaction from the same run — stop, that violates the chosen per-type atomicity boundary (§10).

**Architectural reference:** §9, §10, §11 (report feeds rollback).

---

### Task RC8 — Rollback-assistance tooling

**BLOCKED until Gate -1 resolves (see RC0).** This task may not be implemented while Gate -1 is open. Once resolved, it is built against whichever branch Gate -1 selects — the durable `InitializationRun`/`InitializationRecord` model (preferred) or the manual-only rollback-assistance rules (fallback) — never the on-disk-report-only design this section previously assumed.

**Objective:** Implement §11's rollback-assistance rules as a report-driven, live-reference-checked candidate-deletion tool requiring manual operator confirmation per row. This tool never performs unattended automatic rollback and must not be named or documented as one.

**Files:**
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-rollback.repository.ts`
- Create: `apps/api/src/modules/inventory-reference-init/reference-init-rollback.service.ts`
- Create matching `.test.ts` for each

**Steps:**
1. `loadBatchReport(batchId)`: reads the RC7-written audit report (or, once Gate -1 resolves to the durable model, the `InitializationRun`/`InitializationRecord` data) from its durable/retained source — never an unsigned, unverified on-disk file alone.
2. `findLiveReferences(createdIds)`: queries `InventoryItem` for any row whose `categoryId`/`baseUnitId` is in the created-category/unit ID sets, and `UnitConversion` for any row whose `fromUnitId`/`toUnitId` is in the created-unit ID set — always live, never from the stale report.
3. `assessRollbackCandidates(batchId)`: for each created row (conversions, then units, then categories — per §11's ordering), skip and report any row found referenced by (2); present the rest as candidates requiring individual operator confirmation before deletion (never an automatic batch delete); return an assessment report with per-type before/after counts and a list of blocked (referenced) rows.

**Tests:** batch with no live references → all created rows presented as deletion candidates, `reused` rows never presented; a created unit referenced by a since-created `InventoryItem.baseUnitId` → that unit is excluded and reported, its sibling created categories/conversions with no references are still presented as candidates; a batch report listing a row `reused` (not `created`) is never a rollback candidate even if it happens to have zero references today; no code path deletes a row without a preceding individual per-row confirmation.

**Validation command:** `pnpm --filter @potato-corner/api exec vitest run src/modules/inventory-reference-init/reference-init-rollback.service.test.ts`

**Rollback consideration (of this task itself):** N/A — this task builds the rollback tool.

**Stop condition:** if any row is deleted without first checking live references at rollback time (vs. relying on the stale report) — stop, that violates §11's explicit "checks live, not from the stale report" rule.

**Architectural reference:** §11.

---

### Task RC9 — CLI entrypoints (plan / apply / rollback)

**Objective:** Wire RC6/RC7/RC8 into operator-facing commands enforcing every gate in §12. The apply and rollback entrypoints additionally refuse to run while Gate -1 is open (see RC0); the plan entrypoint is unaffected.

**Files:**
- Create: `apps/api/scripts/inventory-reference-plan.ts`
- Create: `apps/api/scripts/inventory-reference-apply.ts`
- Create: `apps/api/scripts/inventory-reference-rollback.ts`
- Modify: `apps/api/package.json` (+ `inventory-reference:plan`, `inventory-reference:apply`, `inventory-reference:rollback` scripts)

**Steps:** Plan script: loads a manifest path from `--manifest <path>` (required arg, no default file), runs RC5, prints the plan, exits non-zero if any `BLOCKED_*` entries exist among `APPROVED` rows. Apply script: requires `--manifest`, `--manifest-version`, `--batch`, `--target`, `--confirm`, and `--acknowledge-rollback-reviewed` (§12 gate 15); prints every gate from §12 with pass/fail before attempting any write; refuses to proceed if any required flag is missing or any gate fails. Rollback script: requires `--batch` and `--confirm`.

**Tests:** apply script exits non-zero and performs zero writes when `--confirm` or `--acknowledge-rollback-reviewed` is omitted; exits non-zero when `--manifest-version` doesn't match the loaded manifest's own declared version (§12 gate 11); plan script never imports or calls any write-capable repository function (import-graph assertion, same style as Phase C's C6 test).

**Validation command:** `pnpm --filter @potato-corner/api exec tsx scripts/inventory-reference-plan.ts --manifest src/modules/inventory-reference-init/manifests/v1.manifest.json` (safe to actually run — dry-run only, zero writes, even against a real target, since it never opens a write transaction).

**Rollback consideration:** N/A for the plan script; apply's writes are addressed only via the rollback-assistance script (RC8), never by reverting this task's code.

**Stop condition:** if the apply script's write path is reachable with any one of `--manifest-version`/`--batch`/`--target`/`--confirm`/`--acknowledge-rollback-reviewed` missing — stop, that violates §12.

**Architectural reference:** §7, §12.

---

## Self-review

- **Spec coverage:** every numbered prompt section (source-of-truth, category planning, unit planning, fractional packaging, tablespoon, unit conversion rules, seed/init design, execution modes, matching/duplicate rules, idempotency, transaction strategy, rollback strategy, pre-apply gates, recipe coverage, test plan) has a corresponding section (§0–§14, plus the new Gate -1 section) and, where it implies buildable tooling, a task (RC0–RC9).
- **Placeholder scan:** no "TBD"/"implement later" left in any task step; RC1's blank decision-record template fields are an intentional deliverable (an unfilled decision record), not a plan placeholder — the plan itself makes no decision it defers to a placeholder. RC0's CR is drafted as `PROPOSED`, never silently marked `APPROVED`.
- **Type consistency:** `ManifestCategoryEntry`/`ManifestUnitEntry`/`ManifestConversionEntry` (RC2) are the same names used by RC3's inputs, RC4/RC5's `entry` parameters, and RC6's `manifest.categories/units/conversions` fields; `CategoryMatchResult`/`UnitMatchResult` (RC4/RC5) share the same result-union shape consumed by RC6; `ReferenceInitPlan` (RC6) is the same type RC7's `applyReferenceInitPlan` consumes.
- **Provenance/rollback consistency (C0.1):** every reference to automatic rollback in the pre-corrective draft has been replaced with either "rollback assessment/assistance" language or an explicit BLOCKED-until-Gate -1 marker (RC7, RC8); no section claims batch-scoped automatic rollback is currently supported.
- **Evidence consistency (C0.1):** §2/§3/§6 evidence classifications now match only what §0 actually verifies (Phase B's `FLAVOR` category and `grams` unit); no classifier-source-code-only or unverified-prompt-only entry is marked `LEGACY_OBSERVED`/`RECIPE_OBSERVED`.

---

Plan revised by the Phase C0.1 corrective pass and saved to `docs/superpowers/plans/2026-07-27-cr006-phase-c0-canonical-reference-initialization.md`. Task count: 10 (RC0–RC9). No implementation occurred.
