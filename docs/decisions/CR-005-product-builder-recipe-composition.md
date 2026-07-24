# CR-005 — Product Builder & Recipe Composition Engine

**Status:** Proposed. **Date:** 2026-07-24.

## Context

CR-003 shipped the Branch Operating System (role split, employee
lifecycle). CR-004 hardened POS deduction: cross-branch ingredient
resolution, recipe versioning, InventoryMovement/Transaction
immutability, idempotent branch provisioning, recipe-required sale
rejection.

The catalog itself is still engineering-managed. Every new SKU or
recipe change requires a developer. Potato Corner needs to introduce
new products, adjust portions, and add flavors without code changes.
Supervisors observe branch demand but cannot propose SKUs. Multi-flavor
variants (Mega 2-flavor, Giga 2-flavor, Tera 4-flavor) and mix products
(fries + CCP, fries + loopys, loopys + CCP) require composable recipes
rather than hardcoded SKU logic.

Additionally, per-flavor stock visibility is required for real reorder
planning. Today flavor is metadata on a sale line; there is no way to
answer "how much BBQ powder is left."

## Decision

Introduce a neutral, composition-driven Product Builder. Super Admin
composes products from reusable building blocks. Supervisor can draft
proposals; only Super Admin can activate. Every flavor becomes a
first-class Ingredient row with independent stock.

Building blocks:
  - Ingredients (raw, packaging, cups, bags, tissue, flavor powders)
  - Flavor slots (0 to N per product variant)
  - Individual flavors mapped one-to-one to Ingredient rows

ProductVariant lifecycle (via lifecycleStatus):
  DRAFT -> PENDING_APPROVAL -> ACTIVE -> ARCHIVED

At POS, the CR-004 deduction engine reads the active product's recipe,
resolves flavor slot placeholders to the customer's selected flavors'
ingredients, and deducts every resulting recipe row from the selling
branch's inventory. The CR-004 cross-branch resolver, advisory locks,
and immutability guards continue to apply unchanged.

## Decisions locked from stakeholder session (Q1-Q6)

- Q1 Flavor deduction model: **per-flavor ingredient rows**
- Q2 Approval flow: **2-step** (Supervisor drafts, Super Admin activates)
- Q3 Supervisor drafting: **allowed** (draft only, cannot activate)
- Q4 Editing ACTIVE recipes: **allowed with mandatory change reason
  and version bump**; historical sales retain original version
- Q5 Seed data: **none** — catalog built through UI
- Q6 Flavor slot filtering: **universal** — any flavor may fill any slot

## Naming decisions

- The new lifecycle enum is named VariantLifecycleStatus
  (not ProductStatus, which is already taken by the existing
  Product-level catalog status enum with values
  draft/active/temporarily_unavailable/discontinued/archived).
- The lifecycle attaches to ProductVariant (the sellable unit
  that carries basePrice, Recipe, and appears on TransactionItem),
  not to Product (the catalog grouping).
- Product.status remains unchanged and out of scope.
- The new column on ProductVariant is named lifecycleStatus
  (not status) to avoid future confusion with Product.status.
- Flavor→ingredient linkage uses name+unit strings, not a single
  FK. This matches CR-004's resolver pattern for Recipe rows and
  preserves flavor universality across branches. Considered and
  rejected: a single Flavor.ingredientId FK (would either pin the
  flavor to one branch or reintroduce CR-004 branch-leakage). A
  future CR may introduce a first-class IngredientIdentity table to
  replace name+unit resolution across the entire schema.

## Schema changes

Ingredient:
  + category: enum IngredientCategory
    (RAW, FLAVOR, CUP, BAG, PACKAGING, OTHER)
  + defaults to OTHER for existing rows

Flavor:
  + ingredientName: String, nullable initially, NOT NULL after
    Phase 2 backfill
  + ingredientUnit: String, nullable initially, NOT NULL after
    Phase 2 backfill
  + FK to Ingredient was considered and rejected: Ingredient is
    per-branch (Ingredient.branchId required), so a single FK would
    either pin the flavor to one branch (breaking universality) or
    reintroduce the CR-004 branch-leakage bug. Name+unit matches
    the CR-004 resolver pattern used for Recipe rows.

