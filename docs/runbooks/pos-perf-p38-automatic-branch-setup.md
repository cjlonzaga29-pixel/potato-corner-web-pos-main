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
  *P38R4: now durable intents committed with the publication, see below.*
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

---

# POS-PERF-P38R3 — Post-Commit Result and Retry Safety

## Commit → audit → response (traced at `06621fe`)

Both publish endpoints run the same sequence (`products.service.ts`):

| Step | Builder Add to POS (`POST /:id/publish-branches`) | Product page Publish (`POST /:id/publish`) |
| --- | --- | --- |
| 1. Transaction | `prisma.$transaction` (10 s / 30 s budget): advisory lock, `publishWithinLock` for all requested branches | Same, for `[branch_id]` |
| 2. **Commit boundary** | `$transaction` resolves. Links and availability are durable and visible to every reader from here on | Same |
| 3. Audit, after commit, awaited in order | One `INVENTORY_ITEM_BRANCH_ASSIGNED` per linked item, then one `PRODUCT_BRANCH_AVAILABILITY_CHANGED` per branch. Each entry is 2 statements on the global client (read the chain tail, insert) | Same, one availability entry |
| 4. Response | `200` after the last audit entry | `200` after the audit entries |

- **Errors after commit never reached the client** (before and after
  P38R3). `recordAuditLog` swallowed every failure. P38R3's
  `recordCommittedAuditLog` also never throws. Nothing else runs after
  commit. A response sent after commit is always `200`.
- **A `200` is not guaranteed after commit.** The response waits for the
  audit chain (2 statements per entry; P38R2 measured about 9 s for S4's
  first publish at 150 ms RTT). A dropped connection, a tab closed or
  suspended, an API restart, or a proxy `502`/`504` in that window loses
  the answer to a publication that committed. A `P2028` raised while Prisma
  commits can, in principle, also be ambiguous. All of these reach the
  client as `NETWORK_ERROR`, `UNREADABLE_RESPONSE` (non-JSON body) or
  `500 INTERNAL_ERROR`.
- **Before P38R3 the client showed a committed publication as a failure.**
  Builder: "Couldn't add to POS. Could not reach the server…". A proxy page
  showed "Checkout could not be confirmed. Please check Receipts…"
  (`UNREADABLE_RESPONSE`'s checkout text). Product page: "Couldn't publish
  this product". Neither said "rolled back" (the `PRODUCT_NOT_READY` text
  "Nothing was published" is only used before any write), but both claimed
  a failure for a success. The supervisor's natural recovery was to retry.
- **Retry before P38R3:** links were never duplicated (`skipDuplicates`,
  then only missing pairs are planned), and assignment entries were never
  duplicated (written only for links this call created). Availability was
  re-written every time, though. `updated_by`/`updated_at` changed, and a
  new `PRODUCT_BRANCH_AVAILABILITY_CHANGED` entry was written for every
  branch, every time. This was pre-existing (P37 upsert / P38R2 batched
  write), but this flow makes the retry the expected recovery.

## Fault injection (real Postgres, `127.0.0.1:5432/pos_verify`)

`products.publication-result.integration.test.ts` injects faults with a
Prisma `$use` middleware on `AuditLog.create` only. **Against the unmodified
`06621fe` code: 6 of 8 failed.** All 8 pass after the fix.

| Case | Before (`06621fe`) | After |
| --- | --- | --- |
| Slow audit (400 ms per insert, 6 entries): is the publication committed while the call is still pending? | Yes: visible to another connection before the call returned (~2.0–2.3 s total). Passed. | Same (unchanged semantics) |
| Retry after a lost response (sequential) | No new links or assignment entries, but **+1 availability entry per branch**, and the rows' `updated_at`/`updated_by` were rewritten | Nothing written. Rows are byte-identical. Same `200` body shape, `setup.stock_links: []` |
| 3 concurrent retries of an already-published operation | **+6 availability entries** (2 branches × 3) | Nothing written |
| 3 concurrent first publications (racing retry) | **6 availability entries for 2 branches** | Exactly 2 |
| Single-branch Publish retry | **+1 availability entry** | Nothing written |
| Transient audit failure (first 2 inserts fail) | **Entries silently lost** (console only), response `200` | Retried. Every entry is written exactly once. No Sentry event |
| Lost reply to an audit INSERT that landed | (no retry existed) | The retry finds the attempt's hash and does not write it again. All hashes unique |
| Persistent audit outage | **Silently lost**, no Sentry event | Publication still answers `200` (it committed). Each missing entry goes to Sentry and to an `AUDIT_ENTRY_NOT_RECORDED` error log with the full entry. A retry after the outage writes no links |

## Fixes

API:

