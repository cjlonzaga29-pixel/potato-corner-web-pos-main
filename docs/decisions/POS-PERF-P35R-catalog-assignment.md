# POS-PERF-P35R — Explicit Catalog-Management Assignment

## Problem

P35 (`217c269`) moved every remaining catalog/inventory-definition write from
Admin to Supervisor and scoped it to `createdBy`. It documented, as a known
limitation, that this left every pre-existing record with `createdBy = NULL`
(shared master data — all 10 `InventoryCategory` rows, all 17
`UnitOfMeasure` rows, all 16 `InventoryItem` rows, both `ProductOptionGroup`/
`ProductOption` rows on the local disposable DB at the time) and every
record created by an Admin account (1 `Product` row) permanently frozen:
not editable by anyone, since the ownership check requires an exact
`createdBy` match and nothing can self-claim it.

## Decision

Add a second, explicit ownership field — `managedBy` — alongside `createdBy`
on every ownable catalog/inventory-definition model (`Product`,
`ProductCategory`, `ProductOptionGroup`, `ProductOption`,
`InventoryCategory`, `UnitOfMeasure`, `UnitConversion`, `InventoryItem`).

- **`createdBy`** stays untouched everywhere — original creator provenance,
  never overwritten by an assignment.
- **`managedBy`** is nullable and, when set, is the effective owner for
  every write-permission check in that record's module. The effective
  manager is always `managedBy ?? createdBy` (see
  `apps/api/src/lib/catalog-ownership.ts`).
- The only path that may set `managedBy` is
  `POST /api/catalog-assignments`, Super-Admin-only
  (`apps/api/src/modules/catalog-assignment/`). Supervisors have no access
  to this endpoint — they cannot self-claim a shared record, and a Super
  Admin cannot name another Super Admin as the new manager (role is
  validated server-side).
- Every assignment is append-only audited in `catalog_management_assignments`
  (`resource_type`, `resource_id`, `previous_managed_by`, `new_managed_by`,
  `assigned_by`, `reason`, `branch_id`, `created_at`) — a full
  before/after trail, never an overwrite-in-place.
- The write is a compare-and-swap (`UPDATE ... WHERE id = ? AND managed_by
  = ?`), not an advisory lock or raw SQL: whichever of two concurrent
  assignment attempts commits first wins, the other gets a 409
  `ASSIGNMENT_CONFLICT` and must reload and retry. Atomic and race-safe
  without any lock primitive.
- A branch-exclusive `Product`'s assignment is rejected
  (`SUPERVISOR_BRANCH_SCOPE_INVALID`) unless the target supervisor has an
  active `UserBranchAssignment` to that product's `exclusiveBranchId`.
  Every other ownable model in scope is branch-agnostic master data (CR-007
  §3), so no branch check applies to it.
- This is explicitly **not** a restoration of Admin catalog CRUD. Admin's
  write access stays revoked exactly as P35 left it; the assignment
  endpoint is the one narrow administrative transition action layered on
  top.

## Shared-reference protection

Assigning management of a record never implicitly grants edit rights over
records that merely reference it (a product under a category, an option
under a group). Most of those edits are already naturally safe — e.g.
editing a `ProductCategory`'s name only touches that row.

One path was a genuine risk: `ProductOptionGroup.selection_type` /
`min_selections` / `max_selections` are the group's selection *semantics*,
not cosmetic fields, and a shared group can be assigned to variants on
products owned by different supervisors. `product-options.service.ts`'s
`updateGroup` now blocks a semantic-field change
(`OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED`, 409) whenever any assigned
variant's product has a different effective manager than the caller —
actionable message: create a new option group for that case instead.
Cosmetic fields (name/description/`pos_button_label`/`is_active`/
`sort_order`) stay editable regardless of who else depends on the group.

No other ownable model in scope has an editable field capable of silently
reshaping another owner's data this way (`UnitOfMeasure.dimension` and
`InventoryItem.baseUnitId`/category semantics are not editable via their
update schemas at all).

## What this does not do

- No automatic backfill/assignment to an arbitrary supervisor — every
  `managedBy` value traces to exactly one audited `POST
  /api/catalog-assignments` call.
- No bulk-assign endpoint — one resource, one supervisor, one reason, per
  call.
- Does not change the JWT structure, the recipe deduction algorithm, or any
  other business rule in `CLAUDE.md`.
