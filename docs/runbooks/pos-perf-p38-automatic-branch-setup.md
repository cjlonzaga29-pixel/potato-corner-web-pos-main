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
- The product page's per-branch **Publish** (`POST /:id/publish`) and the
  availability endpoints keep their P37 gate, which still blocks on
  `INVENTORY_STOCK_MISSING`. Automatic setup exists only on the builder's Add
  to POS.
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
