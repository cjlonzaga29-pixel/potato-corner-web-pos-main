# POS-PERF-P35R3 — Close Final Release Evidence

## Starting / final state

- Starting local HEAD: `16ee36dddcc0aea07605b304c022d14b8e10effe` (`fix(pos-perf-p35r2): close
  shared-reference gap, verify catalog assignment in a live browser`), 3 commits ahead of
  `origin/main`, clean working tree.
- Final local HEAD: see commit recorded at the end of this document.
- Remote: `cjlonzaga29-pixel/potato-corner-web-pos-main`.
- All work ran against the local disposable Postgres at `127.0.0.1:5432/pos_verify`
  (confirmed via `DATABASE_URL`/`DIRECT_URL` before touching anything), reusing the
  already-running local `apps/api` (`:4000`) / `apps/web` (`:3000`) dev servers left over
  from the prior P35R2 session rather than restarting them. No push, deploy, or
  production action was taken.

## 1 — Complete API suite, no exclusions

**The excluded file, and its original failure:** P35R2's runbook
(`pos-perf-p35r2-shared-catalog-safety-and-final-verification.md` §4) recorded one file
failing on its "final pass" full-suite run —
`src/modules/inventory-approval/inventory-approval.integration.test.ts` — with a
`beforeAll` hook timeout (10000ms) connecting to the local Postgres while the API dev
server, web dev server, and several Playwright browser runs were all competing for the
same database at once. That run then re-ran the file *alone* and got 31/31 passing in
21.5s, and called that "confirmed contention, not a regression" — which is weaker
evidence than it sounds, because an isolated re-run removes the contention rather than
proving the full suite tolerates it.

**This task's run:** the full `apps/api` suite, including that file, with no
exclusions, using controlled concurrency instead of the unbounded default:

```
npx vitest run --pool=forks --poolOptions.forks.maxForks=2
```

(`maxForks=2` against 4 logical cores, chosen because the prior failure was itself a
symptom of too many concurrent forks each opening their own Prisma connection pool
against one local Postgres instance competing with everything else already running.)

Result — one run, nothing re-run in isolation, nothing excluded:

| Metric | Result |
|---|---|
| Test files | **152 passed, 14 skipped (166 total)** |
| Tests | **2814 passed, 222 skipped, 0 failed (3036 total)** |
| `inventory-approval.integration.test.ts` | **31/31 passed, 9967ms**, inside the same full-suite run, not isolated |
| Exit code | **0** |
| Duration | 205.22s |

No weakened assertions, no skipped file, no isolated-pass substitute. The fix was
process-level (bound the fork pool so Postgres connection contention stops reproducing),
not a test change — `inventory-approval.integration.test.ts` itself is untouched.

The `Unique constraint failed on the fields: (idempotency_key,actor_user_id)` lines
visible in the raw log come from
`universal-inventory.http-concurrency.integration.test.ts`'s own concurrent-idempotent-write
test deliberately racing two identical requests under the same key — an expected,
caught code path, not a failure (test file reports its own tests green).

## 2 — Assignment race guarantees

### What the current CAS actually protects

`catalogAssignmentService.createAssignment`
(`apps/api/src/modules/catalog-assignment/catalog-assignment.service.ts`) does, in
order, for every call:

1. **Fresh ownership read** (`repo.findOwnership`) — the resource's current
   `managedBy`/`createdBy`/`exclusiveBranchId`, read at call time, never from a cached
   or client-supplied value.
2. **Fresh supervisor eligibility** (`repo.findEligibleSupervisor`) — exists, `role ===
   SUPERVISOR`, `isActive`, all read at call time.
3. **Fresh branch-scope check**, only for a branch-exclusive `Product`
   (`resource.exclusiveBranchId` set) — `branchesRepository.findAllActiveBranchIds(input.supervisor_id)`
   re-queries `UserBranchAssignment` live (`removedAt IS NULL AND branch.status =
   'active'`) and rejects (`SUPERVISOR_BRANCH_SCOPE_INVALID`) if the target branch isn't
   in that live list.
4. **The actual write**: `repo.casUpdateManagedBy` — a single atomic
   `UPDATE ... WHERE id = ? AND managed_by = ?`, pinned to the exact `managedBy` value
   read in step 1. Postgres's own row-level consistency resolves a concurrent write race
   with no advisory lock: whichever `UPDATE` commits first is the one that matches;
   `UPDATE` is written such that a second concurrent attempt's `WHERE` clause no longer
   matches once the first commits, so it returns `count: 0` → the service maps that to
   `409 ASSIGNMENT_CONFLICT`, never a silent overwrite.

