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

## Schema changes

Ingredient:
  + category: enum IngredientCategory
    (RAW, FLAVOR, CUP, BAG, PACKAGING, OTHER)
  + defaults to OTHER for existing rows

Flavor:
  + ingredientId: FK to Ingredient
  + nullable initially, backfilled via migration, then required

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
7. Each flavor is a first-class Ingredient row, auto-provisioned per
   branch via CR-004 idempotent provisioning.
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
     -> resolve flavor.ingredientId -> deduct that ingredient
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
- Flavor.ingredientId nullable initially
- Backfill migration (separate step):
  * For each existing Flavor without ingredientId:
    - Create corresponding Ingredient row (category=FLAVOR)
    - Provision across all branches at zero stock
      (CR-004 idempotent provisioning)
    - Link Flavor.ingredientId
  * Follow-up migration makes Flavor.ingredientId NOT NULL
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

## References

- CR-003 (shipped, no ADR file yet — see DEBT.md)
- CR-004 (shipped, this file's structural template)
- Stakeholder Q1-Q6 decision log (inlined above)
