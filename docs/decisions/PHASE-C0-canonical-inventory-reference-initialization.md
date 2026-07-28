# Phase C0 — Canonical Inventory Reference Initialization

**Status:** IMPLEMENTED (dry-run/apply/reconcile/rollback tooling built; **apply has not been executed** — no canonical rows exist in any database as a result of this work).

**Supersedes the pending state of** `docs/superpowers/plans/2026-07-27-cr006-phase-c0-canonical-reference-initialization.md` (Gate -1, previously open) — CR-009's durable `InitializationRun`/`InitializationRecord` model is now implemented and this package builds directly on it, per the operator's explicit canonical-value package supplied 2026-07-28.

## Scope

A deterministic, idempotent initialization package for:

1. `InventoryCategory` rows.
2. `UnitOfMeasure` rows.
3. Globally-valid `UnitConversion` rows (mass and volume only).

Module: `apps/api/src/modules/inventory-reference-init/`. Reuses CR-009's `initialization-audit` module unchanged (`InitializationRun`, `InitializationRecord`, fingerprinting, manifest-entry-key encoding, run lifecycle, advisory locking, record-writer CAS, reconciliation, rollback assessment, rollback execution) — no second seeding/initialization system was created.

## Data strategy (unchanged from the operator's instruction)

Current operational data is disposable test data. Legacy `Ingredient` migration (CR-006 Phase C) is intentionally **not** performed here — this package does not read or transform any legacy row. No existing data was deleted or modified. `FINAL-RESET` was not run and is out of scope for this task.

## Canonical records

**Manifest:** `phase-c0-canonical-inventory-reference-data`, version `1` (`apps/api/src/modules/inventory-reference-init/manifest.ts`).

**Categories** (8): `RAW_MATERIAL` (Raw Material), `FLAVORING` (Flavoring), `PACKAGING` (Packaging), `BEVERAGE` (Beverage), `CONSUMABLE` (Consumable), `CLEANING_SUPPLY` (Cleaning Supply), `EQUIPMENT` (Equipment), `OTHER` (Other).

**Units** (13): mass — `mg`/Milligram, `g`/Gram (base), `kg`/Kilogram; volume — `mL`/Milliliter, `L`/Liter (base); count — `pc`/Piece (base), `pack`/Pack, `box`/Box, `case`/Case, `sachet`/Sachet, `bottle`/Bottle, `cup`/Cup, `bag`/Bag. `UnitOfMeasure` has no `symbol` column (`schema.prisma:872-888`) — the manifest's `symbol` field is display-only, never written to the database.

**Conversions** (6, all `ARCHITECTURE_REQUIRED`): `kg->g` (1000), `g->kg` (0.001), `g->mg` (1000), `mg->g` (0.001), `L->mL` (1000), `mL->L` (0.001). No packaging conversion (box/case/pack/bag/bottle/cup) is proposed — those remain item-specific, future purchasing-configuration concerns, per the operator's own non-goals list.

Every manifest row is `approvalStatus: 'APPROVED'`; categories/units are `source: 'OPERATOR_APPROVED'` (the operator specified these exact values in the Phase C0 request), the six conversions are `source: 'ARCHITECTURE_REQUIRED'` (exact arithmetic facts sanctioned by the schema's own comment, `schema.prisma:890-892`).

## Dry-run behavior

`dry-run.service.ts`'s `runDryRun` fetches a live snapshot of all three tables (read-only), classifies every manifest entry via pure matcher functions (`category-matcher.ts`, `unit-matcher.ts`, `conversion-matcher.ts`) as `WILL_CREATE` / `WILL_REUSE` / `BLOCKED_AMBIGUOUS` / `BLOCKED_INCOMPATIBLE` / `MISSING_DEPENDENCY`, then durably records the run + one `InitializationRecord` per manifest entry via CR-009's existing `recordDryRunRun` (composed, not reimplemented), transitioning `PLANNED -> DRY_RUN_VALIDATED`. Zero inserts/updates/deletes against `InventoryCategory`/`UnitOfMeasure`/`UnitConversion` — verified by `dry-run.service.test.ts`'s pure-function tests (no Prisma import in the planning path).

## Apply safety

`apply.service.ts`'s `applyManifest` is fully implemented but **was not executed by this task**. It refuses to run unless: `confirm === true` and `acknowledgeRollbackReviewed === true` (both literal booleans, no default); the exact `migrationBatch` already has a durable `DRY_RUN_VALIDATED` run; and a freshly-recomputed plan against live data reports zero `BLOCKED_*`/`MISSING_DEPENDENCY` entries. One `prisma.$transaction` per reference type (categories, then units, then conversions), each opened via CR-009's `withInitializationLock` so the advisory lock and transaction boundary coincide; the target-table write and its `InitializationRecord` CAS transition happen in the same transaction. A failing type aborts the whole apply (the run is marked `APPLY_FAILED` naming that type) — conversions are never attempted if categories or units fail. Never overwrites an existing row's fields; only creates missing rows or reuses exact matches.

## Reconciliation behavior

Reused unchanged from CR-009: `apps/api/scripts/initialization-reconcile.ts` (already entity-agnostic) detects stale `APPLYING`/`ROLLING_BACK` runs and re-derives true status from durable `InitializationRecord` rows. No new reconciliation logic was needed or written.

## Rollback behavior

Reused unchanged from CR-009: `rollback-assessment.service.ts` (computes eligibility; never deletes) and `rollback-execution.service.ts` (deletes only per-row-confirmed, freshly-re-verified `ELIGIBLE` rows, reverse-dependency order: conversions, then units, then categories). Two new thin CLI wrappers (`inventory-reference-init-rollback-assess.ts`, `inventory-reference-init-rollback-execute.ts`) expose these for this manifest's runs — no new eligibility or deletion logic.

## Execution commands

```
pnpm --filter @potato-corner/api run inventory:reference-init:dry-run [batchId] [targetEnvironment] <initiatedByUserId>
pnpm --filter @potato-corner/api run inventory:reference-init:apply <batchId> <targetEnvironment> --confirm --acknowledge-rollback-reviewed
pnpm --filter @potato-corner/api run initialization:reconcile [timeoutMs]
pnpm --filter @potato-corner/api run inventory:reference-init:rollback-assess <runId>
pnpm --filter @potato-corner/api run inventory:reference-init:rollback-execute <runId> <recordId>:<fingerprint> [...]
```

None of these were run against any database by this task.

## Non-goals (unchanged from the operator's instruction)

No legacy `Ingredient` migration, no Phase C identity migration, no `InventoryItem`/`ProductComponent`/product/variant/recipe work, no POS deduction changes, no startup seeding, no deployment, no commit, no `FINAL-RESET`.

## FINAL-RESET — Fresh Operational Data Reset (documented, not executed)

Current operational data is disposable test data. Legacy identity migration (Phase C) is intentionally skipped here and is not required for preserving current records, since those records are expected to be discarded. `FINAL-RESET` — a controlled reset of operational data to a fresh state — happens only after: Product Catalog, Recipe/BOM, POS inventory deduction, and Sales alignment are implemented, and acceptance testing has passed. Phase C0 (this package) does not delete, migrate, or otherwise touch any operational data, and does not perform or schedule `FINAL-RESET`.
