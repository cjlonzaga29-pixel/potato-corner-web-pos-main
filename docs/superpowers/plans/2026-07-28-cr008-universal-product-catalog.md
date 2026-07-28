# CR-008 — Universal Product Catalog: Implementation Plan (Foundation Pass)

**Date:** 2026-07-28
**Companion doc:** `docs/decisions/CR-008-universal-product-catalog.md` §24 records what actually shipped; this file is the plan that was executed to get there. The 2026-07-27 planning doc (`2026-07-27-cr008-universal-product-catalog-planning.md`) covers the full future-state architecture — this pass implements only its R0–R16 foundation subset, as scoped by the CR-008 implementation brief.

## Scope

Implement the Universal Product Catalog foundation: company-owned Product Categories and a generic Option Group/Option architecture, reusing the existing `Product`/`ProductVariant`/`BranchProductAvailability`/`ProductComponent` models wherever they already cover a requirement. No Recipe/BOM, no automatic inventory deduction, no legacy data migration, no FINAL-RESET.

## Steps executed

1. **R0 — Targeted inspection.** Read `apps/api/prisma/schema.prisma` model list, the `products`/`flavors`/`product-components` modules, `product.schema.ts`, `admin-sidebar.tsx`, and the branch products page — confirmed `Product`/`ProductVariant`/`BranchProductAvailability`/`ProductComponent` already existed and were reusable; confirmed no `ProductCategory` or generic Option Group/Option models existed.
2. **R1/R4/R5/R6 — Schema.** Added `ProductCategory`, `ProductOptionGroup`, `ProductOption`, `ProductVariantOptionGroup`, `ProductVariantOptionGroupOption`, and `ProductOptionSelectionType` enum, plus a nullable `Product.categoryId` FK alongside the untouched legacy `category` string. Wrote the additive migration SQL by hand (`prisma migrate dev` was blocked by the permission classifier since it would touch a live Supabase DB — see decision doc §24.4) and ran `prisma generate` locally so the Prisma Client picked up the new models without touching the database.
3. **Shared schemas/types.** `packages/shared/src/schemas/product-catalog.schema.ts` + `types/index.ts` exports, including SINGLE/MULTIPLE cross-field validation (a SINGLE group cannot declare `max_selections > 1`).
4. **R2/R14 — Product category wiring.** Extended `createProductSchema`/`updateProductSchema`, `products.types.ts`, `products.repository.ts`, and `products.service.ts` to accept/validate/return `category_id`/`category_name`, additive to the existing free-text `category` field.
5. **R1/R4/R5 — New API modules.** `product-categories` and `product-options` modules (types/repository/service/router), following the existing `flavors`/`product-components` module conventions exactly (repository owns all Prisma calls, service owns domain errors + audit logging, router owns HTTP + authorization). Registered at `/api/product-categories` and `/api/product-options` in `app.ts`.
6. **R6 — Variant/option-group assignment.** Added assignment endpoints directly to `products.router.ts` (mirroring how flavor-linking already lives there rather than in the `flavors` module), backed by `product-options.service.ts`'s `assignOptionGroupToVariant`/`updateVariantOptionGroup`/`unassignOptionGroupFromVariant`.
7. **R9 — Universal Inventory linkage.** Verified `ProductComponent` (CR-007/CR-010) already provides the variant→inventory-item linkage foundation; left it untouched per the "don't redesign" instruction.
8. **R13 — Authorization.** Reused `adminOnly`/`adminOrSupervisor`/`adminSupervisorOrBranch` middleware; category/option-group/option identity writes are `adminOnly`, reads are `adminOrSupervisor`; branch has no access to catalog identity endpoints.
9. **R10/R11 — Admin & branch UI.** New admin pages (`/admin/product-categories`, `/admin/product-options`, `/admin/product-options/[groupId]`) plus sidebar nav entries; a new "Option Groups" section on the existing variant card (assign/unassign, alongside the pre-existing Flavor and Inventory Items sections); branch `/branch/products` gained a read-only "Options" column.
10. **R12 — POS compatibility.** Added `option_groups` as a read-only, additive field on the POS-catalog response (`getPosCatalog`) — sourced from `ProductVariantOptionGroup`/`ProductVariantOptionGroupOption`, not read by any pricing or deduction path. Legacy `variantFlavors`-based flavor selection is completely untouched.
11. **R15 — Tests.** Service/router tests for category and option-group/option CRUD, duplicate-code rejection, cross-group option-leakage rejection, variant-assignment duplicate rejection, and branch/supervisor-denied/admin-allowed authorization; a shared-schema test for SINGLE/MULTIPLE selection rules. Fixed two pre-existing test fixtures (`page.test.tsx`'s `ProductDetailResponse` fixture, `variant-card.test.tsx`'s hook mocks) that needed updating for the additive schema changes. Ran the full API suite (1321 passed) and full web suite (324 passed), plus typecheck and lint on both packages — zero regressions, zero new lint errors.
12. **R16 — Documentation.** This file, plus `docs/decisions/CR-008-universal-product-catalog.md` §24.

## Deliberately deferred (see decision doc §24.2)

SKU/barcode identity, promo/scheduled/branch-level variant pricing, bundles, `LegacyCatalogIdentityMapping`, sold-out computation, `ProductOptionPrice` and its effective-dating/priority-tie resolution, Recipe/BOM, POS inventory deduction, and POS Terminal cutover to the new Option Group/Option model for actual order-taking.

## Verification

- `apps/api`: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` — all clean (1321 passed, 199 skipped integration tests requiring a live DB).
- `apps/web`: `npx tsc --noEmit`, `npm run lint`, `npx vitest run` — all clean (324 passed).
- `packages/shared`: `npx tsc --noEmit`, `npx vitest run` — all clean, rebuilt (`npm run build`) after schema/type additions so the API/web packages picked up the new exports.
- Migration SQL written but **not applied** to any database — left for explicit user action pending confirmation of the target Supabase project's prod-vs-throwaway status.
