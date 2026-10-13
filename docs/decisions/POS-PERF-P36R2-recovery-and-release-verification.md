# POS-PERF-P36R2 — Complete Builder Recovery and Release Verification

**Status:** Implemented and verified locally (real-Postgres integration tests,
real-browser Playwright, real-Postgres concurrent races, a populated
pre-P36 → current migration run). Not pushed, not deployed, no production
data touched. See §6 for exact SHAs and §7 for what remains open.

This phase finishes what `docs/decisions/POS-PERF-P36R-branch-isolation-mix-
max-concurrency.md` §7 explicitly deferred: the five browser scenarios never
driven in a real browser, a direct-API audit of publication safety, a real
concurrent-Postgres proof (not just sequential) of every `expected_version`
guarantee, and a populated-database migration rehearsal. As with P36R, doing
this for real — not just reading the code — surfaced genuine defects.

## 1. Browser scenarios (`tests/e2e/pos-perf-p36r2-browser-scenarios.spec.ts`, 5/5 passing, confirmed stable on a repeat run)

Ran against the local disposable stack (`pos_verify` Postgres on `:5432` +
`apps/api` dev server on `:4000` + `apps/web` dev server on `:3000`).

| Scenario | Result | Notes |
|---|---|---|
| Inline inventory-item creation preserves the product draft | **Passed** | Creating a new `InventoryItem` from inside the Recipe Component dialog's "+ Create new item…" option does not lose the in-progress product/variant draft; the newly created item is immediately selected. No duplicate product/variant was created. |
| Save Draft → reload → resume without duplicates | **Passed** | The builder's Zustand store (`localStorage` key `potato-corner:product-builder-draft`) rehydrates `productId` + `step` on a raw page reload mid-wizard; continuing forward does not re-create the product or re-add the variant. |
| Upload/network-failure → retained input → successful retry | **Passed** | A forced 500 on `POST /api/products/:id/image` surfaces the server's error message inline with a "Retry Upload" button, keeping the previously-selected file (`ImageUpload`'s existing retry design, confirmed under a real failure rather than a mocked one). Retrying after the fault clears succeeds and persists past a reload. |
| Remove from POS / Archive / safe-delete restrictions | **Passed — one real defect found and fixed (see §1a)** | Unpublish and Archive both persist across a reload. A hard `DELETE` on an unreferenced product succeeds (204); `PATCH` on an archived product is rejected 409 `PRODUCT_ARCHIVED` (read-only enforcement). |
| Branch-switch cache staleness | **Passed** | Admin's product detail page keys `useProductReadiness`'s query on `['product', productId, 'readiness', branchId]` — switching the `BranchSelector` to a different branch while the previous branch's readiness request is deliberately delayed 3s never leaks the stale branch's data into the new branch's view, confirmed with a fabricated delayed response carrying a recognizable marker that never renders. |

### 1a. Defect found and fixed: every supervisor's Archive/Discontinue/Restore was broken

Driving Scenario 4 in a real browser (not just reading the router/service
code) found that the Archive confirmation dialog never closed — the mutation
silently failed every time, for every supervisor, on every product.

