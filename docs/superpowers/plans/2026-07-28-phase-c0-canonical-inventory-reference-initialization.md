# Phase C0 — Canonical Inventory Reference Initialization (implementation record)

**Status:** COMPLETE (implementation). Dry-run/apply/reconcile/rollback tooling built and unit-tested; apply was **not executed** against any database.

**Supersedes** the Gate -1-blocked state of `docs/superpowers/plans/2026-07-27-cr006-phase-c0-canonical-reference-initialization.md` — CR-009's durable initialization-audit model is now implemented (`apps/api/src/modules/initialization-audit/`), resolving the prior blocker. This document records what was actually built for the operator-specified canonical package, not a re-plan of CR-006 Phase C0's original (now superseded) `UNRESOLVED`-everything manifest.

See `docs/decisions/PHASE-C0-canonical-inventory-reference-initialization.md` for the full scope/behavior writeup. This file records the implementation task list and validation evidence.

## What was built

| File | Purpose |
|---|---|
| `apps/api/src/modules/inventory-reference-init/types.ts` | Manifest entry/shape types |
| `manifest.ts` | The v1 canonical manifest (8 categories, 13 units, 6 conversions) |
| `manifest.schema.ts` | Zod structural validation + duplicate-key/derived-code/dangling-dependency guards |
| `manifest-fingerprint.ts` | Deterministic, key-order-independent manifest fingerprint |
| `batch-id.ts` | `PHASEC0-REFINIT-<UTC timestamp>` batch-id format + validator |
| `category-matcher.ts` / `unit-matcher.ts` / `conversion-matcher.ts` | Pure WILL_CREATE/WILL_REUSE/BLOCKED_*/MISSING_DEPENDENCY classifiers |
| `dry-run.service.ts` | Live-snapshot fetch + plan build + durable dry-run recording (composes CR-009's `recordDryRunRun`) |
| `apply.service.ts` | Per-reference-type locked-transaction apply orchestration (implemented, not executed) |
| `apps/api/scripts/inventory-reference-init-{dry-run,apply,rollback-assess,rollback-execute}.ts` | CLI entry points |
| `docs/decisions/PHASE-C0-canonical-inventory-reference-initialization.md` | Decision record |

Reused unchanged (no reimplementation): `InitializationRun`/`InitializationRecord` models, `manifest-entry-key.ts`, `fingerprint.ts`, `decimal-canonicalization.ts`, `run-lifecycle.service.ts`, `record-writer.service.ts`, `advisory-lock.ts`, `dry-run-contract.ts`'s `recordDryRunRun`, `reconciliation.service.ts`, `rollback-assessment.service.ts`, `rollback-execution.service.ts`, and the existing `initialization-reconcile.ts` CLI script (already entity-agnostic).

## Validation

- `pnpm --filter @potato-corner/api exec tsc -p tsconfig.json --noEmit` — clean.
- `pnpm --filter @potato-corner/api exec eslint src/modules/inventory-reference-init` — clean.
- `pnpm --filter @potato-corner/api test` — 95 test files passed, 13 skipped (real-DB integration suites, correctly gated on `TEST_DATABASE_URL`), 1302 tests passed, 199 skipped, 0 failed. New module: 8 test files, 46 tests, all passing (manifest exactness, schema validation, all three matchers, dry-run plan purity, batch-id format, apply pre-database guards).

## Explicitly not done in this task

Apply was not executed; no canonical row exists in any database as a result of this work. No `FINAL-RESET`. No legacy `Ingredient` migration or Phase C identity migration. No `InventoryItem`/product/variant/recipe/POS-deduction work. No deployment. No commit.
