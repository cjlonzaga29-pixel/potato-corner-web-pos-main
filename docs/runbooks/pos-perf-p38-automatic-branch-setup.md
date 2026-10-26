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

> Superseded for this release by **P38R2 → Release overlap** below. This
> table describes P38 alone. With P38R's web in the same push, the product
> page's Publish is also disabled against a pre-P38 API.

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

- ~~Readiness is still evaluated through the global Prisma client while the
  transaction holds the product lock, the same as P36R2/P37.~~ Fixed in
  **P38R2**: every publication read goes through the transaction. Concurrent
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

> Superseded by **P38R2 → Release overlap** below. "Deploy the API first"
> was wrong: the workflow cannot do that. Vercel deploys the web on push,
> before CI and approval let the API deploy.

| Combination | Behavior |
| --- | --- |
| New web + old API | The product page calls `/publication-check`. On a pre-P38 API (404) it shows "Couldn't check this product", and Publish stays disabled. Nothing is written. On a P38 API the check works, so Publish can be enabled for a missing-link product. The P38 `POST /publish` then returns 409 `PRODUCT_NOT_READY` (`INVENTORY_STOCK_MISSING`), shown inline. Nothing is written. ~~Deploy the API first.~~ |
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

- ~~Readiness and the plan still read through the global Prisma client inside
  the locked transaction (P36R2/P37/P38). Single publish now does the
  plan's extra reads (dependencies, stock pairs, conversions) inside the
  5 s interactive-transaction window, which is still one branch's worth of
  work.~~ Measured and fixed in **P38R2**: the 5 s window did not fit at a
  remote round trip, and the global-client reads could starve the pool.
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

---

# POS-PERF-P38R2 — Publication Transaction Budget and Release Readiness

## What was measured

`publishWithinLock` runs inside one interactive `prisma.$transaction` under
`productCatalogLockId`. At P38R (`893bb73`) that transaction:

- used Prisma's defaults: **2 s `maxWait`, 5 s `timeout`** (no options
  passed). Checkout, `closeShift`, refund and void pass
  `config.posTransaction` instead.
- read almost everything through the **global** Prisma client while holding
  a transaction connection: `findById` (detail include, 7 statements),
  branches, live assignments, publication dependencies (13), conversions (2),
  stock pairs, and **`evaluateProductReadiness` once per branch** (about 15
  statements each, about 11 of them re-reading the same variants).
- wrote availability with one upsert per branch (4 statements each).
- after commit, wrote hash-chained audit entries (a read of the last entry
  plus an insert each): one per linked item and one per branch.

