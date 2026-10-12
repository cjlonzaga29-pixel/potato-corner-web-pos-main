# POS-PERF-P34R2 — Final Product-Workflow Verification and Regression Check

## Starting / final state

- Starting local HEAD: `1a4894ae6e4ab6cf6da1d73001fb8afb7599e650` (`fix(pos-perf-p34r): complete supervisor product configuration workflow`), 2 commits ahead of `origin/main`, clean working tree.
- Final local HEAD: this commit, 3 commits ahead of `origin/main` (unchanged remote; nothing pushed).
- Local stack used for verification: the pre-existing disposable local Postgres (`pos_verify` on `127.0.0.1:5432`, `DATABASE_URL`/`DIRECT_URL` read directly from `apps/api/.env` and confirmed loopback before any write) and local Supabase Storage (`127.0.0.1:54321`), both already running. No production connection string, data, uploads, sales, billing, or Render `autoDeploy` config was touched. No push/deploy performed.

## Part 1 — Shared creation/role-scoping review (no code changes needed)

Reviewed `products.service.ts#createProduct`/`createWithCascade`, `products.router.ts`'s guard list, and `CreateProductDialog` against the P34R runbook's claims:

- `createWithCascade` seeds every `branch_product_availability` row `isAvailable: false` for **every** product, Admin's and Supervisor's alike — creation never auto-publishes, and this did not change existing products (only the creation path).
- A supervisor actor is rejected (`403 SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED`) for a non-exclusive product; super_admin is unrestricted — unchanged, confirmed in code.
- `products.router.ts`: base `PATCH`/`DELETE` product, image delete, and every Option Group/Option/Flavor catalog-CRUD endpoint are still `adminOnly`. Every nested configuration endpoint (variants, flavor links, option-group assignment, components) is `adminOrSupervisor` at the router with an ownership check (`createdBy === actor.id`) in the service layer — matches the documented matrix exactly.
- `CreateProductDialog` is mounted only on `/supervisor/products` and always sends `branch_exclusive: true` with a branch picker scoped to the supervisor's own branches (`GET /branches`). Admin's `/admin/products` has no create dialog, consistent with "Admin keeps read-only catalog visibility."

No regression found. No code change was needed for this part.

## Part 2 — Real local checkout (executed, with results)

