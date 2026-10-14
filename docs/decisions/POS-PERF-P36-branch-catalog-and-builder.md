# POS-PERF-P36 — Branch-Based Catalog Access and Simple Product Builder

**Status:** Shipped — branch-team authority, Simple Product Builder, Recipe
Readiness UI removal, and end-to-end inventory-match coverage are all
committed and verified locally (see §8 Verification below). Scope not
covered in this pass: the Choices step's Mix & Max slot editor UI (existing
Mix & Max data/behavior is preserved, just not re-exposed in the new wizard —
see §5 limitations) and Playwright browser e2e scenarios (unit/integration
coverage only — see §8).

**Superseded in part by `docs/decisions/POS-PERF-P36R-branch-isolation-mix-
max-concurrency.md`**: that phase added the Mix & Max slot editor this doc
deferred, proved the branch-isolation claim below with real-Postgres tests
instead of just an audit, closed the Product-level concurrency gap (§5), and
— via an actual browser run of this builder — found and fixed three defects
this doc's unit/integration-only verification could not have caught: every
builder-created product was permanently stuck at `status: 'draft'` (never
publishable), the Publish/"Add to POS" button could never become enabled on
a first publish (frontend/backend readiness-gate mismatch), and flavor-slot
governance blocked every supervisor outright. Read that doc for the current
state of all three.

## 1. Why

The POS-PERF-P35R catalog-management model granted authority one resource at
a time: a Super Admin manually set `managedBy` on a Product/Category/
OptionGroup/Option/Unit/InventoryItem via the `catalog-assignment` module,
and `isCatalogManager`/`isCatalogManagerForProduct` (`catalog-ownership.ts`)
checked whether the acting supervisor matched `managedBy ?? createdBy`
exactly. That required a manual grant per resource and tied authority to an
*individual*, not to *the branch team currently operating that catalog*. It
was also fronted by a fragmented setup flow — separate Products,
Categories, Options, and Recipe Readiness pages — that made building one
sellable product a multi-page, easy-to-abandon process.

This phase replaces manual per-resource assignment with **branch-team
authority**, derived live from `UserBranchAssignment`, and replaces the
fragmented setup flow with a single guided builder.

## 2. Branch data model — audit conclusion

Before changing authority, every catalog/inventory model was traced for
cross-branch isolation risk. **Conclusion: the existing schema already
isolates branches correctly. No new tables or isolation columns were
needed** — this phase is a live-authority change, not a data-model
redesign.

- **Branch-agnostic shared master data** (by design, CR-007 §3):
  `InventoryItem`, `InventoryCategory`, `UnitOfMeasure`, `UnitConversion`,
  `ProductCategory`, `ProductOptionGroup`, `ProductOption`. These are
  definitions, not branch-owned state — editing one is correctly global.
  `InventoryItemUnitConversion` (density/packaging overrides) is scoped to
  the *item*, not the branch, for the same reason: density is a property of
  the ingredient, not of where it's sold.
- **Branch-scoped presentation/override layer**: `BranchProductAvailability`
  and `BranchFlavorAvailability` turn a shared Product/Flavor on or off per
  branch. `ProductInventory` (legacy recipe mapping) carries `branchId`
  directly. `ProductComponent` (current BOM) is scoped by
  `productVariantId` only — branch-specific stock levels live in
  `InventoryStock`/`InventoryStockMovement`, keyed by `(branchId,
  inventoryItemId)`, and deduction always resolves against that pair at
  checkout time. A recipe row never carries a branch field because "what
  ingredients, how much" is branch-independent; "how much is left" is not,
  and that's `InventoryStock`'s job.
- **Consequence**: editing Branch A's product/recipe cannot change Branch
  B's stock, because nothing in the recipe layer references a branch at
  all — stock resolution is keyed by branch at the point of deduction, not
  baked into the recipe. No stock balances, movements, or ingredient
  identities were duplicated to achieve this; they were never shared
  improperly in the first place.
