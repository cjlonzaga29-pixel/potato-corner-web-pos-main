# POS-PERF-P36R4 — Branch-Isolation Authority Correction

**Status:** Implemented and verified locally (real-Postgres integration
tests, real HTTP requests against the booted Express app, a real concurrent
race). Not pushed, not deployed, no production data, migrations, or Render
config touched. See §6 for exact SHAs and §7 for what remains open.

## 1. The defect

POS-PERF-P36 (and reaffirmed by P36R3 §2) described a shared (non-exclusive)
product's authority rule as: *"any active-branch intersection with the
product's current selling branches grants authority over the whole
product, by design."* That is not the approved requirement. The approved
requirement, restated by this session's instructions, is:

> Supervisor authority follows assigned branches, and editing Branch A must
> not change Branch B.

The intersection rule violated this directly. `Product`, `ProductVariant`,
`ProductComponent` (recipe/BOM), `ProductFlavorSlot`/
`ProductFlavorSlotSnackOption` (Mix & Max), `ProductVariantOptionGroup`
assignments, and the product-identity fields (name/description/category/
image/status) are **not branch-scoped tables** — they are global rows a
shared product's branches all read from. A supervisor assigned to only one
of a shared product's branches could edit any of them, and the change took
effect at every branch selling that product, including branches that
supervisor had no assignment to. That is Branch A's edit changing Branch B.

Only `BranchProductAvailability` (branch-local on/off) and the legacy
`ProductInventory` mapping (carries `branchId` directly) are actually
branch-scoped; those were already correctly gated per-branch via
`branchGuard`/`assertSupervisorMayEnableAtBranch` and are untouched here.

## 2. The fix — `apps/api/src/lib/catalog-authority.ts`

`hasActiveCatalogAuthority`'s non-exclusive branch rule changed from
`.some()` (any overlap) to `.every()` (full coverage): the actor's active
branch set must be a **superset** of every branch the product is
configured at, not merely intersect it. A supervisor with partial (but not
full) coverage now has **zero** authority over the shared row — the same
posture already correctly applied to a supervisor with zero coverage.

