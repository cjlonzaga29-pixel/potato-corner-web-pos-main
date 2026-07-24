# CR-004 — POS Deduction Integrity & Branch Provisioning

**Status:** Implemented. **Date:** 2026-07-24.

## Context

A compliance-verification request came in framed as "CR-003" covering seven
guarantees (global-structure admin-only mutation, branch isolation, atomic
POS deduction with advisory locks, movement-derived inventory, RBAC
boundaries, realtime room isolation, zero-placeholder data) plus five
specific patches (Recipe versioning, TransactionItem recipe snapshot,
recipe-required sale rejection, idempotent branch provisioning, and
InventoryMovement/Transaction immutability).

`CR-003` was already taken — it's the "Branch Operating System" change
request (`EmployeeStatus`, branch-authorized staff logins), shipped the same
day this request came in (migration `20260724000000_add_branch_role_employee_status`,
follow-up `20260724020000_branch_employee_authorization`). This work is
recorded as **CR-004** instead, following the same "layered on top, nothing
in the locked architecture doc is open for discussion without a formal
change request" convention CR-001 and CR-002 used.

## Audit findings (before this CR)

Most of the seven guarantees already held:

- **Global structures Admin-only mutation** — `recipesRouter`/`productsRouter` already gate master Recipe/Product/Flavor writes behind `adminOnly`.
- **Branch isolation on routes** — `branchGuard` + `authorize.ts` already enforce it structurally.
- **Atomic POS deduction with advisory locks** — `transactions.service.ts`'s `deductInventoryForSale` already runs inside `prisma.$transaction` with `pg_advisory_xact_lock` per ingredient.
- **Inventory derived from InventoryMovement** — `inventoryRepository.getCurrentStock`/`getCurrentStockMap` already sum the ledger; `Ingredient.currentStock` is a vestigial unused column (documented in the schema itself).
- **RBAC boundaries** — already enforced via `authorize.ts`'s role-combination exports.
- **Realtime room isolation** — `socket.server.ts`'s `joinRoomsForUser` already scopes every connection to its own user/branch/admin room; already covered by 5 existing unit tests in `socket.server.test.ts`.
- **Zero-placeholder data** — `seed.ts` seeds only users/branch, no fabricated recipes/ingredients/transactions.

**One real, previously-undetected gap was found during the audit**, more
severe than anything in the original request list: master `Recipe.ingredientId`
points at a specific `Ingredient` row, and `Ingredient` has no branch-neutral
identity (`branchId` is required, unique per `(branchId, name)`). A sale at
any branch *other* than the one whose `Ingredient` a master recipe happened
to be created against would silently deduct that *other* branch's stock —
a cross-branch stock leak. It had never manifested because only one branch
(`MAIN01`) had ever been seeded; `PROJECT_STATUS.md` shows Phase 20
(pilot branch/multi-branch deployment) is in progress, which would have
triggered it. Fixing this became CR-004's central piece, alongside the five
originally-requested patches.

## What changed

### Schema (`apps/api/prisma/schema.prisma`, migration `20260724030000_cr_004_recipe_version_and_branch_provisioning`)

- **`Recipe.version`** (`Int @default(1)`) — bumped on every `recipesRepository.updateRecipe` call.
- **`TransactionItem.recipeVersion`** (`Int @default(1)`) — the master recipe version(s) in effect for that line's deduction, frozen at sale time (same pattern as the existing name/price snapshot fields — never updated after creation).

### Cross-branch ingredient resolution (the core fix)

`recipes.service.ts`'s `computeDeduction` now resolves every **master** row
to the *selling* branch's own `Ingredient` before deducting
(`resolveIngredientForBranch`):

- If the row's own ingredient already belongs to the selling branch (the
  common case — single-branch deployments, or a recipe created against that
  branch's own ingredient), it's used as-is — zero extra queries.
- Otherwise it looks up an `Ingredient` with the same `name` at the selling
  branch (`inventoryRepository.findIngredientByBranchAndName` — the same
  match idempotent provisioning uses).
- If no such ingredient exists at that branch, the deduction — and the whole
  sale — is rejected with `INGREDIENT_NOT_PROVISIONED` (409) rather than
  silently deducting the wrong branch's stock. **Fails closed.**

Branch override rows (`BranchRecipeOverride`) are exempt from resolution —
a branch account can only create an override against its own branch's
ingredients (now enforced at write time too, see below), so the row's
`ingredientId` is already correct.

The deduction algorithm's five steps (Architecture doc §7.1) are unchanged —
this only changes which `Ingredient` row a resolved `ingredient_id` points
at, not the base/flavor layering logic itself.

### Idempotent branch provisioning