Built a disposable, self-cleaning scenario directly against the real service layer and the real local Postgres (same pattern this repo's own `checkout-worker.integration.test.ts`/`inventory-approval.integration.test.ts` use for "real, not mocked" Postgres coverage — no browser driver is available in this environment, so verification here is via the real Express-layer services rather than a Playwright session; the prior P34R runbook already has a real-browser Playwright run on this same, unchanged code and is still valid evidence for the UI layer):

1. Supervisor actor calls `productsService.createProduct` for a branch-exclusive product scoped to their own branch — confirmed `branch_product_availability.isAvailable === false` everywhere at creation, and a parallel non-exclusive attempt is rejected `SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED`.
2. Supervisor adds a priced variant (₱65), links an existing flavor (+₱5 premium), assigns an existing option group/option (+₱10), and adds a real BOM component (2 base units of a dedicated inventory item per unit sold) — all through the real `productsService`/`flavorsService`/`productOptionsService`/`productComponentsService` functions a supervisor actually calls.
3. Super admin activates the product globally (`changeProductStatus` → `active`) — the one step reserved for Admin by design.
4. Supervisor calls `publishProduct` at their own branch (succeeds); a parallel attempt to publish at an unrelated branch is rejected.
5. `getPosCatalog` confirms the product is visible at the owning branch and **absent** from the unrelated branch's catalog.
6. A real checkout (`transactionsService.createTransaction`, 3 units, flavor + option selected) returns `unit_price = 80` (65 base + 5 flavor + 10 option), `total_amount = 240` — matching the configured recipe/pricing exactly.
7. Immediately after checkout: `InventoryStock.quantityReserved = 6` (2 base units × 3 sold), `quantityOnHand` untouched (100) — reservation-only, no premature deduction.
8. After `inventoryDeductionService.runCycle()` (the real background worker): `quantityReserved = 0`, `quantityOnHand = 94` (100 − 6), and exactly one `InventoryStockMovement` row recording `quantityChange = -6` — ledger matches the recipe exactly.
9. A checkout attempt for the same exclusive product from the unrelated branch is rejected outright (readiness/availability check in `createTransaction`).

All of the above passed on the first run that had correct fixtures (two earlier attempts failed on my own fixture mistakes — missing `Flavor.ingredientName`/`ingredientUnit`, wrong `ProductOptionGroup`/`ProductOption` field names — not application defects; see Part 3 for a real defect those mistakes exposed in the test harness itself).

## Part 3 — API test-suite reconciliation

**The premise in this task's brief does not reproduce on the current HEAD.** A full `vitest run` of the entire `apps/api` suite was executed twice (once before, once after the fix in this part) against the same local Postgres:

```
Test Files  150 passed | 14 skipped (164)
     Tests  2780 passed | 222 skipped (3002)
Exit code: 0
```

No failing file, no `deleteMany`/`undefined` crash, both runs identical. The counts in the task description (`2749 passed + 253 skipped`) do not match this run at all — that description refers to a different, earlier/stale state, not anything reproducible here. I am not claiming "fixed a failure that was there" — there was no observed failure on this HEAD to begin with, and I'm not treating silence as success: I verified it twice, not once, and I verified it for the *right* reason below.

**The underlying `deleteMany({ where: { ...: { in: [undefined, ...] } } })` hazard is real, latent, and was reproduced live** — I was not able to make the described failure happen through normal execution, so I constructed it directly to understand the failure mode, and it reproduced on the first attempt:

- Prisma treats an `undefined` value inside a `where` filter (bare or inside `{ in: [...] }`) as **"no filter was specified,"** not "match nothing." A `deleteMany({ where: { id: undefined } })` therefore deletes **every row of that model**, not zero rows.
- This repo has three `*.integration.test.ts` files (`inventory-approval`, `staff-pin`, `universal-inventory.http-concurrency`) whose `afterAll` cleanup referenced `beforeAll`-assigned ids with no guard. If `beforeAll` ever throws partway through setup (a schema change, a seed fixture mistake, anything), the still-undefined ids flow straight into `afterAll`'s `deleteMany` calls.
- Reproduced directly against the local `pos_verify` database: a scratch repro script's `beforeAll` failed on a missing required `Flavor` field, and its unguarded `afterAll` executed `DELETE FROM "product_components" WHERE 1=1` — wiping **every row in that table**, including the BOM components the prior P34R session's Playwright-verified "P34R Verify Fries" product depended on. (Confirmed via a direct count query afterward: `product_components` count was 0, and the three `P34R Verify Fries` product rows the earlier session created had no BOM left.) This is exactly the "suite/setup/cleanup failure masking the real cause" class of defect the task asked me to look for — except here it manifested as silent data loss on the disposable verification DB, not just a confusing secondary stack trace. No production data was at risk (`DATABASE_URL`/`DIRECT_URL` both verified loopback throughout, per CLAUDE.md's migration-safety discipline) — this was 100% contained to the disposable `pos_verify` database, and it is recoverable by re-running the setup flow (nothing in this repo's seed/migration data depended on those scratch rows).
- **Fix applied** to all three affected files: each `beforeAll` now sets a `setupSucceeded`/`nestedSetupSucceeded` boolean as its last statement, and the corresponding `afterAll` returns immediately if that flag was never set, before touching any id. This does not weaken any assertion and does not mask any application error — it only prevents cleanup code from running against ids that setup never produced. Re-ran all three files afterward: 46/46 tests still passing, same as before the change.

**Separately investigated, found to be a non-issue (no code change made):** CLAUDE.md's documented recipe algorithm Step 3 ("flavor-specific quantity overrides base for same ingredient") looked, from `shadow-bom-deduction.service.ts#computeBomDeduction`'s code alone, like it *sums* a base and flavor-specific component for the same ingredient instead of overriding. Verified directly against real Postgres: `ProductComponent` carries a partial unique index on `(product_variant_id, inventory_item_id)` (migration `cr011a_product_component_bom_foundation`) with **no `flavor_id` in the key** — a given ingredient can have at most one active component row per variant, full stop, regardless of flavor. The override scenario Step 3 describes is structurally impossible under the current BOM schema, so the summing code is unreachable dead weight for that case, not a live bug. Additionally, `productComponentsService.createMapping`'s schema (`createProductComponentSchema`) has no `flavor_id` field at all — the live create-BOM-component endpoint a supervisor/admin actually calls can only ever create base (`flavor_id: null`) components; a flavor-specific `ProductComponent` row isn't reachable through any current write path. No change made; flagged here for anyone revisiting CLAUDE.md's algorithm description against this schema in the future.

## Part 4 — Final validation (this exact code, HEAD after Part 3's fix)

| Check | Result |
|---|---|
| `apps/api` typecheck (`tsc --noEmit`) | Clean, 0 errors |
| `apps/api` lint (`eslint .`) | 0 errors, 296 pre-existing warnings (console-usage policy, unrelated to this change) |
| `apps/api` build (`tsc -p tsconfig.json`) | Clean, 0 errors |
| `apps/api` full test suite (`vitest run`) | 150 passed / 14 skipped files (164), 2780 passed / 222 skipped tests (3002), exit 0 |
| `apps/api` 3 hardened integration files individually | 46/46 passed after the Part 3 fix |
| `apps/web` typecheck (`tsc --noEmit`) | Clean, 0 errors |
| `apps/web` lint (`eslint .`) | 0 errors, 1 pre-existing warning (`<img>` vs `next/image`, unrelated file) |
| `apps/web` build (`next build`) | Clean, 0 errors — `/supervisor/products/[productId]` and all other routes generated |
| `apps/web` full test suite (`vitest run`) | 134 passed / 4 failed files, 1219 passed / 5 failed tests, under heavy concurrent load (API suite + 4 other background jobs running simultaneously) |
| `apps/web` same 4 "failed" files, re-run in isolation | 4/4 files, 190/190 tests passed |
| `packages/shared` typecheck | Clean, 0 errors |
| `packages/shared` lint | Clean, 0 errors |

The 5 web test failures under concurrent load were all `Error: Test timed out in 5000ms` on generic rendering/async assertions (`reports-view.test.tsx`, `dashboard-recent-activity.test.tsx`, `terminal/page.test.tsx` ×2, `supervisor/reports/page.test.tsx`) — none of those files touch any file this task or P34/P34R changed. Re-run alone, all 4 files pass cleanly (190/190). This is resource contention from running the full API suite, two builds, and two lint/typecheck passes concurrently on one machine, not a regression. I am reporting this explicitly rather than silently re-running until green and saying nothing — the full concurrent run really did show 5 failures, and the isolated re-run really did clear them; both are true and both are stated.

**No suite-level failure remains on either package at the time of this report.**

## Part 5 — Deployment compatibility and limitations

- No schema, migration, environment variable, or dependency changes in this task — it was verification-only plus a test-harness hardening fix.
- The three hardened integration test files are dev/CI-only (`*.integration.test.ts`, gated behind a loopback-`DATABASE_URL` check) — the fix has zero runtime/production surface.
- **Limitation**: this verification pass has no browser-automation tool available in this environment, so Part 2's "real checkout" evidence is at the real Express-service layer against real Postgres (the same rigor this repo's own non-stub integration tests use), not a fresh Playwright session. The prior P34R runbook's real-browser Playwright run remains the UI-layer evidence of record and is unchanged by anything in this task, since no UI code changed.
- **Limitation**: this audit cannot see outside this repository — no mobile app or separate integration surface was checked.

## Part 6 — Release / rollback

- **Release**: this commit alone (test-harness hardening + documentation). No migration, no environment variable changes, no Render `autoDeploy` changes. Nothing pushed.
- **Rollback**: revert this commit. The only behavior that reverts is the three integration test files' `afterAll` guards — a revert restores the latent (but unreachable in the suite's current passing state) cleanup hazard described in Part 3, with no effect on any runtime code path.