Harness: `products.publication-budget.measure.test.ts`. It is opt-in
(`PUBLICATION_BUDGET_MEASURE=1`) and runs only against local Postgres. It
uses a Prisma client with query events and `connection_limit=5`
(production's pool, per `db-round-trip-diagnostics.ts`).
`PUBLICATION_BUDGET_RTT_MS` routes it through a local TCP proxy that delays
every packet by half the RTT in each direction. Scenarios:

| | Branches | Sizes | Components (recipe rows) | Distinct items (incl. option-mapped) |
| --- | --- | --- | --- | --- |
| S1 | 1 | 1 | 3 | 3 |
| S2 | 2 | 2 | 14 (ingredients, packaging, 2 flavor seasonings, 1 kg-entered item) | 10 (+1 required option group × 3 mapped options) |
| S3 | 4 | 3 | 33 | 19 (4 flavors, 2 option groups × 4) |
| S4 | 8 | 3 | 33 | 19 |

"First" is the first publish (it creates every link). "Repeat" publishes
again (no links). "In tx" counts the statements between `BEGIN` and
`COMMIT`. "Total" also counts the post-commit audit entries.

### Local Postgres, 0 ms added latency (127.0.0.1 Docker, `pos_verify`)

| Scenario | Before: in tx / total statements | Before: tx ms | After: in tx / total | After: tx ms |
| --- | --- | --- | --- | --- |
| S1 first | 35 / 43 | 301 | 30 / 38 | 164 |
| S1 repeat | 33 / 35 | 134 | 28 / 30 | 73 |
| S2 first | 66 / 90 | 609 | 42 / 66 | 367 |
| S2 repeat | 64 / 68 | 272 | 40 / 44 | 77 |
| S3 first | 104 / 150 | 827 | 42 / 88 | 154 |
| S3 repeat | 102 / 110 | 571 | 40 / 48 | 113 |
| S4 first | 180 / 234 | 857 | 42 / 96 | 202 |
| S4 repeat | 178 / 194 | 678 | 40 / 56 | 108 |

Before, the transaction grew by about 19 statements per branch. After, it
is **constant**: 28–30 for a single-branch product, 40–42 for this
configuration at any branch count. The post-commit audit chain still grows:
2 statements × (linked items + branches).

### Controlled latency (local proxy, same machine)

| Scenario | Before @100 ms: tx | After @100 ms: tx / request | After @150 ms: tx / request |
| --- | --- | --- | --- |
| S1 first | **P2028** at 9.0 s | 7.1 s / 8.2 s | 9.5 s / 11.1 s |
| S1 repeat | **P2028** at 6.4 s | 3.9 s / 4.2 s | 5.1 s / 5.4 s |
| S2 first | **P2028** at 12.3 s | 10.1 s / 13.3 s | 12.1 s / 17.0 s |
| S2 repeat | **P2028** at 9.5 s | 5.4 s / 5.9 s | 7.5 s / 8.3 s |
| S3 first | **P2028** at 15.5 s | 8.9 s / 15.3 s | 11.4 s / 19.4 s |
| S3 repeat | **P2028** at 12.4 s | 5.4 s / 6.4 s | 7.0 s / 8.5 s |
| S4 first | **P2028** at 19.7 s | 10.1 s / 17.2 s | 8.6 s / 17.6 s |
| S4 repeat | **P2028** at 17.3 s | 5.6 s / 8.4 s | 7.0 s / 9.9 s |

Before, every scenario failed at 100 ms, including the simplest single-branch
product. (P2028 is reported after Prisma's 5 s window. Elapsed times past
5 s are the time until the stalled reads returned.) After, every scenario
commits. Statements cost about 1.4 round trips each when warm (repeat) and
about 2.4 on the first run of a new SQL shape (prepare plus execute). That
gives tx ≈ 30–42 statements × 1.4–2.4 × RTT.

### Product-lock contention (same product, concurrent single-branch publishes)

| | Before | After |
| --- | --- | --- |
| 4 concurrent, 0 ms | All succeed, 1.3–5.1 s end to end (two runs) | All succeed, 0.8 s |
| 6 concurrent, 0 ms, pool 5 | **All 6 fail** (5 × P2028, 1 × P2024 pool timeout) after 10 s | All succeed, 1.1 s |
| 4 concurrent, 100 ms | **All 4 fail** (P2028) | 3 succeed; the 4th exceeds 30 s (P2028, rolled back) |
| 4 concurrent, 150 ms | n/a | 2 succeed; 2 exceed 30 s (P2028, rolled back) |

The 6-way failure at **zero latency** is a deadlock-like pool starvation, not
slowness. Each waiter holds a pool connection while blocked on the advisory
lock. The lock holder's global-client reads need one more connection, and
none is free until `pool_timeout`.

### Production evidence in this repository (not measured here)

- Database: Supabase, Sydney region (`docs/SYSTEM_OVERVIEW.md`). The Render
  region is not in version control.
- `f2cb843` (Task 209.55A): a real `closeShift` against "the QA
  environment's realistic DB latency" threw "Transaction already closed …
  5137 ms passed" under the 5 s default. The identical retry took 6602 ms.
  That transaction is about 6–7 statements. If that per-statement cost
  (~0.8–1 s) were representative of production, a 40-statement publication
  would need about 35–40 s.
- `f33e1a5` (P25): production Render checkout diagnostics showed latency
  "dominated by per-round-trip network latency".
- Phase 19 load test: HTTP median 90 ms, p95 1.11 s (whole requests, not
  database round trips).
- **No per-round-trip production figure is recorded in the repository.** The
  opt-in `DATABASE_ROUND_TRIP_DIAGNOSTICS_ENABLED` probe exists to measure
  it. It was not enabled for this task.

### Estimate (not a measurement)

An uncontended publication's transaction takes about 30–42 statements ×
1.4–2.4 round trips. That is roughly **40–100 × RTT**: 4–10 s at 100 ms,
6–15 s at 150 ms, and 30 s at about 300 ms.

The proxy adds fixed per-packet delay only. It does not model jitter, the
Supabase transaction pooler (PgBouncer) or TLS, and the database is local
and idle. Fast local Postgres proves nothing about the production budget.
These numbers bound the statement count, not production time.

## Changes (P38R2)

Transactions, the product lock, live authorization, branch-spread guards,
selected-branch restriction, all-or-nothing publication and the plan's
decisions are unchanged.

1. **Every publication read goes through `tx`.** `loadPublicationTarget`,
   `assertBranchSelectionAuthorized` (including the supervisor's live
   assignments via `getAccessibleBranchIds(actor, tx)`),
   `findPublicationDependencies`, unit conversions, stock pairs and
   readiness all take an optional client. `publication-check` (a GET, no
   transaction) still uses the global client. This removes the pool
   starvation. The checks stay inside the locked transaction.
2. **Readiness for all branches in one pass:**
   `productReadinessService.evaluateProductReadinessForBranches`. Variants
   are read once; product/flavor availability and stock are read with
   `branch_id IN (…)`, then split per branch through the same
   `buildReadinessResult`. Results are `toEqual` per-branch
   `evaluateProductReadiness` (regression-tested at branches in different
   states). Checkout's single-branch `fetchReadinessData` queries are
   unchanged; only its pure key/grouping code was extracted for sharing.
3. **Lean target read:** `productsRepository.findPublicationTarget` (status,
   exclusivity, scope, availability rows), 2 statements instead of
   `findById`'s 7.
4. **Batched availability write:**
   `productsRepository.publishBranchProductAvailability`. It runs
   `createMany … skipDuplicates`, then `updateMany` (`is_available = true`,
   `updated_by`, `updated_at`), then one read with the branch. That is 4
   statements in place of 4 per branch. The rows, order and response shape
   are unchanged.
5. **Transaction budget:** both publish endpoints pass
   `{ maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs }`
   (defaults 10 s / 30 s; `PRISMA_TRANSACTION_MAX_WAIT_MS` /
   `PRISMA_TRANSACTION_TIMEOUT_MS`).

Not changed: missing-link creation was already one `createMany`. Audit
entries keep their per-item shape, one `INVENTORY_ITEM_BRANCH_ASSIGNED` per
item that this call actually linked (with its branch list), plus the
per-branch availability entries. Both stay after commit. They were not
batched: `recordAuditLog` chains each entry to the newest existing one, and
rows inserted by one statement would share `created_at`, which breaks that
"newest" lookup.

### Why the timeout change is justified (and its tradeoff)

- **Measured budget:** after the statement reductions, a publication is
  still 30–42 sequential statements. That is about 4–10 s at a 100 ms round
  trip and failed every scenario under 5 s. Reducing statements alone cannot
  fit 5 s at a realistic remote round trip.
- **Bounded size:** the transaction's statement count no longer depends on
  the branch count. Row volume is bounded by the product's own
  configuration (links = branches × distinct items, inserted by one
  statement).
- **Lock duration:** the transaction holds `productCatalogLockId` for one
  product only. It delays configuration writes and publications of that
  product. **Checkout never takes this lock.** The only row locks are on
  newly inserted `inventory_stocks` pairs and on that product's
  `branch_product_availability` rows, which checkout reads without locking.
  A waiter's 30 s includes its wait for the lock, so same-product
  publications queue at 30 s divided by the per-publication time (see
  contention above). A timed-out waiter rolls back and is safe to retry.
- It reuses the existing configured budget, as `closeShift` did in
  `f2cb843`. It does not invent a new value.

## Release overlap (this release: `157deac` → P38 + P38R + P38R2)

`origin/main` was `157deac` (P37R) when this was written. The release diff
contains **no Prisma schema or migration change** (`git diff
157deac..HEAD -- apps/api/prisma` is empty). Production's `migrate deploy`
step is therefore a no-op.

**Actual deploy behavior** (`.github/workflows/deploy-production.yml`):

1. On push to `main`, Vercel's GitHub integration builds and serves the new
   `apps/web` **independently**. It is not part of the workflow.
2. The workflow runs full CI (type-check, lint, all tests, build), then
   **waits for manual approval** (the `production` environment).
3. It runs `prisma migrate deploy` (no-op here), then `curl`s the Render
   deploy hook. That only means Render accepted the request; Render then
   builds and swaps asynchronously.

The new web is therefore normally live **before** the new API, from minutes
after the push until approval plus the Render deploy finish. "Deploy the API
first" is not something this pipeline does, and nothing here changes the
automation.

| Combination | When | Behavior (verified by) |
| --- | --- | --- |
| **New web + pre-P38 API** (P37R) | The normal window above | Builder Review and the product page both call `GET /publication-check`. The old API returns `404 NOT_FOUND`. Review shows "Couldn't check this product", and **Add to POS is disabled** (`canAddToPos` requires a plan). The product page shows "Couldn't check this product: …", and **Publish is disabled** (`canPublish` requires `plan.ready`; new page test). **Nothing is written.** Creating products and editing sizes, recipe and choices work, as does Unpublish. It is a publishing outage, not a data risk. Before this release the old page could still publish fully linked products; in this window it cannot. |
| **New web + P38 API (before P38R)** | Only if `e4442d9` is deployed alone, or the API is rolled back to it. One push of this release builds only `HEAD`. | Builder Add to POS works, with setup. The product page's check works, so Publish is enabled for a missing-link product. P38's `POST /publish` still gates on raw readiness and returns `409 PRODUCT_NOT_READY` (`INVENTORY_STOCK_MISSING`), thrown before any write and shown inline (`product-publish-error`; page test). Fully linked products publish. P38's transaction keeps the 5 s default and the per-branch reads (budget above). |
| **Old web + new API** | Vercel rollback, or a tab still on the old bundle | Works. The old builder and page gate on readiness: missing-link products keep their buttons disabled, as before. When enabled, the new `publish-branches` / `POST /publish` publish with setup. Response shapes are unchanged (the batched write returns the same row shape); `setup` is an extra field. The old UI shows errors as toasts. |
| **Old and new API instances** | Render swap overlap | Both use the same tables and the same `productCatalogLockId`, so publications serialize across instances. |

**Form retention and recovery once the API is live:**

- Builder: `productId`, `step` and `draftBranchIds` persist in localStorage
  (`potato-corner:product-builder-draft`). Every step's data is already
  saved on the server, so a reload returns to Review with nothing lost.
- The failed check is not re-run automatically. The query client uses
  `retry: 2` and `refetchOnWindowFocus: false`, so after the 2 retries the
  error stays until the Review step or page remounts. **Recovery:** reload
  the page, or in the builder go Back and then to Review again. The check
  then succeeds, and Add to POS or Publish becomes available.
- A product created during the window stays unpublished (its branch rows
  are unavailable) until someone publishes it. No partial publication is
  possible.

**Write gate (P16):** `POST /publish` and `/publish-branches` (all
`/api/products` writes) and checkout/inventory writes get
`503 SERVICE_WRITE_GATE_CLOSED`. `GET /publication-check` is not gated. The
builder and product page keep the persistent inline "paused for
maintenance" message, with the form and page intact (re-verified in today's
P38/P38R browser runs).