1. **Retry writes nothing for already-published branches.**
   `publishWithinLock` returns `newlyPublished`: the branches the plan
   (read in the transaction, under the product lock) showed as *not*
   published. Only those get a `PRODUCT_BRANCH_AVAILABILITY_CHANGED` entry.
   `publishBranchProductAvailability`'s `updateMany` now matches
   `is_available = false` only, so an already-on row keeps its
   `updated_by`/`updated_at`. A concurrent duplicate waits on the product
   lock and then sees the first one's commit (READ COMMITTED), so it writes
   nothing. Response shapes are unchanged.
2. **Required audit entries are no longer dropped silently.**
   `recordCommittedAuditLog` (audit-log.ts), used for every publication
   entry:
   - It retries a failed append (after 250 ms and then 1 s), re-reading the
     chain tail each time, so it goes through the same hash chain.
   - Before a retry it looks up the previous attempt's `current_hash` (via
     the `(entity_type, entity_id)` index). A lost reply to an INSERT that
     landed is never written twice.
   - If all 3 attempts fail, it sends `Sentry.captureException` with the
     entry, plus a structured `AUDIT_ENTRY_NOT_RECORDED` error log with the
     full entry, so it can be re-entered. It does not throw: the data
     committed, and the response must say so.
   - `recordAuditLog` (everyone else) is unchanged. Its body moved into a
     shared throwing `appendAuditLog`.

Web:

3. **Reconcile before claiming failure.** `usePublishProductToBranches` and
   `usePublishProduct` treat `NETWORK_ERROR`, `UNREADABLE_RESPONSE`,
   `INTERNAL_ERROR` and a code-less error as **unconfirmed**. Every other
   code is a rejection the API makes before writing, and it is shown as
   before. For an unconfirmed error, the hook reads
   `GET /publication-check` (read-only) for the same branches:
   - published at every branch → the mutation **succeeds** (normal toast,
     invalidation; the builder goes to the product page);
   - not published → `PublicationNotConfirmedError('not_published')`:
     **"Not on POS yet** … If the earlier attempt is still finishing, it
     will show up when you check again. Trying again is safe: it never adds
     anything twice." Add to POS / Publish stays available;
   - the check fails → `PublicationNotConfirmedError('unknown')`: **"Could
     not confirm whether this was added to POS** … It may already be on POS.
     Check again before trying to add it." Add to POS / Publish is
     **disabled** until a check settles it (the last cached plan may be
     stale).

   Both show a **Check again** button (`useConfirmPublication`). It only
   reads, refreshes the product, readiness, catalog and plan, and never
   publishes. Builder state and the persisted draft are kept. Once the plan
   shows the product on POS, the unconfirmed alert is replaced by the
   normal "On POS" / "Already on POS" state. The publish is never repeated
   automatically.
4. **Service-worker cache bypass for that read.** next-pwa's default
   runtime caching serves same-origin `/api/*` GETs network-first, with a
   **10 s network timeout and a cached fallback** (24 h, 16 entries). Review
   had just cached a plan from *before* the publish. Offline, or with no
   answer within 10 s, the check returned that stale plan, and the UI said
   **"Not on POS yet" for a publication that had committed** (reproduced in
   the browser, below). `readPublicationOutcome` adds a unique `fresh=` to
   its URL, so no cache entry can match. The read then fails and gives
   `unknown`. The API's `publicationCheckQuerySchema` strips the extra key
   (works against old and new APIs).

Unchanged: the transaction, product lock, live authorization, branch-spread
guard, selected-branch scope, all-or-nothing multi-branch publication, the
plan, and the transaction budget. No schema change, no migration, no new
library.

### Why not move audit into the transaction, or add a durable outbox

> Superseded by **P38R4** (below): the crash window this section accepted
> is closed by a durable audit outbox.

- **In the transaction:** each entry is 2 more sequential statements (a
  first S4 publish has 27 entries, 54 statements). That brings back the
  per-entry growth P38R2 removed, and the timeout risk with it. The chain
  reads its tail with `ORDER BY created_at DESC` and no lock. Inside a
  multi-second transaction, other requests would chain to an older tail
  until commit, so forks become far more likely. A single batched insert
  gives rows the same `created_at` (P38R2).
