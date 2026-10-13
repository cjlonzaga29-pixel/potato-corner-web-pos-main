# POS-PERF-P35R — Historical Catalog Ownership and Scope Verification

## Starting / final state

- Starting local HEAD: `217c269f8dee39b08215203568719aa22bee9cfb`
  (`fix(pos-perf-p35): move product and inventory management to
  Supervisor`), 1 commit ahead of `origin/main`, clean working tree.
- Remote: `cjlonzaga29-pixel/potato-corner-web-pos-main`.
- No push, deploy, or production action was taken. All migration work ran
  against the local disposable Postgres container (`127.0.0.1:5432/pos_verify`,
  confirmed via `DATABASE_URL`/`DIRECT_URL` before every `prisma migrate`
  invocation, per the project's migration-safety rule) and a disposable
  embedded-Postgres instance for the populated-migration test.

## 1 — Audit of existing records (local disposable DB)

Query against `pos_verify` before any schema change:

| Model | Total | `createdBy = NULL` | Owner role breakdown (non-NULL) |
|---|---|---|---|
| `Product` | 17 | 1 | 1 super_admin, 2 supervisor (distinct owners) |
| `ProductCategory` | 0 | 0 | — |
| `ProductOptionGroup` | 2 | 2 | — |
| `ProductOption` | 2 | 2 | — |
| `InventoryCategory` | 10 | 10 | — |
| `UnitOfMeasure` | 17 | 17 | — |
| `UnitConversion` | 0 | 0 | — |
| `InventoryItem` | 16 | 16 | — |

No cross-owner `Product.categoryId` → `ProductCategory` references existed
(0 products referencing a category owned by a different supervisor) — the
dependency-tracing check in §3 below had nothing pre-existing to protect
against on this dataset, confirmed independently by the shared-reference
unit tests.

**Finding:** P35's "known limitation" is not an edge case — the overwhelming
majority of existing catalog/inventory-definition rows (every
`ProductOptionGroup`/`ProductOption`/`InventoryCategory`/`UnitOfMeasure`/
`InventoryItem` row, plus 1 `Product`) are `createdBy = NULL` or
Admin-created, i.e. already unmanageable by anyone under P35's rule alone.
This is the concrete justification for building the assignment mechanism
now rather than later.

## 2 — Explicit assignment process

Built `apps/api/src/modules/catalog-assignment/` (router/service/repository/
types) plus a new `CatalogManagementAssignment` audit table and a nullable
`managedBy` column on all 8 ownable models. Full design rationale:
`docs/decisions/POS-PERF-P35R-catalog-assignment.md`.

- `POST /api/catalog-assignments` — Super-Admin-only. Validates: resource
  exists, target user exists/role=`supervisor`/`isActive`, branch scope for
  a branch-exclusive `Product`. Atomic compare-and-swap write + audit insert.
- `GET /api/catalog-assignments/preview` — read-only impact preview (current
  manager, dependent-record summary, eligible branch scope).
- `GET /api/catalog-assignments/unmanaged` — lists records of a given type
  with `managedBy IS NULL`, the assignment UI's starting point.
- `GET /api/catalog-assignments` — per-resource assignment history.
- Frontend: `/admin/catalog-assignment` (Super Admin nav, new "Catalog
  Assignment" item) — resource-type picker, unmanaged-records table,
  assign dialog with the impact preview inline and a required audited
  reason (min 10 chars).

No bulk-assign, no automatic backfill — every assignment is one resource,
one supervisor, one reason, one audit row.

## 3 — Shared-reference protection

Traced every editable field on every ownable model against what else could
reference it. Only one semantic risk exists in the current schema:
`ProductOptionGroup.selection_type`/`min_selections`/`max_selections` can
reshape every variant assignment that already exists, including on
products another supervisor manages. `updateGroup` now blocks that specific
change (`OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED`, 409) when any assigned
variant's product has a different effective manager; cosmetic fields
(name/description/label/active/sort order) stay freely editable. No other
model's update schema exposes a field capable of the same kind of silent
cross-owner reshape (`UnitOfMeasure.dimension` is immutable after create;
`InventoryItem`'s update schema never accepts `baseUnitId`).

Historical recipes, unit meaning, sales, stock balances, and ledger rows
are never touched by an assignment — it only ever writes `managedBy` on
the one named resource and inserts one audit row.

## 4 — Endpoint permission matrix review

Grepped every router's RBAC middleware to confirm P35 did not drift outside
its stated scope, and that P35R's additions stayed equally narrow:

| Area | Guard | Changed by P35/P35R? |
|---|---|---|
| Product/category/option/universal-inventory catalog writes | `supervisorOnly` (createdBy/managedBy-scoped) | Yes — P35's intended change |
| Manual stock receive/adjust/waste/transfer/count (`universal-inventory` stock sub-routes, `inventory.router.ts`) | `adminOrSupervisor` (unchanged) | No |
| Inventory approval/review/cancellation (`inventory-approval.router.ts`) | `adminOrSupervisor` (unchanged) | No |
| POS PIN (`staff-pin.router.ts`) | `branchOnly` (unchanged) | No |
| Attendance (`attendance.router.ts`) | `allRoles` / `adminOrSupervisor` (unchanged) | No |
| Checkout/transactions (`transactions.router.ts`) | `allRoles` + `branchGuard` (unchanged) | No |
| Admin reporting (`reports.router.ts`, `audit.router.ts`) | `adminOnly` (unchanged) | No |
| **New:** `catalog-assignment.router.ts` | `adminOnly` on every route (Supervisor has zero access) | New in P35R |
| `write-gate.ts` gated-path list | Added `/api/catalog-assignments` (a catalog write) | New in P35R |

No unintended guard drift found; the full regression suite (below) confirms
behaviorally that nothing outside the catalog/inventory-definition surface
changed.

## 5 — Populated migration verification

`apps/api/scripts/test-p35r-catalog-assignment-migration-on-populated-data.ts`
(same embedded-Postgres technique as the existing
`test-migration-on-populated-data.ts`): seeds rows under the post-P35/
pre-P35R schema — an Admin-created `InventoryItem`, a `NULL`-owned
`InventoryCategory`, a supervisor-owned `ProductCategory`, a
supervisor-owned branch-exclusive `Product` — applies migration
`20261013061526_pos_perf_p35r_catalog_management_assignment` in isolation,
then asserts:

```
OK: legacy InventoryItem inserted under the old (pre-managed_by) schema
OK: pre-existing InventoryItem.created_by (an Admin-created row) is untouched by the migration
OK: pre-existing InventoryItem defaults managed_by to NULL — no guessed/backfilled assignment
OK: pre-existing NULL-owned InventoryCategory stays NULL/NULL (still frozen, not auto-claimed)
OK: pre-existing UnitOfMeasure defaults managed_by to NULL
OK: pre-existing supervisor-owned ProductCategory keeps created_by, gets NULL managed_by
OK: pre-existing branch-exclusive Product survives untouched (name, created_by, exclusive_branch_id)
OK: catalog_management_assignments table was created
OK: catalog_management_assignments starts empty — no backfilled/guessed assignment rows
OK: assigning management sets managed_by without overwriting the original created_by provenance

[p35r-migration-test] ALL CHECKS PASSED — the P35R migration is safe against populated pre-migration tables.
```

## 6 — Automated checks executed

| Check | Result |
|---|---|
| `apps/api` full `vitest run` (first pass, after ownership-check refactor) | 455/455 passed across every touched module (products, product-categories, product-options, product-components, flavors, universal-inventory); 0 failures |
| `apps/api` full `vitest run` (whole suite, pre-write-gate-test-addition) | 2787 passed, 222 skipped (pre-existing skip set, unchanged), 0 failures |
| `apps/api` new `catalog-assignment` module tests | 19/19 passed (11 service, 8 router) |
| `apps/api` `product-options` suite (after semantic-change guard) | 44/44 passed |
| `apps/api` `write-gate` suite (after adding `/api/catalog-assignments` to the gated-path test list) | 35/35 passed |
| `apps/api` full `vitest run` (final) | 2811 passed, 2 failed, 222 skipped (3035 total). Both failures are `src/lib/reports/inventory-summary-export.test.ts` PDF-render timeouts (20000ms) — re-ran that file alone immediately after: 10/10 passed in 2.6s, confirming CPU contention during the full parallel run, not a regression (same class of flakiness documented in `pos-perf-p34r3-final-web-suite-check.md`). No file this task touched is in that test's import graph. |
| `apps/api` `tsc --noEmit` | clean |
| `apps/api` `eslint` on every touched/new file | clean |
| `packages/shared` `tsc --noEmit` + build | clean |
| `apps/web` `tsc --noEmit` | no new errors — one pre-existing failure in `product-options/[groupId]/page.test.tsx` confirmed present before this task too (`git stash` + re-run) |
| `apps/web` `eslint` on new files | clean |
| `apps/web` full `vitest run` | 1225 passed, 3 failed (1228 total). Failures: `inventory-movements-view.test.tsx`, `edit-product-dialog.test.tsx`, `terminal/page.test.tsx` (one 5000ms timeout) — none in a file this task touched. Re-ran all three together immediately after: 135/135 passed, confirming the same contention pattern as the `apps/api` run above, not a regression. |
| Populated pre-P35R migration verification | 10/10 assertions passed (§5) |

No real-browser/Playwright scenarios were executed in this session — the
verification above covers API-level RBAC (role-chain middleware tests),
service-level business logic (mocked-repository unit tests), and a real
local-Postgres migration run. The user-facing assignment UI
(`/admin/catalog-assignment`) was built and typechecks/lints cleanly but
was not exercised in a running browser; this is a stated limitation, not a
claimed-and-unverified pass.

## 7 — Known limitations / remaining scope

- Assignment UI was not exercised end-to-end in a live browser session —
  typecheck/lint-verified only.
- `UNIT_CONVERSION` and `PRODUCT`/`PRODUCT_OPTION` dependent-summary
  reporting in the impact preview is intentionally empty (§3 — no
  shared-reference risk exists for those as dependents of themselves);
  this is by design, not an unimplemented gap.
- No bulk-assignment endpoint exists by design — see
  `docs/decisions/POS-PERF-P35R-catalog-assignment.md`.
- Real production catalog ownership state was never read or written in
  this task — every count/verification ran against the local disposable
  `pos_verify` database or a disposable embedded Postgres instance.

## 8 — Rollout / rollback

- **Deployment compatibility:** purely additive (nullable columns + one new
  table) — safe to deploy ahead of a frontend release; existing rows are
  unaffected and no existing query changes shape.
- **Rollback:** `managedBy` is additive and unread by any pre-P35R code
  path; reverting the application code is safe without a down-migration.
  If the column/table must be dropped, it's a standard additive-migration
  rollback (drop FK constraints, drop columns, drop table) — no data
  migration to reverse, since nothing is backfilled.
