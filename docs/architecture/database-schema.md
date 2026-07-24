# Database Schema Reference

**Last verified:** 2026-07-20 (commit `70caead`)

The authoritative schema is `apps/api/prisma/schema.prisma`. This document summarizes it and records the schema-level decisions made during Phase 0 scaffolding, plus the CR-001 change request layered on top in Phase 7.5, that go beyond what the architecture document specified verbatim.

## Design principles (from Final Approved Architecture §4.1)

UUID primary keys throughout. `createdAt`/`updatedAt` on every table (except the two append-only tables, see below). No hard deletes — soft delete via `deletedAt` or a status field, per table.

## Phase 0 schema decisions

- **Enums:** native Prisma `enum` (not `String` + `CHECK`) for `Role`, `EmploymentType`, `BranchStatus`, `ProductStatus`, `TransactionStatus`, `PaymentMethod`, `InventoryDeductionStatus`, `ShiftStatus`, `DenominationCountType`, `MovementType`, `ImageProofType`, `AttendanceGpsStatus`, `AttendanceStatus`, `FraudAlertSeverity`, `FraudAlertStatus`. This gives Postgres-level `CREATE TYPE` validation and does not conflict with the app-code "no hand-written TS `enum`" rule — Prisma-generated enums compile to string-literal unions, not a hand-authored TS `enum` keyword.
- **Government ID encryption:** application-layer AES-256-GCM (`apps/api/src/lib/encryption.ts`, Node's built-in `crypto`), not `pgcrypto`. Ciphertext stored as `String?` columns (`sssNumberEncrypted`, `philhealthNumberEncrypted`, `tinNumberEncrypted`, `pagibigNumberEncrypted`) on `User`. Keeps the encryption key in app secrets rather than DB config, keeps Prisma's typed CRUD usable on every other `User` field, and is unit-testable without a live database.
- **Append-only tables:** `InventoryMovement` and `AuditLog` intentionally have no `updatedAt`/`deletedAt` — rows are never modified after creation, per the architecture doc's audit-trail and inventory-history requirements.
- **`Recipe.flavorId` is nullable** — this is the field the recipe deduction algorithm keys off. `NULL` = base ingredient (applies to every sale of the variant); a specific value = flavor-specific override for that ingredient. See `docs/architecture/final-approved-architecture.md` Part 7.1 for the full algorithm.
- **`TransactionItem` snapshot fields** (`productNameSnapshot`, `variantNameSnapshot`, `flavorNameSnapshot`, `unitPriceSnapshot`) freeze the sale-time state and are never updated after creation, even if the product catalog changes later.

## CR-001 schema additions (Phase 7.5, layered on the Phase 0–7 schema)

CR-001 added branch-level exceptions to the master catalog/recipe without touching the master tables' own shape:

- **`BranchPriceOverride`** — a supervisor-submitted request for a branch-exclusive price on an existing variant. Goes through an approval workflow (`status`: `pending`/`approved`/`rejected`, plain `String` not a native enum — checked in application code against `REQUEST_STATUS`, matching every other CR-001 request table). A partial unique index enforces at most one pending request per `(branch_id, product_variant_id)` — see index state below.
- **`ProductRequest`** — a supervisor-submitted request to add a brand-new product to the master catalog. `proposedVariants`/`proposedFlavors`/`proposedRecipes` are freeform JSON snapshots (validated against `proposedVariantSchema` etc. at the API boundary, not by the DB) — nothing is committed to real `Product`/`ProductVariant`/`Recipe` rows unless and until a Super Admin approves the request, at which point `reviewRequest` creates those rows from the JSON and sets `createdProductId`.
- **`BranchRecipeOverride`** — a branch-scoped recipe row that replaces (same ingredient+flavor combination) or adds to (new ingredient) the master `Recipe` for one branch's `computeDeduction`. No approval workflow — a supervisor may create/update/delete these directly, audit-logged with a mandatory `reason`. Same `flavorId`-nullable base/flavor-specific semantics as the master `Recipe` model. Soft-deleted via `deletedAt` (added after initial CR-001 landing, matching `Recipe`'s own soft-delete shape — see index state below).
- **`Product.branchExclusive` / `Product.exclusiveBranchId`** — a branch-exclusive product (created directly by Super Admin with `branchExclusive: true`, or via an approved `ProductRequest`) skips the all-active-branches availability cascade and is only ever available at the one named branch.
- **`User` / `Branch` / `ProductVariant`** each gained the inverse relations for the three new tables above (`priceOverrideRequests`, `productRequestsFiled`, `recipeOverridesCreated`, etc.) — no new scalar columns on these three.