`branchesService.createBranch` now provisions the new branch with a
zero-stock `Ingredient` row for every distinct `(name, unit)` identity an
active master `Recipe` references
(`recipesService.listDistinctIngredientIdentities` →
`inventoryService.provisionBranchIngredients` →
`inventoryRepository.provisionIngredient`, which is a
find-or-create keyed on `(branchId, name)` — safe to re-run).

Scope note: this runs at *branch-creation* time only, not retroactively when
a brand-new master recipe/ingredient is added to an *existing* branch later
— that would require `recipes.service.ts` to depend on `branchesRepository`,
creating a circular module dependency (`branches → recipes → branches`).
Instead, an existing branch selling a variant whose master recipe
references an ingredient it was never provisioned with hits the
`INGREDIENT_NOT_PROVISIONED` fail-closed path above, which is safe (no
sale, no wrong-branch deduction) even if less convenient than silent
auto-provisioning. An admin/supervisor adds the ingredient at that branch
(existing inventory UI) or a branch override to unblock it.

### Recipe-required sale rejection

`transactions.service.ts`'s `resolveCartItems` now calls
`recipesService.assertRecipeExists` for every cart line before pricing it —
a sale for a variant with zero master `Recipe` rows is rejected
(`RECIPE_MISSING`, 422) instead of silently succeeding with nothing
deducted (previously: `computeDeduction` on a recipe-less variant just
returns an empty line list).

### Immutability enforcement

New `lib/prisma-immutability.ts`, applied via `prisma.$use(...)` in
`lib/prisma.ts` — `$extends` was rejected because it altered the type of
`tx` across every repository; `$use` middleware preserves
`TransactionClient` typing (carries over into `prisma.$transaction`
callbacks). A backstop, not the primary guard — the repository layer already
never calls
`update`/`delete` on `InventoryMovement` and never touches `TransactionItem`
after creation:

- `InventoryMovement`, `TransactionItem`: `update`/`updateMany`/`delete`/`deleteMany`/`upsert` all rejected outright.
- `Transaction`: `delete`/`deleteMany` rejected outright; `update`/`updateMany`/`upsert` rejected unless every touched field is in a fixed allowlist of status-transition columns (`status`, `voidedAt`/`voidedById`/`voidReason`, `refundedAt`/`refundedById`/`refundReason`, `receiptPrinted`, `inventoryDeductionStatus`, `syncedAt`, `updatedAt`) — money/catalog-snapshot fields (`subtotal`, `totalAmount`, etc.) can never be rewritten after creation.

Raw SQL (`$executeRaw`) bypasses this by design — it's the escape hatch
integration-test teardown uses, not a hole in the guard (no application
code path uses raw SQL against these tables).

### Minor hardening found along the way

`recipesService.createOverride` now verifies the given `ingredient_id`
actually belongs to `branch_id` (`INGREDIENT_NOT_IN_BRANCH`, 422) — previously
unvalidated, which would have let a branch override silently point at
another branch's ingredient the same way the master-recipe bug did.

## Guarantees NOT re-verified by new automated tests

- **Zero mock/demo data** — verified by reading `seed.ts`, not by an
  automated test (there's nothing to assert against; absence of seeded
  recipes/transactions is the point).
- **RBAC boundaries** — already covered by each module's existing
  router/service unit tests (`authorize.ts`, `branchGuard`); this CR added
  no new role-boundary code, only the ingredient-branch-ownership check
  above.

## Tests

- `recipes.service.test.ts` — cross-branch resolution (resolves / fast-path
  / fails closed when unprovisioned / overrides exempt), `assertRecipeExists`,
  `getRecipeVersion`.
- `transactions.service.test.ts` — `RECIPE_MISSING` rejection (no
  Transaction row created), `recipeVersion` stamped onto created items.
- `inventory.repository.test.ts` / `inventory.service.test.ts` — `provisionIngredient` / `provisionBranchIngredients`.
- `branches.service.test.ts` — `createBranch` wiring to provisioning.
- `lib/prisma-immutability.test.ts` — the guard's allow/block matrix, unit-tested directly (no live DB needed).
- `lib/notify.test.ts` — new: `notifyBranch`/`notifySuperAdmin`/`notifyUser` each target exactly one room, complementing `socket.server.test.ts`'s existing proof that a connecting socket only ever joins its own room(s).
- `transactions.integration.test.ts` (real DB, `TEST_DATABASE_URL`-gated) — cross-branch stock isolation, rollback on insufficient stock, `RECIPE_MISSING` at any branch.
- `branches.integration.test.ts` (real DB, `TEST_DATABASE_URL`-gated) — idempotent provisioning on branch creation, re-run idempotency.