`branchScopeFromProduct` also changed what counts as "a branch this product
is configured at": every `BranchProductAvailability` row, not only rows
with `isAvailable: true`. A branch where the product is temporarily
unpublished is still a branch the shared resource is tied to (the session's
instruction: "include configured branches where the product is temporarily
unpublished") — a supervisor who lost coverage of that branch must not
retain authority over the rest of the product just because availability
there happens to be off right now.

Every call site (`products.service.ts`, `product-components.service.ts`,
`product-options.service.ts`, `flavors.service.ts` — ~15 sites) consumes
`hasActiveCatalogAuthorityForProduct`/`hasActiveCatalogAuthority` as a
single shared helper, so this is a zero-touch correction at every call
site: Product create/update/status/delete/image, Variant create/update/
archive/delete, flavor-slot/snack-option CRUD, recipe/BOM mapping,
variant-flavor linking, and option-group assignment are now all correctly
gated on full branch coverage. Branch-exclusive products are unaffected
(a single branch trivially satisfies both "any" and "all").

The `branch-exclusive, never published anywhere yet` fallback
("any active supervisor may edit a brand-new draft") is unchanged — a
product configured at zero branches has nothing to protect yet.

## 3. The scoped path — fork-to-branch

A supervisor with authority over only *some* of a shared product's
branches now correctly cannot edit it in place. Per this session's
instruction ("do not merely hide the button and leave legitimate branch
editing impossible"), such a supervisor needs a real path to configure
their own branch's version of the product. New: `POST /api/products/:id/
fork-to-branch` (`forkProductForBranch`, `products.service.ts` /
`forkProductCascade`, `products.repository.ts`).

**What it does**: clones the product's full catalog configuration into a
brand-new, **branch-exclusive** `Product` row scoped to one branch the
acting supervisor actually controls (`branchGuard` enforces this — the same
`hasBranchAccess` check every other branch-scoped route uses). The
supervisor then owns that copy outright and edits it through every
existing endpoint, no new UI surface required.

**Narrow model chosen, consistent with existing data** (no schema redesign
— `Product.branchExclusive`/`exclusiveBranchId` already existed and already
fully support independent per-branch ownership; this just reuses it):

| Copied | Not copied |
|---|---|
| Product identity (name/description/category/seasonal window) | `InventoryStock`/`InventoryStockMovement` balances |
| `ProductVariant` rows (price, size, kcal, maxFlavors) | `TransactionItem`/`HoldOrderItem` sale history |
| `ProductVariantFlavor` links | Pending inventory-deduction jobs |
| `ProductComponent` (recipe/BOM, same `inventoryItemId` references — correct recipe-to-inventory mapping is preserved, not re-derived) | `ProductChangeLog` audit history (the fork gets its own, starting fresh) |
| `ProductFlavorSlot` + `ProductFlavorSlotSnackOption` (Mix & Max) | — |
| `ProductVariantOptionGroup` + allowed-options | — |

- **Historical IDs preserved**: the source product keeps its id; every
  existing sale/transaction/hold-order row referencing it is untouched. The
  fork gets a brand-new id — nothing is renumbered or migrated.
- **Creator provenance**: the fork's `createdBy` is the forking supervisor;
  `forkedFromProductId` (new column, see §4) records where it came from for
  audit/history display. A `PRODUCT_FORKED_FOR_BRANCH` audit-log entry is
  written.
- **No duplicate copies on retries/concurrent requests**: a unique index on
  `(forkedFromProductId, exclusiveBranchId)` makes a second fork request
  for the same (source product, destination branch) pair resolve to the
  existing row — `forkProductForBranch` checks for an existing fork first
  (idempotent retry) and also catches the `P2002` a genuine concurrent race
  produces on the final insert, re-reading and returning the winner's row
  instead of erroring or creating a second copy. Proven with a real
  `Promise.all` double-POST against the booted Express app (not sequential)
  — both requests return `201` with the identical product id, and exactly
  one row exists afterward.
- **Rejected, not silently coerced**: forking a product that is already
  branch-exclusive (`409 PRODUCT_ALREADY_BRANCH_EXCLUSIVE` — it doesn't need
  this path, the supervisor already has full authority if they control its
  one branch) and forking for a branch the product isn't configured at at
  all (`422 BRANCH_NOT_CONFIGURED_FOR_PRODUCT`) even when the acting
  supervisor has active authority at that branch for other products.

## 4. Migration — additive, applied against the verified local shadow DB

`Product.forkedFromProductId` (nullable `TEXT`, self-FK, `ON DELETE SET
NULL`) plus `@@unique([forkedFromProductId, exclusiveBranchId])`. Verified
`DIRECT_URL` resolved to `127.0.0.1:5432/pos_verify` (per CLAUDE.md's
three-URL rule) before generating or applying anything. Migration:
`apps/api/prisma/migrations/20261014214817_pos_perf_p36r4_product_fork_provenance/`.

NULL values never collide under Postgres unique-index semantics, so every
pre-existing product (never forked) is unaffected by the new index. Applied
and verified against the already-populated local `pos_verify` database — no
backfill needed since the column is purely additive and defaults to NULL.

**Correction made during this session**: the first `migrate deploy` run
recorded this migration against an *empty* `migration.sql` file, because an
earlier failed `prisma migrate dev` attempt (the command refuses to run in
this non-interactive shell) silently created an empty migration directory
at the same generated timestamp, and a cleanup step deleted the wrong
duplicate. Caught before any test ran successfully (the column didn't
exist, loudly, as a Prisma error) — the bad `_prisma_migrations` row was
deleted, the real SQL was written back, and `migrate deploy` was re-run
cleanly. No other environment ever saw the empty version. Noted here in the
interest of reporting actual results, not a cleaned-up narrative.

## 5. Real cross-branch tests

New: `apps/api/src/modules/products/products.partial-branch-authority.
integration.test.ts` (15 tests, real Express + Postgres, two branches
sharing one non-exclusive product):

| Case | Result |
|---|---|
| Partial-authority supervisor edits product name | `403`, row unchanged |
| Full-authority supervisor (both branches) edits product name | `200` |
| Partial-authority supervisor archives (global, no `branch_id`) | `403`, status unchanged — cannot take the product away from Branch B |
| Partial-authority supervisor sets Branch A to `temporarily_unavailable` (branch-scoped) | `200`; Branch B's `BranchProductAvailability.isAvailable` unchanged |
| Partial-authority supervisor names Branch B's id as a forged `branch_id` on the branch-scoped path | `403` — `branchGuard`'s `hasBranchAccess`, not the product's selling-branch set, gates this |
| Partial-authority supervisor: variant create/update, flavor-slot add | `403`, variant price unchanged |
| Partial-authority supervisor: recipe/BOM mapping on the shared variant | `403` |
| Fork for a branch the actor has no active assignment to | `403` (`branchGuard`) |
| Fork for a branch the product isn't configured at, even with active authority there | `422` (service-level check, proven by also granting the actor access to that branch) |
| Fork creates a branch-exclusive copy scoped to the actor's branch | `201`; `branchExclusive: true`, `exclusiveBranchId` = actor's branch, `forkedFromProductId` = source |
| Retried fork for the same pair | `201`, same id, row count stays `1` |
| Fork of an already branch-exclusive product | `409` |
| Editing the fork | `200`; original product's name and Branch B's availability unchanged |
| Two concurrent fork requests for the same pair (`Promise.all`, not sequential) | both `201`, identical id, row count `1` |
| Revoking the partial-authority supervisor's Branch A assignment | fork-to-branch now `403` |

Existing suites re-run clean against the corrected rule (no regressions):
`products.branch-isolation.integration.test.ts` (branch-exclusive products,
unaffected since a single branch trivially satisfies both "any" and "all"),
`products.status-branch-guard.integration.test.ts`,
`products.catalog-revocation.integration.test.ts`,
`products.inactive-supervisor.integration.test.ts`,
`products.publish-safety.integration.test.ts` — 25 tests, all passing.

## 6. Validation / SHAs

Starting HEAD: `2b3ace541d2cf82458d266cb9ba35d82d8b2142a` (matches the
expected starting commit; working tree was clean before this session).

Files changed this session:

- `apps/api/prisma/schema.prisma` — `Product.forkedFromProductId` +
  `@@unique([forkedFromProductId, exclusiveBranchId])`.
- `apps/api/prisma/migrations/20261014214817_pos_perf_p36r4_product_fork_provenance/` (new).
- `apps/api/src/lib/catalog-authority.ts` — full-coverage rule;
  `branchScopeFromProduct` includes every configured branch, not only
  `isAvailable: true` rows.
- `apps/api/src/modules/products/products.repository.ts` —
  `findForkCopy`, `forkProductCascade`.
- `apps/api/src/modules/products/products.service.ts` —
  `forkProductForBranch`.
- `apps/api/src/modules/products/products.router.ts` — `POST /:productId/
  fork-to-branch`.
- `packages/shared/src/schemas/product.schema.ts` /
  `packages/shared/src/types/index.ts` — `forkProductToBranchSchema` /
  `ForkProductToBranchInput`.
- `apps/api/src/modules/products/products.partial-branch-authority.
  integration.test.ts` (new, 15 tests).
- `docs/decisions/POS-PERF-P36-branch-catalog-and-builder.md` /
  `POS-PERF-P36R3-final-publication-and-branch-scope-verification.md` —
  corrected the superseded "intersection grants global authority" language,
  pointing at this doc.

## 7. Remaining limitations / not covered in this pass

- **No browser/Playwright coverage.** Everything above is real-Postgres
  integration + real HTTP against the booted Express app; no frontend UI
  was added for the fork-to-branch action (no "Copy to my branch" button in
  `apps/web`). A supervisor needing it today has direct API access, the
  same posture P36's Mix & Max slot editor was in before its own follow-up
  UI pass. A follow-up session should add that affordance to the product
  detail page's authority-denied state.
- **Full checkout-level (local-register) proof for forked products was not
  re-run.** The fork clones `ProductComponent`/pricing correctly and stock
  deduction already resolves by `(branchId, inventoryItemId)` independent
  of which `Product`/`ProductVariant` row references it (unchanged,
  pre-existing architecture — POS-PERF-P36 §2) — but this session did not
  additionally re-run a full checkout against a freshly-forked product's
  own branch. The existing `transactions.builder-recipe-match.integration.
  test.ts` already proves the underlying deduction arithmetic for any
  `ProductComponent` set, forked or not; it was not re-run since this
  session touched no deduction code.
- No production migration, product, upload, assignment, sale, billing, or
  credential-rotation action was taken. No Render `autoDeploy` config was
  touched. Not pushed, not deployed.
- The frontend `apps/web` product builder/detail pages were not audited in
  this pass for how they currently react to an increased `403` rate from
  partial-authority supervisors (e.g. whether an edit button is already
  conditionally hidden, or now needs to be). Flagged, not fixed — scope was
  the backend authority/data-isolation correction and its test proof.

## 8. Rollback

`catalog-authority.ts`'s rule change is a pure logic revert (`.every()` →
`.some()`), independent of the fork feature. The fork feature is fully
additive — new column (nullable, FK `ON DELETE SET NULL`), new endpoint,
new repository/service methods — and can be disabled by removing the route
without touching existing data; no existing row's shape changed. No
production data, migrations, catalog copies, assignments, uploads, or sales
were touched.
