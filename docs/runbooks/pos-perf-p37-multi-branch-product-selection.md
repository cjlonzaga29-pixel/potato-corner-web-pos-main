# POS-PERF-P37 — Create Once, Select Multiple Branches

## Behavior

The Product Builder's Step 1 shows **Available at branches**: one checkbox per
active branch the supervisor is currently assigned to, a **Select all assigned
branches** toggle (shown when there is more than one branch), and a live count with
the selected branch names. At least one branch is required to continue. A supervisor
with exactly one branch gets it preselected. A supervisor with none sees "An
administrator must assign you to a branch first." "Select all" means the supervisor's
assigned *active* branches only, never every branch in the organization or future ones.

- The product is configured once. Sizes, recipe and choices are shared by every
  selected branch.
- **Save Draft** leaves it unsellable everywhere. Availability rows exist only at the
  selected branches, all `is_available = false`.
- **Review** lists the selected branches and shows a readiness checklist for each one.
  **Add to POS** stays disabled until every selected branch is ready.
- **Add to POS** publishes at exactly the selected branches, all at once or not at all.
- Before the product exists, the selection is persisted in the builder's localStorage
  draft (`draftBranchIds`), so it survives step changes and a reload. After that, the
  server's `branch_availability` rows are the selection of record.

## Data model / API

| Change | Detail |
| --- | --- |
| `POST /api/products` | New optional `branch_ids: uuid[]` (1–100, duplicates collapsed). Cannot be combined with `branch_exclusive`/`exclusive_branch_id`. **1 id**: the existing branch-exclusive shape, unchanged. **2+ ids**: one non-exclusive product, `branch_selection_scoped = true`, with unpublished rows only at those branches. |
| `POST /api/products/:id/publish-branches` | New, supervisor-only, body `{ branch_ids }`. Runs in one transaction under the product's advisory lock: re-checks the live assignment to every id, the branch-spread guard and per-branch readiness, then flips every row. Any failure means zero rows are written. Returns `409 PRODUCT_NOT_READY` with `details.branches[]` naming each blocked branch. |
| `products.branch_selection_scoped` | Additive migration `20261026120000_pos_perf_p37_product_branch_selection` (`BOOLEAN NOT NULL DEFAULT false`). |
| Branch-spread guard | `assertSupervisorMayEnableAtBranch` now also rejects enabling a scoped product at a branch outside its selection (`403 PRODUCT_BRANCH_NOT_SELECTED`). This covers single publish, availability PATCH, bulk availability, branch status change and publish-branches. Single `/publish` now runs this guard **before** readiness, so an unselected branch gets 403 instead of a readiness report. |

**Why a column:** without it, a multi-branch supervisor product looks the same as a
pre-P35 legacy shared product. The guard has to cover the new products, and it must
not change how legacy products behave (supervisors can still enable those at branches
without a row).

**Errors:** `422 BRANCH_SELECTION_INVALID` (unknown or inactive id), `403
BRANCH_ACCESS_DENIED` (not a live active assignment), `403
SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED` (supervisor sent no branch scope at all; still
never treated as company-wide).

## Unchanged rules

- **Full-coverage authority:** to edit shared configuration, a supervisor must be
  assigned to every branch the product has a row at, including unpublished ones.
  Partial-coverage supervisors use the existing branch-copy (fork) and replace-source
  workflow.
- **Inventory:** checkout reserves and deducts only the purchasing branch's stock.
  Creating or publishing never copies or changes balances.
- **Missing setup vs. shortage:** a selected branch with no `InventoryStock` row for a
  recipe item blocks publication with `INVENTORY_STOCK_MISSING`. No stock row is
  created and no ingredient is substituted. A branch that has the row but low or zero
  stock still publishes; shortage stays a checkout-time outcome.
- **Retry safety:** publish-branches is an idempotent upsert on unique
  `(branch, product)` rows. Create-retry safety is the same as before: the builder
  reuses the created product id. There is no server-side idempotency key on create.

