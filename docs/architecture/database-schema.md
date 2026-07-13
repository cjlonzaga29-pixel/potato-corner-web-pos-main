# Database Schema Reference

The authoritative schema is `apps/api/prisma/schema.prisma`. This document summarizes it and records the schema-level decisions made during Phase 0 scaffolding that go beyond what the architecture document specified verbatim.

## Design principles (from Final Approved Architecture §4.1)

UUID primary keys throughout. `createdAt`/`updatedAt` on every table. No hard deletes — soft delete via `deletedAt` or a status field, per table.

## Phase 0 schema decisions

- **Enums:** native Prisma `enum` (not `String` + `CHECK`) for `Role`, `EmploymentType`, `BranchStatus`, `ProductStatus`, `TransactionStatus`, `PaymentMethod`, `InventoryDeductionStatus`, `ShiftStatus`, `DenominationCountType`, `MovementType`, `ImageProofType`, `AttendanceGpsStatus`, `AttendanceStatus`, `FraudAlertSeverity`, `FraudAlertStatus`. This gives Postgres-level `CREATE TYPE` validation and does not conflict with the app-code "no hand-written TS `enum`" rule — Prisma-generated enums compile to string-literal unions, not a hand-authored TS `enum` keyword.
- **Government ID encryption:** application-layer AES-256-GCM (`apps/api/src/lib/encryption.ts`, Node's built-in `crypto`), not `pgcrypto`. Ciphertext stored as `String?` columns (`sssNumberEncrypted`, `philhealthNumberEncrypted`, `tinNumberEncrypted`, `pagibigNumberEncrypted`) on `User`. Keeps the encryption key in app secrets rather than DB config, keeps Prisma's typed CRUD usable on every other `User` field, and is unit-testable without a live database.
- **Append-only tables:** `InventoryMovement` and `AuditLog` intentionally have no `updatedAt`/`deletedAt` — rows are never modified after creation, per the architecture doc's audit-trail and inventory-history requirements.
- **`Recipe.flavorId` is nullable** — this is the field the recipe deduction algorithm keys off. `NULL` = base ingredient (applies to every sale of the variant); a specific value = flavor-specific override for that ingredient. See `docs/architecture/final-approved-architecture.md` Part 7.1 for the full algorithm.
- **`TransactionItem` snapshot fields** (`productNameSnapshot`, `variantNameSnapshot`, `flavorNameSnapshot`, `unitPriceSnapshot`) freeze the sale-time state and are never updated after creation, even if the product catalog changes later.

## Table list

`User`, `Branch`, `UserBranchAssignment`, `Product`, `ProductVariant`, `Flavor`, `ProductVariantFlavor`, `BranchProductAvailability`, `BranchFlavorAvailability`, `Ingredient`, `Recipe`, `Transaction`, `TransactionItem`, `Shift`, `ShiftCashDenomination`, `InventoryMovement`, `AttendanceRecord`, `AuditLog`, `FraudAlert`.

Local verification (no live database provisioned in Phase 0): `pnpm --filter api exec prisma validate` and `prisma format`. Do not run `prisma migrate dev` until a real `DATABASE_URL` (Supabase) is configured.
