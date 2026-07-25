# Branch Permanent Delete — Design

**Date:** 2026-07-25
**Status:** Approved by user, proceeding to implementation

## Problem

The branch Settings tab's "Danger Zone" only supports closing a branch (status
change to `closed`). There is no way to permanently remove a branch record —
e.g. a branch created by mistake, or a branch the owner wants fully purged.

## Decision: true cascading hard delete

The user explicitly chose full cascade delete over the safer alternatives
(hard-delete-only-if-empty, or soft-delete/archive). This is a conscious
trade-off:

- Destroys `Transaction` rows, which are official BIR receipts
  (`transaction_number` **is** the receipt number — see project CLAUDE.md).
  Philippine tax law expects receipt retention; this is an accepted risk, not
  an oversight.
- Destroys shift, inventory, expense, and attendance history for the branch.

Two safety rails remain regardless of the "delete everything" decision,
because they protect live system state rather than historical records:

1. **Active shifts block deletion.** Cascading away a `Shift` row for someone
   currently clocked in would corrupt in-progress app state. Reuses the
   existing `BRANCH_HAS_ACTIVE_SHIFTS` check already used by Close Branch.
2. **Pending `InventoryRequest`s block deletion.** An app-layer pre-check
   (not the schema FK — see "Schema changes" below for why the FK itself
   changes to `Cascade`), because a pending request is unresolved live state:
   deleting the branch out from under it means it can never be approved or
   rejected. Surfaced as a clear `BRANCH_HAS_PENDING_INVENTORY_REQUESTS`
   error.

## Audit trail handling

`AuditLog` uses a tamper-evident hash chain (`previousHash`/`currentHash` per
row). Cascading deletes into this table would break the chain for every
subsequent entry, not just the deleted branch's own rows. Instead:

- `AuditLog.branchId` and `FraudAlert.branchId` get `onDelete: SetNull`
  (both columns are already nullable). Rows are never deleted; they just lose
  the live FK.
- Before deletion, one `BRANCH_DELETED` audit entry is written with the
  branch's name/code/status snapshotted into `beforeState`, so the record
  stays legible after `branchId` goes null.

## Schema changes

Verified directly against the schema and `recipes.service.ts` — this section
supersedes the original draft, which got two things wrong: it left
`InventoryRequest` as `Restrict` (see below, that still blocks deletion for
non-pending requests) and it didn't account for `Recipe`'s cross-branch
pinning (see "Recipe pinning" below) or three transitive-cascade gaps
(`TransactionItem`, `HoldOrderItem`, `ShiftCashDenomination`).

**`onDelete: Cascade` on the branch relation** (direct children of `Branch`,
keyed on `branchId`):

`UserBranchAssignment`, `BranchProductAvailability`, `BranchFlavorAvailability`,
`BranchPriceOverride`, `ProductRequest`, `FlavorRequest`, `Ingredient`,
`BranchRecipeOverride`, `InventoryMovement`, `Transaction`, `Shift`,
`HoldOrder`, `AttendanceRecord`, `Expense`, `InventoryRequest`.

(`BranchReceiptConfig` and `BranchPaymentMethodConfig` already cascade.)

**`onDelete: Cascade` on transitive child relations** — these tables aren't
branch-scoped themselves, so they only get cleaned up if the FK to their
*direct* parent (which the branch cascade above deletes) also cascades:

- `TransactionItem.transaction` (no `branchId` column on this table — its
  only path to `Branch` is through `Transaction`)
- `HoldOrderItem.holdOrder` (same reasoning, via `HoldOrder`)
- `ShiftCashDenomination.shift` (same reasoning, via `Shift`)
- `InventoryRequest.ingredient` (`ingredientId` → `Ingredient`) — changed
  from `Restrict` alongside `InventoryRequest.branch` (see below)
- `Recipe.ingredient` (`ingredientId` → `Ingredient`) — see "Recipe pinning"
  below; this one is an accepted-risk decision, not a mechanical fix

