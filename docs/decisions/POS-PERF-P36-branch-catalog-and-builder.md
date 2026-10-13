# POS-PERF-P36 — Branch-Based Catalog Access and Simple Product Builder

**Status:** In progress (branch-team authority shipped; Simple Product Builder in progress — see "Rollout status" below).

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
  -> non-exclusive, published at >=1 branch (BranchProductAvailability,
     isAvailable=true): actor's active branches intersect those selling branches
  -> non-exclusive, never published (zero availability rows): any active
     supervisor (a brand-new draft is not orphaned before its first publish)
```

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

See the builder implementation notes in `apps/web/app/(supervisor)/supervisor/products/builder/` and the orchestration endpoint at
`apps/api/src/modules/products/` (`builder/publish`) for the 5-step flow
(Details → Sizes & Prices → Ingredients & Packaging → Choices → Review).
Every step writes through the existing Product/ProductVariant/
ProductComponent/ProductOptionGroup/ProductOption/ProductFlavorSlot APIs —
no new product data concepts were introduced, only one guided UI over them.
`productReadinessService` (unchanged) is the server-side gate behind "Add to
POS"; the separate Recipe Readiness page is removed, its checks are not.

## 6. Compatibility

- Legacy `ProductInventory`/`Flavor.ingredientName` deduction path: untouched.
- `isCatalogManager`/`isCatalogManagerForProduct`/`effectiveCatalogManager`:
  untouched, kept for read-only provenance display.
- Checkout, inventory deduction, PWD/Senior VAT, transaction-number, and JWT
  structure: untouched — none of this phase's files touch those modules.

## 7. Rollout / rollback

Every change in this phase is additive or a pure authority-check swap:
- No destructive migration. Any new builder-draft/idempotency table is
  purely additive.
- Rollback = stop routing traffic to the new builder route/endpoints and
  the trimmed `catalog-assignment` router; `catalog-authority.ts` can be
  reverted independently of the builder UI since it only changes which
  check a router calls, not any stored data.
- No production data, catalog copies, assignments, or uploads were touched
  in developing or verifying this phase — verification ran against a local
  disposable Postgres only (see the verification report in this phase's
  commit messages / PR description).