- **Durable outbox:** no existing generic one exists.
  `InventoryProjectionOutbox` is specific to inventory projections, and
  `job-runner.ts` is in-memory ("an in-flight job is lost on process
  restart"). A new table needs a migration and a worker, which is out of
  scope for a narrow fix.
- **Tradeoff accepted:** a process crash or kill *between commit and the
  last audit insert* (about 2 round trips per entry) still loses the
  remaining entries. The data stays correct. To detect it, compare published
  `branch_product_availability` rows / publication-created
  `inventory_stocks` with the audit entries. Every other failure is now
  retried or reported loudly.
- **Pre-existing, not changed:** `recordAuditLog`'s chain has no lock, so
  concurrent writers anywhere in the API can fork it. P38R3 does not make
  that worse (same post-commit path).

## Browser verification (P38R3)

`tests/e2e/pos-perf-p38r3-publication-result.spec.ts`: built API
(`node dist/server.js`), `next build` + `next start` (service worker
active), `--project="Admin Dashboard (Desktop)"`. Faults are injected on
the browser's own requests. `page.route` lets the real POST reach the API
and commit, then holds and drops the answer. `context.setOffline`
emulates the connection loss. **4/4 (5.7 min)** in one final run:

1. **Normal Add to POS** (A+B): one POST, `200`, product page. Links and
   assignment entries for exactly the 3 missing pairs. Availability
   entries: A and B once.
2. **Delayed answer, lost after commit, while offline.** The POST commits
   (`200` at the API; the DB shows A+B published) while the browser waits
   3 s more. Add to POS stays disabled (pending), with no error. Then the
   browser goes offline and the answer is dropped. **"Could not confirm
   whether this was added to POS"**, not "Couldn't add to POS" and not
   "Not on POS yet". "Nothing you entered was lost." Add to POS is
   disabled, and the builder is kept. **Check again** while offline:
   same honest message, still 1 POST. Reconnecting reloads the page
   (next-pwa `reloadOnOnline`). Review resumes with both branches **On
   POS** and **Already on POS**. Entries exactly once. An API retry of the
   same operation: `200`, `stock_links: []`, no new entries.
   - **Before the `fresh=` fix** (the web bundle built before it), this
     same step showed **"Not on POS yet"** with `data-outcome=
     "not_published"` for a publication that had committed. The service
     worker answered the offline check with Review's pre-publish plan.
3. **Product page Publish, answer lost after commit** (online): reconciled
   from the check, shown as **"Published at your branch" / "On POS at your
   branch."** with no error. 1 POST plus the check. The cup link and A's
   availability are each audited once.
4. **Add to POS never reached the server**: **"Not on POS yet … Trying
   again is safe"**. Neither the check nor Check again writes anything
   (links, availability and entries unchanged; 1 POST). After
   reconnecting, Add to POS publishes once (`200`). Entries exactly once.

Regression, same build: **P38R product page Publish 2/2** (4.4 min),
**P38 builder Add to POS 2/2** (6.8 min), each against a fresh API.

Attempts before the final run, all harness problems:

- `beforeAll` exceeded Playwright's 30 s hook default (four seeded
  products). The spec now gives it 180 s.
- The check-blocking route used a glob that never matched. Then a URL
  predicate didn't fire either, because the service worker serves
  same-origin `/api` GETs and `page.route` doesn't see those. That
  finding led to fix 4. The spec now uses `setOffline`.
- Two runs landed on `/supervisor/dashboard` when navigating right after
  login (before the dashboard rendered). `loginAs` now waits for the
  dashboard heading, and `openReview` re-navigates once. This is in
  login/navigation, which P38R3 doesn't change.

## Remaining timeout and concurrency limits

- *(P38R4: no longer true. The response returns at commit.)*
  **The response still waits for the audit chain.** Answers lost in that
  window are now reconciled, not hidden. A failing entry adds up to
  1.25 s of retry waits plus its attempts. During an audit-database outage
  this lengthens the response, and therefore the ambiguity window.
- **`not_published` is a snapshot.** If the original request is still
  running (for example, queued behind the product lock), the check can run
  before it commits. The message says so. A retry serializes behind it and
  is a no-op.
- **Same-product concurrency and pool use** are unchanged from P38R2:
  publications of one product serialize on its lock (2 of 4 exceeded 30 s
  at 150 ms in P38R2 and rolled back cleanly). Each publication holds 1 of
  5 pool connections for its transaction. Not load-tested.
- **Review's own plan query** (not the reconciliation read) still goes
  through the service worker's network-first cache. Offline, it can show
  the last cached plan. Add to POS is disabled while an attempt is
  unconfirmed, and a retry is a no-op.
- The unused availability `PATCH` endpoints don't take the product lock. A
  `PATCH` racing a publication could make the "newly published" decision
  miss or add one availability entry. No UI mounts them (P38R).

## Latency: what is known

| Kind | Figure | Source |
| --- | --- | --- |
| Historical production | Checkout latency "dominated by per-round-trip network latency" | `f33e1a5` (P25, Render diagnostics) |
| Historical QA | `closeShift` (~6–7 statements) took 5137 ms, then 6602 ms on retry | `f2cb843` |
| Historical load test | HTTP median 90 ms, p95 1.11 s (whole requests) | Phase 19 |
| Local proxy (P38R2) | Publication transaction 3.9–10.1 s at 100 ms RTT, 5.1–12.1 s at 150 ms; post-commit audit adds up to ~9 s (S4 first, 150 ms) | `products.publication-budget.measure.test.ts` |
| Local (P38R3) | 400 ms per audit insert × 6 entries: committed state visible ~2 s before the call returned | fault-injection test |
| Estimate | Transaction ≈ 40–100 × RTT. Audit ≈ 2 × RTT × (linked items + branches) | P38R2 |