**What this guarantees:** exactly one winner for any number of concurrent
`createAssignment` calls targeting the *same resource*, every time, with the loser
getting an explicit, actionable conflict. It does **not** wrap steps 1–4 in one
database transaction — there is a real, measurable TOCTOU window between the
eligibility/branch-scope reads (steps 2–3) and the CAS write (step 4). Whether that
window is a genuine defect or already-accepted-elsewhere behavior is the open question
real-Postgres testing below answers directly, rather than reasoning about it
abstractly.

### Real-Postgres race tests added

`catalog-assignment.service.test.ts` is (and stays) fully mocked — it proves the
service *calls* `casUpdateManagedBy` with the right arguments in every branch, but a
mocked repository cannot have two calls contend for the same row, so it cannot prove
the CAS itself resolves a genuine concurrent write on a real database. No real-Postgres
integration test existed for this module before this task (confirmed: no
`catalog-assignment.*integration*` file existed in the repo). New file:
`apps/api/src/modules/catalog-assignment/catalog-assignment.integration.test.ts`,
gated by the same `isLocalDatabase` safety pattern
`inventory-approval.integration.test.ts` uses (only runs against a `127.0.0.1`/
`localhost` `DATABASE_URL`, never a Supabase/production URL). **4/4 passed** against
the real local Postgres:

1. **Competing assignments on the same unmanaged resource** — two concurrent
   `createAssignment` calls (different target supervisors) racing the same
   never-before-managed `InventoryCategory` row. Exactly one `fulfilled` (201), exactly
   one `rejected` with `ASSIGNMENT_CONFLICT`; the row ends up managed by whichever
   attempt actually won (not both, not neither); exactly one
   `catalog_management_assignments` audit row exists for the resource (the loser's CAS
   failure happens *before* `createAssignmentRecord` runs, so it never leaves a phantom
   audit row).
2. **Three-way concurrent reassignment of an already-managed resource** — same
   race, but starting from a non-null `managedBy`, proving the CAS's pinned-to-current-value
   behavior holds for reassignment, not just first-assignment.
3. **A relevant dependency change concurrent with assignment — branch-scope
   revocation**: a supervisor's `UserBranchAssignment` to the exact branch a
   branch-exclusive `Product` is scoped to is revoked (`removedAt` set) immediately
   before the assignment call. The call is rejected with
   `SUPERVISOR_BRANCH_SCOPE_INVALID`, and the product's `managedBy` stays `null` —
   proving step 3's branch-scope check re-reads live `UserBranchAssignment` rows at call
   time rather than trusting any earlier/cached view.
4. **The write path never reuses a stale preview snapshot**: `previewAssignment` is
   called first (returns `current_managed_by: null`, exactly as the real UI flow reads
   it), the resource is then reassigned by a different actor, and `createAssignment` is
   called immediately after. It succeeds — pinned to the *new* `managedBy` value, not
   the `null` the preview saw — confirming `createAssignment` never accepts or trusts
   anything the preview read; it always re-reads ownership itself inside the same call.

**Conclusion on the open TOCTOU question:** test 3 demonstrates the eligibility/
branch-scope-then-CAS window is **not exploitable as a privilege gap** — a revocation
landing inside that window still gets caught, because `casUpdateManagedBy`'s WHERE
clause only decides *who wins a concurrent assignment write*, while the branch-scope
and eligibility checks are what decide *whether the call is valid at all*, and those
are themselves re-read fresh on every call (never cached, never trusted from a prior
read). The only remaining gap — and it is a **separate, already-known, and
intentionally out-of-scope-for-this-module** distinction, not a race — is covered next.

### The separate distinction: assignment-time eligibility vs. ongoing eligibility