- The gate does not cover the new-web/old-API window. That window starts at
  the push. Closing the gate for the whole of CI plus approval would also
  stop every checkout, and nothing is written in that window anyway.
- Its use is the API swap: close it just before approving the production
  run, let migrate (no-op) and Render finish, confirm the new API is
  serving, then reopen it.
- **Evidence rules:**
  - Gate state is what `GET /api/settings/write-gate` (Super Admin) returns,
    `enabled` plus `activeGatedRequests` on the serving instance. A `401`
    only says the request was unauthenticated.
  - A successful hook `curl` only says Render accepted a deploy.
  - Workflow, Vercel or Render timestamps do not prove which commit is
    serving. `GET /health` returns only `{ status: 'ok' }`; the API exposes
    no version.
  - Confirm the running API commit in Render's dashboard (the live deploy's
    commit). A `200` from `GET /api/products/:id/publication-check` shows
    only that the API is P38 or later. P38, P38R and P38R2 cannot be told
    apart over HTTP.

**Rollback:**

- **Web only (Vercel):** safe. This is "old web + new API" above.
- **API back to P38R:** functionally identical, minus this budget work. The
  5 s default and the per-branch reads return, and so does the starvation
  risk under concurrent publishes.
- **API back to P37R:** safe for data. Zero-stock links created by P38/P38R
  are ordinary rows; leave them. Published products stay published. The old
  API's `POST /publish` blocks again on still-missing links. The current web
  then behaves as "new web + pre-P38 API": publication is disabled and
  nothing is written. Rolling back the web as well restores P37R behavior.
