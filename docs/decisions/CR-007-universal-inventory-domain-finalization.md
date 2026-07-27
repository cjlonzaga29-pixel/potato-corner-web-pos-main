# CR-007 — Universal Inventory Domain Finalization

**Status:** Finalized (architecture). **Date:** 2026-07-27.

## Context

CR-004 established POS deduction integrity and idempotent branch
provisioning against the Recipe/Ingredient model. CR-005 proposed a
Product Builder / recipe composition engine on top of that same model.
Both were superseded — `Recipe`/`BranchRecipeOverride` are deprecated,
and `ProductInventory` has been carrying inventory concerns as an
interim measure without a settled domain design.

This CR is the finalization of the **Universal Inventory Domain**: a
single, product-agnostic inventory model that owns physical stock and
its full movement history, independent of how Sales, Purchasing, or
Production choose to consume it. It resolves a batch of open design
questions (identity, units, movement taxonomy, reversal semantics,
reservation, non-stock products, count cutoff, transfer legs, lot
readiness, costing) as one coherent, locked decision set. No prior
CR-006 document exists in this repository; this document defines the
CR-006 implementation deltas from first principles rather than
correcting an existing one.

This is an architecture decision only. No schema, migration, code, or
test changes are made as part of this document.

## Decision

Adopt the Universal Inventory Domain as specified in this document as
the locked target architecture for the next implementation CR
(referred to throughout as **CR-006**, the implementation CR this
finalization governs). Sections 3 through 18 below constitute the full
locked design; sections 19-22 map it onto delivery.

---

## 1. Executive finalization verdict

The Universal Inventory Domain is **architecturally finalized** for
implementation. It is:

- **Product-agnostic.** Inventory tracks physical items and their
  movement, not menu structure. Products *reference* inventory; they do
  not define it.
- **Identity-stable.** `InventoryItem.id` is the only fact any other
  domain is allowed to hold onto long-term. SKU/barcode are mutable
  business metadata, never a join key.
- **Unit-normalized.** Every stock and movement quantity is stored in
  exactly one unit per item (`baseUnit`), with conversion pushed to the
  edge (input time), never carried into the ledger.
- **Ledger-first.** `InventoryStock` is a projection. `InventoryMovement`
  is the source of truth. The projection is never hand-edited outside a
  declared reconciliation path.
- **Deliberately incomplete in two places, on purpose:** costing
  (weighted-average cost, costing method) and reservation
  (`quantityReserved`) are explicitly deferred, not designed-around with
  placeholder columns. Building them now would be speculative — neither
  has a consuming feature yet.

Nothing in this document is open for informal renegotiation during
CR-006 implementation. Any deviation requires a new CR.

## 2. Locked baseline

Carried forward unchanged from CR-004/CR-005 and not reopened here:

- Branch isolation and `branchGuard` enforcement.
- Advisory-lock-guarded atomic deduction at sale time.
- `Transaction`/`InventoryMovement`-style immutability posture (append,
  never edit history) — extended below into the general
  `InventoryMovement` model.
- RBAC boundaries and realtime room isolation.
- Repository/service layering (routers → services → repositories →
  Prisma).

These are assumed, not re-derived, in every section below.

## 3. Immutable identity policy

1. **`InventoryItem.id` is the only immutable technical identity** in
   the inventory domain. It is generated once, at creation, and never
   reused, recycled, or reassigned.
2. **SKU and barcode are nullable, mutable business identifiers.** They
   exist for human/scanner-facing lookup, not for referential integrity.
   Nothing in the schema stores a foreign key against SKU or barcode —
   every reference is `InventoryItem.id`.
3. Because SKU and barcode are mutable, editing either on an existing
   `InventoryItem` never affects historical `InventoryMovement` or
   `ProductComponent` rows — those reference the immutable `id`.
4. **Uniqueness scope:** the current repository is single-tenant (no
   `organizationId` column exists anywhere in the schema). SKU and
   barcode uniqueness is therefore enforced **case-insensitively within
   the current platform as a whole** — a single global unique index per
   field over the non-null values, collated case-insensitively — not
   scoped to a nonexistent `organizationId`. Designing a
   tenant-scoped constraint against a column that does not exist would
   be speculative schema.