- **Historical migration/mapping**: none required. No rows moved, no
  ownership field was backfilled or guessed. `createdBy`/`managedBy` and the
  `catalog_management_assignments` audit trail are untouched and remain
  queryable for historical "who used to manage this" questions.

## 3. Branch-team authority model

New helper: `apps/api/src/lib/catalog-authority.ts`.

```
hasSharedCatalogAuthority(actorId)
  -> actor has >=1 active UserBranchAssignment (any branch)
  -> used for branch-agnostic master data: categories, option groups/
     options, units, unit conversions, inventory items.

hasActiveCatalogAuthorityForProduct(product, actorId)
  -> branch-exclusive product: actor's active branches include exclusiveBranchId
  -> non-exclusive, configured at >=1 branch (BranchProductAvailability,
     any row, available or not): actor's active branches must be a SUPERSET
     of every branch the product is configured at (corrected by
     POS-PERF-P36R4 — see that doc; this originally read "intersect", which
     let a supervisor assigned to only one branch edit shared rows that
     affect every branch selling the product)
  -> non-exclusive, never configured anywhere (zero availability rows): any
     active supervisor (a brand-new draft is not orphaned before its first
     publish)
```

**POS-PERF-P36R4 correction**: see
`docs/decisions/POS-PERF-P36R4-branch-isolation-authority-correction.md`.
The "intersect" rule above was never actually consistent with "supervisor
authority follows assigned branches, and editing Branch A must not change
Branch B" — it was corrected to require full coverage, and a
fork-to-branch scoped-copy path was added for a supervisor who controls
only some of a shared product's branches.

`createdBy`/`managedBy` are no longer read for the live authority decision —
`catalog-ownership.ts`'s `effectiveCatalogManager`/`isCatalogManager` stay in
the codebase read-only, for historical "who manages this" display only.

**Builder branch selection** (Step 1 of the product builder):
- One active assigned branch → auto-selected, no picker shown.
- Multiple active assigned branches → picker shown, cleared by default.
- Zero active assigned branches → explanatory empty state, no builder
  access at all.

### Retired surface

- `POST /api/catalog-assignments` (manual grant), `GET /.../preview`, and
  `GET /.../unmanaged` are removed. `GET /api/catalog-assignments` (history
  read, Admin-only) survives unchanged in shape — it is the permanent audit
  trail of every POS-PERF-P35R-era manual grant and is never deleted.
- The Admin "Catalog Assignment" nav item and page are removed — there is
  nothing left for an Admin to manually grant.
- `CatalogManagementAssignment` (Prisma model) is untouched: append-only,
  still queryable, never backfilled or migrated.

## 4. Role matrix

| Role | Catalog authority |
|---|---|
| Super Admin | Branch/supervisor assignment, monitoring/reporting. No catalog CRUD (unchanged from POS-PERF-P35). Read-only audit history of the retired manual-assignment era. |
| Supervisor | Builder + edit/archive/remove, scoped to `hasActiveCatalogAuthority`'s result for each resource — i.e., their *currently active* branch team, not personal ownership. |
| Branch / Staff | No catalog management access (unchanged). POS read path is unaffected by this phase. |

## 5. Simple Product Builder

`apps/web/app/(supervisor)/supervisor/products/builder/page.tsx` — one
guided wizard (Details → Sizes & Prices → Ingredients & Packaging → Choices →
Review) replacing the old `CreateProductDialog` + separately-navigated
Categories/Options/Recipe-Readiness pages. Each step is composed from
existing, already-tested components rather than reimplemented:

| Step | Reused components / endpoints |
|---|---|
| Details | Inline form (lifted from the old `CreateProductDialog`) → `POST /api/products` (branch-exclusive, status `draft`) + `POST /api/products/:id/image` |
| Sizes & Prices | `VariantFormDialog` → `POST`/`PATCH .../variants` |
| Ingredients & Packaging | `RecipeBomPanel` + `RecipeComponentFormDialog` → `POST/PATCH/DELETE .../components`, with a new inline "+ Create new item…" affordance (`InlineCreateInventoryItemDialog` → `POST /api/universal-inventory/items`) so a missing item never forces abandoning the step |
| Choices | `AssignOptionGroupDialog` + `LinkFlavorDialog` → the existing variant/option-group and variant/flavor endpoints |
| Review | `ReadinessChecklist` (unchanged) + `productsService.publishProduct` (the pre-existing Phase D1 "Add to POS" endpoint — already gated on `productReadinessService`, already refuses with the blocking-issue list when not ready, already never deducts stock) |

**No new orchestration/draft/idempotency endpoint was built.** Once Step 1
creates the Product (`status: draft`), every later step edits that *same*
row directly through its own existing, independently-tested endpoint — so
"draft" literally is a `Product` row with `BranchProductAvailability.
isAvailable = false` for its branch, not a parallel storage system. "Save
Draft" is therefore a no-op (everything already persisted incrementally);
"Add to POS" is the pre-existing `publish` call. This was a late-discovered
scope reduction from the original plan (which assumed no publish/readiness
gate existed yet) — see the `mutable-scribbling-simon` plan file's §3 for
the superseded original design.

Client-only wizard progress (`apps/web/stores/product-builder.store.ts`,
Zustand + localStorage) tracks only `{ productId, step }` — substantive data
(variants, recipe components, choices) is never buffered client-side, so a
refresh loses at most a half-typed Step 1 form before the first Product row
exists, never an already-entered size/ingredient/choice.

**Branch selection**: filtered to the supervisor's own active
`UserBranchAssignment`s (via the JWT `branchIds` snapshot, same source
`useSelectedBranch` already uses elsewhere) — auto-selected when exactly
one, cleared when multiple, blocked with an explanatory empty state at zero.

**Known limitation**: the Choices step exposes Option Groups/Options
(flavors, add-ons) but not a dedicated Mix & Max slot (`ProductFlavorSlot`)
editor — existing Mix & Max products/data/checkout behavior is fully
preserved (nothing in this phase touches `ProductFlavorSlot`/
`ProductFlavorSlotSnackOption` or their deduction path), it's just not yet
reachable from the new wizard UI. A supervisor needing to configure Mix & Max
slots for a brand-new product still needs direct API access until a
follow-up adds that step.

**Concurrency**: `ProductVariant.version` (already existed, already bumped
on every update) is now also read as an optimistic-concurrency token —
`PATCH .../variants/:id` accepts an optional `expected_version` and returns
`409 VARIANT_CONFLICT` on mismatch; `VariantFormDialog` sends the version it
loaded on edit. Product-level fields (name/category/etc., no per-row version
column) are not covered by this — a known, narrower-scope gap than the full
"handle concurrent edits" ask, left for a future migration adding a
`Product.version` column.

## 6. Query-cache branch scoping audit

Traced every TanStack Query key in `apps/web/hooks/queries/use-products.ts`,
`use-product-categories.ts`, `use-product-options.ts`, and
`use-universal-inventory.ts`. **Conclusion: already correct, no changes
needed.** Every read whose result actually varies by branch already carries
`branchId` in its key — `['catalog', branchId]` (POS terminal catalog),
`['product', productId, 'readiness', branchId]`, `['branch-inventory-stock',
branchId]` — so switching branches naturally produces a different cache
entry instead of serving a stale one. Every key *without* a branchId
(categories, option groups/options, units, conversions, inventory items) is
correctly branch-agnostic shared master data per §2 — adding a branchId to
those keys would be wrong, not a fix.

## 7. Compatibility

- Legacy `ProductInventory`/`Flavor.ingredientName` deduction path: untouched.
- `isCatalogManager`/`isCatalogManagerForProduct`/`effectiveCatalogManager`:
  untouched, kept for read-only provenance display.
- Checkout, inventory deduction, PWD/Senior VAT, transaction-number, and JWT
  structure: untouched — none of this phase's files touch those modules.