- There is no schema to roll back. To list the links publication created:
  `audit_logs WHERE action = 'INVENTORY_ITEM_BRANCH_ASSIGNED' AND
  after_state->>'source' = 'product_publication'`.

## Remaining limitations

- **Production round-trip latency is not measured.** Everything above about
  production time is an estimate. If the `f2cb843` QA figure (~0.8–1 s per
  statement) reflected production, publication would exceed 30 s. Before
  relying on Add to POS in the pilot, read one `DATABASE_ROUND_TRIP_DIAGNOSTICS_ENABLED`
  probe, or time one real publication on the deployed API. Turning that
  flag on is a Render environment change and was not made here.
- **Same-product concurrency:** publications of one product serialize on its
  lock. At 150 ms, 2 of 4 simultaneous publications exceeded 30 s; they
  rolled back cleanly and are safe to retry.
- **Request time after commit:** the hash-chained audit entries cost 2
  statements each, after the transaction. On a first publish of S4 that was
  about 9 s of extra response time at 150 ms. The data is already committed;
  a client that gives up early sees an error for a publication that
  succeeded, and a retry is a no-op. The web client sets no request timeout.
- A publication holds one pool connection (of 5) for the whole transaction:
  about 4–15 s at 100–150 ms. Several simultaneous publications of different
  products compete with checkout for the pool. This was not load-tested.