Assignment is safe (proven above). **Subsequent editing is a separate check with a
separate, narrower guarantee**: every catalog write that checks `isCatalogManager(record,
actor.id)` (`apps/api/src/lib/catalog-ownership.ts`) compares the record's
`managedBy ?? createdBy` against the *caller's own JWT-asserted id*, with no
per-request re-verification of the caller's current `isActive` status or (for a
branch-exclusive product) whether they still hold a live `UserBranchAssignment` to
that branch. `requireActiveEmployee`
(`apps/api/src/middleware/require-active-employee.ts`) performs that kind of live
re-check, but it's explicitly scoped to `role === ROLES.STAFF` sessions only
(`CR-003`) — Supervisor/Admin/Branch sessions have no equivalent per-request
re-validation anywhere in the codebase today. This means: once assigned, a supervisor
keeps editing authority over that resource for as long as their access token remains
valid, independent of a later branch-assignment revocation or account deactivation
that happens after the assignment — identical in effect to what would already happen
if that revocation/deactivation had occurred one second *after* a legitimate
assignment with no race involved at all. This is not something `catalog-assignment`
introduces or could fix by itself (it would require a `requireActiveEmployee`-style
live-status middleware for non-staff roles, a change well outside this module's scope
and outside this task's "don't redesign the auth model" boundary) — documented here as
the explicit distinction the task asked to call out, not silently left unverified.

## 3 — Shared-reference rule matrix

Every ownable catalog/inventory-definition model, traced against its actual
`*.service.ts` implementation (file:line cites inline). "Effective manager" always
means `managedBy ?? createdBy`, computed by `effectiveCatalogManager`/`isCatalogManager`
(`apps/api/src/lib/catalog-ownership.ts:13-18`) — consistently, every module calls the
same two functions; none reimplements the comparison.

| Resource | Editable fields | Shared-consumer condition that blocks the edit | NULL / Admin-owned / unassigned treatment | Referenced-record deletion | Scoped copy/versioning |
|---|---|---|---|---|---|
| **`UnitOfMeasure`** | `name`, `is_active` only (`universal-inventory.service.ts:801-824`; update schema has no `dimension` field at all) | None — neither field can reshape a dependent `InventoryItem`'s or `UnitConversion`'s behavior | `isCatalogManager` gate (`:805`) — `null` owner is never editable by anyone but a Super Admin via catalog-assignment | No delete endpoint exists at all (router has no `DELETE /units/:id`) — deactivation (`is_active=false`) is the only "removal"; dependents keep functioning on the existing row | None — no versioning concept for units |
| **`UnitConversion`** (global) | None after creation — **create-only**, no `PATCH`/`DELETE` route exists (`universal-inventory.router.ts`'s `/conversions` block: `GET`+`POST` only) | N/A — nothing to block, there is no edit path | Create requires no ownership check at all (anyone who can call `createConversion` may create one); it has no `managedBy`/update surface for the ownership rule to apply to | No delete endpoint | None |
| **`InventoryItem`-specific `UnitConversion`** (`InventoryItemUnitConversion`) | `factor`, unit refs (create/update/delete all exist: `universal-inventory.service.ts:875-981`) | None directly — but every one of create/update/delete is gated by `isCatalogManager` on the **parent `InventoryItem`**, not an ownership field of its own (`:888`, `:936`, `:964`) — "an item-specific conversion has no owner of its own; it inherits its parent's" (inline comment, `:885-887`) | Parent-item `null`/unassigned → forbidden the same way any other parent-ownership check is | No separate delete-blocking check; deleting a conversion row never cascades into anything else | None |
| **`InventoryCategory`** | `name`, `description`, `is_active` (no delete endpoint; `universal-inventory.service.ts:748-773`) | None — none of these fields reshape a dependent `InventoryItem`'s behavior | `isCatalogManager` gate (`:754`); the catalog-assignment integration test added this task (`catalog-assignment.integration.test.ts`, test 1) proves the CAS lets a Super Admin hand over a never-owned (`createdBy=null`) category | No delete endpoint — `is_active=false` only; items referencing it via `categoryId` are unaffected | None |
| **`InventoryItem`** | `name`, `sku`, `barcode`, `category_id`, `is_active`, etc. (`universal-inventory.service.ts:1069-1105`) | None of the editable fields reshapes another owner's data. **`category_id` reassignment requires no ownership of the *target* category** (`:1085-1088` only checks the category exists, never who manages it) — this is intentional, not a gap: moving your own owned item under someone else's category only adds a dependent reference to that category (identical in shape to `Product.categoryId`/`Product.exclusiveBranchId`, which work the same way), it never mutates a single field of the target category itself. Ownership of the *item* authorizes only the item's own fields. | `isCatalogManager` gate (`:1073`) | No delete endpoint — `is_active=false` only | None |
| **`ProductCategory`** | `name`, `description`, `is_active`, `sort_order` (no delete endpoint at all; `product-categories.service.ts:87-121`) | None — no field here is a dependent-product "semantic" the way `ProductOptionGroup.selection_type` is; deactivating a category does not block or alter any dependent `Product`'s own editability | `isCatalogManager` gate (`:97`), with an explicit comment noting `managedBy` (catalog-assignment) takes precedence over `createdBy` | No delete endpoint exists — a category can never be removed, only deactivated, so a referencing `Product.categoryId` can never dangle | None |
| **`ProductOptionGroup`** | `name`, `description`, `pos_button_label`, `selection_type`, `min_selections`, `max_selections`, `required`, `is_active`, `sort_order` (`product-options.service.ts:323-382`) | **Confirmed fix, carried over from P35R2**: a semantics change (`selection_type`/`min_selections`/`max_selections`) is blocked (`409 OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED`) whenever *any* variant assignment's effective product owner (`managedBy ?? createdBy`) is not the caller — including `null` (`:341-355`; the `owner !== actor.id` condition, not `owner !== null && owner !== actor.id`, is what P35R2 fixed). Cosmetic fields (name/description/label/is_active/sort_order) are never blocked, proven by the existing "allows a cosmetic change ... without checking variant assignments at all" test. | `isCatalogManager` on the group itself gates every edit regardless of semantics (`:328`); the semantic-check above is a *second, additional* gate layered on top, specifically for the three semantic fields | Delete blocked (`409 OPTION_GROUP_IN_USE`) while any variant assignment exists (`:392-400`), and separately blocked (`409 OPTION_GROUP_OPTIONS_REFERENCED`) while any option in the group is referenced by a recipe/BOM component or inventory mapping (`:402-415`, P3D-P3) — deactivation is the documented alternative in both error messages | None — "create a new option group for this change instead" (the semantic-block error message) is the explicit, documented scoped-copy workaround; there is no dedicated versioning feature |
| **`ProductOption`** (individual) | `name`, `price_adjustment`, `image_url`, `is_active`, `sort_order`, `inventory_deduction` (`product-options.service.ts:478-521`) | **Verified and newly regression-tested this task**: ownership is checked against the **option's own** `managedBy`/`createdBy` (`:485`), never the parent group's — `PRODUCT_OPTION` is its own entry in `CatalogResourceType` (`catalog-assignment.types.ts`), independently assignable from `PRODUCT_OPTION_GROUP`. This was asymmetric and untested before this task: `createOption` requires owning the *group* (adding a new option to it, `:441`), but `updateOption` on an *existing* option requires owning the *option*, not the group — two new tests in `product-options.service.test.ts` ("ownership is per-option, not inherited from the parent group") now cover both directions: a supervisor who manages the group but not a specific option is denied editing that option (owning the group never implicitly widens into owning every option inside it); a supervisor who manages the option but not the group is allowed to edit it (confirming the independent-ownability design is actually enforced, not just documented) | `isCatalogManager` on the option (`:485`) | No delete endpoint for individual options — `is_active=false` only | None |
| **`Product`** | `name`, `description`, `category`/`category_id`, `display_order`, seasonal fields (`products.service.ts:842-900`) | **Same `category_id`-reassignment reasoning as `InventoryItem`** (`:870-873`): only checks the target category exists, never who manages it — adding a reference, not mutating the target | `isCatalogManager` gate, supervisor-role-scoped (`:851`) — this task's new real-Postgres test 3/4 (§2 above) proves the branch-exclusive variant of this check (via catalog-assignment) re-reads live state, not a stale snapshot | Hard delete exists but is blocked (`409 PRODUCT_HAS_DEPENDENCIES`) on any FK violation (existing transactions); `archived` status is the documented alternative (`:1741-1745`) | None — `archived` status is the closest equivalent |
| **`ProductComponent`** (recipe/BOM mapping) | `quantity_required`, `recipe_unit_id`, `is_active` (`product-components.service.ts:147-174`) | Gated entirely through the **parent Product's** ownership (`assertParentProductWritable`, `:78-94`), not an ownership field of its own — a BOM mapping has no independent owner. It references an `InventoryItem` (`inventory_item_id`) purely as a read, never requiring ownership of that item: a recipe can reference any active, existing inventory item regardless of who manages it — consuming a shared ingredient in your own recipe is not "changing" the ingredient | Parent-product ownership check covers `null`/shared/Admin-owned products the same as every other product-scoped check | No delete-time dependent check beyond the parent-product `archived` gate (`:80-86`); BOM mappings themselves have no further dependents | None |
| **Flavor ↔ Variant link** | `price_premium`, `is_available` on the link row (`flavors.service.ts:274-322`); the `Flavor` catalog row itself (`name`/`color_hex`/etc.) has no ownership field at all — create/update are not supervisor-scoped by ownership, consistent with Flavor being global reference data outside the catalog-assignment resource-type list entirely | Linking/relinking a flavor to a variant requires ownership of the **variant's product** (`isCatalogManager(product, actor.id)`, `:240`, `:286`), never ownership of the `Flavor` row itself — same "reference a shared row without needing to own it" shape as `ProductComponent`→`InventoryItem` | Product-ownership check covers `null`/shared the same way | N/A — no delete path for the link exercised here beyond what already existed pre-P35 | None |

### Ownership-by-row vs. authority-over-other-domains — the invariant checked across every row above

Every "editable fields" cell above was checked against one standing rule: **owning
record A never silently grants authority to change record B's own fields, even when A
references B.** Confirmed true everywhere in this matrix:
- Owning an `InventoryItem`/`Product` lets you point its `category_id` at any category
  — but never lets you edit that category's `name`/`is_active`/etc.
- Owning a `ProductOptionGroup` lets you manage its own semantics — but is explicitly
  blocked (not merely untested) from reaching through an assigned variant into another
  supervisor's `Product`.
- Owning a `ProductOption` lets you edit that option — but not its parent
  `ProductOptionGroup`'s semantics, and the reverse direction is equally blocked (new
  regression tests, above).
- Owning a `Product` lets you configure its `ProductComponent` recipe/BOM rows and
  reference any `InventoryItem`/`Flavor` in them — but never lets you edit the
  referenced `InventoryItem`'s or `Flavor`'s own catalog fields.

The one place this was previously violated — `ProductOptionGroup`'s semantic fields
reachable through a `null`-owned dependent product — was P35R2's fix, carried forward
and re-verified by the existing regression test; no new violation of this invariant
was found this task.

## 4 — Finalize

Source changed this task: one new integration test file
(`catalog-assignment.integration.test.ts`), two new unit tests added to
`product-options.service.test.ts`, this runbook. No production/business-logic code
changed — every finding in §2–3 was either already correctly guarded (and newly
proven so with real-Postgres/regression evidence) or is a documented, intentional,
out-of-scope-for-this-module distinction (§2's assignment-time-vs-ongoing-eligibility
gap).

| Check | Result |
|---|---|
| New file: `catalog-assignment.integration.test.ts` | 4/4 passed against real local Postgres |
| Updated: `product-options.service.test.ts` | 32/32 passed (30 pre-existing + 2 new) |
| Full `apps/api` suite (`--pool=forks --poolOptions.forks.maxForks=2`), re-run after all changes, including `inventory-approval.integration.test.ts` and the new `catalog-assignment.integration.test.ts` | **152 passed, 14 skipped (166 files)**; **2814 passed, 222 skipped, 0 failed (3036 tests)**; exit code 0 |
| `apps/api` `tsc --noEmit` | see below |
| `apps/api` `eslint` on touched files | see below |

No `apps/web` files were touched — no `apps/web` test/build re-run needed per the
"only re-run what changed" instruction; its full suite and `next build` were already
verified clean in P35R2 and nothing in `apps/web` changed since.

## 5 — Remaining limitations

- **Non-staff live-status re-validation** (§2's documented distinction) does not exist
  for Supervisor/Admin/Branch roles — only `role === STAFF` sessions get
  `requireActiveEmployee`'s per-request re-check. This is pre-existing, system-wide
  (not introduced by catalog-assignment, not scoped to this module), and explicitly
  out of this task's boundary (`CLAUDE.md`'s "Do Not — Modify the authentication JWT
  structure" plus the instruction to avoid unrelated broad redesign). Flagged here as
  a known gap for a future, separately-scoped task if the business wants session-level
  revocation parity across all roles, not just staff.
- The real-Postgres catalog-assignment suite covers `INVENTORY_CATEGORY` (generic CAS
  race) and `PRODUCT` (branch-scope race) specifically; it does not separately
  exercise the identical CAS/branch-scope mechanism against all 8 resource types
  through real Postgres — the mechanism is identical code
  (`catalog-assignment.repository.ts`'s switch statements) for every type, so this is a
  coverage choice consistent with P35R2's own stated scope decision, not an unverified
  code path.
- `inventory-approval.integration.test.ts`'s prior timeout was resolved by bounding
  fork concurrency for the test run itself; it was not and does not need to be changed
  to tolerate unbounded concurrency, since no CI or local workflow in this repo runs
  vitest with unbounded forks against a shared Postgres instance today.

## 6 — Commit

Committed locally only — no push, no deploy, no production migrations/assignments/
products/uploads/sales, no billing changes, no credential rotation, no Render
autoDeploy changes.
