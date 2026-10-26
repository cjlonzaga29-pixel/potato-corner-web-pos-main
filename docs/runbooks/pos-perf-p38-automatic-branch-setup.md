# POS-PERF-P38 — Automatic Selected-Branch Setup

## What supervisors saw

Review in the Product Builder showed, for a product whose branches had been
selected in step 1:

> Cheese Fries is not available at this branch.
> Recommended action: Enable the product for this branch under Branch Availability.

with **Add to POS** disabled. "Enabling it under Branch Availability" *is* Add
to POS, so the message asked for the action it was blocking.

## Proven root cause

Reproduced over HTTP against a local API (`pos_verify`). The script followed the
builder's own call sequence: create with `branch_ids [A, B]`, two sizes, recipe
components, a flavor, then `GET /readiness` per branch, then
`POST /publish-branches`.

| Case | `GET /readiness` at A and B | Client `isReadyToPublish` | `POST /publish-branches` |
| --- | --- | --- | --- |
| Every recipe item already has an `InventoryStock` row at A and B | `NOT_READY`, 90.91%, blocking = `BRANCH_NOT_AVAILABLE` × 2 (one per size) | `true` | 200 |
| One recipe item has no `InventoryStock` row at A/B | `NOT_READY`, 81.82%, blocking = `BRANCH_NOT_AVAILABLE` × 2 + `INVENTORY_STOCK_MISSING` × 2 | `false` (button disabled) | **409 `PRODUCT_NOT_READY`**, both branches, `INVENTORY_STOCK_MISSING` |

So there were two problems:

1. **The real blocker was `INVENTORY_STOCK_MISSING`, a circular gate.** A
   valid, shared inventory item with no `InventoryStock` row at a selected
   branch blocked publication both on the client and on the server. Recipe
   pickers list every active item no matter where it is stocked. Such rows go
   missing in normal operation: branch creation only fans out *tracked* items,
   and items seeded or initialized before a branch existed never got a row
   there. The only fix was a separate inventory branch-assignment action,
   outside the builder.
2. **The visible message was a false blocker.** Readiness reports
   `BRANCH_NOT_AVAILABLE` for every unpublished variant. It was listed first,
   once per size and again in the product-level list, as "blocking", next to a
   completion percentage. Both client and server already excluded it from the
   gate, so it never actually disabled the button. But it hid the real reason
   and pointed supervisors to the wrong page.

The P37 tests did not catch this. Their fixtures pre-created the stock rows at
the selected branches, and the case without rows was asserted as "Add to POS
stays disabled".

## Behavior after P38

### One decision for Review and Add to POS

`buildPublicationPlan` (products.service.ts) is the single decision. Review
reads it through `GET /api/products/:id/publication-check?branch_ids=a,b`
(read-only, writes nothing). `POST /api/products/:id/publish-branches` runs the
same function inside its transaction. The button can no longer disagree with
the server.

It separates two things the old checklist mixed together:

- **Configuration completeness** (blocks Add to POS): an active size with a
  positive price; a recipe on every size; no archived item or zero quantity in
  a recipe; required Mix & Max slots with a branch-available snack; and two new
  checks that checkout already failed on but readiness never checked:
  - `UNIT_CONVERSION_MISSING`: a recipe or option unit with no conversion to
    the item's base unit (item-specific or global, either direction, the same
    lookup order as `convertQuantity`). Checkout rejected these with
    `RECIPE_INVENTORY_UNIT_MISMATCH`.
  - `REQUIRED_CHOICE_EMPTY`: a required option group (or `min_selections > 0`)
    with fewer active options than it requires.
  - `OPTION_INVENTORY_ITEM_ARCHIVED`: an active option mapped to an archived
    item. Checkout rejected these with `PRODUCT_OPTION_INVENTORY_INACTIVE`.
- **Current branch availability** (does not block):
  - `BRANCH_NOT_AVAILABLE`: the state Add to POS changes.
  - `INVENTORY_STOCK_MISSING` for a valid item: setup that Add to POS performs.
  - `FLAVOR_NOT_AVAILABLE_AT_BRANCH`: shown as a notice. That flag is a
    branch's own manual or stock-out setting; checkout keeps refusing that
    flavor there.