## Verification (P38R2, local `127.0.0.1:5432/pos_verify` only)

`DATABASE_URL`/`DIRECT_URL` were checked as `127.0.0.1:5432/pos_verify`
(host, port and database printed; no credentials). No `prisma migrate` was
run. No production data, configuration, billing, credentials, region, pool
or `autoDeploy` setting was touched.

- **New `products.publication-budget.integration.test.ts`: 4/4** against real
  Postgres, with a 5-connection pool and SQL capture. All 4 fail on the
  pre-P38R2 code (verified by stashing the production changes: 140 vs 46
  in-transaction statements; all 6 concurrent publishes rejected):
  - batched readiness `toEqual` per-branch readiness at a published/stocked
    branch, a branch with no links, and a branch with the flavor turned off;
  - publication to 6 branches issues the same number of in-transaction
    statements as to 1 (both ≤ 45);
  - 6 concurrent publications of one product all succeed, with each link
    created and audited exactly once;
  - the batched availability write flips an existing unavailable row,
    creates the absent one, and keeps branch order and row shape.
- **Updated:** `products.service.test.ts` (publish tests use the new
  repository and readiness calls, and assert every publication read goes
  through `tx` with the configured transaction options).
  `branch-access.test.ts` (+1: the client pass-through). The P38/P38R
  rollback integration tests now inject the failure after the batched
  availability write has written every branch, and still roll back setup
  and availability.
- **Web:** product page test **6/6** (+1: a failed publication check, the
  pre-P38-API case, keeps Publish disabled and the page intact).
- **Affected API suites:** products, product-readiness, transactions
  (checkout shares the readiness module), branches and `src/lib`: **44
  files, 981 passed**, 80 skipped (env-gated, as before), 0 failed.
- `pnpm type-check` 4/4. ESLint on every changed file: 0 problems. `apps/api`
  build (`tsc`) passes. The web build was not re-run: no web source changed
  (only a test), and the existing `.next` build is newer than every web and
  shared source file.
- **Browser** (built `apps/api` `node dist/server.js`, fresh per spec;
  `next start`; `--project="Admin Dashboard (Desktop)"`): **P38R product
  page Publish 2/2** (4.0 min), **P38 builder Add to POS 2/2** (6.2 min),
  both with the default config.
- **Not executed:** the P37 multi-branch and P36R/P36R6 browser specs (they
  share `publish-branches` with the P38 spec, which passed), the
  mobile/PWA projects, the full API and web suites (changes are limited to
  publication, readiness's shared helpers and three repository signatures,
  all covered above), and any production measurement.

Local leftovers in `pos_verify`: the `P38R2 …` test branches are deleted
(regression suite) or deactivated (measurement harness) in `afterAll`; the
browser specs' data stays, as with earlier phases.
