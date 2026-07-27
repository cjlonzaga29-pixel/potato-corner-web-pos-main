# CR-008 — Universal Product Catalog: Implementation Planning

**Status:** Planning only. No code, schema, or data changes performed by this document or its tasks — this file defines future work, it does not execute it.
**Governed by:** `docs/decisions/CR-008-universal-product-catalog.md` (architecture, final for this scope) > CR-007 > CR-006 (Phase B/C/C0 plans) > CR-005 > CR-004.

Tasks are grouped by phase (CR-008 §21). Each task is scoped for one implementer + one reviewer. No task in this file is authorized to run yet — each requires its own approval gate before execution, consistent with the CR-006 Phase C0/C0.1 precedent of planning-then-explicit-apply.

---

## Phase D — Product Catalog foundation

### D1. `ProductCategory` schema addition
- **Objective:** Add `ProductCategory` model per CR-008 §2.1; add nullable `Product.categoryId` FK. No backfill yet.
- **Exact expected files:** `apps/api/prisma/schema.prisma` (model + FK only); new migration under `apps/api/prisma/migrations/`.
- **Implementation steps:** Add `ProductCategory` model (id, name, normalizedName unique, description?, sortOrder?, parentCategoryId? self-relation, isActive default true, timestamps). Add `Product.categoryId String?` + relation. Do not drop `Product.category`. Run `prisma migrate dev` only against verified local shadow DB per CLAUDE.md's three-URL rule.
- **Tests:** Prisma schema validates (`prisma validate`); migration applies cleanly to a fresh local DB; existing seed/test suite still passes with `categoryId` null everywhere.
- **Validation command:** `pnpm --filter api prisma validate && pnpm --filter api prisma migrate dev --name add_product_category` (local shadow DB only) `&& pnpm --filter api test`.
- **Rollback:** drop the migration (schema-only, no data written yet) — safe, zero rows depend on it.
- **Stop condition:** if `DIRECT_URL` does not resolve to the verified local/dev DB, stop and escalate — do not run migrate.
- **Architectural reference:** CR-008 §2.1, §4, §16.