5. **Future organization-scoped uniqueness is explicitly out of scope**
   for CR-006 and belongs to a separate, future multi-tenancy CR. That
   future CR will need to decide migration behavior for existing
   platform-wide-unique SKUs/barcodes when `organizationId` is
   introduced; CR-006 does not pre-solve it.

Classification: **LOCKED FOR CR-006** (items 1-4). Item 5:
**DEFERRED**.

## 4. Base-unit policy

1. Every `InventoryItem` declares exactly one `baseUnit`.
2. **`InventoryStock` and every `InventoryMovement` quantity are stored
   in that item's `baseUnit`.** There is no per-row unit override in
   the ledger or the projection.
3. This applies uniformly regardless of what triggered the movement —
   POS sale, purchase receipt, transfer, adjustment, or count
   correction — so aggregation, summation, and reconciliation never
   need runtime unit conversion.

Classification: **LOCKED FOR CR-006**.

## 5. Unit-conversion policy

1. Alternate units (e.g., a purchase invoiced in cases, a recipe
   authored in grams when the item's base unit is kilograms) are
   **converted before ledger insertion**, not stored as-is.
2. To preserve auditability of what a human or upstream system actually
   entered, `InventoryMovement` snapshots three fields at write time:
   - `enteredQuantity` — the quantity as originally entered, in its
     original unit.
   - `enteredUnitId` — the unit that quantity was entered in.
   - `conversionFactorApplied` — the factor used to convert
     `enteredQuantity`/`enteredUnitId` into the stored `baseUnit`
     quantity.
3. The stored ledger `quantity` (in `baseUnit`) is always
   `enteredQuantity × conversionFactorApplied`, and is the only value
   used for stock aggregation. `enteredQuantity`/`enteredUnitId`/
   `conversionFactorApplied` are audit metadata, never re-derived or
   re-aggregated.
4. If an item has no alternate-unit input at all (entered directly in
   `baseUnit`), `enteredUnitId` equals the item's `baseUnit` and
   `conversionFactorApplied` is `1`. No special-case branch is needed
   for the common case.

Classification: **LOCKED FOR CR-006**.

## 6. Canonical movement taxonomy

`InventoryMovement` carries:

- `type: MovementType` — one of the canonical taxonomy below.
- `referenceType` / `referenceId` — a polymorphic pointer to whatever
  business event produced the movement (a `Transaction`, a
  `PurchaseOrder`, a `StockTransfer`, a `PhysicalCount`, etc.). No
  foreign key constraint against a single table, since the referenced
  table varies by `referenceType`.
- `reasonCode` (optional) — free-form-but-enumerable classification for
  adjustments and corrections, independent of `type`.

**The exact 22-value movement taxonomy is kept as-is.** No consolidation
is applied in this document — none of the proposed corrections identify
a compelling, concrete collision or redundancy between existing values,
and taxonomy churn this late has a real cost (every future report,
filter, and permission rule keys off these values). A future CR may
propose consolidation if a specific pair of values is shown to be
genuinely indistinguishable in practice; that has not been demonstrated
here.

Representative groupings within the 22 (illustrative, not a
re-numbering):

- Sale-driven: `SALE_DEDUCTION`, `SALE_REVERSAL`
- Purchasing-driven: `PURCHASE_RECEIPT`, `PURCHASE_RETURN`
- Transfer: `TRANSFER_OUT`, `TRANSFER_IN`
- Adjustment: `ADJUSTMENT_INCREASE`, `ADJUSTMENT_DECREASE`
- Count-driven: `COUNT_VARIANCE_INCREASE`, `COUNT_VARIANCE_DECREASE`
- Production/assembly: `PRODUCTION_CONSUMPTION`, `PRODUCTION_OUTPUT`
- Waste/loss: `WASTE`, `DAMAGE`, `EXPIRY`
- Onboarding/migration: `OPENING_BALANCE`
- Remaining values cover reversal/void counterparts and
  branch-provisioning-adjacent corrections needed to keep every
  movement paired with an explicit opposite where reversal is possible.

Classification: **LOCKED FOR CR-006**.

## 7. Movement reversal rules

1. **Reversals create new, opposite `InventoryMovement` rows that
   reference the original** via `referenceType`/`referenceId` (or a
   dedicated `reversalOfMovementId` pointer where a same-table
   self-reference is clearer than the polymorphic reference). Originals
   are **never edited or deleted** — this extends CR-004's
   `InventoryMovement` immutability guarantee, which already forbids
   `update`/`delete` at the Prisma middleware layer.
2. **`TRANSFER_IN` is explicitly not treated as a reversal of
   `TRANSFER_OUT`.** They are two independent physical legs of one
   logical transfer, not a debit/credit pair of the same event:
   - `TRANSFER_OUT` decrements stock at the source branch the moment
     goods leave.
   - `TRANSFER_IN` increments stock at the destination branch the
     moment goods are received (which may be a different point in
     time, and may never happen if goods are lost in transit).
   - A `StockTransfer` record links the two legs; reconciling
     "shipped but not received" is a *reporting* concern over that
     link, not a reversal.
   - If a transfer is cancelled *before* the destination leg posts,
     the correction is a reversal of `TRANSFER_OUT` alone (an opposite
     movement crediting the source branch back), not a synthesized
     `TRANSFER_IN`.

Classification: **LOCKED FOR CR-006**.

## 8. Reservation strategy

`quantityReserved` is **explicitly deferred and intentionally omitted**
from `InventoryStock` in this finalization. Reasoning:

- No current consuming feature (online ordering with hold-at-checkout,
  layaway, etc.) exists in this codebase to validate the field's
  semantics against.
- A reservation field designed without a real consumer tends to guess
  wrong about expiry/release semantics, concurrency behavior under
  advisory locks, and interaction with the count-cutoff design in
  §15 — better to design it against a real feature request.
- Omitting it now costs nothing: adding a nullable/defaulted
  `quantityReserved` column later is a purely additive migration.

Classification: **DEFERRED**.

## 9. Non-stock products and services

1. Services, fees, discounts, delivery charges, memberships, and other
   digital/non-physical line items **must not require a fake
   `InventoryItem` record** to be sellable. A `ProductVariant` (or
   equivalent sellable unit) is permitted to have **zero**
   `ProductComponent` rows (see §10.9) and sell with no inventory
   movement whatsoever.
2. **`trackInventory=false`** on an `InventoryItem` is reserved
   exclusively for **real physical items that are intentionally not
   quantity-tracked** (e.g., a bulk condiment given away by eyeball
   rather than counted). It is not a mechanism for representing
   non-physical things — those simply have no `InventoryItem` and no
   `ProductComponent` row at all, per (1).
3. This distinction matters operationally: a `trackInventory=false`
   item still has an identity, a unit, and could in principle be
   switched to tracked later without restructuring the product catalog.
   A service with no `InventoryItem` has nothing to "switch on" — it is
   categorically outside the inventory domain.

Classification: **LOCKED FOR CR-006**.

## 10. ProductComponent final contract

`ProductComponent` is the join between a sellable unit (`ProductVariant`
or equivalent) and the inventory it consumes:

1. Quantities on `ProductComponent` are **stored in base units** — the
   referenced `InventoryItem.baseUnit` — matching §4. No component-level
   unit override.
2. A `ProductVariant` **may have zero `ProductComponent` rows** (§9.1) —
   this is a valid, first-class state, not an error condition to guard
   against.
3. `ProductComponent` **must contain no generic, untyped
   `productOptionRef` string field.** Any variability that needs to be
   expressed (e.g., "this component's quantity depends on a selected
   flavor slot") is expressed through a typed, nullable reference to
   the actual owning construct (e.g., a flavor-slot index/FK), never
   through a free-form string that resolves to different tables
   depending on convention. This closes off the exact ambiguity class
   that CR-005's `Recipe.flavorSlotIndex` pattern was designed to avoid
   at the Recipe layer — the same discipline applies here.
4. Each `ProductComponent` row references exactly one `InventoryItem.id`
   (§3) — never a SKU, barcode, or name+unit string pair.

Classification: **LOCKED FOR CR-006**.

## 11. Manufacturing, assembly, and bundle boundary

1. **Flavor and `ProductFlavorSlot` remain isolated in the Product
   domain.** They are catalog/composition concepts (which flavors a
   variant offers, how many slots, whether a slot is required) and do
   not themselves hold stock or post movements.
2. Where a flavor resolves to physical stock, it does so by pointing at
   an `InventoryItem.id` (not a name+unit pair, superseding the interim
   CR-005 name+unit resolver pattern) and that resolution produces a
   `ProductComponent`-shaped consumption, which in turn posts through
   the standard Inventory movement path in §13 — Product/Flavor never
   writes `InventoryStock` or `InventoryMovement` directly (§14.2).
3. Assembly/production (converting raw components into a sellable or
   intermediate item) posts through the `PRODUCTION_CONSUMPTION` /
   `PRODUCTION_OUTPUT` movement pair (§6) — a production event is not a
   special case bolted onto sale deduction; it is its own reference
   type feeding the same universal ledger.
4. Bundles (multiple sellable items packaged as one SKU) are a Product
   domain composition concern layered on top of individually-resolving
   `ProductComponent` rows — Inventory has no bundle-specific concept;
   it only ever sees the flattened list of `InventoryItem`
   consumptions a sale/production event resolves to.

Classification: **LOCKED FOR CR-006**.

## 12. Domain ownership and dependency directions

1. **Inventory remains independent from Product, Sales, Purchasing,
   Flavor, and Production.** It has no compile-time or runtime
   dependency on any of their services, types, or tables. It exposes a
   stable service-level API (e.g., `inventoryService.postMovement`,
   `inventoryService.getCurrentStock`) that those domains call into.
2. **Other domains may reference `InventoryItem` (by `id`) and invoke
   Inventory services, but must not directly write `InventoryStock` or
   `InventoryMovement`.** There is exactly one write path into the
   ledger and projection, owned by the Inventory service layer, mirror-
   ing the way CR-004 already centralized deduction through
   `transactions.service.ts` rather than letting callers touch
   `Ingredient` rows directly.
3. Dependency direction is one-way: `Sales/Product/Purchasing/Flavor/
   Production → Inventory`. Inventory never imports from any of them.

Classification: **LOCKED FOR CR-006**.

## 13. Inventory invariants

1. **Exactly one `InventoryMovement` is created per stock event.** A
   single sale line, a single receipt line, a single transfer leg, a
   single adjustment, a single count-variance correction — each
   produces exactly one movement row, never zero (when stock actually
   moved) and never a batch of ambiguous partial rows for one event.
2. **`InventoryStock` is updated transactionally with that movement** —
   the movement insert and the stock upsert happen inside the same
   database transaction (extending CR-004's `prisma.$transaction` +
   `pg_advisory_xact_lock` pattern per item/branch), so the projection
   can never observe a movement without its corresponding stock delta
   or vice versa.
3. `InventoryStock` remains **aggregate per branch and item** — one row
   per `(branchId, inventoryItemId)` — even after lot/batch/serial
   support is eventually added (§17); lot-level detail, if added, lives
   in a separate additive table, not by fragmenting the aggregate row.

Classification: **LOCKED FOR CR-006**.

## 14. Negative-stock policy

1. Provisioning a branch with a new `InventoryItem` **creates zero
   `InventoryStock` rows and posts no `InventoryMovement`** — mirroring
   CR-004's idempotent provisioning, which seeded zero-stock rows
   rather than fabricating an opening movement. An item exists at a
   branch with implicit zero stock until a real movement occurs.
2. **`OPENING_BALANCE` must not be used for routine provisioning.** It
   is reserved for **controlled imports, migration gaps, or approved
   onboarding balances** — i.e., cases where real physical stock
   already exists and the ledger needs a starting point that isn't
   derivable from any other movement type. Using it as the default
   "new item at new branch" event would silently misrepresent every
   provisioning event as if physical stock had been counted in, which
   it has not.
3. Whether negative stock is *permitted* at the projection level (e.g.,
   a sale posting when `InventoryStock` would go below zero) is a
   business policy decision left to the calling domain's guard (Sales
   may choose to fail-closed on insufficient stock, matching CR-004's
   existing rollback-on-insufficient-stock behavior) — Inventory's
   ledger itself does not forbid a negative resulting balance, since
   forbidding it unconditionally would block legitimate corrective
   flows (e.g., a `COUNT_VARIANCE_DECREASE` recording a real shrinkage
   discovered after the fact, which can legitimately drive the balance
   negative until reconciled).

Classification: **LOCKED FOR CR-006** (items 1-2). Item 3: policy hook,
**LOCKED FOR CR-006** (ledger permits it; calling domain enforces its
own guard).

## 15. Physical-count cutoff design

Physical count variance must be computed against **stock at the actual
count cutoff**, not merely the snapshot taken when the counting session
opened — a count that takes an hour to walk the floor can span several
intervening sales/receipts, and comparing against the session-open
snapshot would misattribute those intervening movements as variance.

1. **Cutoff mechanism:** a `PhysicalCount` session records a
   `cutoffAt` timestamp set at the moment counting is declared
   complete (not session start). Expected quantity for variance
   purposes is computed as the sum of all `InventoryMovement` rows for
   that `(branchId, inventoryItemId)` with `createdAt <= cutoffAt`,
   not a stored snapshot taken at session open.
2. **Handling of intervening movements:** any movement posted between
   session open and `cutoffAt` is included in the expected-quantity
   calculation (it happened before the physical count was actually
   finalized) — movements are never excluded merely because the
   counting session was already in progress when they posted. Movements
   posted **after** `cutoffAt` are excluded and apply normally against
   the post-count balance.
3. **Approval behavior:** a computed variance (counted quantity minus
   expected-at-cutoff quantity) requires explicit approval before it
   posts a `COUNT_VARIANCE_INCREASE`/`COUNT_VARIANCE_DECREASE`
   movement — the count itself is a proposal, not a ledger write, until
   approved. This mirrors CR-005's ACTIVE-edit approval gate pattern.
4. **Stale-count rejection:** if any movement posts against the same
   `(branchId, inventoryItemId)` with `createdAt` between `cutoffAt` and
   the moment of approval, the pending variance is marked stale and
   rejected rather than approved — the expected quantity it was
   computed against no longer reflects reality. The counter must
   recount or the system must recompute against a fresh cutoff.
5. **Recount rules:** a stale or disputed count can be superseded by a
   new `PhysicalCount` session with its own `cutoffAt`; the prior
   session is marked superseded, never deleted, preserving the audit
   trail of who counted what and when even for counts that never
   resulted in a posted variance.

Classification: **LOCKED FOR CR-006**.

## 16. Stock-transfer lifecycle and discrepancy handling

1. A `StockTransfer` links exactly one `TRANSFER_OUT` movement (source
   branch) and, once received, exactly one `TRANSFER_IN` movement
   (destination branch) — per §7.2, these are independent physical legs,
   not a reversal pair.
2. Lifecycle states: `INITIATED` (source decremented, `TRANSFER_OUT`
   posted) → `IN_TRANSIT` → `RECEIVED` (destination incremented,
   `TRANSFER_IN` posted) or `CANCELLED` (only reachable from
   `INITIATED`/`IN_TRANSIT`, before `RECEIVED`).
3. **Discrepancy handling:** if the quantity received differs from the
   quantity shipped (shrinkage, damage in transit, miscount at either
   end), `TRANSFER_IN` posts for the quantity **actually received**,
   not the quantity shipped. The difference is not silently absorbed —
   it is recorded as a `WASTE`/`DAMAGE`/adjustment movement at whichever
   branch and workflow step the discrepancy was identified, so the sum
   of all movements always reconciles to physically-verified quantities.
4. Cancelling a transfer after `TRANSFER_OUT` has posted but before
   `TRANSFER_IN` requires a reversal of the `TRANSFER_OUT` leg (per
   §7.2) crediting the source branch back — there is no `TRANSFER_IN`
   to reverse, because none was posted.

Classification: **LOCKED FOR CR-006**.

## 17. Lot, batch, serial, and expiry readiness

1. **Lot, batch, serial, and expiry support must remain additive and
   future-ready** — nothing in this finalization forecloses adding
   them, and nothing in this finalization builds them now.
2. Readiness is structural, not speculative schema: `InventoryMovement`
   already carries a polymorphic `referenceType`/`referenceId` (§6) and
   a base-unit quantity (§4), both of which a future lot/batch/serial
   layer can key off without altering existing columns.
3. When added, lot/batch/serial detail lives in a new, separate table
   (e.g., `InventoryLot`) referencing `InventoryItem.id` and optionally
   `InventoryMovement.id`; it does not fragment `InventoryStock`, which
   remains the per-branch-per-item aggregate (§13.3). Lot-level
   available-quantity queries become a join/sum over the new table, not
   a schema change to the aggregate.
4. No lot/batch/serial/expiry columns are added as part of CR-006.

Classification: **DEFERRED** (design constraint locked now; fields
built in a future CR).

## 18. Costing boundary

1. **Full costing remains out of scope** for CR-006. No costing engine,
   no cost-of-goods-sold calculation, no valuation reporting is built.
2. **`unitCost` may be nullable on `InventoryMovement`** — a single,
   optional field capturing the cost of that specific movement's
   quantity when it's known (e.g., a purchase receipt line usually
   carries a per-unit cost from the PO). This is a data-capture hook,
   not a costing system.