ProductVariant:
  + lifecycleStatus: enum VariantLifecycleStatus
    (DRAFT, PENDING_APPROVAL, ACTIVE, ARCHIVED)
  + defaults to ACTIVE for existing rows (grandfather)
  + Product.status remains unchanged; this enum is a separate,
    variant-level approval-workflow gate
  + createdBy: FK to User
  + approvedBy: FK to User (nullable)
  + approvedAt: DateTime (nullable)
  + version: Int default 1
  + lastChangeReason: String (nullable)

ProductFlavorSlot (new table):
  - id
  - productVariantId (FK)
  - slotIndex (Int)
  - label (String)
  - flavorQty (Decimal)
  - unit (String)
  - required (Boolean)

Recipe:
  + flavorSlotIndex: Int (nullable)
    - null: fixed ingredient row
    - non-null: resolves to slot's selected flavor's ingredientId at
      sale time

ProductChangeLog (new table):
  - id
  - productVariantId
  - version
  - changedBy (FK to User)
  - reason (String, required non-empty)
  - snapshotJson (Json)
  - createdAt

TransactionItem:
  + selectedFlavors: Json (array of {slotIndex, flavorId})
  - recipeVersion already added by CR-004

## Guarantees

1. Only super_admin can transition a variant's lifecycleStatus to ACTIVE.
2. Supervisor can create and edit variants with lifecycleStatus DRAFT or
   PENDING_APPROVAL.
3. Supervisor cannot edit variants with lifecycleStatus ACTIVE.
4. A variant's lifecycleStatus must be ACTIVE for it to appear on POS
   terminals — one of four independent sellability gates (see POS flow).
5. Editing a variant with lifecycleStatus ACTIVE requires:
   - Non-empty change reason
   - Version increment
   - Snapshot logged to ProductChangeLog
   - Historical TransactionItems retain original recipeVersion (CR-004)
6. Approval blocked if any recipe row references an ingredient that
   cannot be resolved in at least one active branch.
7. Each flavor's name+unit identity is auto-provisioned as an
   Ingredient row per branch via CR-004 idempotent provisioning.
   At sale time, POS resolves flavor.ingredientName +
   flavor.ingredientUnit against the selling branch's Ingredient
   row using the CR-004 resolver. Fail-closed with
   INGREDIENT_NOT_PROVISIONED if missing.
8. Flavor slots are universal — any flavor may fill any slot.
9. Sale rejected with FLAVOR_SLOT_UNFILLED if any required slot empty.
10. Sale rejected with INGREDIENT_NOT_PROVISIONED (CR-004) if any
    resolved ingredient missing from selling branch.
11. All create/edit/approve actions written to AuditLog and
    ProductChangeLog.

## Non-goals

- No dynamic pricing engine
- No per-branch product enablement
- No AI recipe suggestions
- No catalog import/export (deferred to a later CR)
- No seed data
- No changes to CR-004 deduction engine internals
- No changes to InventoryMovement or Transaction immutability
- No backfill of missing CR-001/CR-002/CR-003 ADR files
  (separate documentation CR)

## Workflow

Super Admin path:
  Draft -> Add recipe rows -> Add flavor slots -> Set price ->
  Save DRAFT -> Approve -> ACTIVE

Supervisor path:
  Draft -> Add recipe rows -> Add flavor slots -> Set price ->
  Save DRAFT -> Submit for approval -> PENDING_APPROVAL ->
  Super Admin reviews -> Approve or Reject

Edit ACTIVE:
  Load -> Edit recipe/slots/price -> Provide change reason ->
  Save -> Version incremented -> ProductChangeLog entry ->
  New version applies to future sales only; historical sales unchanged

## POS flow

A ProductVariant is sellable at POS when ALL of:
  1. Product.status == 'active'         (existing global gate)
  2. ProductVariant.isActive == true    (existing per-variant switch)
  3. ProductVariant.lifecycleStatus == 'ACTIVE'  (CR-005 approval gate)
  4. ProductVariant has at least one Recipe row (CR-004 guarantee)

Any of these being false hides the variant from POS terminals.

1. Customer selects ACTIVE product
2. POS reads ProductFlavorSlot definitions
3. Customer fills all required slots by picking flavors
4. POS validates all required slots filled
5. Sale posts to API with selectedFlavors payload
6. API loads recipe at variant's current version
7. For each recipe row:
   - flavorSlotIndex null -> deduct fixed ingredientId
   - flavorSlotIndex set -> resolve to selectedFlavors[slotIndex]
     -> use CR-004 resolver on flavor.ingredientName +
     flavor.ingredientUnit against selling branch -> deduct
     that ingredient row
