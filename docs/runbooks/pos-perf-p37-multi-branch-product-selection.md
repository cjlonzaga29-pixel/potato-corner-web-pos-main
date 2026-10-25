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

## Rollout compatibility

1. Apply the migration before (or together with) the API deploy. The column is
   additive with a default, so the currently deployed API is unaffected by it.
2. Deploy the API before the web app. Old web builds keep sending
   `branch_exclusive`/`exclusive_branch_id` and keep working. The new builder needs
   `branch_ids` and `/publish-branches`.
3. Existing products are untouched. All rows get `branch_selection_scoped = false`.

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

### Local test-infra notes

- The global `apiLimiter` (100 req/min per IP, in-memory) is easily exhausted by
  back-to-back browser specs on one machine. The P37 spec waits out the 1-minute
  window between tests. Run each browser spec against a freshly started API (see
  `docs/decisions/POS-PERF-P36R6-branch-copy-browser-verification.md` §4).
- Pre-existing cross-spec leaks: P36R6 leaves the shared staff fixture clocked in at
  its own branch and leaves its test branches active, which breaks P36R's checkout and
  P36R2 Scenario 5 when run afterwards. The P37 spec clocks the staff fixture out and
  deactivates its own branches in `afterAll`.