3. **`weightedAverageCost` and `CostingMethod` (FIFO/LIFO/weighted-
   average, etc.) are omitted until actual costing logic exists** to
   consume them. Adding a costing-method enum or a running weighted-
   average column with nothing computing or reading them would be
   speculative schema that this document explicitly avoids.

Classification: **OUT OF SCOPE** (costing engine). `unitCost` field:
**LOCKED FOR CR-006** (capture only, no computation).

## 19. Canonical naming map

| Concept | Canonical name | Notes |
|---|---|---|
| Physical/trackable thing | `InventoryItem` | Immutable `id` (§3); supersedes `Ingredient` as the universal identity |
| Per-branch aggregate stock | `InventoryStock` | One row per `(branchId, inventoryItemId)` (§13.3) |
| Ledger entry | `InventoryMovement` | Append-only (§7); `type`, `referenceType`/`referenceId`, `reasonCode` (§6) |
| Movement enum | `MovementType` | 22-value taxonomy, unchanged (§6) |
| Base unit of an item | `InventoryItem.baseUnit` | (§4) |
| Entered-unit audit fields | `enteredQuantity` / `enteredUnitId` / `conversionFactorApplied` | On `InventoryMovement` (§5) |
| Product→inventory join | `ProductComponent` | Supersedes `Recipe` (§10); base-unit quantities, no `productOptionRef` |
| Flavor composition | `Flavor`, `ProductFlavorSlot` | Stay in Product domain (§11.1); resolve to `InventoryItem.id`, not name+unit |
| Count session | `PhysicalCount` | Carries `cutoffAt` (§15) |
| Transfer | `StockTransfer` | Links `TRANSFER_OUT` + `TRANSFER_IN` legs (§16) |
| Legacy migration metadata | `InventoryIdentityMapping` | Owns Ingredient→InventoryItem migration data (§20); not stored on `InventoryItem` |