Root cause: `PATCH /api/products/:productId/status` applies `branchGuard`
unconditionally. `branchGuard` 400s `BRANCH_ID_REQUIRED` for any non-
`super_admin` caller with no `branch_id` in the request — but this route's
own comment (and `products.service.ts`'s `changeProductStatus`) documents
`branch_id` as **intentionally optional**: omitted, it's a global lifecycle
change (archive/discontinue/restore), fully authorized inside the service
via `hasActiveCatalogAuthorityForProduct`; present, it's a branch-scoped
availability flip that still needs `branchGuard`'s `hasBranchAccess` check.
`branchGuard` had no way to express that distinction, so it rejected the
global path before the service's own (correct) authorization logic ever ran.

**Fixed**: added `branchGuardOptional` (`apps/api/src/middleware/branch-
guard.ts`) — skips straight to `next()` when no `branch_id` is present on the
request, defers to the real `branchGuard` otherwise. Swapped it in for the
one route that needs it (`products.router.ts`'s `PATCH /:productId/status`).
Every other `branchGuard` call site (branch-availability PATCH, catalog GET,
etc.) is untouched — those routes correctly always require a branch_id.

Proven two ways:
- The browser pass itself (Archive now closes its dialog and persists).
- A new real-Express + real-Postgres integration test
  (`apps/api/src/modules/products/products.status-branch-guard.integration.test.ts`,
  2 tests): a global archive with no `branch_id` now returns 200 (previously
  400), and a branch-scoped status change naming a branch the supervisor has
  no access to is still correctly rejected 403 — the fix narrows the gate,
  it doesn't remove it.

## 2. Publication safety — direct API verification (`apps/api/src/modules/products/products.publish-safety.integration.test.ts`, 6 tests)

Exercised `productsService.publishProduct` directly (not through the UI)
against every incomplete-configuration case the task asked for:

- Missing BOM/recipe (zero `ProductComponent` rows) → `409 PRODUCT_NOT_READY`.
- Invalid BOM component (zero quantity) → `409 PRODUCT_NOT_READY`.
- Unauthorized branch (a supervisor publishing their branch-exclusive product
  to a different branch) → `403 PRODUCT_BRANCH_EXCLUSIVE`, never reaching the
  availability write.
- A valid, complete configuration → **publishes successfully on its first
  publish** (the exact case P36R's doc fixed — re-verified here directly
  against the service, not just through the builder UI).
- Current stock shortage *alone* (a stock row exists but is zero) does
  **not** block publish — confirmed distinct from an invalid/missing
  configuration, per the task's explicit instruction.
- No automatic all-branch publication or stock deduction was observed in
  any of the above — publish only ever wrote the one targeted branch's
  `BranchProductAvailability` row.

## 3. Atomic concurrency — real-Postgres races, three gaps found and fixed

P36R's doc claimed Product/Variant/Recipe-level `expected_version` checks
already had the "compare, then write" guarantee proven. That claim was
**only ever tested sequentially** ("tab two saves, then tab one tries") —
never with two requests genuinely racing each other. Firing two truly
concurrent calls with `Promise.allSettled` (not `await`ed one at a time)
exposed three real gaps, all in the same shape: the service read
`before.version`, checked it, then issued a *separate*, unconditional
`prisma.X.update({ where: { id } })` with no version predicate — leaving a
window where two callers that both read the same version could both pass the
check and both write.

| Path | Gap | Fix |
|---|---|---|
| `productsService.updateProduct` | Two concurrent updates with the same stale `expected_version` **both succeeded** (proven: `fulfilled.length === 2`, not 1) | `productsRepository.update` now does one `updateMany({ where: { id, version: expectedVersion } })` + `version: { increment: 1 }`; `count === 0` ⇒ `409 PRODUCT_CONFLICT`. Compare and write are one atomic statement. |
| `productsService.updateVariant` | Worse: the repository's `updateVariant` **never touched the `version` column at all** on this path — only the separate flavor-slot-governance path did. The `expected_version` check could never detect a stale edit because the DB value it compared against never changed. | Same atomic `updateMany` + `version: { increment: 1 }` shape as Product; `count === 0` ⇒ `409 VARIANT_CONFLICT`. |
| `productComponentsService.updateMapping` | Same check-then-unconditional-write shape as Product (version *did* increment, but not atomically with the compare) | Same atomic `updateMany` shape; `count === 0` ⇒ `409 MAPPING_CONFLICT`. |

All three are proven with a real concurrent-Postgres test using
`Promise.allSettled` (not sequential), in
`products.concurrency.integration.test.ts`'s new case and the existing
`updateVariant`/`updateMapping` unit coverage updated to match the new
call shape.

**Publish vs. a concurrent readiness-invalidating mutation** — `publishProduct`
evaluated readiness, then separately flipped `BranchProductAvailability` as
two unlocked steps. A concurrent `deleteMapping` landing in between could
publish a product whose only Recipe/BOM component had just been removed.
Proven with a real race (both operations fired concurrently): the product
was published (`isAvailable: true`) with zero remaining components.

**Fixed**: added `productCatalogLockId` (`apps/api/src/lib/pg-lock.ts`),
following this codebase's existing `pg_advisory_xact_lock` pattern (same as
`pg-lock.ts`'s other lock IDs). `publishProduct` takes this lock, keyed on
`productId`, before evaluating readiness, and holds it through the
availability write — both inside one `prisma.$transaction`. `deleteMapping`
and `updateMapping` (the two component mutations that can invalidate
readiness) take the same lock before writing. Whichever side acquires it
first completes its entire read-then-write before the other can begin —
proven with a deterministic version of the race (one side holds the lock
open on purpose, synchronized via a gate promise, so the interleaving isn't
left to chance): publish now either succeeds against a configuration that
provably still existed when it read it, or is correctly rejected
`409 PRODUCT_NOT_READY`.

**Not changed** (per the task's "do not add version fields mechanically"
instruction): flavor-slot CRUD (`performSlotEditWithActiveGovernance`) and
option-group assignment. Flavor-slot operations are individually well-
defined mutations (add/remove/reorder), not "the record hasn't changed"
field edits — the existing transaction + no-op snapshot guard already
provides the relevant guarantee, and `publishProduct`'s new lock now also
covers the one place a flavor-slot change could otherwise race a concurrent
publish (any mutation that could flip `MIX_MAX_SLOT_INCOMPLETE` would need
the same lock to interleave with publish, same as the component case — left
as a flagged follow-up since no slot-specific race was proven here, unlike
the proven component-delete race above).

## 4. Populated migration test

Applied the exact pending migration set (identified by diffing
`apps/api/prisma/migrations/` between the last reported production baseline
`9f87159640dfdc18b3a9534140a2c585181df408` and this branch's `4985ef1` — the
single, additive `20261013185718_pos_perf_p36r_product_version` migration:
`ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1`) against
a disposable local Postgres seeded with a **pre-P36** schema snapshot
(migrations as of `9f87159`) populated with real data: a branch, a user, two
inventory items with stock, two Recipe/BOM components, a published product +
variant, a completed sale (`transactions` + `transaction_items`), and a
`pending` `inventory_deduction_job`.

- All 9 seeded row counts (products, product_variants, product_components,
  inventory_stocks, inventory_stock_movements, transactions,
  transaction_items, inventory_deduction_jobs, branch_product_availability)
  were **identical before and after** the migration — no rows lost, no FK
  references broken.
- The new `version` column defaulted to `1` on the pre-existing row, as
  expected for an `ADD COLUMN ... DEFAULT 1 NOT NULL` on Postgres (a
  metadata-only change for a constant default, not a full table rewrite).
- **Exercised editing post-upgrade**: `productsService.updateProduct` against
  the migrated row succeeded and correctly bumped `version` 1 → 2 (proving
  the P36R2 atomic-update fix from §3 works against data that pre-dates the
  `version` column's existence, not just freshly-created rows).
- **Exercised the queued deduction post-upgrade**: `inventoryDeductionService.
  runCycle` claimed and completed the pre-existing `pending` job
  (`claimed:1, completed:1, failed:0`) without error. The job's own stock
  deltas were zero in this run only because the synthetic seed's
  `transaction_item` was inserted directly via SQL without a
  `deduction_snapshot` (which real checkout populates) — a property of this
  test's seed data, not a migration defect; the worker's claim/complete
  lifecycle itself, the part migration safety actually depends on, ran
  cleanly against the upgraded schema.

No production migration or backfill was run. The disposable database was
dropped immediately after.

## 5. Final validation

| Check | Result |
|---|---|
| `apps/api` full `vitest run` (`TEST_DATABASE_URL` set to local `pos_verify`, dev servers stopped first) | **2,969 passed, 0 failed, 99 skipped** |
| `apps/web` full `vitest run` | **1,218 passed, 0 failed, 0 skipped** |
| New Playwright spec (`pos-perf-p36r2-browser-scenarios.spec.ts`) | **5/5 passed**, confirmed stable on a repeat run |
| `apps/api` / `apps/web` / `packages/shared` `tsc --noEmit` | clean |
| `apps/api` `eslint` on touched files | clean |
| `apps/api` build (`tsc -p tsconfig.json`) | clean |
| `apps/web` build (`next build`) | clean — full route manifest generated |

**On the skip/pass-count discrepancy with a naive run**: `apps/api`'s
integration suites are gated behind `TEST_DATABASE_URL` (`describe.skipIf
(!canRunIntegrationTests)`); without that env var set, the same run shows
**2,832 passed / 227 skipped** instead. This is not a change in test
discoverability from this session's edits — it's the suite's existing,
intentional gate, confirmed by reading the gate condition in
`transactions.integration.test.ts` et al. Every count in the table above was
captured with the gate open.

**One pre-existing flake, confirmed not a regression**: a single
full-suite run (not re-run in isolation) showed
`transactions.integration.test.ts`'s "two concurrent sales against stock
sufficient for exactly one cannot both succeed" fail once
(`expected 200 to be +0`); run alone it passes reliably. This matches the
same "known environmental hazard" category P36R's doc already documented
(resource contention across vitest's parallel worker threads hitting the
same real Postgres instance) — confirmed by running it in isolation
immediately after (passed) and by it passing cleanly in the final full-suite
run captured in the table above. No code in this session touches the
checkout/overselling path this test exercises.

## 6. Validation / SHAs

Starting HEAD: `4985ef103b094805a849624fbdbc98b70054df6d` (6 commits ahead of
the last reported production baseline
`9f87159640dfdc18b3a9534140a2c585181df408`).

Files changed this session:
- `apps/api/src/lib/pg-lock.ts` — added `productCatalogLockId`.
- `apps/api/src/middleware/branch-guard.ts` — added `branchGuardOptional`.
- `apps/api/src/modules/products/products.router.ts` — swapped
  `branchGuardOptional` into `PATCH /:productId/status`.
- `apps/api/src/modules/products/products.repository.ts` — atomic
  compare-and-swap for `update`/`updateVariant`.
- `apps/api/src/modules/products/products.service.ts` — atomic
  `publishProduct` (advisory lock + transaction); `updateProduct`/
  `updateVariant` use the new atomic repository calls.
- `apps/api/src/modules/products/products.types.ts` — dropped the now-unused
  `version` field from `UpdateProductData` (replaced by the repository's
  `expectedVersion` parameter).
- `apps/api/src/modules/product-components/product-components.repository.ts` /
  `.service.ts` — atomic `update`/`delete`, same `productCatalogLockId`
  taken before either write.
- `apps/api/src/modules/products/products.concurrency.integration.test.ts` —
  new true-concurrency race test for `updateProduct`.
- `apps/api/src/modules/products/products.publish-safety.integration.test.ts`
  (new) — §2/§3's publication-safety and publish-vs-delete race coverage.
- `apps/api/src/modules/products/products.status-branch-guard.integration.test.ts`
  (new) — §1a's regression coverage.
- `apps/api/src/modules/products/products.service.test.ts` /
  `apps/api/src/modules/product-components/product-components.service.test.ts` —
  updated mocks/assertions for the new atomic call shapes.
- `tests/e2e/pos-perf-p36r2-browser-scenarios.spec.ts` (new) — §1's five
  browser scenarios.

## 7. Remaining limitations / not covered in this pass

- Option-group assignment's lack of `expected_version` was reviewed again
  and left as-is, per P36R's existing reasoning (no proven race, publish is
  idempotent per branch).
- The flavor-slot-vs-publish race flagged in §3 (end of that section) is a
  plausible analog of the proven component-delete race but was not itself
  proven or fixed this pass — flagged for a follow-up.
- No real checkout/sale was driven through the populated-migration DB in §4
  (synthetic `transaction_item` seeded directly); the deduction worker's
  claim/complete lifecycle was proven, not the ingredient-quantity math,
  which is already covered elsewhere (`transactions.builder-recipe-match.
  integration.test.ts`).
- Local Postgres accumulated a large number of leftover test branches/rows
  from this and prior sessions' integration tests (each creates fixtures it
  doesn't always fully tear down, e.g. branches). Harmless for a disposable
  local DB and out of scope for this task; not cleaned up.

## 8. Rollback

Every change is additive (new lock ID, new middleware function, new test
files) or a narrow correctness fix to an existing code path (branchGuard
usage on one route, the repository update methods' SQL shape). Rollback =
revert the relevant file(s); no schema change, no production data,
migrations, catalog copies, assignments, uploads, or sales were touched —
verification ran entirely against local disposable Postgres databases, both
of which were dropped at the end of their respective sections.