8. Apply CR-004 cross-branch resolver per resolved ingredient
9. Atomic transaction: sale + inventory movements committed together
10. Any failure -> full rollback -> clear error to POS

## Acceptance tests

- A variant with lifecycleStatus=DRAFT cannot be sold at POS
- A variant with lifecycleStatus=PENDING_APPROVAL cannot be sold at POS
- A variant with lifecycleStatus=ACTIVE and an unfilled required slot ->
  sale rejected (FLAVOR_SLOT_UNFILLED)
- A variant with lifecycleStatus=ACTIVE and all slots filled -> sale
  succeeds, correct deduction
- Editing a variant with lifecycleStatus=ACTIVE without change reason ->
  rejected
- Editing a variant with lifecycleStatus=ACTIVE increments version;
  historical sales use old version
- Supervisor cannot approve (403)
- Supervisor cannot edit a variant with lifecycleStatus=ACTIVE (403)
- Approval blocked if any recipe row unresolvable in any branch
- Per-flavor deduction verified end-to-end (BBQ selection deducts
  BBQ Powder, Cheese deducts Cheese Powder)
- Cross-branch isolation still holds (CR-004 guarantee)
- InventoryMovement still immutable (CR-004 guarantee)
- All actions logged to AuditLog and ProductChangeLog
- A variant with lifecycleStatus=ACTIVE is still hidden from POS
  if its Product.status is not 'active'
- A variant with lifecycleStatus=ACTIVE is still hidden from POS
  if isActive=false
- Setting Product.status to 'archived' does not change any
  variant's lifecycleStatus (independent gates)

## Migration plan

- All schema additions are additive
- Ingredient.category defaults to OTHER for existing rows
- ProductVariant.lifecycleStatus defaults to ACTIVE for existing rows
  (grandfather). Product.status is untouched.
- ProductVariant.version defaults to 1
- ProductFlavorSlot table created empty
- ProductChangeLog table created empty
- Recipe.flavorSlotIndex nullable, defaults to null
- Flavor.ingredientName and Flavor.ingredientUnit nullable
  initially, both become NOT NULL after Phase 2 backfill
  (separate migration step)
- Backfill migration (separate step):
  * For each existing Flavor without ingredientName, populate
    ingredientName from Flavor.name and ingredientUnit from a
    schema default (e.g. 'grams'). Then, for each branch,
    provision a per-branch Ingredient row (branchId, name, unit,
    category=FLAVOR) via CR-004 idempotent provisioning.
  * Follow-up migration makes Flavor.ingredientName and
    Flavor.ingredientUnit NOT NULL
- No breaking changes
- No data loss
- Fully reversible until backfill is committed

## Consequences

Positive:
- Zero engineering required for new product introductions
- Per-flavor stock visibility enables accurate reorder planning
- Supervisor participation without weakening approval control
- Historical accuracy preserved via recipe versioning
- Fully composable — supports any future product family
- No hardcoded SKU knowledge in the deduction engine

Negative:
- Ingredient row count grows (one per flavor per branch)
- POS UX must handle multi-slot flavor selection
- Admin builder UI complexity
- Approval bottleneck if super_admin unavailable

Mitigations:
- CR-004 idempotent provisioning absorbs the ingredient count growth
- POS flavor selection extends existing flavor picker component
- Product Builder split into small shadcn/ui components
- Multiple users can hold super_admin role

## Implementation status

### Phase 1 — Schema foundations

Shipped in 24aa312 (amended after Phase 2 review — see Fix 2 below).
Adds IngredientCategory, VariantLifecycleStatus, ProductFlavorSlot,
ProductChangeLog, plus additive columns on Ingredient, Flavor,
ProductVariant, Recipe, TransactionItem.

**Fix 2:** 26f04b5 — Original Phase 1 used Flavor.ingredientId as a
single FK, which would either pin flavors to one branch (breaking
universality) or reintroduce CR-004 branch-leakage. Replaced with
Flavor.ingredientName + Flavor.ingredientUnit (name+unit identity,
matches CR-004 resolver pattern used for Recipe rows).

### Phase 2 — Flavor backfill and NOT NULL enforcement

Shipped in b822622. Backfilled ingredientName/ingredientUnit for
existing flavors, provisioned per-branch FLAVOR Ingredient rows,
enforced NOT NULL on both new columns. Idempotency key aligned to
CR-004's actual unique index (branchId, name).