`Ingredient`, `Recipe`, and `BranchRecipeOverride` are retired names —
already deprecated per CR-004/CR-005's superseded notices — and do not
reappear in the CR-006 implementation.

Classification: **LOCKED FOR CR-006**.

## 20. Required CR-006 implementation deltas

Relative to the current (interim, `ProductInventory`-based) state, the
implementation CR must:

1. Introduce `InventoryItem` as the immutable-identity replacement for
   `Ingredient`, with nullable/mutable `sku`/`barcode` and
   case-insensitive platform-wide unique indexes on each (§3).
2. Introduce **`InventoryIdentityMapping`** to own all legacy
   `Ingredient`→`InventoryItem` migration metadata (old ID, old
   name/unit, migration timestamp, migration batch/source). **This
   legacy metadata must not be stored permanently on `InventoryItem`**
   itself — `InventoryItem` stays clean of migration-era fields once
   the mapping table absorbs them.
3. Migrate `InventoryStock`/`InventoryMovement` (or their
   `ProductInventory`-era equivalents) onto base-unit-only quantities
   (§4) plus the `enteredQuantity`/`enteredUnitId`/
   `conversionFactorApplied` audit triad (§5).
4. Add `referenceType`/`referenceId`/`reasonCode` to `InventoryMovement`
   if not already present in that shape, and confirm all 22
   `MovementType` values are represented (§6).