## Rollout compatibility (POS-PERF-P37R, checked against the real workflow)

### What actually happens on push to `main`

`.github/workflows/deploy-production.yml` runs one job in this order: full CI
(type-check, lint, test, build), then the `production` environment's required-reviewer
approval, then `prisma migrate deploy` against production, then the Render deploy hook
for `apps/api`. **`apps/web` is not in that job.** Vercel's GitHub integration deploys
it on the same push, on its own clock. Nothing makes the API go first. The P37 version
of this section said "deploy the API before the web app". **That was wrong**: no
mechanism enforces it. In practice the new web build usually goes live first, and stays
ahead of the API until CI finishes and a reviewer approves.

Migration-before-API **is** enforced inside that job. The Render hook step only runs
if `migrate deploy` succeeded. One gap can't be checked from this repo: Render's own
`autoDeploy` setting is not in version control. If it is on, Render could build the
API from the push before the migration step runs. An operator should confirm it is
off (deploys come only from the hook) before this release.

### Overlap matrix

| Combination | When it happens | Behavior |
| --- | --- | --- |
| **New web + old API, old schema** | Normal window: from Vercel going live until migrate + Render finish. Lasts as long as CI plus approval. | **Builder product creation is blocked; nothing is written.** The old `createProductSchema` is a plain (non-strict) Zod object, so it strips the unknown `branch_ids`. The builder sends `branch_exclusive: false`, so the old service rejects every supervisor create with `403 SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED`. The builder shows that as a toast. The form and the `draftBranchIds` selection stay in place, so the supervisor can retry after the API deploys. Review's **Add to POS** calls `/publish-branches`, which the old API doesn't have (404), so publishing from the builder also fails with a toast. The per-branch Publish on the product page still uses the old `/publish` and keeps working. Read paths are unaffected: the missing `branch_selection_scoped` field reads as falsy. |
| **Old web + new API, new schema** | Vercel rollback, or a browser tab still running the old bundle. | Works. The old builder sends `branch_exclusive` + `exclusive_branch_id`, an unchanged shape. The new response field is ignored. On a scoped product (made by the new builder), the old product page's per-branch Publish at an unselected branch gets `403 PRODUCT_BRANCH_NOT_SELECTED`, which is the intended guard. |
| **Old API + new schema** | Between `migrate deploy` and the Render swap; Render's old/new instance overlap. | Safe. The column is additive with `DEFAULT false`. The old Prisma client neither selects it nor writes it, so inserts get `false`. |
| **New API + old schema** | Only if the API deploys before the migration (see the `autoDeploy` caveat above). | **Broken.** Prisma selects every scalar column, so every product read and write fails with "column does not exist". This is why the migration must come first. |

### Write gate (POS-PERF-P16) during the overlap

The gate covers every `POST`/`PATCH`/`DELETE` under `/api/products` (create,
`/publish`, `/publish-branches`, availability) plus checkout and inventory writes. It
returns `503 SERVICE_WRITE_GATE_CLOSED` with `Retry-After: 30`. It is DB-backed, so old
and new API instances see the same state.

- **What it covers:** HTTP writes during the API-side swap, when old and new Render
  instances overlap. It also blocks new checkouts, so no new deductions get queued.
  It does **not** stop the in-process job runner: deduction jobs already queued can
  still run the pre-P37R out-of-stock cascade on an old instance. Scoped products only
  exist once the new API has created them, so that exposure is limited to the short
  swap overlap, or to an API rollback (below).
- **What it does not cover:** the new-web/old-API window above. That window opens
  when Vercel deploys, which may be long before anyone would close the gate. Closing
  the gate for the whole time CI plus approval takes would also stop checkout, so it
  is not a practical cover for that window. That window is already safe without the
  gate, because nothing is written. It is a feature outage for the builder only.