### Phase 3 — Provisioning hooks and lifecycle machinery
Shipped in 6 commits:

- **3a (b5ebdac):** Flavor create/reactivate provisions per-branch
  Ingredient rows via new provisionIdentityAcrossBranches. Ingredient
  identity fields immutable after creation.
- **3b.1 (387e897):** Branch create unions recipe-derived +
  flavor-derived identities before provisioning. FLAVOR wins category
  on name/unit collision.
- **3b.2 (279eb58):** Wrapped createBranch in prisma.$transaction for
  atomic branch + provisioning. Post-commit audit + socket emit stay
  outside the transaction. Closes a pre-existing atomicity gap.
- **3c (bb90376):** ProductVariant lifecycle (submit/approve/reject/
  editActive/archive) with strict RBAC, VARIANT_TRANSITIONS matrix,
  mandatory reason enforcement on reject + editActive, version bumps
  only on editActive, ProductChangeLog written on editActive + archive
  only. Two approval gates: Phase 4 gate (blocks approval if any
  recipe row has flavorSlotIndex OR any ProductFlavorSlot row exists)
  and Guarantee 6 gate (blocks approval if any recipe ingredient is
  unresolvable in every branch).
- **3d (e0636b8):** ProductFlavorSlot CRUD (add/update/remove/reorder/
  list) with shared performSlotEditWithActiveGovernance helper.
  Contiguous slotIndex enforcement, maxFlavors cap, atomic ACTIVE-state
  mutations with version bump + ChangeLog. 2-phase reorder pattern
  to avoid unique constraint violation.
- **3f (f3ffd1f):** Recipe write path accepts flavor_slot_index with
  mutual exclusivity vs flavor_id, range validation. Extended 3d's
  removeFlavorSlot with SLOT_HAS_DEPENDENT_RECIPES guard, extended
  3d's reorder to cascade Recipe.flavorSlotIndex for semantic
  preservation across reorders. 2-phase temp-offset pattern for Recipe
  cascade to handle swap cases (0↔1).

### Phase 4 — POS deduction integration (pending)

Not yet started. Phase 4 will:

- Remove the Phase 4 gate from approveVariant (3c)
- Extend computeDeduction to resolve flavor_slot_index at sale time
  against TransactionItem.selectedFlavors payload
- Wire the CR-004 branch-scoped resolver to consume slot-based recipes
- No UI changes (Phase 5/6)

### Phase 5 & 6 (pending)

Admin Builder UI and POS runtime UI + final end-to-end tests. Not yet
started.

## Lessons learned (Phase 1-3)

- **Runbook restriction "no service/repository code touches" was too
  rigid for schema-change phases.** Adding NOT NULL constraints on new
  required columns necessarily requires companion write-path fixes.
  Phase 2 hit this with flavors.repository.create. Future phases scope
  service touches per-need.

- **Socket event naming must respect existing contract tests.** Repo
  enforces ^[a-z_]+:[a-z_]+$; sub-phases 3c and 3d discovered this via
  failing tests when specs used hyphens or extra colons. Underscore-
  single-colon convention is canonical.

- **Field name convention is snake_case in DTOs** (matches existing
  flavor_id, product_variant_id pattern), even where the Prisma model
  uses camelCase. Sub-phase 3f caught this.

- **Two-phase temp-offset pattern needed for any bulk index rewrite,
  unique-constrained or not.** Sub-phase 3f's Recipe cascade would
  have subtly failed on swap cases (0↔1) with single-phase updates
  because the WHERE clause of a later UPDATE would match rows the
  earlier UPDATE just rewrote. Two-phase is the safe default.

- **Pre-existing atomicity gaps deserve companion fixes when a new
  sub-phase widens their blast radius.** Sub-phase 3b.2 wrapped
  createBranch in a transaction because 3b.1 added a second identity
  source; a partial failure would have left more incomplete state
  than before.

- **The Phase 4 gate is a governance-clean way to ship partial
  features safely.** New capability (flavor slots) is fully authored
  and validated in Phase 3, but activation is blocked until the
  runtime resolver ships in Phase 4. No half-broken production risk.

## References

- CR-003 (shipped, no ADR file yet — see DEBT.md)
- CR-004 (shipped, this file's structural template)
- Stakeholder Q1-Q6 decision log (inlined above)