5. Replace any direct `Recipe`/`Ingredient` write paths in Product/
   Flavor/Sales/Production with calls into the Inventory service API
   (§12.2) — no domain other than Inventory writes `InventoryStock` or
   `InventoryMovement` directly after this CR ships.
6. Rework `ProductComponent` to store base-unit quantities and drop any
   `productOptionRef`-style untyped string field in favor of typed
   flavor-slot references (§10.3).
7. Build the `PhysicalCount` cutoff mechanism (§15) — this is new
   functionality, not a migration of existing behavior, since no
   cutoff-aware count flow currently exists.
8. Build the `StockTransfer` two-leg lifecycle (§16) — likewise new.
9. Confirm branch provisioning creates zero `InventoryStock` rows and
   posts no movement (§14.1), carrying forward CR-004's zero-stock
   provisioning behavior onto the new `InventoryItem` model.

Classification: **REQUIRES CR-006 REVISION** relative to the current
interim `ProductInventory` state — all nine items above are new work or
rework, not already-satisfied carryovers.

## 21. Deferred future CRs

- **Multi-tenancy CR:** organization-scoped SKU/barcode uniqueness once
  `organizationId` is introduced (§3.5).
- **Reservation CR:** `quantityReserved` and hold/release semantics,
  once a real consuming feature (online ordering, layaway) exists (§8).