### D2. Category backfill (data migration, dry-run first)
- **Objective:** Populate `ProductCategory` from distinct `Product.category` values; backfill `Product.categoryId`.
- **Exact expected files:** `apps/api/src/modules/product-catalog-migration/` (new module: `dry-run.ts`, `apply.ts`, `types.ts`), `apps/api/scripts/product-category-backfill.ts` (CLI entrypoint), following the `inventory-migration` module convention (CR-006 Phase B precedent).
- **Implementation steps:** Dry-run mode: read distinct `Product.category` strings, normalize, group, report proposed `ProductCategory` rows + collision/ambiguity flags, zero writes. Apply mode: gated behind explicit batch ID + confirmation flag, writes `ProductCategory` rows + `Product.categoryId` backfill inside one transaction, emits audit report (same pattern as CR-006 Phase C0's manifest/apply/rollback tool).
- **Tests:** Vitest unit tests for normalization/grouping (synthetic fixtures, no DB seeding of fake production data, per CR-006 Phase B constraint). Integration test against local DB: dry-run emits zero writes; apply is idempotent (second run is a no-op).
- **Validation command:** `pnpm --filter api tsx scripts/product-category-backfill.ts --dry-run` reviewed manually before any `--apply` run.
- **Rollback:** apply tool emits a report consumable by a rollback tool that deletes only the rows it created in that batch (CR-006 Phase C0 rollback pattern) and nulls the `categoryId` backfill it performed.
- **Stop condition:** any `Product.category` value that doesn't cleanly normalize to a single candidate stops that row as `UNRESOLVED` for manual review — never auto-resolved.
- **Architectural reference:** CR-008 §17 (migration phase 1).

---

## Phase E — Product identifiers & pricing

### E1. `ProductVariant.sku`/`barcode` schema addition
- **Objective:** Add nullable, case-insensitive-unique `sku`/`barcode` columns to `ProductVariant`, mirroring `InventoryItem`'s exact pattern.
- **Exact expected files:** `apps/api/prisma/schema.prisma`; new migration.
- **Implementation steps:** Add columns + citext/lower-index-based case-insensitive unique constraint (match whatever mechanism `InventoryItem.sku` already uses — inspect that column's actual constraint implementation before copying, don't assume).
- **Tests:** constraint test — inserting two variants with same SKU differing only in case fails; null SKUs coexist freely (nullable unique allows multiple nulls in Postgres).
- **Validation command:** `pnpm --filter api prisma validate && pnpm --filter api prisma migrate dev --name add_variant_sku_barcode && pnpm --filter api test`.
- **Rollback:** drop migration, zero data dependency (nullable, unpopulated).
- **Stop condition:** if `InventoryItem.sku`'s actual constraint mechanism differs from assumed (e.g. app-layer-only, not DB-level), stop and reconcile before proceeding — CR-008 §18 requires DB-level enforcement.
- **Architectural reference:** CR-008 §2.3, §2.9, §6.

### E2. `ProductPrice` model
- **Objective:** Add `ProductPrice` model per CR-008 §2.4 (append-only, branch/promo override).
- **Exact expected files:** `apps/api/prisma/schema.prisma`; new migration; `apps/api/src/modules/product-pricing/` (new module: router/service/repository/types per CLAUDE.md module convention).
- **Implementation steps:** Add model with partial unique index on `(productVariantId, branchId, priceType)` where `effectiveTo IS NULL`. Build read-path service resolving effective price by priority (promotional > branch override > base) — write-path (creating override/promo rows) is a separate task (E3), this task is schema + read-resolution only.
- **Tests:** unit tests for priority resolution (promotional beats branch-override beats base; expired rows excluded; multiple branches don't collide).
- **Validation command:** `pnpm --filter api test -- product-pricing`.
- **Rollback:** schema-only migration, drop if unused; no runtime code reads it until this task's service is wired in, so safe pre-wiring.
- **Stop condition:** if any existing checkout/pricing code path assumes `basePrice` is the only price and this task's read-resolution isn't yet called from it, do not wire it into POS checkout in this task — that's Phase I.
- **Architectural reference:** CR-008 §2.4, §7, §13.

### E3. `ProductPrice` write path (admin API)
- **Objective:** Endpoint(s) for supervisor/super_admin to create branch-override/promotional price rows.
- **Exact expected files:** `apps/api/src/modules/product-pricing/product-pricing.router.ts` (extend from E2), Zod schemas in `packages/shared`.
- **Implementation steps:** Validate `effectiveFrom`/`effectiveTo` ordering; close any existing open row of the same `(variant, branch, priceType)` scope before opening a new one (never two open rows in the same scope, per §2.4 unique constraint); write `AuditLog` entry.
- **Tests:** creating a second open override in the same scope closes the first, not a constraint violation; RBAC test — staff role rejected.
- **Validation command:** `pnpm --filter api test -- product-pricing`.
- **Rollback:** feature-flag the router registration if issues surface post-merge; underlying data is append-only so no destructive rollback needed.
- **Stop condition:** none beyond standard RBAC/Zod review.
- **Architectural reference:** CR-008 §7, §14, §19.

---

## Phase F — Branch availability parity

### F1. `ProductVariantBranchAvailability` model + toggle API
- **Objective:** Add variant-level branch availability per CR-008 §2.5.
- **Exact expected files:** `apps/api/prisma/schema.prisma`; migration; extend existing branch-product-availability module (or new `product-variant-availability` module, match current file location for `BranchProductAvailability`'s existing router).
- **Implementation steps:** Add model with `(branchId, productVariantId)` unique. Toggle endpoint scoped to supervisor's assigned branches (JWT `branch_ids` claim). Absence of a row = available (default-true inheritance, §2.5) — do not seed rows for existing branches.
- **Tests:** toggle off then read effective-availability helper returns false; no row present returns true (default); supervisor outside `branch_ids` scope rejected.
- **Validation command:** `pnpm --filter api test -- product-variant-availability`.
- **Rollback:** schema-only addition, drop migration if unused pre-launch.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §2.5, §8, §19.

### F2. Effective-availability resolution helper
- **Objective:** Single function combining `Product.status` + `BranchProductAvailability` + `ProductVariantBranchAvailability` (three-gate AND, §2.5).
- **Exact expected files:** `apps/api/src/modules/product-catalog/availability.ts` (new, or colocate in existing product module — match convention).
- **Implementation steps:** Pure function, three inputs, boolean out; used by POS menu-fetch (not modified in this task, consumed later in Phase I).
- **Tests:** all 8 truth-table combinations of the three gates.
- **Validation command:** `pnpm --filter api test -- availability`.
- **Rollback:** unused function, no risk.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §8, §20.9.

---

## Phase H — Generic options & legacy flavor migration (revised, CR-008.1 — was "Bundles & options")

### H1. `ProductOptionGroup`/`ProductOption`/`ProductVariantOptionGroup` schema foundation
- **Objective:** Add the universal option models per CR-008 §2.7/§23.2 (supersedes the old non-flavor-only H1).
- **Exact expected files:** `apps/api/prisma/schema.prisma`; migration.
- **Implementation steps:** Add all three models (`ProductOptionGroup` owned by `Product`; `ProductOption` owned by group; `ProductVariantOptionGroup` join with per-variant overrides); `ProductOption.effectClassification` enum (§23.3); `ProductOption.linkedProductVariantId` nullable FK with app-layer check that `LINKED_VARIANT`/`PRICE_AND_RECIPE` options carry the link (Prisma/Postgres can't express the cross-field conditional cleanly — accepted app-layer enforcement point, not a gap, same posture as the prior draft).
- **Tests:** schema validates; FK constraints present; normalizedName uniqueness within group/product.
- **Validation command:** `pnpm --filter api prisma validate && pnpm --filter api prisma migrate dev --name add_product_options`.
- **Rollback:** schema-only, safe to drop pre-adoption.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §2.7, §23.2, §23.3.

### H2. `ProductOptionPrice` schema and constraints (revised, CR-008.2 — was "`ProductPrice` extension")
- **Objective:** Add the dedicated `ProductOptionPrice` model per CR-008 §23.7 (CR-008.2 correction). Replaces the rejected design of extending `ProductPrice` with an optional `productOptionId` XOR FK — `ProductPrice` stays variant-only, unmodified by this task.
- **Exact expected files:** `apps/api/prisma/schema.prisma`; new migration (independent of E2, no change to `ProductPrice`); `apps/api/src/modules/product-option-pricing/` (new module: `product-option-pricing.types.ts`, `product-option-pricing.repository.ts`).
- **Implementation steps:** Add `ProductOptionPrice` model (id, `productOptionId` required FK, `applicableProductVariantId`/`branchId` nullable FKs, `currency`, `adjustmentType` enum [`FIXED_DELTA`/`FIXED_OVERRIDE`], `amount` Decimal 10,2, `priority` Int, `effectiveFrom`, `effectiveTo?`, `isActive`, `createdAt`, `createdById`, `supersedesProductOptionPriceId?` self-relation). DB-level uniqueness on exact-duplicate identity `(productOptionId, applicableProductVariantId, branchId, currency, priority)` scoped to open (`effectiveTo IS NULL`) rows, mirroring `ProductPrice`'s partial-unique pattern (E2). Check constraint: `effectiveTo` null or ≥ `effectiveFrom`. Wire `AuditLog` writes on insert/deactivate/supersede.
- **Tests:** schema validates; exact-duplicate insert at the same open scope is rejected at the DB level; `effectiveTo < effectiveFrom` rejected; Decimal precision round-trips correctly; audit row written on insert.
- **Validation command:** `pnpm --filter api prisma validate && pnpm --filter api prisma migrate dev --name add_product_option_price && pnpm --filter api test -- product-option-pricing`.
- **Rollback:** schema-only migration, zero rows depend on it pre-adoption, safe to drop.
- **Stop condition:** if `InventoryItem`/`ProductPrice`'s actual partial-unique-index mechanism differs from assumed, inspect and reconcile before proceeding (same posture as E1).
- **Architectural reference:** CR-008 §23.7 (CR-008.2 revision).

### H2b. Option-price resolution service (new, CR-008.2)
- **Objective:** Read-path service resolving the effective `ProductOptionPrice` for a given `(productOptionId, productVariantId, branchId)` selection, per CR-008 §23.7's specificity + priority resolution rule. Write-path (creating price rows) is a separate follow-on task, scoped like E2/E3's split.
- **Exact expected files:** `apps/api/src/modules/product-option-pricing/product-option-pricing.service.ts`.
- **Implementation steps:** Implement specificity resolution (variant+branch > variant > branch > global), then `priority` tie-break within a tier; an unresolved exact tie returns a blocking ambiguity result (never an arbitrary pick). Validate currency match against the resolved `ProductPrice` for the variant before returning a result; mismatch returns a blocking result. Validate the option is still applicable to the variant via `ProductVariantOptionGroup` (H3) before resolving a price — a price row never grants applicability.
- **Tests:** global option price; variant-specific price; branch-specific price; variant-and-branch-specific price; specificity precedence (variant+branch beats variant beats branch beats global); priority precedence within a tier; overlapping ranges flagged by the write-side validator (integration test, see below); exact ties block resolution; expired prices excluded; future-dated prices excluded; zero-price authorization path (DISPLAY_ONLY/RECIPE_ADJUSTMENT per §23.7); missing required price for PRICE_ONLY/PRICE_AND_RECIPE blocks rather than defaulting to zero; currency mismatch blocks; inactive option blocks; invalid variant applicability blocks; concurrent overlapping-row creation is rejected by a transactional recheck at write time (§23.7 duplicate/overlap prevention items 2–3).
- **Validation command:** `pnpm --filter api test -- product-option-pricing`.
- **Rollback:** unused pre-wiring (not called from checkout until I2), safe to disable.
- **Stop condition:** none beyond standard review.
- **Architectural reference:** CR-008 §23.7, §23.10 Gate O5.

### H3. Variant-to-option-group applicability service
- **Objective:** Service-layer read/write for `ProductVariantOptionGroup` linkage and per-checkout min/max/required validation, per CR-008 §23.9.
- **Exact expected files:** `apps/api/src/modules/product-catalog/product-options.service.ts` (new, or colocate — match convention).
- **Implementation steps:** CRUD for linking/unlinking a group to a variant with override constraints; a pure validation function checking a proposed selection set against effective min/max/required/selectionMode for a given variant.
- **Tests:** linking/unlinking; override constraints take precedence over group defaults when set; validation rejects under-min, over-max, and violated-required selections.
- **Validation command:** `pnpm --filter api test -- product-options`.
- **Rollback:** unused pre-adoption, no risk.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §2.7, §23.9.

### H5. Legacy flavor → generic option durable mapping (renumbered, CR-008.2 — was H4)
- **Objective:** Add `LegacyCatalogIdentityMapping` schema + backfill tool per CR-008 §23.5 Stage 2.
- **Exact expected files:** `apps/api/prisma/schema.prisma`; migration; `apps/api/src/modules/legacy-flavor-mapping/` (`dry-run.ts`, `apply.ts`, `types.ts`), CLI entrypoint under `apps/api/scripts/`, following the same dry-run/apply/rollback convention as D2/CR-006 Phase C0.
- **Implementation steps:** Model with unique `(legacyType, legacyId)`. Dry-run: propose `Flavor`→`ProductOption` and `ProductFlavorSlot`→`ProductOptionGroup` mappings, flag ambiguous/unresolved cases, zero writes. Apply: batch-gated, transactional, audit-logged.
- **Tests:** dry-run emits zero writes; apply idempotent; ambiguous legacy record stays `UNRESOLVED`, never auto-resolved.
- **Validation command:** `pnpm --filter api tsx scripts/legacy-flavor-mapping.ts --dry-run` reviewed manually before `--apply`.
- **Rollback:** apply-batch rollback tool deletes only mapping rows it created in that batch (CR-006 Phase C0 pattern).
- **Stop condition:** any legacy record without a clean single candidate mapping stops as `UNRESOLVED` for manual review.
- **Architectural reference:** CR-008 §23.5 Stage 2, §23.10 Gate O1/O2/O3.

### H6. `LegacyFlavorOptionAdapter` compatibility + dual-validation reporting (renumbered, CR-008.2 — was H5)
- **Objective:** Implement the read-path adapter and Stage 1/3 dual-validation reporting per CR-008 §23.4/§23.6.
- **Exact expected files:** `apps/api/src/modules/legacy-flavor-mapping/legacy-flavor-option-adapter.ts` (new).
- **Implementation steps:** Adapter exposes active `Flavor`/`ProductFlavorSlot` rows as generic `ProductOption`/`ProductOptionGroup`-shaped reads via H5's mapping table (never name-derived); dual-validation job runs both legacy and generic resolution for a sample/full set of active products and reports mismatches; legacy path remains the only one affecting production checkout in this task.
- **Tests:** adapter output matches expected generic shape for known fixtures; mismatch report correctly flags a deliberately-diverged fixture; legacy checkout path unmodified/unaffected.
- **Validation command:** `pnpm --filter api test -- legacy-flavor-option-adapter`.
- **Rollback:** read-only service, no data risk, safe to disable.
- **Stop condition:** if mismatch rate on real data is non-trivial, stop before Stage 4 write-cutover and investigate root cause rather than waiving broadly.
- **Architectural reference:** CR-008 §23.4, §23.5 Stage 1/3, §23.10 Gate O6.

### H7. `ProductBundleComponent` schema + cycle-check service (renumbered, CR-008.2 — was H6)
- **Objective:** Add bundle composition model per CR-008 §2.8. (Unchanged from prior draft's H2, renumbered.)
- **Exact expected files:** `apps/api/prisma/schema.prisma`; migration; `apps/api/src/modules/product-bundles/product-bundles.service.ts` (cycle-detection + one-level-nesting enforcement).
- **Implementation steps:** Model with `(bundleVariantId, componentVariantId)` unique; service function walks `componentVariantId`'s own bundle components (if any) and rejects if it resolves back to `bundleVariantId`, and rejects any component that itself has bundle components (max one nesting level, §2.8).
- **Tests:** direct self-reference rejected; two-hop cycle rejected; bundle-of-bundle rejected; valid flat composition accepted.
- **Validation command:** `pnpm --filter api test -- product-bundles`.
- **Rollback:** schema-only, safe pre-adoption.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §2.8, §9, §18.

### H8. Bundle versioning + change-log wiring (renumbered, CR-008.2 — was H7)
- **Objective:** Bundle composition edits to an ACTIVE bundle variant bump `version` and write `ProductChangeLog`, matching CR-005's existing ACTIVE-variant edit rule. (Unchanged from prior draft's H3, renumbered.)
- **Exact expected files:** `apps/api/src/modules/product-bundles/product-bundles.service.ts` (extend H7).
- **Implementation steps:** Reuse the existing CR-005 change-log write path (locate and call the same helper `ProductVariant` edits already use — do not duplicate its logic).
- **Tests:** editing an ACTIVE bundle's components without a `reason` is rejected (matches existing ACTIVE-variant rule); `version` increments; `ProductChangeLog` row snapshot includes the component diff.
- **Validation command:** `pnpm --filter api test -- product-bundles`.
- **Rollback:** none needed, additive behavior on top of H7.
- **Stop condition:** if no shared change-log helper exists (CR-005 logic is inlined per-call-site instead), stop and flag for a small refactor task first rather than duplicating the audit-write logic.
- **Architectural reference:** CR-008 §9, §13, §14.

---

## Phase I — POS integration

### I1. `TransactionItem` snapshot column additions (expanded, CR-008.2)
- **Objective:** Add `skuSnapshot`, `selectedOptions`, `bundleComponentsSnapshot` nullable columns per CR-008 §12, with `selectedOptions` carrying the expanded per-selection shape (productOptionId, optionGroupId, name/price/effect-classification snapshots, `productOptionPriceId`/scope/currency/adjustmentType/amount/priority/effectiveFrom snapshot per §23.7, linkedVariant/recipe-adjustment-version snapshots, legacy flavorId/slotId snapshots).
- **Exact expected files:** `apps/api/prisma/schema.prisma`; migration.
- **Implementation steps:** Additive nullable columns only; no backfill (historical rows keep null, same posture as `deductionSnapshot`'s original rollout).
- **Tests:** existing transaction-creation tests still pass unmodified with new columns null.
- **Validation command:** `pnpm --filter api prisma migrate dev --name add_transaction_item_catalog_snapshots && pnpm --filter api test`.
- **Rollback:** additive, safe to drop if unused.
- **Stop condition:** none.
- **Architectural reference:** CR-008 §12, §16.

### I2. Checkout write-path population (revised, CR-008.2)
- **Objective:** Wire checkout to populate the new snapshot columns and consume `ProductPrice`/availability/`ProductOptionPrice` resolution (E2/F2/H2/H2b) instead of raw `basePrice`/`isAvailable` only. During Stage 1–3 (§23.6) this task must still read the *legacy* flavor path for actual deduction — only Stage 4 (below) flips writes to generic options.
- **Exact expected files:** existing transactions module service (locate current checkout price/availability read call sites before editing — do not guess the file name without inspecting).
- **Implementation steps:** Replace direct `basePrice` read with E2's priority-resolution call; replace direct `BranchProductAvailability`-only check with F2's three-gate helper; resolve each selected option's price via H2b's resolution service and persist the `productOptionPriceId` snapshot per §23.7; treat any resolution-service ambiguity result (unresolved tie, missing required price, currency mismatch) as a blocking checkout error — never a silent zero or arbitrary pick; populate `skuSnapshot` from `ProductVariant.sku` at sale time; populate `selectedOptions`/`bundleComponentsSnapshot` from cart selection if present, using H6's adapter for any still-legacy flavor selection.
- **Tests:** full checkout integration test — branch-override price takes precedence over base; variant-level sold-out blocks sale even when product-level is available; option price snapshot persisted with correct `productOptionPriceId`/scope/amount; unresolved option-price ambiguity blocks checkout rather than defaulting; missing required option price blocks rather than silently pricing at zero; snapshot columns populated correctly, including legacy-flavor-originated selections; existing CR-004 deduction tests still pass unmodified; deterministic rollback to legacy checkout verified (feature flag off restores pre-I2 behavior).
- **Validation command:** `pnpm --filter api test -- transactions` (full suite, this touches the highest-risk path in the system).
- **Rollback:** this is the first task with real runtime-behavior risk — land behind a feature flag if the existing transactions module supports one, otherwise require a fast-revert commit plan before merge.
- **Stop condition:** if the existing checkout path has no clean single call site for price/availability resolution (logic scattered/duplicated), stop and scope a small consolidation task first rather than patching multiple call sites inconsistently.
- **Architectural reference:** CR-008 §12, §20.9, §20.10, §23.6 Stage 4, §23.7, §23.10 Gate O5.

### I3. Generic-option runtime cutover gate (new, CR-008.1)
- **Objective:** Single explicit approval task gating Stage 5 of §23.6 (generic options become authoritative for checkout deduction; legacy `Flavor`/`ProductFlavorSlot` stop being read at sale time).
- **Exact expected files:** none (process/checklist task — may produce a `docs/decisions/CR-008-cutover-gate-report.md` artifact, not code).
- **Implementation steps:** Verify Gates O1–O8 (CR-008 §23.10) all pass or are explicitly waived per record; obtain super_admin sign-off; only then flip the checkout read path (a follow-on code task, not this one) from legacy to generic-authoritative.
- **Tests:** N/A (checklist gate, not code) — the code flip itself, once approved, requires its own test pass mirroring I2's integration tests but asserting generic-option-authoritative behavior.
- **Validation command:** manual checklist review against §23.10; no automated command replaces this gate.
- **Rollback:** Gate O8 requires a tested rollback path to legacy checkout to exist *before* this gate can pass — that rollback path is exercised here, not invented after the fact.
- **Stop condition:** any gate not met or not explicitly waived blocks cutover; do not proceed on partial completion.
- **Architectural reference:** CR-008 §23.6 Stage 5, §23.10.

---

## Phase J — Recipe/BOM cutover

Out of scope for CR-008 execution — remains CR-007 §20.6's deferred `ProductComponent` rework, tracked as its own future CR. CR-008 §23.8's `ProductOptionRecipeAdjustment` target shape is also deferred here. No task defined in this file.

---

## Summary (recalculated, CR-008.2)

- **Planned task count:** 18 (was 17) — D1–D2 (2), E1–E3 (3), F1–F2 (2), H1–H8 (8, was H1–H7/7 — H2 split into H2 schema + H2b resolution service, H3–H7 renumbered to H4–H8), I1–I3 (3). Phase J deferred to a future CR.
- **Recommended execution method:** `superpowers:subagent-driven-development` or `superpowers:executing-plans`, one task per subagent/session with review checkpoint, matching the CR-006 Phase B/C0 precedent. Highest-risk tasks are I2 (checkout write-path) and I3 (cutover gate) — execute last and in strict order, after D–H are merged and stable, and only after H5/H6's legacy mapping and dual-validation have run.
- Every task above requires its own explicit approval before execution; this document authorizes none of them yet.