Each blocking issue carries the builder step that fixes it (`details` /
`sizes` / `ingredients` / `choices`). Issues are de-duplicated across sizes
and branches, and worded for supervisors ("Regular: add at least one
ingredient or packaging item.").

Product readiness (`productReadinessService`) is **unchanged**. The POS
catalog and checkout still gate on it, so checkout still refuses an
unpublished product, a missing stock row, or a disabled flavor.

### Exactly what Add to POS writes

All of this happens in one `prisma.$transaction` under the product's existing
advisory lock (`productCatalogLockId`), after re-checking the actor's **live**
assignment to every branch and the branch-spread guard:

| Write | Where | Detail |
| --- | --- | --- |
| `inventory_stocks` insert | Only the selected, authorized branches; only for items the product actually uses | Items come from the active recipe components of the product's eligible sizes (base and flavor-specific), plus the inventory mappings of active options in active option groups assigned to those sizes. A row is inserted only where the `(branch, item)` row is absent. It uses `universalInventoryRepository.createStockRows` (`createMany … skipDuplicates`, the same primitive branch and item provisioning use), so every column is a default: on hand 0, reserved 0, thresholds/cost null. Presence of every planned pair is re-read inside the transaction before publishing. |
| `branch_product_availability` upsert | The selected branches | `is_available = true`, unchanged from P37. |
| Audit | After commit | One `INVENTORY_ITEM_BRANCH_ASSIGNED` per item (`source: 'product_publication'`, `product_id`, `assigned: [branch ids]`), plus the existing per-branch `PRODUCT_BRANCH_AVAILABILITY_CHANGED`. |

**Reused, never copied or modified:** the product, its sizes, recipe
components, flavor links, option groups and options, inventory items, units
and conversions. All of these are global catalog rows shared by every
selected branch.

**Never written:** existing stock rows (balance, reservation, thresholds,
cost, version, timestamps), stock movements or ledger receipts, deductions,
`BranchFlavorAvailability`, unit conversions, archived/inactive definitions
(archived items are excluded from setup and reported instead), other
products (Mix & Max snack products are not auto-published), unselected
branches.

**Atomicity and retry:** any failure (one branch not ready, revoked
assignment, an error at the second branch) rolls back every stock row and
availability flip. Repeating Add to POS creates nothing (`setup.stock_links:
[]`). The response now includes `setup.stock_links` (`[{ branch_id,
inventory_item_id }]`).

**Zero stock is not missing setup.** A branch whose rows exist at zero is
"Ready to add to POS". The sale is stopped at checkout with
`INSUFFICIENT_STOCK` (a missing row and a zero row behave the same in the
reservation `UPDATE`). Creating zero rows can never make an unfulfillable
sale succeed.

### Review UI

- Lists the selected branches and explains that sizes, recipe, flavors and
  options are set up once and shared, and that stock is tracked separately
  at each branch.
- Per branch: **Ready to add to POS** / **Missing setup** / **On POS**, the
  items Add to POS will add to that branch's inventory at zero stock, and any
  notices. Overall: **Not added to POS yet** until published.
- **Missing setup** card: each issue has a **Fix** button that jumps to the
  right builder step.
- Removed from the builder: the readiness checklist (completion percentages,
  duplicate per-size `BRANCH_NOT_AVAILABLE` rows, "Manage Branch
  Availability"), and the Ingredients step's per-branch "Inventory
  Incomplete" badge, which reported setup Add to POS now does. The admin
  product page keeps the full readiness checklist.
- A failed Add to POS or product create stays on screen inline
  (`BuilderWriteError`). The form, branch selection and created product id
  are kept. Only a real `SERVICE_WRITE_GATE_CLOSED` response is described as
  maintenance; any other error shows its own message. Errors now carry the
  API code (`ProductApiError`).
- Save Draft is unchanged: nothing is published anywhere.

## Unchanged

- Selected-branch scope and P37R's cascade fix; `assertSupervisorMayEnableAtBranch`.
- Full-coverage authority for editing shared configuration; branch copy and replacement.
- Checkout's branch-local reservation and deduction, and sale snapshots.
- Legacy shared and branch-exclusive products. A single-branch builder
  product also goes through `publish-branches`, so it gets the same setup.
- ~~The product page's per-branch **Publish** (`POST /:id/publish`) and the
  availability endpoints keep their P37 gate, which still blocks on
  `INVENTORY_STOCK_MISSING`. Automatic setup exists only on the builder's Add
  to POS.~~ Superseded by **P38R** below: the product page's Publish now runs
  the same publication operation. (Correction: the availability `PATCH`
  endpoints never had a readiness gate. See P38R.)
- No schema change, no migration.

## Rollout compatibility

| Combination | Behavior |
| --- | --- |
| New web + old API (the normal window, until migrate + Render finish; see P37R) | Review calls `/publication-check`, which the old API doesn't have (404). Review shows "Couldn't check this product" and **Add to POS stays disabled**. Nothing is written. Builder publishing is unavailable in this window; create/sizes/recipe/choices work. Product page per-branch Publish still works. |
| Old web + new API | Works. The old Review gates on readiness (missing links keep its button disabled, as before). Clicking Add to POS on the new API also performs setup. The extra `setup` field in the response is ignored. |
| Write gate (P16) | `publish-branches` is gated (503); `publication-check` is a GET and is not. The builder shows the persistent inline maintenance message. |

## Rollback

- **Web only:** safe. Old Review behavior returns.
- **API:** safe. Zero-stock rows created by P38 are ordinary, valid
  `InventoryStock` rows, the same as branch/item provisioning creates. They
  are left in place, since balances may already have moved. Products
  published through P38 stay published. The old API's publish blocks again
  on any still-missing links. To list what P38 set up:
  `audit_logs WHERE action = 'INVENTORY_ITEM_BRANCH_ASSIGNED' AND
  after_state->>'source' = 'product_publication'`.
- No schema to roll back.

## Known limitations

- Readiness is still evaluated through the global Prisma client while the
  transaction holds the product lock, the same as P36R2/P37. Concurrent
  configuration writes that take the same lock are serialized. Stock rows
  are created and verified inside the transaction.
- The new configuration checks (conversions, required choices, archived
  option items) are part of the publication plan only. The POS catalog's
  readiness badge doesn't show them; checkout still rejects those sales as
  before.
- Audit entries are written after commit (existing pattern). A crash between
  commit and audit would lose the entry, not the data.

## Verification (local `127.0.0.1:5432/pos_verify` only)

Database: `DATABASE_URL`/`DIRECT_URL` were checked as `127.0.0.1:5432/pos_verify`
before any run. The verification used local Supabase storage only. Nothing
touched production data, config, or billing.

- **New:** `products.publication-setup.integration.test.ts`, **11/11** against
  real Postgres. Its recipe items start with no stock rows at the selected
  branches; no fixture pre-links them. It covers:
  - Review's plan is ready, with no `BRANCH_NOT_AVAILABLE` and no writes, while
    readiness itself is unchanged.
  - Links are created only at A+B (never at the assigned but unselected C), at
    zero, and A's existing 500/7/threshold/cost row is unchanged. No stock
    movements, plus audit entries.
  - Repeating Add to POS adds no rows.
  - Zero stock means ready.
  - A sale at A deducts only A; B at zero stock refuses with
    `INSUFFICIENT_STOCK`; B and C are unchanged.
  - An archived item is reported and never linked or revived.
  - A missing unit conversion is reported, none is invented, and adding the
    conversion makes the product ready.
  - A missing recipe and an empty required choice still block.
  - A disabled flavor shows as a notice.
  - A revoked branch gets 403 with no partial writes.
  - A simulated failure at the second branch rolls back the first branch's
    setup and publication.
- **Updated:** `products.multi-branch-selection.integration.test.ts` (P37),
  **19/19**. Its "missing inventory setup blocks" test now asserts automatic
  zero-stock linking, on its own branch. `products.router.test.ts` **22/22**
  (adds publication-check role gate, query validation, and pass-through).
  `use-products.test.tsx` **16/16** (publication-check query, maintenance code
  kept on the error).
- **Full suites:** API 167 files / 2917 tests passed (15 env-gated files
  skipped, same as before). Web 141 files / 1224 tests passed. API, web and
  shared type-checks pass. Lint has 0 errors (the changed files add no
  warnings). `pnpm build` passes for all 3 packages.
- **Browser** (built API `node dist/server.js` + `next build`/`next start`, a
  fresh API per spec, `--project="Admin Dashboard (Desktop)"`):

  | Spec | Result | 429s |
  | --- | --- | --- |
  | P38 automatic branch setup (new) | **2/2** (6.3 min) | 0 |
  | P37 multi-branch builder (test 4 updated to the new behavior) | **5/5** (7.5 min) | 0 |
  | P36R Mix & Max builder | **2/2** (3.0 min) | 0 |

  The P38 spec drives the real flow:
  1. Select A+B, add two sizes, ingredient + packaging per size, and a flavor
     per size.
  2. Review shows "Ready to add to POS" at both, the items each branch will
     get at zero stock, "Not added to POS yet", and no "not available at this
     branch", percentages, or "Manage Branch Availability".
  3. The write gate is closed: Add to POS gets 503, the inline maintenance
     message is still shown 6 s later, the builder is intact, and nothing is
     set up.
  4. The gate is reopened and Add to POS returns 200. Catalogs show the
     product at A and B, not at C. A's existing balance is untouched, the new
     rows are at zero, and C has none.
  5. A repeat publish returns 200 with no links. A sale at A deducts only A
     (potato 500 → 350, cup 100 → 99). The sale at B is refused with 409
     `INSUFFICIENT_STOCK`.
- **Not executed:** the P36R2/P36R6 browser specs and the mobile/PWA
  projects. They don't touch Review's publish path beyond what P36R/P37
  cover. The other single-publish paths are unchanged.

Two failed attempts before the final P38 run, both environmental or fixture
problems:

1. Review showed "Couldn't check this product — NOT_FOUND". The pre-change
   dev API process from the reproduction step still held port 4000, so the
   new build exited with `EADDRINUSE`. Fixed by stopping that process.
2. Test 2 got 400 assigning the staff fixture to two branches. Staff carry
   exactly one branch, so the spec now reassigns per sale, as P37 does.

Local leftovers: the reproduction script's `P38 Repro A/B/Home` branches and
`P38 Cheese Fries linked/missing-link` products stay in `pos_verify`, as with
earlier phases' local data. The spec's branches are deactivated in `afterAll`.

---

# POS-PERF-P38R — Consistent Product Publication

## Problem

After P38 there were two publish operations with different rules:

| Path | Gate | Missing `InventoryStock` link for a valid item |
| --- | --- | --- |
| Builder **Add to POS** (`POST /:id/publish-branches`) | `buildPublicationPlan` | Created at zero, then published |
| Product page **Publish** (`POST /:id/publish`) | Raw `productReadinessService` blockers minus `BRANCH_NOT_AVAILABLE` | **409 `PRODUCT_NOT_READY`**, and the button was disabled client-side (`isReadyToPublish`) |

The same product could be added from the builder but not published from its
own page. The page also gated on sale readiness: it skipped the unpublished
flag but not the missing link that publication itself can create.

## Shared operation

`products.service.ts` now has one transaction-aware operation, used by both
publish endpoints:

- **`publishWithinLock(tx, productId, branchIds, actor)`**. The caller holds
  `productCatalogLockId(productId)` in `tx`. It runs, in order:
  1. `loadPublicationTarget`: the product exists and isn't
     discontinued/archived; the actor's **live** assignment to every branch
     (`assertBranchSelectionAuthorized`: database, not JWT); active
     branches; the branch-spread guard (`assertSupervisorMayEnableAtBranch`:
     branch-exclusive and scoped-selection restrictions).
  2. `buildPublicationPlan` for **exactly `branchIds`**. If it isn't ready,
     it throws `PRODUCT_NOT_READY` (409) with `details.issues`,
     `details.branches` and `details.blocking_issues` (P38 shape). It writes
     nothing.
  3. `createStockRows(links, tx)` for the plan's `setup_items` at those
     branches only (`createMany … skipDuplicates`: on hand 0, reserved 0,
     thresholds/cost null; existing rows are never touched), then re-reads
     every planned pair inside the transaction (`PRODUCT_SETUP_FAILED` if
     any is absent).
  4. Upserts `branch_product_availability.is_available = true` at those
     branches only.
- **`recordPublicationSetupAudit`**: after commit, one
  `INVENTORY_ITEM_BRANCH_ASSIGNED` per item that this call actually linked
  (`source: 'product_publication'`). A retry links nothing and writes no
  assignment entry.
- `buildPublicationPlan` also keeps the pre-P38R single-publish guard: an
  `eligibleVariantCount === 0` result is always `NO_ELIGIBLE_VARIANTS`, even
  if readiness ever omitted that issue.

## Endpoint semantics

| Endpoint | Branches set up and published | Authorization (unchanged) | Response (unchanged) | Audit |
| --- | --- | --- | --- | --- |
| `POST /api/products/:id/publish` `{ branch_id }` (product page) | **Only `branch_id`.** Never the product's other selected branches. | `supervisorOnly`, `requireActiveSupervisor`, `requirePasswordChange`, `branchGuard`, plus the in-lock live re-check | `data`: one availability row (`branch_id`, `is_available`, …) | Setup entries + one `PRODUCT_BRANCH_AVAILABILITY_CHANGED` `{ productId, isAvailable: true }` |
| `POST /api/products/:id/publish-branches` `{ branch_ids }` (builder) | All requested branches, all-or-nothing | Unchanged (no `branchGuard`; in-service check of every id) | `{ product_id, branches, setup.stock_links }` | Setup entries + per-branch `PRODUCT_BRANCH_AVAILABILITY_CHANGED` with `publishedBranchIds` |
| `GET /api/products/:id/publication-check?branch_ids=` | Writes nothing | Unchanged | Unchanged plan | None |

`POST /:id/publish` error changes (status and code unchanged):

- A missing link for a valid item no longer returns 409. Publish creates it.
- `PRODUCT_NOT_READY` `details.blocking_issues` entries are now publication
  issues (`{ code, message, fix_step }`), the same shape as
  `publish-branches`. Before, they were the admin readiness shape. No client
  reads that field (the product page shows `error.message`).
- New possible errors from the live re-check, same as `publish-branches`:
  `BRANCH_SELECTION_INVALID` (422, inactive branch) and
  `BRANCH_ACCESS_DENIED` (403, assignment revoked after the request passed
  `branchGuard`).

### Other enable paths: reviewed, left unchanged

- `PATCH /:id/branch-availability/:branchId` and `/bulk`: these were never
  readiness-gated, in P37 or since. P38's runbook was wrong about that. No
  live UI calls them: `BranchAvailabilityPanel` is not mounted anywhere.
  Their single/bulk semantics are documented and covered by
  `products.bulk-availability-authority` and `products.partial-branch-authority`.
  Adding a gate would change those contracts, so they are unchanged. Checkout
  still refuses whatever isn't sale-ready.
- `POST /:id/replace-source` (branch copy → replacement): kept its own
  readiness gate (copy on, source off, both locks) to keep the replacement
  semantics. A copy uses the same items its source already sold at that
  branch. If an edited copy adds an item with no link there, replacement is
  still refused with `INVENTORY_STOCK_MISSING`, and the page's **Replace
  Source Product** button stays gated on `isReadyToPublish`, matching it.
- `changeProductStatus` restore cascade: unchanged (P37R).

## Product page UI

`/supervisor/products/:id` → **Variants, Flavors & Recipe** → **Readiness &
Publication**:

- Publish is enabled from `usePublicationCheck(product.id, [branchId])`: the
  same plan, for the one branch `POST /publish` will act on. It only runs
  while the product is unpublished there and the viewer has authority
  (`isOwner`). A missing link that Publish creates, or the unpublished state,
  never disables it.
- Ready: "Ready to publish." plus "Publishing also adds … to this branch's
  inventory at zero stock: …" (`publication-setup-items`).
- Genuine missing setup: "Fix the setup below before publishing." and the
  plan's actionable messages (`publication-issues`). A `details` issue links
  to Overview. Plan notices (e.g. a flavor turned off) are shown. A failed
  check shows "Couldn't check this product: …", and Publish stays disabled.
- A failed Publish stays on screen inline (`product-publish-error`). The
  page, tab and form state are kept. Only `SERVICE_WRITE_GATE_CLOSED` reads as
  "Publishing is paused for maintenance". Any other error shows its own
  message. `usePublishProduct` now throws `ProductApiError` (code kept) and
  refetches readiness and the plan on error instead of showing a toast.
- The readiness checklist is still shown, now headed **Sale readiness at
  this branch**. It is what the POS checks before each sale.
  `BRANCH_NOT_AVAILABLE` / `INVENTORY_STOCK_MISSING` are listed there until
  publication. Sale readiness, the POS catalog and checkout are unchanged, so
  an unpublished product is still never sold.
- The builder's inline error component moved to
  `components/products/product-write-error.tsx` (`ProductWriteError`) and is
  shared. The builder still renders it as `builder-write-error`.
- Scope note (unchanged behavior): the product page acts on
  `exclusive_branch_id`. A multi-branch builder product (P37) shows "This
  product has no assigned branch yet" there, and Add to POS in the builder
  remains its publish path. Single-branch isolation for multi-branch products
  is covered at the service level (below).

No schema change, no migration.

## Deploy overlap

| Combination | Behavior |
| --- | --- |
| New web + old API | The product page calls `/publication-check`. On a pre-P38 API (404) it shows "Couldn't check this product", and Publish stays disabled. Nothing is written. On a P38 API the check works, so Publish can be enabled for a missing-link product. The P38 `POST /publish` then returns 409 `PRODUCT_NOT_READY` (`INVENTORY_STOCK_MISSING`), shown inline. Nothing is written. Deploy the API first. |
| Old web + new API | Works. The old page gates on readiness, so missing-link products keep Publish disabled, as before. If it is clicked anyway (e.g. links exist), the new API publishes with the same result. The old page's toast shows errors. |
| Write gate (P16) | `POST /publish` gets 503. The page shows the persistent maintenance message, and nothing is set up. `publication-check` (GET) is not gated. |

## Rollback

- **Web only:** safe. The old product page gating returns.
- **API:** safe. Links created by P38R's single publish are ordinary
  zero-stock `InventoryStock` rows, the same as P38's. Leave them in place.
  Products stay published. The old `POST /publish` blocks again on any
  still-missing links. To list them: `audit_logs WHERE action =
  'INVENTORY_ITEM_BRANCH_ASSIGNED' AND after_state->>'source' =
  'product_publication'` (same as P38; single-branch entries have one id in
  `assigned`).
- No schema to roll back.

## Known limitations (P38R)

- Readiness and the plan still read through the global Prisma client inside
  the locked transaction (P36R2/P37/P38). Single publish now does the
  plan's extra reads (dependencies, stock pairs, conversions) inside the
  5 s interactive-transaction window, which is still one branch's worth of
  work.
- A repeat `POST /publish` to an already-published branch still writes a
  `PRODUCT_BRANCH_AVAILABILITY_CHANGED` entry, as before P38R. It never
  writes an assignment entry, because nothing is linked. The page hides
  Publish once a product is published.
- Assignment audit entries are written after commit (existing pattern).
- The availability `PATCH` endpoints and replacement keep their own
  semantics (above). They are not routed through the shared operation.

## Verification (P38R, local `127.0.0.1:5432/pos_verify` only)

`DATABASE_URL`/`DIRECT_URL` were checked as `127.0.0.1:5432/pos_verify` (host
and database printed, no credentials) before any run. The DB is the local
`potato-corner-pos-postgres-1` container. No production data, config,
billing, or credentials were touched. No `prisma migrate` was run.

- **New `products.single-publication.integration.test.ts`: 12/12** against
  real Postgres. Recipe items start with no links. It covers:
  - A product selected for A+B, published from the product page at A. A's
    links are created at zero, and A's existing 500/7/threshold/cost row is
    `toEqual` unchanged. B (selected, not requested) and C (assigned, not
    selected) get nothing. Only A is published and audited.
    `publication-check` for `[A]` agrees. B then reads `ready`.
  - Retry at A: no new rows, no new assignment entries.
  - Builder Add to POS then completes B only. A is untouched. Every
    (branch, item) link is audited exactly once across both paths.
  - Zero stock at a freshly linked, published branch: checkout gets
    `INSUFFICIENT_STOCK` and nothing changes.
  - Missing unit conversion, empty required choice and archived item: both
    paths return `PRODUCT_NOT_READY` with **identical** `blocking_issues`,
    with no links, publication or audit. No conversion is invented and the
    archived item isn't revived.
  - An unselected branch (scoped `PRODUCT_BRANCH_NOT_SELECTED`, exclusive
    `PRODUCT_BRANCH_EXCLUSIVE`), a revoked assignment (`BRANCH_ACCESS_DENIED`,
    re-checked live) and a never-assigned branch (403): no writes.
  - Concurrent `publishProduct(M)` ‖ `publishProductToBranches([M, N])`: both
    succeed, with 6 zero rows, each link audited once, and 2 availability
    rows.
  - A simulated failure inside single publish rolls back its links. A retry
    then succeeds.
- **Updated `products.service.test.ts`: 164/164.** The old "missing link
  blocks publish" case now asserts the link is created at the requested
  branch only. A new case asserts genuine `RECIPE_MISSING` still blocks.
- **All products + readiness suites:** 16 files / 307 tests passed. That
  includes P38 `publication-setup` 11/11, P37 `multi-branch-selection`
  19/19, `publish-safety` 8/8, `replace-source` 7/7,
  `restore-cascade-skip-replaced-branch` 1/1, `concurrency` 3/3,
  `bulk-availability-authority` 2/2, `partial-branch-authority` 15/15,
  `status-branch-guard` 7/7, `branch-isolation` 8/8 and router 22/22.
  `products.integration.test.ts` (22) is env-gated and skipped, as before.
- **Web:** new `supervisor/products/[productId]/page.test.tsx` 5/5 (Publish
  enabled despite a missing link and the unpublished state; the check is
  scoped to `[branchId]`; genuine issues disable it with the message; inline
  failure retains the screen; maintenance only for
  `SERVICE_WRITE_GATE_CLOSED`; no check once published). Existing
  `use-products`, builder and admin product tests: 52/52.
- `pnpm type-check` (4/4), `pnpm lint` (0 errors; the changed files have 0
  warnings) and `pnpm build` (3/3) pass.
- **Browser** (built API `node dist/server.js`, fresh process per spec;
  `next build` + `next start`; `--project="Admin Dashboard (Desktop)"`):

  | Spec | Result | Notes |
  | --- | --- | --- |
  | P38R product page Publish (new) | **2/2** (4.7 min) | 0 × 429. Log: `publish` 503 (gate) → 200 → 200 (retry); invalid product `publish` 409, `publish-branches` 409 |
  | P38 automatic branch setup (builder) | **2/2** (6.6 min) | Default config |
  | P37 multi-branch builder | **5/5** (8.0 min) | Needed a 15 s `expect` timeout, see below |
  | P36R6 branch copy / replace (product page, Replace Source) | **10/10** (11.4 min) | 15 s `expect` timeout (same temporary config) |

  The P38R spec drives the real page. It opens a builder-style product
  exclusive to A (potato already stocked at A, cup not linked) and checks:
  "Ready to publish." and "zero stock: <cup>", with Publish enabled. With the
  write gate closed, Publish gets 503, and the maintenance message is still
  on screen 6 s later, the page intact, nothing set up. With the gate
  reopened, Publish gets 200 with the unchanged row contract, and the page
  shows "Published at your branch" / "On POS at your branch.". A's potato is
  still 500/7/50, the cup is 0/0 at A, and B and C have nothing. One
  assignment entry; the catalog shows the product at A, not B; an API retry
  adds nothing. A kg-recipe product with no conversion shows the actionable
  message, Publish is disabled, and both endpoints return 409 with no
  writes.

- **Environment note (P37 timing):** P37 failed twice with the stock config,
  both times at its first assertion (Branch A checkbox, default 5 s). The
  page was still on "Loading your branches…" behind a 5.2–5.8 s token
  refresh (`auth.service` rotation cache; one hit Prisma's 5 s transaction
  timeout). Host CPU was at 94% (desktop apps outside the test run), and
  logins took 0.6–3.5 s. That step is in the builder's branch loading and
  auth, which P38R didn't change. P37 passed 5/5 unmodified with a
  temporary, uncommitted config that only sets `expect.timeout` to 15 s (the
  budget the P38 spec already gives that step). Rate limits were not
  changed.
- **Not executed:** P36R/P36R2 browser specs, the mobile/PWA projects, and
  the full API/web suites. Changes are limited to the products publish
  path, the product page and the builder's error component, which are all
  covered above.

Local leftovers in `pos_verify`: P38R spec branches (deactivated in
`afterAll`) and its products/items, as with earlier phases.