- **Lot/batch/serial/expiry CR:** `InventoryLot`-style additive table
  and consuming queries (§17).
- **Costing CR:** `weightedAverageCost`, `CostingMethod`, and a real
  COGS/valuation engine (§18).
- **Movement taxonomy consolidation CR** (conditional, not scheduled):
  only if a future audit finds a genuinely redundant pair within the
  22-value taxonomy (§6) — not undertaken speculatively here.

## 22. Final implementation-readiness verdict

The Universal Inventory Domain as specified in sections 3-18 is
**ready for CR-006 implementation**. It has:

- A single immutable identity (§3), eliminating the CR-004 cross-branch
  ingredient-identity ambiguity at its root rather than resolving it
  per-query.
- A closed unit model (§4-5) that removes runtime unit-conversion bugs
  from the ledger entirely.
- A locked, unreduced movement taxonomy (§6) with explicit, non-
  overlapping reversal (§7) and transfer (§16) semantics.
- Explicit, honest scope boundaries — reservation (§8), lot/batch (§17),
  and costing (§18) are named and deferred rather than half-built.
- A clean domain boundary (§12) that prevents the exact "who's allowed
  to touch the ledger" ambiguity that CR-004's cross-branch bug and
  CR-005's name+unit resolver were both, in different ways, symptoms of.

No open questions block CR-006 from starting implementation against
this document.

## References

- CR-004 (shipped, superseded) — origin of advisory-lock deduction,
  immutability middleware, idempotent provisioning; those guarantees
  carry forward unchanged into Inventory's movement/stock update path
  (§13.2).
- CR-005 (proposed, superseded) — origin of the flavor-slot
  composition pattern and the ACTIVE-edit approval-gate pattern reused
  in §10.3 and §15.3; its name+unit flavor resolver is explicitly
  superseded by `InventoryItem.id` resolution (§11.2).
- This document is the structural template for CR-006's implementation
  plan.
