# CR-006 Phase B — Legacy Migration Source Inventory

Structured inventory of every legacy source involved in the Ingredient ->
InventoryItem migration (CR-007 SS20). Read-only reference; no runtime
behavior changes. Counts are captured live by the dry-run command
(`pnpm inventory:migration:dry-run`) — this document is the structural map,
not a point-in-time count.

## Legacy models

| Source | Prisma model | Table | Branch-scoped? | Notes |
|---|---|---|---|---|
| Ingredient | `Ingredient` | `ingredients` | Yes (`branchId`) | Legacy identity; unique on `(branch_id, name)` where not deleted. Category via `IngredientCategory` enum (`RAW, FLAVOR, CUP, BAG, PACKAGING, OTHER`). No `sku`/`barcode` columns exist. |
| Ingredient category | `IngredientCategory` (enum) | n/a | n/a | Fixed 6-value enum on `Ingredient.category`, not a lookup table. |
| Product-to-ingredient mapping | `ProductInventory` | `product_inventory` | Yes (`branchId`) | Links `productVariantId` + optional `flavorId` to `ingredientId` with `quantityRequired`/`unit`. Soft-delete (`deletedAt`, `isActive`). |
| Flavor-linked inventory | `Flavor` (`ingredientName`/`ingredientUnit`) | `flavors` | No (global) | Flavor resolves to an `Ingredient` per branch by name+unit match (CR-004 resolver), not by FK. This is the flavor-linked identity source for SS7. |
| Flavor product composition | `ProductFlavorSlot` | `product_flavor_slots` | No | Catalog/composition only — does not hold stock or reference `Ingredient` directly; relevant only as context for which variants have flavor slots. |
| Movement ledger | `InventoryMovement` (legacy) | `inventory_movements` | Yes (`branchId`) | Keyed off `ingredientId`; `MovementType` enum (`stock_in, sale_deduction, manual_adjustment, waste, physical_count, transfer_in, transfer_out`) — distinct from the new CR-007 22-value taxonomy. |
| Physical count | *(no dedicated legacy model)* | n/a | n/a | Legacy `physical_count` is a `MovementType` value on `InventoryMovement`, not a session/cutoff-aware model. No physical-count-specific fields to migrate beyond those movement rows. |
| Transfer | *(no dedicated legacy model)* | n/a | n/a | Legacy `transfer_in`/`transfer_out` are `MovementType` values on `InventoryMovement`, not a `StockTransfer`-style linked record. No legacy transfer-session data to migrate beyond those movement rows. |

## Provisioning / write-path code (read-only inspection, not modified)

| File | Role |
|---|---|
| `apps/api/src/modules/inventory/inventory.repository.ts` | Only production repository writing legacy `Ingredient`/`InventoryMovement` (`provisionIngredient`, `createIngredient`, `updateIngredient`, `softDeleteIngredient`, movement append). |
| `apps/api/src/modules/inventory/inventory.service.ts` | `provisionBranchIngredients` (branch creation: dedupes candidate identities by `(name, unit)`, FLAVOR category wins collision) and `provisionIdentityAcrossBranches` (fan-out new Flavor identity to all branches). Closest existing precedent for identity-collision handling — operates on legacy identities only. |
| `apps/api/src/modules/product-inventory/product-inventory.repository.ts` | CRUD for legacy `ProductInventory` deduction mappings. |
| `apps/api/src/modules/transactions/transactions.service.ts` | Writes `sale_deduction` `InventoryMovement` rows at checkout via the inventory module. |
| `apps/api/src/modules/branches/branches.repository.ts` | Read-only: aggregates `Ingredient` for low-stock display when listing branches. |
| `apps/api/src/modules/reports/reports.repository.ts` | Read-only: `Ingredient`/movement reporting aggregates. |

No seed script (`apps/api/prisma/seed.ts`) creates `Ingredient` rows directly — branch provisioning creates them idempotently via `inventory.service.ts` at branch-creation time.

## Confirmed absence of prior migration tooling

A grep across `apps/api/src` at the start of Phase B found no existing
`normalize*`, `migration-batch`, `dry-run`, or `collision` helpers — this is
new infrastructure, not a rework of an existing tool.