**No change needed** for `AuditLog.branch` / `FraudAlert.branch` — verified
against `migrations/20260709172014_init/migration.sql`: both already declare
`ON DELETE SET NULL` in the live schema today (Prisma's implicit default for
an optional/nullable FK column when no `onDelete` is set). The design
decision to preserve the hash chain is already the current behavior; this
plan only needs to write the `BRANCH_DELETED` audit entry, not touch these
two FKs.

### InventoryRequest: Restrict → Cascade (correction from the original draft)

The original draft said "leave `InventoryRequest` as `Restrict`, existing
and intentional." That was wrong: `InventoryRequest.branchId` already has
`onDelete: Restrict` today, which means the DB would refuse deletion for
**any** branch with **any** inventory request ever recorded — approved and
rejected ones included, not just pending ones. That's a much stricter gate
than "block on pending requests" and would surface as a raw Prisma FK
violation (P2003), not the clean `BRANCH_HAS_PENDING_INVENTORY_REQUESTS`
error this design wants.

Fix: change both `InventoryRequest.branchId` and `InventoryRequest.ingredientId`
to `onDelete: Cascade`. The service-layer pre-check (below) remains the real
gate for *pending* requests — once it passes, historical (approved/rejected)
requests should just cascade away cleanly with everything else, not throw.

### Recipe pinning — accepted catalog-breakage risk

Master `Recipe` rows are pinned to one specific branch's `Ingredient` row,
not to a branch-neutral ingredient identity (`recipes.service.ts`
`resolveIngredientForBranch`, CR-004,
`docs/decisions/CR-004-pos-deduction-integrity.md`). Every other branch
resolves its own equivalent ingredient by name at sale time, but the recipe
itself stays pinned to whichever branch's ingredient it was authored against
— often the first/oldest branch.

Cascading `Recipe.ingredient` means: deleting the branch that happens to be
the pinned source for a product's recipe silently deletes that master
`Recipe` row too, breaking deduction for that product **at every branch**,
not just the one being deleted — until someone notices and recreates it.

**This is a deliberate, explicitly-accepted decision, not an oversight.**
The user was shown the alternative (block deletion and list affected
recipes) and chose to accept the breakage instead, in order to keep "delete
means delete, unconditionally" true for every branch. No pre-check is added
for this case.

## Backend

- `DELETE /branches/:branchId` — `authenticate`, `adminOnly`,
  `requirePasswordChange` (same stack as other mutating branch routes).
- `branches.service.ts#deleteBranch(branchId, deletedBy, ipAddress)`:
  1. Load branch, 404 if missing.
  2. `countActiveShifts` — throw `BRANCH_HAS_ACTIVE_SHIFTS` (409) if > 0.
  3. `countPendingInventoryRequests` (new repo method) — throw
     `BRANCH_HAS_PENDING_INVENTORY_REQUESTS` (409) if > 0.
  4. `recordAuditLog` with action `BRANCH_DELETED`, `beforeState` snapshot.
  5. `branchesRepository.delete(branchId)` → `prisma.branch.delete(...)`,
     relying on the cascade/set-null FK actions above.
  6. Emit a socket event to the super-admin room, mirroring
     `BRANCH_STATUS_CHANGED`.

## Frontend

- Danger Zone card (`apps/web/app/(admin)/admin/branches/[branchId]/page.tsx`,
  `SettingsTab`) gets a second destructive action below Close Branch:
  "Permanently Delete Branch".
- New `DeleteBranchDialog` component
  (`apps/web/components/admin/branches/delete-branch-dialog.tsx`), modeled on
  the existing `EditBranchDialog`/`ChangeStatusDialog` pattern. Requires two
  typed confirmations to enable the submit button: the exact branch name,
  then the literal word `DELETE`.
- New `useDeleteBranch(branchId)` mutation hook in
  `hooks/queries/use-branches.ts`. On success: invalidate the branches list
  query, redirect to `/admin/branches`.
- Surface the two new error codes as readable messages in the dialog instead
  of a generic failure toast.

## Out of scope

- No export/backup step before deletion (not requested).
- No password re-auth step (user picked name+DELETE, not name+password).
- No change to who can close a branch — only who can permanently delete
  (same `adminOnly` gate, unchanged).
