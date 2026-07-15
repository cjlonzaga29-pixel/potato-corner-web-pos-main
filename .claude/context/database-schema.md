# Database Schema Context

Full detail: `docs/architecture/database-schema.md` (decisions) and `apps/api/prisma/schema.prisma` (source of truth).

## Quick reference

19 tables, UUID PKs, `createdAt`/`updatedAt` on every table, soft delete via `deletedAt` where the architecture doc specifies it. `InventoryMovement` and `AuditLog` are append-only (no `updatedAt`/`deletedAt` — rows are never modified after creation).

## The one field that matters most: `Recipe.flavorId`

`NULL` = base ingredient, applied to every sale of the product variant regardless of flavor. A specific UUID = flavor-specific override — replaces the base quantity for the same `ingredientId` when that flavor is selected. This is the entire mechanism behind the recipe deduction algorithm (see `.claude/context/business-rules.md`). Get this field wrong and the algorithm silently deducts the wrong ingredients.

## Encrypted fields

`User.sssNumberEncrypted`, `philhealthNumberEncrypted`, `tinNumberEncrypted`, `pagibigNumberEncrypted` — AES-256-GCM ciphertext via `apps/api/src/lib/encryption.ts`. Never `SELECT` these into a standard API response; only the employee-management module's explicit Super Admin decrypt path should ever call `decryptField`.

## Snapshot fields

`TransactionItem.productNameSnapshot`/`variantNameSnapshot`/`flavorNameSnapshot`/`unitPriceSnapshot` are frozen at sale time. Never join back to `Product`/`ProductVariant`/`Flavor` to "refresh" a historical transaction's display values — that would silently rewrite sales history when the catalog changes.