- Mix & Max (`ProductFlavorSlot`), legacy Flavor-based variant flavors,
  Product Options/inventory mappings: untouched, still fully functional —
  see §5's limitation note on the builder not yet exposing a Mix & Max editor.

## 8. Verification

Ran entirely against a local disposable Postgres (`127.0.0.1:5432/pos_verify`
— verified host/port before every `prisma migrate`/`db execute` call per
CLAUDE.md's three-URL rule; never touched `PRODUCTION_DATABASE_URL_DIRECT`).

- **Migration**: an additive `Product.builder_draft_id` column was
  generated, applied, and verified via `prisma migrate deploy` while
  prototyping an idempotency-key design; once the design simplified (§5), the
  column was found unnecessary and cleanly reverted (`ALTER TABLE ... DROP
  COLUMN`, migration folder removed, `_prisma_migrations` row deleted) before
  anything was committed — `git diff` on `schema.prisma` confirmed a clean
  no-op. No migration is part of the final committed change.
- **Typecheck**: `apps/api`, `apps/web`, `packages/shared` all clean
  (`tsc --noEmit`), rerun after every edit round.
- **API unit + real-Postgres integration suite** (`TEST_DATABASE_URL` set to
  the local DB, run standalone — not concurrently with the web suite, which
  caused transient cross-suite DB contention on a first combined attempt):
  **2,947 passed, 0 failed, 99 skipped** (skips are integration suites gated
  on env vars not relevant here). The new
  `transactions.builder-recipe-match.integration.test.ts` (5 tests) passed
  consistently across three separate runs.
- **Web unit/component suite**: 1,218 tests; the only failures seen were
  environment-timeout flakes (5s default `testTimeout`) in files this phase
  never touched (`attendance-override-dialog`, `edit-product-dialog`,
  `sales-analytics-section`, the admin dashboard page, the branch terminal
  page, the supervisor reports page) — all four of the first group
  independently confirmed passing when re-run in isolation; the pattern is
  consistent with this session's machine being under heavy load from running
  very large suites, not a regression. One real failure was fixed during this
  phase: `recipe-component-form-dialog.test.tsx`'s mock of
  `use-universal-inventory` needed `useInventoryCategories`/
  `useCreateInventoryItem` added for the new inline item-creation dialog.
- **Known environmental hazard observed, not a code defect**: one local-only
  rerun of the pre-existing `transactions.integration.test.ts` CR-004 suite
  showed a stock-mismatch false failure while this repo's own `apps/api` dev
  server (`pnpm --filter @potato-corner/api dev`, left running from before
  this session) was simultaneously connected to the same local database —
  consistent with its background inventory-deduction poller racing the
  test's own manual `inventoryDeductionService.runCycle()` call against the
  same jobs table. Stopping contention (running the suite alone) made it
  pass cleanly and reproducibly on every subsequent run. Recommend running
  integration suites against a database with no live dev server attached.
- **Not run in this pass**: Playwright browser e2e scenarios (supervisor
  access without manual assignment, replacement/revocation,
  create→publish→checkout→deduction, edit/archive, cross-branch denial,
  admin nav absence). The scenarios this phase specifically required
  (branch-authority replacing manual assignment, builder-driven
  create→publish, exact multi-ingredient deduction match) are covered at the
  integration level instead (§8 above); a follow-up session should add the
  browser-level pass, following the now-deleted
  `pos-perf-p35r2-catalog-assignment-browser.spec.ts` as a style reference
  for structure (it was removed in this phase since its subject — the manual
  assignment UI — no longer exists).

## 9. Rollout / rollback

Every change in this phase is additive or a pure authority-check swap, and
no migration is actually part of the committed change (see §8):

- Rollback = stop routing traffic to the new builder route and the trimmed
  `catalog-assignment` router; `catalog-authority.ts` can be reverted
  independently of the builder UI since it only changes which check a router
  calls, not any stored data.
- No production data, catalog copies, assignments, or uploads were touched
  in developing or verifying this phase — verification ran against a local
  disposable Postgres only.
