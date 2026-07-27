# CR-008 — Universal Product Catalog Architecture

**Status:** Planning only. No code, schema, or data changes performed by this document.
**Date:** 2026-07-27
**Authority (descending):** CR-007 (final, universal inventory) > CR-006 (Phase B doc + Phase B/B.1/C0/C0.1/C plans) > CR-005 (Product Builder/recipe composition) > CR-004 (POS deduction integrity) > existing POS/product schema.

This CR does not weaken or redesign the universal inventory architecture. `InventoryItem` and `Product`/`ProductVariant` remain distinct domains. This CR governs the sellable side only.

---

## 0. Domain separation (restated, locked)

- **InventoryItem** (CR-007 §3): stocked/consumed/transferred/counted/adjusted. Owns `sku`/`barcode`, `baseUnit`, branch-agnostic identity; `InventoryStock` is the per-branch balance.
- **Product / ProductVariant**: sold/displayed/priced/ordered/bundled/made available. No stock balance ever lives here.
- **ProductComponent** (CR-007 §10, already schema-present): `ProductVariant` → `InventoryItem` consumption edge, base-unit quantity only.
- **POS order line** (`TransactionItem`): selects a `ProductVariant` (+ optional `Flavor`), never an `InventoryItem` directly.

No change to this separation is proposed. CR-008 fills the gaps in the *sellable* side: category, identity (SKU), pricing, branch availability, bundles/add-ons, and the recipe/POS relationship, all of which currently either don't exist or are ad hoc.

---

## 1. Existing-schema findings (as-is)

| Concern | Current state | Gap |
|---|---|---|
| Category | `Product.category: String?`, free text, indexed but unconstrained | No configurable category entity, no dedup/archival, no hierarchy |
| SKU/barcode | Not present on `Product` or `ProductVariant` at all | No stable sellable identity independent of name |
| Pricing | `ProductVariant.basePrice` (Decimal 10,2) + `vatableCapAmount`; no branch/promo/scheduled pricing | Single global price only |
| Branch availability | `BranchProductAvailability` (branch × product, `isAvailable` bool) + `BranchFlavorAvailability`; **product-level only, not variant-level** | Can't sell-out one size at one branch while others remain active |
| Bundles | None | Mix & Match, Fries+Loopys etc. have no representation |
| Modifiers/add-ons | `Flavor` + `ProductVariantFlavor` (price premium, kcal offset) + `ProductFlavorSlot` (CR-005, multi-slot selection) — flavor-specific, already generic-enough for its purpose | No generic non-flavor add-on (extra drink, packaging upgrade) |
| Recipe/BOM | `ProductComponent` (CR-007, additive, not yet wired to runtime) supersedes legacy `ProductInventory`; both currently coexist | Wiring/cutover is out of scope here (CR-007 §20.6, deferred) |
| Lifecycle | `Product.status: ProductStatus` (draft/active/temporarily_unavailable/discontinued/archived) + `ProductVariant.lifecycleStatus: VariantLifecycleStatus` (DRAFT→PENDING_APPROVAL→ACTIVE→ARCHIVED, CR-005) | Two parallel lifecycle enums already exist and are sufficient — do not add a third |
| Versioning | `ProductVariant.version` (Int@1) + `ProductChangeLog` (CR-005) | Sufficient; extend pattern, don't replace |
| Audit | `AuditLog` (append-only, hash-chained) + `ProductChangeLog` (product-specific) | Reuse both; no new audit model |
| POS reference | `TransactionItem` already snapshots name/price/recipeVersion/deductionSnapshot | Sufficient pattern; extend for new fields (SKU snapshot, bundle/add-on selections) |

**Conclusion:** the catalog is not being built from zero. CR-008 adds `ProductCategory`, sellable identifiers (SKU), variant-level branch availability + pricing overrides, and bundle/generic-add-on models — it does **not** replace `Product`, `ProductVariant`, `Flavor`, `ProductFlavorSlot`, or `ProductComponent`.

---

## 2. Required domain model analysis

Only models with a demonstrated gap (§1) are proposed. Existing models are extended, not replaced.