- **How the frontend behaves while writes are paused:** create and publish failures
  surface `error.message` ("Temporarily unavailable for maintenance. Please try again
  shortly.") as a toast. The builder keeps the form, the selection and any created
  product id, so a retry after reopening continues instead of starting over. There is
  no automatic retry and no dedicated "paused" banner in the builder.

Recommended order, without changing any automation: close the write gate just before
approving the production run, approve, let migrate + Render finish, verify, then
reopen. Tell supervisors that the builder's create/publish may fail with a toast from
the moment the push lands until the API is live.

### Rollback

- **Web only:** safe at any time (see "old web + new API").
- **API rollback with scoped products already created:** the old API has no idea what
  `branch_selection_scoped` means. It treats those products as legacy shared products,
  which has two effects:
  1. A supervisor assigned to an unselected branch can enable the product there,
     through availability PATCH/bulk, which never needed a row for legacy products.
  2. The old out-of-stock cascade can seed unavailable rows at unselected branches
     (the defect fixed below).
  Full-coverage edit authority still holds, because it reads rows. Keep the write
  gate closed for as long as the old API serves traffic if you can. After rolling
  forward again, list availability rows for `branch_selection_scoped = true` products
  that were created during the rollback window (by `updated_by`/audit log) and review
  them.
- **Schema:** never drop `products.branch_selection_scoped` to roll back. Old code
  ignores it, and dropping it permanently loses which products are scoped.
- Existing products are untouched by the migration. All of them get
  `branch_selection_scoped = false`.

## POS-PERF-P37R — out-of-stock cascade fix

The §7.2 cascade (`inventoryRepository.runOutOfStockCascade`) runs when a flavor
ingredient sells out at a branch. It used to upsert an unavailable
`branch_product_availability` row for every product whose flavors were then all
unavailable **at that branch**, whether or not the product had a row there. For a
scoped product, a row *is* its selection, so a stock-out at an unselected branch:

- silently added that branch to the selection, so a supervisor there could then
  publish the product (`assertSupervisorMayEnableAtBranch` saw a row), and
- widened full-coverage edit authority to require that branch too.

**Fix:** for `branch_selection_scoped` products, the cascade now updates existing rows
only and never creates one. If there is no row, the product isn't sellable at that
branch, so there's nothing to disable. Selected branches still flip unavailable as
before. Legacy shared products keep the historical upsert, and branch-exclusive
products are unchanged too: their guard and authority use `exclusive_branch_id`, not
rows. Regression coverage is in
`products.multi-branch-selection.integration.test.ts` › "out-of-stock flavor cascade".
It failed before the fix: the scoped product appeared in `affectedProducts` at the
unselected branch.

## Known limitation (unchanged, deliberately out of scope)

The builder's create retry safety is client-side only: after a create succeeds, it
reuses the created product id. **This is not server-side exactly-once protection.** If
the create response is lost (timeout, network drop, tab closed) after the server has
committed, the builder has no id to reuse, and a retry creates a second product. No
idempotency key exists on `POST /api/products`. If a duplicate happens, a supervisor
deletes the unreferenced duplicate, which safe-delete allows because it has no sales.

## Verification (local `127.0.0.1:5432/pos_verify` only)

- `products.multi-branch-selection.integration.test.ts`: 17/17 against real Postgres.
- `products.router.test.ts`: publish-branches role gate and body validation.
- Web: `use-products.test.tsx` (publish-branches hooks), `product-builder.store.test.ts`.
- Full suites: API 166 files / 2899 tests passed (15 env-gated files skipped, same as
  baseline). Web 141 files / 1223 tests passed. Type-check, lint (0 errors) and
  `pnpm build` pass for all three packages.
- Browser: `tests/e2e/pos-perf-p37-multi-branch-builder.spec.ts`, 5/5 against
  `next build` + `next start` and a fresh local API. Covers checkboxes, select-all
  scope, reload recovery, Save Draft, Review, Add to POS, catalogs at A/B/C, retry and
  forged/partial-authority rejection, real checkouts at A then B (each deducts only its
  own branch), the missing-setup block, and single-branch preselection.

### POS-PERF-P37R final verification (local `pos_verify` only)

Run on the final code: a fresh `tsc` build of `apps/api` (`node dist/server.js`) and
`next build` + `next start` for `apps/web`. Specs ran serially with
`--project="Admin Dashboard (Desktop)"`, each against **its own freshly started API
process**. The order was P36R6 first (the former leaker), then P36R2, P36R and P37.

| Spec | Final result | Throttled (429) responses in the final run |
| --- | --- | --- |
| P36R6 branch-copy / replacement | **10/10 passed** (11.4 min) | 0 |
| P36R2 recovery / lifecycle | **5/5 passed** (6.5 min) | 0 |
| P36R Mix & Max | **2/2 passed** (2.9 min) | 0 |
| P37 multi-branch selection | **5/5 passed** (7.0 min) | 0 |

Earlier failing runs, with the actual cause of each:

1. **P36R6, run 1:** test 4 timed out waiting for "Change Status". The API log
   showed `GET /api/products/<copy> 429`, which the page rendered as "Product not
   found". That was real throttling, not an environment problem. Fixed with 61s pacing
   per test.
2. **P36R6, run 2:** test 1's banner check hit the 5s `expect` timeout with 0 429s.
   Logins took up to 10.7s because a repo-wide type-check and lint were running
   concurrently (verifier-induced CPU load). The run was discarded and repeated with
   nothing else running, and passed.
3. **P36R2, run 1:** Scenario 4 got `POST /api/auth/login 429` (request #103 in its
   minute). Scenario 5 timed out because `Main Branch` was not in the selector at
   all, a real fixture-isolation problem (below). Fixed with pacing and test-owned
   branches.
4. **P36R2, run 2:** Scenario 1's `Main Branch (MAIN01)` check hit the 5s default
   with 0 429s, while Step 1 was still on "Loading your branches…" against a cold API.
   Fixed with an explicit 15s timeout. Step 1 has depended on the assigned-branches
   query since P37.

After all four runs, the shared staff fixture had no open attendance, and no branch
created by these runs remained active.

Other checks: the P37 integration suite passed 19/19, including both new cascade
tests; the full API suite passed 166 files / 2901 tests (15 env-gated files skipped,
same as before); `pnpm run type-check` passed; `pnpm run lint` reported 0 errors; and
both `apps/api` and `apps/web` built. An ad hoc strict `tsc` of the four specs passed.
The web app source was not changed by P37R.

### Local test-infra notes

- **Rate limiting:** the global `apiLimiter` (100 req/min, in-memory) is mounted
  before any router's `authenticate`. Its "user id when authenticated" key therefore
  never applies, and locally every request, logins included, shares the single
  127.0.0.1 bucket. All four specs now wait out the 1-minute window before each test.
  Their timeouts include that wait, because hooks share the test timeout. Limits were
  not changed or bypassed. Run each spec against a freshly started API process: the
  login limiter's 15-minute window is also in-memory.
- **Fixture cleanup (P37R):**
  - P36R6's `afterAll` now clocks the shared staff fixture out and deactivates its
    two branches. Before, it left both behind, which broke later specs' terminals and
    branch selectors.
  - P36R clears any stale staff attendance before it starts and clocks out after.
  - P37 clocks out defensively in `afterAll`, since `sellOneAt` only clocks out on
    success.
  - P36R2 Scenario 5 now switches between two branches it creates and deactivates
    itself, instead of the seeded `Main Branch`/`Second Branch`.
- **Leftover local data, deliberately not cleaned:** the local DB has about 200 active
  branches, mostly from older suites (P28, P34R2, P36R2P, P36R4…), plus 14 P36R6/P37
  branches leaked by runs before this fix. The admin selector lists 100, newest first,
  so seeded branches fall off the list on a long-lived DB. That is why Scenario 5 uses
  its own branches. The same 100-branch cap also exists in the real admin UI. It does
  not matter at pilot scale, but it is noted here.