Production publication latency is not *measured*, but it is bounded by the
evidence above. The P2028/QA figures show round trips there can be large.

## Controlled release checklist

1. Release diff `157deac..HEAD` still has no schema or migration change
   (`git diff 157deac..HEAD -- apps/api/prisma` is empty). Verify again
   before pushing.
2. Push. Vercel serves the new web first ("new web + old API", P38R2). The
   new web's `fresh=` read and reconciliation work against P37R/P38/P38R2
   APIs: the extra query key is stripped, and a pre-P38 API returns 404 →
   `unknown` → "Could not confirm", never a false success or failure.
3. CI green → close the write gate → approve → `migrate deploy` (no-op) →
   Render deploy → confirm the live commit in Render's dashboard → reopen
   the gate (P38R2 evidence rules).
4. Confirm Sentry is receiving events from the deployed API (an
   `AUDIT_ENTRY_NOT_RECORDED` must reach someone). Add an alert on that tag
   if one does not exist. This is a Sentry setting, not code.
5. Rollback: web-only is safe (old messages return). API back to `06621fe`
   is safe for data; availability entries on retries and silent audit loss
   return.

## Timing the next real publication (after deployment, no new diagnostics)

Do not create synthetic production data. When the owner next publishes a
real product:

1. Ask the supervisor to keep the browser's DevTools Network panel open (or
   save a HAR). Record the `publish-branches` / `publish` request duration
   and status, and whether any "Could not confirm" / "Not on POS yet"
   appeared.
2. Afterwards, run read-only queries for that product:
   - `inventory_stocks.created_at` of its publication links and
     `branch_product_availability.updated_at` (inside the transaction);
   - `audit_logs.created_at` of its `INVENTORY_ITEM_BRANCH_ASSIGNED` /
     `PRODUCT_BRANCH_AVAILABILITY_CHANGED` entries (after commit).

   Last audit `created_at` minus the availability `updated_at` ≈
   post-commit audit time. Request duration minus that ≈ transaction plus
   network time. Divided by the statement counts above, that gives a
   production per-round-trip estimate without enabling
   `DATABASE_ROUND_TRIP_DIAGNOSTICS_ENABLED`.
3. Check Render's logs and Sentry for `AUDIT_ENTRY_NOT_RECORDED` around
   that time.

If the request exceeds about 30 s, or the transaction fails with `P2028`,
treat the P38R2 budget as insufficient for production before relying on
Add to POS in the pilot.

## Verification (P38R3, local `127.0.0.1:5432/pos_verify` only)

`DATABASE_URL`/`DIRECT_URL` were checked as `127.0.0.1:5432/pos_verify` (host
and database printed, no credentials). No `prisma migrate` was run. No
production data, configuration, billing or credentials were touched.

- **New `products.publication-result.integration.test.ts`: 8/8** (6/8
  failed on `06621fe`, table above).
- **Updated `products.service.test.ts` 164/164** (publication entries go
  through `recordCommittedAuditLog`).
- **Affected API suites** (products, product-readiness, middleware,
  transactions): **26 files, 773 passed**, 65 skipped (env-gated, as
  before), 0 failed.
- **Web:** `use-products.test.tsx` 21/21 (+5: lost answer → `published`
  with 1 POST and a `fresh` read; `not_published` never retried; failed
  check → `unknown`; definite rejection → no check; Check again only
  reads). Product page test 7/7 (+1: unconfirmed message, Publish
  disabled until checked, Check again reads only, settles to
  published). Products, builder, components and stores suites: 10 files,
  81 passed.
- `pnpm type-check` 4/4. ESLint on every changed API and web file: 0
  problems. `apps/api` and `apps/web` builds pass.