## Post-CR-001 additions (Phase 20–21.5, not yet layered into the sections above)

- **`RevokedToken`** / **`RefreshTokenRotationCache`** — Phase 21/21.5 Postgres-native replacements for the Redis-backed JWT blacklist and refresh-rotation result cache; see `apps/api/src/lib/pg-lock.ts`.
- **`IdCounter`** — Phase 21 Postgres-native sequence table (`key`/`value`), replaced Redis `INCR` usage for generating sequential IDs; see `apps/api/src/lib/id-counter.ts`.
- **`HoldOrder`** / **`HoldOrderItem`** — Phase 20 held-order backend: a branch/shift-scoped saved cart and its line items, resumed later at the POS.
- **`PasswordResetToken`** — hashed, expiring token backing the forgot-password flow, same shape as `RevokedToken`.
- **`ReportSnapshot`** — cached materialized report output (`reportType`, optional `branchId`), avoids recomputing expensive aggregate reports on every request.
- **`Notification`** — in-app notification record (`type`, `payload` JSON) surfaced to users via Socket.io.

## CR-004 schema additions (POS deduction integrity & branch provisioning)

See [`docs/decisions/CR-004-pos-deduction-integrity.md`](../decisions/CR-004-pos-deduction-integrity.md) for full context — this fixed a cross-branch stock-leak gap (`Recipe.ingredientId` pinned to one branch's `Ingredient`, since `Ingredient` has no branch-neutral identity) discovered during a POS-deduction-integrity audit, plus the CR's originally-requested patches.

- **`Recipe.version`** (`Int @default(1)`) — bumped on every `recipesRepository.updateRecipe` call.
- **`TransactionItem.recipeVersion`** (`Int @default(1)`) — frozen recipe-version snapshot at sale time, same immutability convention as the existing name/price snapshot fields.
- No new tables — the cross-branch fix is resolution logic in `recipes.service.ts` (`computeDeduction`), not a schema change; idempotent branch provisioning reuses the existing `Ingredient` table via a find-or-create keyed on `(branchId, name)`.

## Table list

`User`, `Branch`, `UserBranchAssignment`, `RefreshToken`, `RevokedToken`, `RefreshTokenRotationCache`, `IdCounter`, `PasswordResetToken`, `PinCredential`, `Product`, `ProductVariant`, `Flavor`, `ProductVariantFlavor`, `BranchProductAvailability`, `BranchFlavorAvailability`, `BranchPriceOverride` (CR-001), `ProductRequest` (CR-001), `Ingredient`, `Recipe`, `BranchRecipeOverride` (CR-001), `InventoryMovement`, `Transaction`, `TransactionItem`, `Shift`, `ShiftCashDenomination`, `HoldOrder`, `HoldOrderItem`, `AttendanceRecord`, `AuditLog`, `FraudAlert`, `ReportSnapshot`, `Notification`.

## Partial unique index state

Prisma's schema DSL has no `WHERE`-clause index syntax, so every partial unique index below is declared as a plain `@@unique` in `schema.prisma` (for documentation/client-typing purposes) and then replaced by raw SQL inside its migration with the real partial index. Confirmed present as of the `20260715090000_cr_001_soft_delete_branch_recipe_override` migration:

| Table | Partial unique index | Migration |
|---|---|---|
| `ingredients` | `(branch_id, name)` WHERE `deleted_at IS NULL` | `20260714033647_phase8_step2_soft_delete_ingredient_recipe` |
| `recipes` | `(product_variant_id, ingredient_id, flavor_id)` WHERE `deleted_at IS NULL` | `20260714033647_phase8_step2_soft_delete_ingredient_recipe` |
| `branch_recipe_overrides` | `(branch_id, product_variant_id, ingredient_id, flavor_id)` WHERE `deleted_at IS NULL` | `20260715090000_cr_001_soft_delete_branch_recipe_override` |
| `branch_price_overrides` | `(branch_id, product_variant_id)` WHERE `status = 'pending'` | `20260712210558_cr_001_product_catalog_refactor` |

The shared reasoning across all four: a soft-deleted or resolved row must not permanently block recreating the same combination, but a live/pending row must still enforce uniqueness.

Local verification: `pnpm --filter api exec prisma validate` and `prisma format`. Run `pnpm --filter api exec prisma migrate deploy` against a real `DATABASE_URL` (Supabase, not yet provisioned) to apply the migration history above.