### 2.1 `ProductCategory` (new)
- **Purpose:** configurable, reusable category taxonomy, replacing free-text `Product.category`.
- **Identity:** `id` (uuid), authoritative.
- **Required fields:** `name`, `normalizedName` (lowercase/trimmed, unique — duplicate prevention), `isActive`.
- **Optional fields:** `description`, `sortOrder`, `parentCategoryId` (self-relation — only if a real two-level need appears; Potato Corner's own list — Fries, Loopys, Chicken, Drinks, Bundles — is flat, so default to flat, add `parentCategoryId` as a nullable column now to avoid a later migration, but do not populate it).
- **Uniqueness:** `normalizedName` unique (case/whitespace-insensitive collision prevention, same pattern as `InventoryItem.sku` per CR-007 §13.3).
- **Relationships:** `Product.categoryId → ProductCategory.id` (replaces `Product.category` string; string column retained temporarily as `legacyCategory` during migration, dropped in a later CR once verified unused).
- **Lifecycle:** `isActive` soft-toggle; archival never deletes a category referenced by any `Product`.
- **Audit:** `AuditLog` entries on create/rename/archive.
- **Concurrency:** no `version` field needed — categories are low-contention, single-field edits; last-write-wins is acceptable (unlike pricing/recipe).
- **Deletion:** never hard-deleted if referenced; otherwise soft-delete via `isActive=false`.

### 2.2 `Product` (existing, extended)
- Add `categoryId` (nullable FK → `ProductCategory`, migrated from `category` string).
- No other structural change. Remains the "menu concept" (e.g. "French Fries").

### 2.3 `ProductVariant` (existing, extended — decision in §3)
- Add `sku` (nullable, mutable, case-insensitive-unique — mirrors `InventoryItem.sku` convention from CR-007 §13.3) and `barcode` (same pattern).
- No other structural change to the model itself; pricing/availability move to new join models (§2.4/§2.5) rather than more columns on `ProductVariant`, to keep history and per-branch overrides queryable instead of overwritten.

### 2.4 `ProductPrice` (new)
- **Purpose:** priced history + branch/scheduled/promotional override, replacing the assumption that `ProductVariant.basePrice` is the only price that will ever exist.
- **Identity:** `id` (uuid).
- **Required fields:** `productVariantId`, `price` (Decimal 10,2), `priceType` (enum: `BASE` / `BRANCH_OVERRIDE` / `PROMOTIONAL`), `effectiveFrom`.
- **Optional fields:** `branchId` (null = applies to all branches; required when `priceType=BRANCH_OVERRIDE`), `effectiveTo`, `reason`, `createdById`.
- **Uniqueness:** partial unique on `(productVariantId, branchId, priceType)` where `effectiveTo IS NULL` — only one open-ended active price per scope, preventing overlapping ambiguity.
- **Relationships:** `ProductVariant.prices ProductPrice[]`.
- **Priority (highest wins, first match):** open `PROMOTIONAL` row for the branch → open `BRANCH_OVERRIDE` for the branch → `ProductVariant.basePrice` (kept as the row-0 fallback, not deprecated).
- **Lifecycle:** rows are closed by setting `effectiveTo`, never deleted (price history is audit-relevant).
- **Audit:** `AuditLog` on every insert/close.
- **Concurrency:** insert-only; no update-in-place, so no `version` field required.
- **Deletion:** never (append-only, same posture as `InventoryMovement`).
- Tax handling stays outside this CR — `price` is VAT-inclusive SRP exactly as `basePrice` is today; VAT computation is a POS/transaction concern (CR-004's formula), unaffected here.

### 2.5 `ProductVariantBranchAvailability` (new, replaces variant-level gap in `BranchProductAvailability`)
- **Purpose:** per-branch, per-variant sold-out/activation control (today only product-level exists, which can't sell out "Mega Fries" at one branch while "Regular Fries" stays active there).
- **Required fields:** `branchId`, `productVariantId`, `isAvailable` (bool default true).
- **Optional fields:** `soldOutReason`, `soldOutAt`, `updatedById`.
- **Uniqueness:** `(branchId, productVariantId)` unique — same pattern as `BranchProductAvailability`.
- **Relationships:** `Branch`, `ProductVariant`.
- **Inheritance rule:** effective availability = `Product.status=active` AND `BranchProductAvailability(branch,product).isAvailable` (or no row = default true) AND `ProductVariantBranchAvailability(branch,variant).isAvailable` (or no row = default true). All three gates AND together; any false makes the variant unsellable at that branch. `BranchProductAvailability` is retained unchanged as the product-level gate; this new model is strictly additive at the variant level, not a replacement.
- **Lifecycle:** toggled freely; not versioned (matches existing `BranchProductAvailability`, which also has no version field).
- **Audit:** `AuditLog` on toggle (`updatedById` already gives attribution; hook into existing audit write path).

### 2.6 `ProductAttribute` / `ProductAttributeValue` — **not introduced**
Rejected. `sizeLabel` (free string on `ProductVariant`) and the `Flavor`/`ProductFlavorSlot`/`ProductVariantFlavor` mechanism (CR-005) already cover every attribute dimension Potato Corner's use cases require (size, flavor, format). Introducing a fully generic EAV attribute system on top would duplicate `Flavor` and create two competing ways to express "flavor," which CR-005 explicitly reasoned against (rejected a single ingredient FK for exactly this kind of premature genericity). **Decision:** attributes that are variant-defining (size) stay as distinct `ProductVariant` rows (see §3); attributes that are selectable-at-sale (flavor) stay on the existing `Flavor`/`ProductFlavorSlot` path. Re-evaluate only if a second business (non-QSR, e.g. apparel with color+size matrices) is onboarded and demonstrates the existing mechanism doesn't generalize — do not build it speculatively now.

### 2.7 `ProductOptionGroup` / `ProductOption` / `ProductVariantOptionGroup` (new, universal — supersedes the CR-008 draft's "non-flavor only" framing; see §23)

**Corrective note (CR-008.1):** the original §2.7 scoped this mechanism to "non-flavor modifiers," leaving `Flavor`/`ProductFlavorSlot` as a permanent parallel system. That is revised: the generic option architecture below is the universal catalog's *only* selection mechanism going forward (flavor included). `Flavor`/`ProductFlavorSlot` become temporary legacy compatibility structures per §23. Full detail — effect classification, legacy adapter, migration stages, pricing/recipe boundaries, gates — is in §23; this subsection states the schema shapes only.

- **Ownership strategy:** `Product` owns reusable `ProductOptionGroup` definitions (e.g. "Flavor," "Color," a QSR product and a future non-QSR product each define their own groups under their own `Product`). `ProductVariantOptionGroup` links a group to the variants it applies to and may override selection constraints per variant. No business-specific enum names a group — `name` is free-form, deduplicated via `normalizedName`.
- **`ProductOptionGroup`:** `productId` (FK — owner), `name`, `normalizedName` (unique within `productId`), `description?`, `minSelect`, `maxSelect`, `isRequired`, `selectionMode` (enum `SINGLE`/`MULTIPLE` — the one architecturally-justified enum here, since selection UX genuinely bifurcates this way), `sortOrder`, `isActive`, `version` (optimistic concurrency — same edit-contention profile as `ProductFlavorSlot`), effective-dating (`effectiveFrom`/`effectiveTo?`, matching the append-only-history posture used elsewhere in this CR).
- **`ProductVariantOptionGroup`:** `productVariantId`, `productOptionGroupId`, optional per-variant overrides (`minSelect?`/`maxSelect?`/`isRequired?` — null means inherit the group default), `sortOrder`. Unique on `(productVariantId, productOptionGroupId)`. A group's options apply to a variant **only if** this join row exists — this is also the answer to "which options are allowed for each variant" (§23): no separate applicability model is introduced, since group-level linkage already gates it, following the same don't-build-speculatively posture as §2.6.
- **`ProductOption`:** `optionGroupId` (FK), stable `id`, `name`, `normalizedName` (unique within `optionGroupId`), `description?`, `sortOrder`, `isActive`, `effectClassification` (enum, §23.3), `linkedProductVariantId` (nullable FK — required whenever `effectClassification` is `LINKED_VARIANT`), lifecycle/audit per §23.
- **Relationships:** `Product.optionGroups`, `ProductVariant.variantOptionGroups → ProductVariantOptionGroup`, `ProductOptionGroup.options → ProductOption[]`, `ProductOption.linkedVariant → ProductVariant?`.
- **Lifecycle/versioning/audit:** same posture as `ProductFlavorSlot` (CR-005) — changes go through `ProductChangeLog` when the owning variant is ACTIVE; `ProductOptionGroup.version` bumps on constraint edits.

### 2.8 `ProductBundle` / `ProductBundleComponent` (new)
- **Purpose:** Mix & Match, Fries+Loopys, Loopys+Chicken Pops, promotional combos.
- **`ProductBundle`:** modeled as a `ProductVariant` itself (a bundle IS a sellable thing with its own price, SKU, lifecycle, branch availability) — **not** a separate top-level entity duplicating those concerns. A `Product` of category "Bundles" with variants like "Fries + Loopys — Mega" carries the bundle's own `basePrice`/`sku`/lifecycle exactly like any other variant. This reuses every mechanism in §2.2–2.5 instead of re-deriving pricing/availability/versioning for bundles specifically.
- **`ProductBundleComponent`** (the new model): `bundleVariantId` (FK → `ProductVariant`, the bundle), `componentVariantId` (FK → `ProductVariant`, a sellable variant — **not** a direct `InventoryItem` reference, per the prompt's stated default), `quantity` (default 1), `isRequired` (bool), `selectionGroupLabel` (nullable — groups mutually-exclusive optional components, e.g. "choose one drink"), `displayOrder`.
- **Cycle prevention:** `componentVariantId` must not transitively resolve back to `bundleVariantId` — enforced at write time (service-layer graph check), and bundles may nest at most one level deep (a bundle-of-bundles is rejected) to keep sold-out/inventory-availability computation tractable.
- **Inventory deduction:** expands through each component variant's own `ProductComponent` recipe at sale time — no direct `InventoryItem` shortcut, so a bundle never bypasses the recipe/versioning/audit trail a standalone sale would get.
- **Pricing:** the bundle variant's own `basePrice`/`ProductPrice` rows are authoritative; component variants' individual prices are informational only (not summed), since bundles are typically priced below the sum of parts.
- **Versioning:** bundle composition changes bump the bundle variant's existing `version` field and write a `ProductChangeLog` row exactly like any other ACTIVE-variant edit (CR-005 pattern) — no separate bundle-versioning mechanism.
- **Availability:** a bundle is sellable only if the bundle variant itself is available (§2.5) AND every `isRequired=true` component is available; optional/grouped components that are all sold out simply narrow the selectable set (service-layer concern, not schema).

### 2.9 `ProductIdentifier` — **not introduced as a separate model**
SKU/barcode are added as direct nullable columns on `ProductVariant` (§2.3), mirroring `InventoryItem`'s exact pattern (CR-007 §13.3: nullable, mutable, case-insensitive unique, no separate identifier table). A separate `ProductIdentifier` table would only be justified by multiple concurrent identifiers per variant (e.g. legacy + new SKU simultaneously); no such requirement exists today. Revisit only if legacy-identifier coexistence becomes a real migration need (§7).

### 2.10 `ProductLifecycle` / status history — **not introduced**
`ProductStatus` + `VariantLifecycleStatus` + `ProductChangeLog` (CR-005) already provide current-state and change-history. A dedicated status-history table would duplicate `ProductChangeLog`. Not built.

### 2.11 `ProductRecipeVersion` — **not introduced as a new model**
`ProductComponent.version` (CR-007) already versions the recipe edge per variant. The prompt's "recipe ownership" question is answered directly: **a `ProductVariant` resolves to its current set of `ProductComponent` rows (each independently versioned)**, not a separate monolithic "recipe version" wrapper — this matches CR-007's existing design and CR-004's `recipeVersion` snapshot pattern on `TransactionItem` (which snapshots the versions actually used, not a wrapper object). No new model required.

### 2.12 `ProductComponent` linkage — unchanged
Out of scope per prompt ("Do not rework ProductComponent implementation in this CR"). CR-008 only documents the target relationship (§6), consistent with CR-007 §10 and the still-deferred CR-007 §20.6 rework.

---

## 3. Product vs ProductVariant — decision

**Recommendation: keep the existing structure — `Product` = menu concept, `ProductVariant` = sellable size/formulation (e.g. Product "French Fries" → variants "Regular Cheese Fries," "Large Cheese Fries," "Mega BBQ Fries").** This is already how the schema is built; CR-008 does not change it.

Rejected alternatives and why:
- **"Regular Fries" as Product with flavor as a pure selectable option:** already effectively how it works — `Flavor` is a selectable option on top of a variant, not folded into variant identity. Consistent, not rejected in substance, but the *size* dimension must stay variant-level (see next point), so this alternative as stated (collapsing size into Product) is rejected.
- **Every size+flavor combination as its own flat sellable record:** rejected — explodes SKU count combinatorially (5 sizes × 8 flavors = 40 rows per product for what is structurally one recipe difference: size drives quantity, flavor drives one ingredient swap), breaks clean sold-out computation (a flavor stockout would require disabling dozens of records instead of one `ProductVariantFlavor`/`BranchFlavorAvailability` toggle), and duplicates SKU/price maintenance CR-005 already avoided by design.

Decisive reasons for the kept structure:
- **Inventory deduction:** size (variant) drives quantity via `ProductComponent`; flavor drives an ingredient swap via `ProductFlavorSlot`/`Flavor` — these are orthogonal and should stay orthogonal in the schema (CR-005's explicit reasoning, restated here as still correct).
- **Stable SKU identity:** one SKU per size-variant, independent of which flavor is chosen at sale time (flavor is a `TransactionItem.selectedFlavors` snapshot, not a separate catalog identity).
- **Branch pricing/sold-out:** variant-level `ProductPrice`/`ProductVariantBranchAvailability` (§2.4/§2.5) operate at exactly the granularity the business actually reasons about ("Mega Fries sold out at Branch X"), not at the flavor-combination level.
- **Reporting/recipe assignment/bundle composition:** all already keyed off `ProductVariant.id` throughout the existing schema (`ProductComponent`, `ProductBundleComponent`, `TransactionItem.productVariantId`) — changing this would cascade into every one of those.

---

## 4. Category strategy

`ProductCategory` (§2.1), no enum. Duplicate prevention via `normalizedName` unique constraint. Flat by default (`parentCategoryId` nullable column reserved, unpopulated) — Potato Corner's own list (Fries, Loopys, Chicken, Drinks, Bundles) has no real subcategory need today.

## 5. Attribute strategy

No generic attribute system (§2.6 rationale). Size = variant identity. Flavor = existing `Flavor`/`ProductFlavorSlot`/`ProductVariantFlavor`/`BranchFlavorAvailability` mechanism (CR-005), unchanged. Format/serving-type, if ever needed, follows the same pattern as size (a variant dimension) rather than a new attribute table.

**Invalid-combination prevention** (prompt's example: a flavor with no approved recipe): already structurally enforced — `ProductFlavorSlot` selection at sale time must resolve through `Flavor.ingredientName`/`ingredientUnit` (CR-005 Fix 2) via the branch resolver (CR-004); a flavor lacking that linkage fails closed (`INGREDIENT_NOT_PROVISIONED`, CR-004 pattern) rather than being silently sellable. CR-008 adds no new enforcement here — it inherits CR-004/CR-005's existing fail-closed behavior.

## 6. SKU strategy

Owner: `ProductVariant.sku`/`barcode` (§2.3/§2.9), nullable, mutable, case-insensitive unique — identical posture to `InventoryItem` (CR-007 §13.3). `ProductVariant.id` (uuid) remains the immutable identity; SKU is a mutable label on top of it, never the join key for any FK. Barcode follows the same rule. No branch-specific SKU (single global catalog, branch-specific pricing/availability handled by §2.4/§2.5, not by re-issuing SKUs per branch).

## 7. Pricing strategy

`ProductVariant.basePrice` = fallback/default (unchanged column, still authoritative when no override row exists). `ProductPrice` (§2.4) layers branch overrides and time-boxed promotions on top, append-only, with an explicit priority order (promotional > branch override > base). No price field is ever added to `InventoryItem`. Currency: implicit PHP throughout (unchanged, no multi-currency requirement surfaced). Tax: VAT computation stays entirely in the transaction/POS layer (CR-004 formula); `ProductPrice.price` is VAT-inclusive SRP, same convention as `basePrice` today.

## 8. Branch-availability strategy

Two-tier AND (§2.5): existing product-level `BranchProductAvailability` (unchanged) gates the whole menu item; new `ProductVariantBranchAvailability` gates individual sizes. No duplicate `Product`/`ProductVariant` rows per branch — identity stays global, availability is the only per-branch dimension, exactly the prompt's stated default.

## 9. Bundle strategy

Bundles are `ProductVariant` rows (reusing pricing/lifecycle/SKU/availability wholesale) plus new `ProductBundleComponent` rows referencing sellable component variants (never direct `InventoryItem`s), one nesting level max, cycle-checked at write time (§2.8).

## 10. Add-on/modifier strategy (revised, CR-008.1)

**Superseded:** the original split ("flavor stays on its own mechanism forever, generic options are for everything else") is revised. All modifiers — flavor included — are `ProductOptionGroup`/`ProductOption` (§2.7) selections in the target architecture. `ProductVariantFlavor`/`ProductFlavorSlot` remain live only as temporary legacy compatibility structures during the staged migration in §23.5, behind the `LegacyFlavorOptionAdapter` (§23.4). Every inventory-changing option — flavor or otherwise — must resolve through exactly one of `LINKED_VARIANT` or a versioned `RECIPE_ADJUSTMENT` (§23.3/§23.6); no free-text inventory-changing modifier is permitted, enforced at the service layer, and this rule applies identically whether the option originated as a legacy `Flavor` row or a native `ProductOption` row.

## 11. Recipe ownership

A `ProductVariant` resolves to its live set of `ProductComponent` rows (CR-007), each independently versioned; no new "recipe version" wrapper model (§2.11). CR-008 does not rework `ProductComponent` itself (explicitly out of scope, still CR-007 §20.6's deferred item).

## 12. POS order-line strategy (extended, CR-008.1)

`TransactionItem` (unchanged model) continues to reference `productId`/`productVariantId`/`flavorId?` with `onDelete: Restrict` on product and full name/price snapshots. **Additive fields required** (new nullable columns, not a new model): `skuSnapshot` (freezes `ProductVariant.sku` at sale time, since SKU is mutable per §6), `selectedOptions` (Json?, mirrors `selectedFlavors`' snapshot pattern, for §2.7 options — see expanded per-selection shape below), `bundleComponentsSnapshot` (Json?, mirrors `deductionSnapshot`'s pattern, for §2.8 bundle selections). This follows CR-004/CR-005's own established snapshot convention exactly — historical orders remain readable after catalog mutation without requiring any join to current mutable catalog state, matching the prompt's explicit requirement.

Per the §23 corrective pass, each entry inside `selectedOptions` must snapshot enough to survive both catalog mutation *and* the legacy→generic migration, since orders placed mid-migration span both worlds:

- `productOptionId`, `optionGroupId`
- option name snapshot, option-group name snapshot
- `productOptionPriceId` snapshot (§23.7, when the selection carries a price effect), plus the resolved `applicableProductVariantId`/`branchId` scope, `currency`, `adjustmentType`, `amount`, `priority`, `effectiveFrom` at time of sale — resolved values, never a live FK read
- effect-classification snapshot (§23.3)
- `linkedProductVariantId` snapshot, when `LINKED_VARIANT`
- recipe-adjustment version ID snapshot, when `RECIPE_ADJUSTMENT`/`PRICE_AND_RECIPE`
- legacy `flavorId` snapshot, when the selection originated via `LegacyFlavorOptionAdapter` during Stage 1–4 (§23.5)
- legacy `ProductFlavorSlotId` snapshot, when applicable
- selection order/quantity

No new column beyond `selectedOptions` is required for this — it is a Json snapshot precisely so historical rows never depend on a join to `ProductOption`, `Flavor`, or any other mutable catalog row.

## 13. Versioning strategy

Extend the existing `version Int @default(1)` convention (already on `ProductVariant`, `ProductComponent`) to: none needed on `ProductCategory` (low-contention, §2.1), none on `ProductPrice`/`BranchProductAvailability`-style tables (insert-only or last-write-wins by design, §2.4/§2.5), and standard `version` bump + `ProductChangeLog` write on `ProductBundleComponent` edits to an ACTIVE bundle variant (§2.8, same rule as any other ACTIVE-variant edit per CR-005). No new versioning mechanism invented.

## 14. Audit strategy

Reuse `AuditLog` (hash-chained, platform-wide) for category/price/availability/bundle/SKU changes, and `ProductChangeLog` (CR-005) for ACTIVE-variant edits specifically — do not invent a third audit model, per CR-007's own posture on not duplicating existing architecture.

## 15. Existing-schema conflicts

None identified that require weakening CR-007. One naming note: the prompt's authority list references "Approved Phase A," "Approved Phase B/B.1," and "Approved Phase C0.1 plan" — the actual repository artifacts are `docs/superpowers/plans/2026-07-27-cr006-phase-b-backfill-support.md` (Phase B), `2026-07-27-cr006-phase-c-identity-migration.md` (Phase C, references "Phase A/B/B.1 approved implementation" internally), and `2026-07-27-cr006-phase-c0-canonical-reference-initialization.md` (Phase C0, revised by a "Phase C0.1 corrective pass" noted inline, not a separate file). CR-008 treats these as the intended referents; no separate "Phase A" document exists as a standalone file — "Phase A" is the schema-comment label CR-006/CR-007 use for the already-merged additive schema (§1 of this doc, "CR-006 Phase A" comments throughout `schema.prisma`).

## 16. Required schema changes (deferred to implementation CR, not made here) — counts corrected, CR-008.2

- **New (9, was 8):** `ProductCategory`, `ProductPrice` (variant pricing only — no longer extended for options, §23.7 corrected), `ProductVariantBranchAvailability`, `ProductOptionGroup`, `ProductOption`, `ProductVariantOptionGroup`, `LegacyCatalogIdentityMapping` (§23.5 durable legacy↔generic identity mapping), `ProductBundleComponent`, `ProductOptionPrice` (**added**, §23.7 — dedicated append-only option-price model, replaces the rejected `ProductPrice` XOR-extension design).
- **Extended (3, unchanged count):** `Product.categoryId` (new FK, nullable during migration), `ProductVariant.sku`/`barcode` (new nullable columns), `TransactionItem.skuSnapshot`/`selectedOptions`/`bundleComponentsSnapshot` (new nullable columns, `selectedOptions` shape expanded per §12).
- `Flavor`/`ProductFlavorSlot`: **no schema change** in this CR — they remain as-is, read through `LegacyFlavorOptionAdapter` (§23.4); durable mapping lives in the new `LegacyCatalogIdentityMapping` table, not on the legacy models themselves.
- No change to `InventoryItem`, `InventoryStock`, `ProductComponent`, or any CR-007 model.

## 17. Migration phases (analysis only, not implemented here)

1. **Catalog identity migration:** create `ProductCategory` rows from distinct existing `Product.category` string values (deduped via `normalizedName`); backfill `Product.categoryId`; retain `Product.category` (renamed `legacyCategory` in a later CR) until verified unused by any query.
2. **Pricing migration:** no data migration needed — `ProductVariant.basePrice` remains authoritative; `ProductPrice` starts empty, populated only when a branch override/promo is first created; `ProductOptionPrice` (§23.7) likewise starts empty, populated only when an option price is first defined.
3. **Branch-availability migration:** no backfill needed — absence of a `ProductVariantBranchAvailability` row already means "available" (§2.5 inheritance rule), so existing branches need no seed rows.
4. **Recipe migration:** unchanged, remains CR-007 §20.6's deferred `ProductComponent` rework — CR-008 introduces no new recipe migration step.
5. **POS foreign-key transition:** additive-only (`skuSnapshot`/`selectedOptions`/`bundleComponentsSnapshot` nullable columns); no existing `TransactionItem` FK changes; historical rows keep `NULL` in the new columns and remain valid.

## 18. Idempotency and concurrency

- `ProductCategory.normalizedName`, `ProductVariant.sku`/`barcode` (case-insensitive), `ProductVariantBranchAvailability(branchId, productVariantId)`, `ProductPrice` partial-unique-open-row constraint (§2.4), `ProductBundleComponent(bundleVariantId, componentVariantId)` — all enforced as DB unique constraints, not just application checks, matching CR-007's own posture (e.g. `InventoryStock` unique branch+item).
- Concurrent variant edits: existing `version` optimistic-concurrency check (CR-005 pattern) extended to bundle composition writes (§13).
- Concurrent category creation: unique constraint on `normalizedName` makes duplicate-create a DB-level conflict (409), not a race condition — same fail-closed posture as CR-004's `provisionIngredient`.

## 19. Security and permissions

Mapped to the existing Product Builder authorization boundary (CR-005): catalog viewing — all authenticated roles per existing RBAC; product/category/price/bundle creation and editing — supervisor drafts, super_admin activates (unchanged CR-005 rule, extended to category/price/bundle/option entities); branch availability toggle — supervisor scoped to their assigned branches (existing `branch_ids` JWT claim pattern); migration execution — super_admin only, consistent with CR-006/CR-007 migration-tooling posture. No new role is introduced; this CR does not implement authorization code.

## 20. Required architectural decisions (explicit)

1. **Product vs ProductVariant:** unchanged — Product=concept, ProductVariant=sellable size (§3).
2. **SKU ownership:** `ProductVariant.sku` (§6).
3. **Pricing ownership:** `ProductVariant.basePrice` (fallback) + `ProductPrice` (variant overrides) (§7); option adjustments are owned by the dedicated `ProductOptionPrice` model, never `ProductPrice` (§23.7, CR-008.2).
4. **Category ownership:** new `ProductCategory`, FK from `Product` (§4).
5. **Recipe ownership:** `ProductComponent` per variant, unchanged, no wrapper (§11).
6. **Branch-availability ownership:** two-tier, `BranchProductAvailability` (product) AND `ProductVariantBranchAvailability` (variant, new) (§8).
7. **Bundle representation:** bundle = `ProductVariant` + `ProductBundleComponent` referencing component variants, never direct `InventoryItem` (§9).
8. **Modifier representation (revised, CR-008.1):** universal `ProductOptionGroup`/`ProductOption`/`ProductVariantOptionGroup` (§2.7) is the target architecture for *all* modifiers including flavor; `Flavor`/`ProductFlavorSlot` are temporary legacy compatibility structures behind `LegacyFlavorOptionAdapter`, retired only after the Stage 1–6 migration (§23.5) clears gates O1–O8 (§23.8). Inventory-changing options must resolve through `LINKED_VARIANT` or a versioned `RECIPE_ADJUSTMENT` — never free text (§10, §23.3).
9. **Sold-out calculation boundary:** owned by a catalog/availability service consuming `Product.status` + both availability tiers + downstream `InventoryStock` sufficiency (via `ProductComponent`) — computation itself is out of scope (not implemented here), only the ownership boundary is fixed.
10. **Historical order snapshots:** `TransactionItem` additive snapshot columns, never a join to live catalog state (§12).
11. **Versioning boundary:** `version` field only where concurrent edit risk is real (`ProductVariant`, `ProductComponent`, bundle composition edits); insert-only or low-contention tables skip it (§13).
12. **Audit boundary:** `AuditLog` (platform-wide) + `ProductChangeLog` (ACTIVE-variant-specific), no new audit model (§14).
13. **Migration boundary:** catalog-identity/category migration only in this CR's follow-on; pricing/availability need no backfill; recipe migration stays CR-007 §20.6's separate deferred item (§17).
14. **Deletion and archival:** never hard-delete a referenced `ProductCategory`/`ProductVariant`/bundle component; archive via existing status enums; `ProductPrice`/`AuditLog`-style rows are append-only and never deleted.

---

## 21. Phase sequencing (recommended)

1. Phase C0 — canonical inventory references (CR-006, already planned, unaffected by this CR)
2. Phase C — inventory identity migration (CR-006, already planned, unaffected by this CR)
3. **Phase D — Product Catalog foundation:** `ProductCategory` model + migration of `Product.category` strings (schema-only CR, this CR's first implementation follow-on)
4. **Phase E — Product identifiers & pricing:** `ProductVariant.sku`/`barcode`, `ProductPrice`
5. **Phase F — Branch availability parity:** `ProductVariantBranchAvailability`
6. **Phase G** — `InventoryStock` initialization (already reserved by CR-006 Phase C plan's schema comment — unaffected, sequenced here only for cross-reference)
7. **Phase H — Bundles & options:** `ProductBundleComponent`, `ProductOptionGroup`, `ProductOption`
8. **Phase I — POS integration:** `TransactionItem` snapshot column additions, sold-out/availability service wiring
9. **Phase J — Recipe/BOM cutover:** CR-007 §20.6's deferred `ProductComponent` rework (separate CR, not started here)

Each phase is independently shippable and additive; no phase requires reverting a prior one.

---

## 22. Blockers / unknowns

- Whether `ProductCategory.parentCategoryId` will ever be populated is unresolved — column reserved, not used, no blocker.
- Sold-out computation service ownership (module name/location) is not decided in this CR — an architectural decision (§20.9) fixes the boundary but not the implementation module; first implementer of Phase I must choose consistent with the existing `<name>.service.ts` convention.
- No blocker requiring CR-007 renegotiation was found.
- §23 blockers/unknowns are listed separately at §23.10.

---

## 23. Generic option architecture & flavor migration (CR-008.1 corrective pass)

This section is the authoritative detail for the option/flavor boundary. §2.7 and §10 above summarize; this section is the full definition and controls on any conflict.

### 23.1 Why this correction was needed

The original §2.7 treated `Flavor`/`ProductFlavorSlot` as a permanent, food-specific parallel system sitting alongside a generic option mechanism reserved for "everything else." That violates CR-008's own stated premise (a **universal** catalog) — a future non-food business (apparel color/material, service temperature/prep-style) would have no path onto the flavor mechanism, and the catalog would permanently carry a food-specific model at its core. This pass makes `ProductOptionGroup`/`ProductOption`/`ProductVariantOptionGroup` (§2.7) the one universal selection mechanism, and demotes `Flavor`/`ProductFlavorSlot` to temporary legacy compatibility, retired only under a future separate CR (Stage 6, §23.5).

### 23.2 Ownership strategy (confirmed)

`Product` owns reusable `ProductOptionGroup` definitions; `ProductVariantOptionGroup` links a group to the variants it applies to, with optional per-variant constraint overrides. This mirrors the existing `ProductComponent`/`ProductBundleComponent` pattern of "definition lives on the owning entity, applicability is a join row" already used elsewhere in this CR — no new ownership idiom is introduced.

### 23.3 Option effect classification

`ProductOption.effectClassification` (enum):

| Value | Price effect | Inventory effect | Resolution |
|---|---|---|---|
| `DISPLAY_ONLY` | none | none | display/reporting only |
| `PRICE_ONLY` | yes | none | `ProductOptionPrice`-equivalent row (§23.7) |
| `RECIPE_ADJUSTMENT` | none | yes | versioned recipe adjustment (§23.6) |
| `LINKED_VARIANT` | via linked variant's own price | yes | `linkedProductVariantId`, deduction expands through that variant's active `ProductComponent` recipe |
| `PRICE_AND_RECIPE` | yes | yes | both of the above |

Every `ProductOption` carries exactly one classification. This is the generic form of §2.7's original inventory-changing rule, extended to also cover price-only and display-only cases explicitly instead of leaving them implicit.

### 23.4 Inventory-changing option rule (generalized)

Unchanged in substance from the original §2.7/§10 rule, restated precisely: any option classified `LINKED_VARIANT`, `RECIPE_ADJUSTMENT`, or `PRICE_AND_RECIPE` MUST resolve through exactly one of (a) `linkedProductVariantId` or (b) a versioned recipe adjustment (§23.6) — never through option display name, legacy flavor name, free text, inferred unit conversion, category, or a hard-coded runtime switch. Validated at the service layer before the option can be published ACTIVE, and re-verified at Gate O4 (§23.8) before any runtime cutover.

### 23.5 Legacy Flavor compatibility strategy

**`Flavor`/`ProductFlavorSlot`:** retained, unchanged schema, as temporary legacy compatibility structures only. Not the permanent architecture.

**`LegacyFlavorOptionAdapter`** (conceptual boundary, not implemented in this CR):
- Exposes existing `Flavor` rows as generic `ProductOption` reads (classification: `LINKED_VARIANT` if the flavor already resolves an ingredient via CR-005's `Flavor.ingredientName`/`ingredientUnit` path, otherwise `RECIPE_ADJUSTMENT`).
- Resolves legacy `ProductFlavorSlot` rules (min/max selection, required-ness) into `ProductOptionGroup`/`ProductVariantOptionGroup` constraint shape for read purposes.
- Prevents dual deduction: while legacy is authoritative (Stage 1–3), the adapter's generic-shaped reads must never themselves trigger a second deduction path.
- Prevents duplicate selection: a flavor and its generic-mapped option must be recognized as the same selection, never offered as two independent choices.
- Provides deterministic legacy→generic identity mapping via `LegacyCatalogIdentityMapping` (§23.9), never derived from name matching.

**Durable mapping model (new, persisted — required because Stage 2 mandates durability/auditability, so this cannot stay adapter-only):**

`LegacyCatalogIdentityMapping`: `legacyType` (enum `FLAVOR` / `FLAVOR_SLOT`), `legacyId`, `genericType` (enum `OPTION` / `OPTION_GROUP`), `genericId`, `createdAt`, `createdById`. Unique on `(legacyType, legacyId)` — one durable mapping per legacy record, auditable via `AuditLog`, never inferred from name at read time.

### 23.6 Flavor migration stages

1. **Compatibility:** legacy `Flavor`/`ProductFlavorSlot` remain authoritative for runtime. Generic option models are introduced with zero effect on live checkout. Adapter reads are read-only/dual-readable. No generic-option write affects inventory deduction yet.
2. **Identity mapping:** populate `LegacyCatalogIdentityMapping` for every active `Flavor`→`ProductOption` and `ProductFlavorSlot`→`ProductOptionGroup`/variant-constraint pairing. Durable, auditable, never name-derived.
3. **Dual validation:** legacy and generic option resolution run side by side; mismatches are reported; only the legacy path affects production checkout.
4. **Write cutover:** product administration begins writing generic option structures directly; legacy records remain readable; checkout starts snapshotting selected generic option IDs (§12) alongside the legacy path.
5. **Runtime cutover:** generic options become authoritative for checkout; `Flavor`/`ProductFlavorSlot` become compatibility-only (no longer read at sale time); inventory deduction runs exclusively through `LINKED_VARIANT`/recipe-adjustment resolution. Gated by O1–O8 (§23.8).
6. **Retirement:** `Flavor`/`ProductFlavorSlot` may be archived or removed only under a separate, future, explicitly approved CR. Historical orders remain readable via the §12 snapshot fields regardless of what happens to the live legacy tables.

### 23.7 Option pricing boundary (revised, CR-008.2 — supersedes prior `ProductPrice` XOR-extension design)

**Correction:** the CR-008.1 design (an optional `productOptionId` FK bolted onto `ProductPrice`, XOR against `productVariantId`) is rejected as unsafe polymorphism — it collapses two different lifecycles (variant base/override pricing vs. option adjustment pricing) into one nullable-FK table, defeating clean uniqueness/overlap constraints and making the priority-resolution query branch on which FK is set. `ProductPrice` (§2.4) remains **variant pricing only**; it is not extended in this pass. Option pricing gets its own dedicated, append-only model: `ProductOptionPrice`.

**`ProductOptionPrice` (new model):**

- `id` (uuid)
- `productOptionId` (FK → `ProductOption`, required)
- `applicableProductVariantId` (FK → `ProductVariant`, nullable — see applicability below)
- `branchId` (FK → `Branch`, nullable — see applicability below)
- `currency` (ISO-style uppercase code, e.g. `PHP`; normalized/validated; must match the resolved `ProductVariant` price's currency — no silent conversion, mismatch blocks checkout)
- `adjustmentType` (enum: `FIXED_DELTA` | `FIXED_OVERRIDE` — no percentage type; not evidenced as needed)
- `amount` (Decimal 10,2)
- `priority` (Int — explicit tie-break within same specificity tier)
- `effectiveFrom` (required), `effectiveTo` (nullable; if set, must be ≥ `effectiveFrom`)
- `isActive` (soft lifecycle toggle, same posture as §2.5)
- `createdAt`, `createdById`
- `supersedesProductOptionPriceId` (nullable, self-relation — records a correction lineage without mutating the superseded row)
- Audit: `AuditLog` entry on every insert/deactivate/supersede, same as §2.4/§2.5.
- Historical rows are never mutated or deleted once referenced by a `TransactionItem` snapshot (§12); corrections are new rows via `supersedesProductOptionPriceId`, matching the append-only posture already used for `ProductPrice`/`InventoryMovement`.

**Applicability semantics:**

- `productOptionId` only → global adjustment for that option, any variant/branch.
- `+ applicableProductVariantId` → adjustment scoped to that option on one variant.
- `+ branchId` → branch-specific adjustment, all applicable variants.
- `+ applicableProductVariantId + branchId` → branch-and-variant-specific adjustment.
- A `ProductOptionPrice` row never makes an otherwise-invalid selection sellable — the option must still be valid for the selected variant via `ProductVariantOptionGroup` (§2.7) independent of any pricing row. Pricing is a value resolution, not an applicability grant.

**Resolution priority (deterministic, most-specific first):**

1. option + variant + branch
2. option + variant
3. option + branch
4. option (global)

Within the same specificity tier: higher explicit `priority` wins. If `priority` also ties, the tie is **not** broken by `effectiveFrom` recency — an unresolved tie blocks checkout (fail closed) rather than choosing arbitrarily; this is stricter than §2.4's variant-pricing tie posture and is intentional given options compose per line-item. `ProductPrice` resolves the `ProductVariant` base price first; `ProductOptionPrice` then resolves each selected option's adjustment independently. The combined result is snapshotted at checkout (§12) — never re-derived from a live join on a historical order.

**`FIXED_OVERRIDE` semantics:** overrides only the option's own adjustment amount, never the variant's base price. Example: base variant price $5.00, option `FIXED_DELTA` +$0.50 → option charge $0.50; a competing `FIXED_OVERRIDE` row resolving instead sets the option's own charge directly (e.g. $0.75) → final price $5.75. It never replaces the full order-line price.

**Duplicate and overlap prevention:**

1. DB-level uniqueness on exact-duplicate identity: `(productOptionId, applicableProductVariantId, branchId, currency, priority)` scoped to the effective period (matches §2.4's partial-unique posture, adapted for the extra `priority` dimension).
2. Time-range overlap is not fully expressible as a simple unique index — required in addition: service-layer overlap validation at write time (reject/flag two active rows at the same specificity+priority+currency scope with overlapping `[effectiveFrom, effectiveTo)` periods) plus a concurrency-safe recheck immediately before commit (matches CR-004's `provisionIngredient` fail-closed pattern, §18/§23.10 O3 precedent). If the target Postgres version supports a range/exclusion constraint compatible with Prisma's raw-migration escape hatch, a follow-on implementation task should evaluate it; it is not assumed available here.
3. A write that would create an overlapping equal-precedence pair returns a conflict (409), never a silent last-write-wins.

**Currency rule:** authoritative ISO-style uppercase code, normalized and validated; must equal the resolved `ProductVariant` price's currency for the same order line. No silent conversion. Mismatch blocks checkout.

**Missing-price and zero-price behavior:** absence of a `ProductOptionPrice` row is never silently treated as free. `DISPLAY_ONLY` and `RECIPE_ADJUSTMENT` options may resolve to zero price only when the owning `ProductOptionGroup`/`ProductOption` configuration explicitly allows it (§23.3). `PRICE_ONLY` and `PRICE_AND_RECIPE` options require either a resolvable `ProductOptionPrice` row or an explicit zero-price authorization flag on the option/group; if neither is present, the option is not sellable and checkout blocks rather than defaulting to zero.

**Pre-resolution validation:** before resolving an option's price, verify (in order): the `ProductOption` is active; its group applies to the selected variant via `ProductVariantOptionGroup`; the selected branch is valid and the option is available there; any `linkedProductVariantId` is itself available; `effectiveFrom`/`effectiveTo` cover the transaction time; currency matches; and no priority tie remains unresolved. Any failure blocks checkout — never silently degrades to a partial or zero price.

Final order-line price, including every selected option's resolved adjustment, is snapshotted at checkout into `TransactionItem` (§12) — never re-derived from a live join against current catalog state.

### 23.8 Recipe-adjustment boundary (conceptual only, not implemented here)

For `RECIPE_ADJUSTMENT`/`PRICE_AND_RECIPE` options, a future Recipe/BOM CR must define a versioned relationship conceptually equivalent to `ProductOptionRecipeAdjustment` (`productOptionId`, `applicableProductVariantId`, recipe/effective version, `InventoryItem` components + quantity + unit, operation `ADD`/`REPLACE`/`REMOVE`, approval status, effective dates). CR-008 fixes only this target relationship shape; no `InventoryItem` FK is added directly to `ProductOption`, and no recipe logic is implemented in this CR — consistent with §2.12's existing `ProductComponent` boundary.

### 23.9 Invalid-option-combination prevention

A `ProductVariant` must not be sellable with an option selection that has no valid price or inventory resolution. Constraints enforced (service layer, not new schema beyond §2.7's models): which `ProductOptionGroup`s apply to a variant (`ProductVariantOptionGroup` presence, §2.7); per-group min/max/required; mutually exclusive options (expressed via `selectionMode=SINGLE` at the group level — a second cross-group exclusion model is not introduced now, matching §2.6's don't-build-speculatively posture, revisit only if a real cross-group exclusion need surfaces); branch restrictions (via existing §2.5 variant availability, unaffected by this pass); effective dates (`ProductOptionGroup`/`ProductOption` effective-dating, §2.7); recipe/linked-variant availability (an option resolves to unavailable if its `linkedProductVariantId` or recipe adjustment is itself unavailable — checked at the same service boundary as §20.9's sold-out computation).

### 23.10 Gates (pre-cutover)

Mandatory before Stage 5 (runtime cutover) of §23.6 may proceed:

- **O1:** every active legacy `Flavor` has a durable `ProductOption` mapping (`LegacyCatalogIdentityMapping`).
- **O2:** every active `ProductFlavorSlot` constraint resolves to generic option-group applicability.
- **O3:** no duplicate or ambiguous mappings exist (`LegacyCatalogIdentityMapping` unique constraint plus a service-layer ambiguity check).
- **O4:** every inventory-changing option resolves to a linked variant or approved recipe adjustment (§23.4).
- **O5 (revised, CR-008.2) — Valid and unambiguous option pricing:** every active `PRICE_ONLY` option has a resolvable `ProductOptionPrice` or explicit zero-price authorization; every active `PRICE_AND_RECIPE` option has a resolvable `ProductOptionPrice` or explicit zero-price authorization; all applicable variant/branch combinations resolve deterministically; no overlapping equal-precedence `ProductOptionPrice` records exist; no unresolved priority ties exist; currencies match the resolved `ProductVariant` price; checkout snapshots include the resolved `ProductOptionPrice` identity and values (§12, §23.7). Any failure blocks runtime cutover.
- **O6:** dual-validation (Stage 3) mismatch count is zero, or every remaining mismatch is explicitly waived per record.
- **O7:** historical order snapshot compatibility verified — pre-migration `TransactionItem` rows remain fully readable under the expanded §12 snapshot shape.
- **O8:** a tested rollback path to legacy checkout exists and is exercised before runtime cutover is flipped.

### 23.11 Blockers / unknowns (§23-scoped)

- Cross-group mutual exclusion (e.g. "size L is incompatible with topping X") has no dedicated model in this pass — deferred per §23.9 until a real case surfaces; not a blocker for Stages 1–4.
- The exact enum member set for `legacyType`/`genericType` on `LegacyCatalogIdentityMapping` may need a third pairing if a future legacy structure beyond `Flavor`/`ProductFlavorSlot` needs migrating — extendable without a boundary change.
- No blocker requiring renegotiation of CR-007's inventory boundary was found; §23.8's recipe-adjustment shape is deliberately left to the future BOM CR.