- **Browser:** above.
- **Not executed:** the full API/web suites (changes are limited to the
  publish path, the audit helper's new export and the two publish screens),
  the P37/P36R browser specs, mobile/PWA projects, and any production
  measurement.

Local leftovers in `pos_verify`: the integration test deletes its data in
`afterAll`. The browser spec's branches are deactivated in `afterAll`, and
its products/items stay, as with earlier phases.

---

# POS-PERF-P38R4 — Durable Publication Audit Delivery

## What changed

P38R3 wrote publication's audit entries **after** commit, awaited, in the
request. A process crash, kill or deploy between COMMIT and the last audit
INSERT lost the remaining entries for good (P38R3 "Tradeoff accepted"). It
also made the response wait 2 round trips per entry.

P38R4 closes that window with a durable outbox:

| Step | Where | What |
| --- | --- | --- |
| 1. Publication transaction | `publishWithinLock` (both publish endpoints) | Unchanged checks, links and availability, **plus one `createMany` into `audit_outbox`**: one intent per entry for what this call actually changed. Same entries, same order as before: one `INVENTORY_ITEM_BRANCH_ASSIGNED` per newly linked item, then one `PRODUCT_BRANCH_AVAILABILITY_CHANGED` per newly published branch. Nothing changed → nothing enqueued (no statement). |
| 2. Commit | `prisma.$transaction` resolves | Links, availability and intents are durable together. Any throw before it rolls back all three. |
| 3. Response | endpoint returns | **Right after commit.** It never waits for the audit chain. Response shapes are unchanged and carry no audit information, so a queued or failing delivery can never be shown as a failed publication. |
| 4. Delivery | `audit-outbox.worker.ts`, started in `server.ts` on every API instance (poll 5 s) | Appends each group to `audit_logs` (below). |

No post-commit audit code remains on the publication path.
`recordCommittedAuditLog` (P38R3) was removed. P38R3's web reconciliation
(lost answer → read `publication-check` → published / not published /
unknown) and the no-op retry are unchanged. No web code changed.

## Schema (additive): `audit_outbox`

Migration `20261026140000_pos_perf_p38r4_audit_outbox`: enum
`AuditOutboxStatus` (`pending`, `processing`, `delivered`, `stuck`) and
table `audit_outbox`. Nothing else is touched (`audit_logs` unchanged).

- **Event columns, never updated after insert:** `event_key` (unique,
  `<group_id>:<position>`), `group_id` + `position` (unique; one group per
  publication call), `action`, `entity_type`, `entity_id`, `actor_id`,
  `actor_role`, `branch_id`, `before_state`, `after_state` (the original
  entry payload), `ip_address` (the request IP, as on every audit entry; no
  user agent, credentials or other request data), `occurred_at` (the
  publication transaction's time).
- **Delivery columns:** `status`, `attempts`, `last_error` (first line of the
  error, ≤ 500 chars), `next_attempt_at`, `locked_at`, `claim_token`,
  `delivered_at`, `updated_at`.
- Indexes: `(status, next_attempt_at)`, `occurred_at`.
- No foreign keys, so an outbox row never blocks a user/branch change.
  Delivered rows are kept; code never deletes a row.

## Delivery semantics and guarantees

**Claim** (`claimBatch`): the same token-stamped two-phase claim as the
inventory deduction/projection outboxes, at group granularity. It reads up
to 50 eligible rows oldest-first (`pending` past their backoff, or
`processing` with a claim older than **5 min**), then flips every row of
their groups to `processing` with a fresh `claim_token` in one guarded
`updateMany`. Postgres re-checks eligibility under each row lock, so two
workers never claim the same row. A group always changes state as a whole.

**Deliver** (`deliverGroup`), **one transaction per group**:

1. Ownership guard: `UPDATE … SET status='delivered' WHERE group_id = ? AND
   status='processing' AND claim_token = ?`. 0 rows → this worker lost the
   claim; return, nothing written. It row-locks the group, so a concurrent
   recoverer waits for this transaction and then no longer matches.
2. `pg_advisory_xact_lock(auditChainLockId())`: serializes chain appends
   between outbox workers on any number of instances.
3. Read the chain tail (`created_at DESC`, as `appendAuditLog` does).
4. One `createMany` of the group's entries in `position` order. Each is
   chained to the previous one with the **same** `computeAuditHash`
   `appendAuditLog` uses. `created_at` values are 1 ms apart and strictly
   later than the tail's, ending at "now" (unless the tail is newer), so the
   tail lookup keeps returning the group's last entry.

Insertion and acknowledgment commit atomically, so an entry is in
`audit_logs` **if and only if** its rows are `delivered`. That is enforced
by the database transaction plus the row-locked token guard, not by an
application lookup:

| Crash / fault point | Result |
| --- | --- |
| Before the publication commits | Nothing: no links, availability or intents |
| After commit, before any delivery (incl. API restart, deploy, rollback) | Intents stay `pending`; the next cycle on any P38R4+ instance delivers them |
| During delivery, before COMMIT (incl. after the audit INSERT) | Rolled back: no entries, rows still `processing` → retry (recorded failure) or stale-claim recovery after 5 min |
| After the delivery COMMIT, reply lost | Rows are `delivered`; the failure handler's guarded update matches 0 rows; never re-claimed, so no duplicate |
| Worker stalls past 5 min, another recovers | The stale owner's guard / failure update match 0 rows; it can't finalize or fail the recoverer's claim |

**Ordering:** within a publication the entries keep their order and are
inserted contiguously; nothing can chain onto the middle of a group.
Groups are claimed oldest `occurred_at` first. Publications of one product
are serialized by its lock, so their groups' `occurred_at` follow commit
order. Across different publications, order between concurrent instances
is approximately occurrence order, not strict. No consumer relied on
cross-publication order.

**Retry and failure:** a failed delivery puts the whole group back to
`pending` with backoff **10 s, 60 s, 5 min, 15 min, 30 min**. The 6th
failed attempt (about 50 minutes) marks it **`stuck`**: never claimed
again automatically, never deleted. It sends one Sentry event (tag
`audit_outbox=stuck`, extra: group id, event keys, actions, entity ids,
error) and one `AUDIT_OUTBOX_STUCK` error log. Each retry logs an
`AUDIT_OUTBOX_RETRY` warning. Eventual delivery depends on neither the
browser nor Sentry.

**What audit entries look like now:** fields, actions and hash are as
before. `after_state` gains two keys: `occurred_at` (when the publication
happened) and `audit_event_id` (the outbox `event_key`). `created_at` is
the insertion (delivery) time, normally a few seconds later. Both new
keys are inside the hash. The delivered `after_state` is built in jsonb key
order before hashing, so a delivered entry's hash **can be recomputed from
the stored row** (the integration test verifies every one). This is not
true for most legacy entries: their hash covers the caller's key order,
which jsonb discards. That is pre-existing and unchanged.

**Hash chain alongside other writers:** `recordAuditLog` (every other
module) is unchanged and takes no lock, so it can still fork the chain
with any concurrent writer, as before P38R3. Outbox workers never fork
with each other. A fork between a legacy writer and a worker is the same
pre-existing race; publication entries used to be such legacy writers
themselves. The concurrent test reports 1 such fork per run among 30
unlocked legacy writes. Locking every audit writer was out of scope; it
would add a transaction and a global lock to every audited request.

## Transaction cost (measured)

`products.publication-budget.measure.test.ts`, local Docker Postgres
(`pos_verify`), pool 5, same scenarios as P38R2. Baseline = `3c5fa1c`
(P38R3) with the unmodified harness. The harness now also counts outbox
inserts and times the worker's delivery separately.

| Scenario | In-tx statements before → after | Response total @0 ms before → after | Tx @100 ms before → after | Response total @100 ms before → after |
| --- | --- | --- | --- | --- |
| S1 first (4 entries) | 30 → **31** | 242 → 145 ms | 7.1 → 7.3 s | 8.2 → **7.3 s** |
| S1 repeat | 28 → 28 | 101 → 64 ms | 3.9 → 3.9 s | 3.9 → 3.9 s |
| S2 first (12 entries) | 42 → **43** | 518 → 173 ms | 10.1 → 9.1 s | 13.8 → **9.1 s** |
| S2 repeat | 40 → 40 | 166 → 89 ms | 5.6 → 5.6 s | 5.6 → 5.6 s |
| S3 first (23 entries) | 42 → **43** | 484 → 195 ms | 10.3 → 9.0 s | 16.2 → **9.0 s** |
| S3 repeat | 40 → 40 | 124 → 115 ms | 5.4 → 5.4 s | 5.4 → 5.4 s |
| S4 first (27 entries) | 42 → **43** | 452 → 306 ms | 8.7 → 10.4 s | 15.6 → **10.4 s** |
| S4 repeat | 40 → 40 | 119 → 197 ms | 5.7 → 5.4 s | 5.7 → 5.4 s |

- **Added transaction cost: exactly one statement** (the intent
  `createMany`), only when something changed. A repeat publish adds
  nothing. At about 1.4–2.4 round trips per statement (P38R2), that is
  about 140–240 ms at 100 ms RTT. Run-to-run noise in this harness at
  100 ms is ±1.5 s (S4 first measured 8.7 s before and 10.4 s after; S2/S3
  measured faster after). The statement count is the reliable figure. The
  transaction budget (10 s / 30 s) was **not** changed.
- **Removed from the response:** the post-commit chain, 2 statements per
  entry (S4 first: 54 statements, 6.8 s at 100 ms). A first publish now
  answers when its transaction commits.
- **Delivery (background, not in any request):** 7 statements per cycle,
  whatever the entry count: 3 to claim (Prisma wraps the claim's
  `updateMany` in its own BEGIN/COMMIT) plus **one 4-statement
  transaction** (guard, chain lock, tail read, `createMany`). Measured 26–57
  ms at 0 ms, and 0.9–1.1 s transaction / 1.5–2.2 s cycle at 100 ms, for 4
  to 27 entries. It holds the chain lock only for that transaction; legacy
  writers don't wait on it. It holds 1 pool connection briefly every 5 s
  when there is work. One read when there isn't.
- Same-product contention is unchanged (4 concurrent @100 ms: 3 succeed,
  the 4th exceeds 30 s and rolls back, before and after).

## Release: migration first, and overlap

The table must exist **before** any P38R4 API instance runs. The
production workflow already orders it that way: CI → approval →
`prisma migrate deploy` → Render deploy hook. Vercel deploys the web
independently on push, as before. **This release changes no web code**, so
every web/API combination behaves as in P38R3.

| Combination | Behavior |
| --- | --- |
| Migration applied, old (P38R3) API still serving | Old code ignores `audit_outbox`; it audits publications post-commit as before |
| Render swap overlap: old and new instances | Each publication runs on exactly one instance: old → post-commit entries, new → intents. Never both, so no duplicates. Both serialize on the same product lock. Several new instances each run a worker; claims and guards make that safe |
| New API without the migration (wrong order; expected from the code path, not executed) | The intent insert fails inside the publication transaction → the **whole publication rolls back** (`500`, nothing published). The web's reconciliation shows "Not on POS yet", which is true. Worker cycles log `Audit outbox worker cycle failed`. Fix: apply the migration; no data repair needed |
| Old or new web | Unaffected (no response change) |

## Worker startup verification (after deploy, read-only)

1. Render logs for the new deploy show `Audit outbox worker started
   (polling every 5s).` right after `Inventory deduction worker started`.
2. After the next real publication, read-only:
   `SELECT status, count(*), min(occurred_at) FROM audit_outbox GROUP BY status;`
   Expect only `delivered` within seconds (or run
   `tsx scripts/audit-outbox.ts status`; it prints the target host/db and
   counts, and writes nothing).
3. No `AUDIT_OUTBOX_RETRY` / `AUDIT_OUTBOX_STUCK` in logs or Sentry.
   Add a Sentry alert on tag `audit_outbox=stuck` (a Sentry setting, not
   code; not done here).

## Failure monitoring and manual recovery

Signals: Sentry `audit_outbox=stuck`; logs `AUDIT_OUTBOX_STUCK` (error) and
`AUDIT_OUTBOX_RETRY` (warn); `pending` rows whose `occurred_at` is older
than about 1 hour (the full retry schedule) mean no worker is running.

Bounded recovery procedure (`apps/api/scripts/audit-outbox.ts`; never
deletes, prints the target first; run from a P38R4+ checkout with the
environment's `DATABASE_URL`, only by an operator who has verified that
target):

1. `status`. Then read the stuck rows' `last_error`, `group_id`, `action`
   and `entity_id`.
2. Fix the cause (e.g. database outage over; a hard-deleted actor fails the
   `audit_logs.actor_id` foreign key and stays stuck until resolved).
3. `requeue --group <group_id>` (one group) or `requeue --all-stuck
   --limit N` (at most 100 per run, default 10). The rows return to
   `pending` with a fresh attempt budget, and `last_error` is kept.
4. The API's worker delivers within 5 s. Or `drain [--group <id>]
   [--cycles N]` (at most 50 cycles) runs the same guarded delivery from the
   script. It is safe while the API's workers run.
5. `status` again: the group is `delivered`. Each entry's
   `after_state->>'audit_event_id'` equals its outbox `event_key`.

## Rollback

- **API back to P38R3 (`3c5fa1c`):** safe. Leave `audit_outbox` in place;
  never drop it. Verified locally: `prisma migrate deploy` with P38R3's
  migrations folder against a database that has this migration reports "No
  pending migrations to apply", and the table and its rows survive. Pending
  intents wait. The P38R3 API audits new publications post-commit. Intents
  committed before the rollback are delivered when a P38R4+ API runs again
  (with their original `occurred_at`), or by `scripts/audit-outbox.ts
  drain` from a P38R4 checkout. Check `status` before and after a rollback.
- **Re-release after rollback:** pending intents are picked up
  automatically; there is no duplicate path, since the P38R3 code never
  read or wrote the outbox.
- **Web:** no web change in this release.
- The migration is additive; there is no down-migration and none is needed.

## Remaining limits

- Delivery is asynchronous: an entry reaches `audit_logs` about 0–5 s
  after publication (plus delivery time at the real round trip). If no
  worker runs, it stays `pending` (visible) until one does.
- Legacy `recordAuditLog` writers can still fork the chain (pre-existing,
  above).
- Cross-publication ordering in `audit_logs` is approximate between
  concurrent instances; within a publication it is exact.
- Delivered entries are back-dated by at most (entries − 1) ms so the last
  one is "now". Instance clock skew can push `created_at` later than the
  tail (the tail always wins).
- A hard-deleted actor makes its group `stuck` (foreign key). Users are
  normally deactivated, not deleted.
- Production round-trip latency is still unmeasured (P38R2); the delivery
  transaction is 4 statements, so it fits its 30 s budget by a wide margin.
- Only publication uses the outbox. Other modules' audit entries keep the
  existing post-commit, best-effort `recordAuditLog`.

## Verification (P38R4, local `127.0.0.1:5432/pos_verify` only)

`DATABASE_URL`/`DIRECT_URL` were printed as host/port/database only
(`127.0.0.1:5432/pos_verify`) before any `prisma` command. No production
data, migration, configuration, credentials or billing were touched.

- **Migration on a populated disposable copy** (`CREATE DATABASE pos_p38r4_mig
  TEMPLATE pos_verify`, then `prisma migrate deploy`): before/after
  identical for `audit_logs` (15,542 rows, same chain-tail hash
  `384a36cd…`), `inventory_stocks` (15,715 rows, same total on hand),
  products (458) and `branch_product_availability` (576). Constraints
  195 → 196 and indexes 231 → 236 (the new table only); `migrate diff`
  from the migrations to the schema showed only the new enum, table and
  indexes. Then on that copy: a pending group → `scripts/audit-outbox.ts
  status` (3 pending) → `drain` (1 cycle, delivered) → `status` (3
  delivered); the first delivered entry chains to `384a36cd…`. P38R3's
  migrations folder against it: "No pending migrations to apply".
- **New `audit-outbox.integration.test.ts`: 10/10** in each of 5 isolated
  runs, real Postgres, deterministic faults via Prisma middleware and a
  spied repository call: commit together (incl. actor, role, branch, IP,
  payload, `occurred_at` vs later `created_at`, hash recomputed); failure
  after the intent insert rolls back links, availability and intents; 3
  concurrent first publishes → one group; repeat → nothing; crash after
  commit → next cycle delivers once; crash after the audit INSERT before
  COMMIT → nothing written, backoff respected, delivered once; lost COMMIT
  reply → no duplicate; stale claim recovered, stale owner can't finalize
  or fail it; stale owner and recoverer racing → one write; transient →
  retried; exhausted → `stuck`, 1 Sentry event, 1 `AUDIT_OUTBOX_STUCK`,
  not re-claimed, requeued and delivered once; 4 concurrent workers + 30
  concurrent legacy writers → every event once, hashes verify, groups
  contiguous, no worker-vs-worker fork (1 legacy-involved fork reported per
  run, pre-existing).
- **Updated suites:** `products.service.test.ts` 164/164 (intents enqueued
  in the transaction, in order). P38R3 `publication-result` 5/5 (the 3
  post-commit audit-failure cases moved to the outbox suite; its first case
  now asserts the response does not wait for the chain). P38 setup 11/11,
  P38R single-publication 12/12, P38R2 budget 4/4 (each delivers its own
  groups before reading audits).
- **Affected API suites in parallel** (products, product-readiness,
  middleware, transactions, branches, `src/lib`, audit, audit-outbox,
  inventory-deduction, universal-inventory; 66 files, 1,382 tests):
  1,302 passed / 0 failed in 3 of 8 runs. The other runs had load
  timeouts on the local Docker Postgres ("Transaction already closed …
  5000 ms", hook/test timeouts, incl. suites this change doesn't touch).
  **The same set at `3c5fa1c` (3 runs)** failed the P38R2 six-way
  concurrency test once and an untouched restore-cascade test once:
  pre-existing load flakiness, not introduced here. **Serial
  (`--no-file-parallelism`), same set: 60 files passed, 1,302 passed, 0
  failed.** (An earlier serial attempt was void: the Docker engine stopped
  responding and every database suite failed at setup; Docker Desktop was
  restarted locally and the run repeated.)
- `pnpm type-check` 4/4. ESLint on every changed API file: 0 errors (the
  only warnings are `no-console`, matching `server.ts`'s and the scripts'
  existing convention). `apps/api` (`tsc`) and `apps/web` (`next build`)
  builds pass.
- **Measurements:** above (`products.publication-budget.measure.test.ts`,
  baseline at `3c5fa1c` with the unmodified harness, same machine).
- **Browser** (built `apps/api` `node dist/server.js` with its real
  worker, `next build` + `next start`, `--project="Admin Dashboard
  (Desktop)"`): **P38R3 publication result 4/4** (6.1 min: normal Add to
  POS; answer delayed then lost after commit while offline → "Could not
  confirm", then On POS; product page Publish answer lost → reconciled as
  published; never reached the server → "Not on POS yet", retry publishes
  once), **P38R product page Publish 2/2** (4.3 min), **P38 builder Add to
  POS 2/2** (6.4 min). `p38r-single-publish.cjs` now waits until the
  product's intents are delivered (up to 30 s; fails on `stuck`) before
  reading audit entries, so every "exactly once" check ran against entries
  the API's own worker delivered. API log: `Audit outbox worker started
  (polling every 5s).`, no worker cycle failures.
- **Live crash recovery (unplanned):** the Docker outage killed test runs
  mid-flight, leaving 93 undelivered groups. On API start the worker
  delivered every group whose actor still existed. The other 80 groups (150
  rows) belong to test users those runs had already hard-deleted; the
  `audit_logs.actor_id` foreign key rejects them, so they retry
  (`AUDIT_OUTBOX_RETRY`) toward `stuck`, exactly the documented limit.
  No production code hard-deletes users. They are local test data and were
  left in place.

Local leftovers: the disposable `pos_p38r4_mig` and `pos_p38r4_shadow`
databases; the integration tests delete their own rows.
