# POS-PERF-P35R2 — Shared Catalog Safety and Final Verification

## Starting / final state

- Starting local HEAD: `eeab17b7b6e95cd1028a77a74d58d3db7efa6086` (`fix(pos-perf-p35r): add
  explicit catalog-management assignment`), 2 commits ahead of `origin/main`, clean
  working tree.
- Remote: `cjlonzaga29-pixel/potato-corner-web-pos-main`.
- All work ran against the local disposable Postgres at `127.0.0.1:5432/pos_verify`
  (confirmed via `DATABASE_URL`/`DIRECT_URL` before enabling `ALLOW_DATABASE_SEED`) and
  the existing local `apps/api`/`apps/web` dev servers for the same stack. No push,
  deploy, or production action was taken.
- This database is long-lived across P28–P35R verification sessions, so it already
  carried a large backlog of real unmanaged/shared catalog rows — used directly as test
  fixtures below rather than synthesized, since that backlog is the more realistic trace
  of what P35R2 will actually encounter in production.

## 1 — Shared-reference safety audit: one real gap found and fixed

Re-traced every editable field on every ownable catalog/inventory-definition model
against what else could reference it (products/categories, option groups/options,
inventory items/categories, units/conversions, recipes/BOM, branch assignments),
per P35R's own `docs/decisions/POS-PERF-P35R-catalog-assignment.md` audit.

**Confirmed solid (no change):**
- Every ownership check across products/categories/options/components/flavors/
  universal-inventory resolves the effective manager as `managedBy ?? createdBy` via
  the shared `effectiveCatalogManager`/`isCatalogManager` helper
  (`apps/api/src/lib/catalog-ownership.ts`) — `null` (unassigned/shared/historical)
  never silently resolves to "anyone may edit," consistently across every module.
- `UnitOfMeasure`'s update schema exposes only `name`/`is_active` (no `dimension`); a
  global `UnitConversion` has no update/delete endpoint at all (create-only) — neither
  has a field capable of a silent cross-owner semantic reshape, so neither needed a
  guard.

**Gap found — `ProductOptionGroup.selection_type`/`min_selections`/`max_selections`
(`apps/api/src/modules/product-options/product-options.service.ts`, `updateGroup`):**
the existing P35R guard blocked a semantic-changing edit only when a dependent
variant's product was owned by *another named* supervisor
(`owner !== null && owner !== actor.id`) — it silently **allowed** the same edit
when the dependent product's effective owner was `null` (an unassigned, shared, or
Admin-created product with no one to have consented to the change). P35R's own
audit (`pos-perf-p35r-catalog-assignment-verification.md` §1) found this exact
class of row is the majority case in this database, not an edge case, which is
what made this a real, reachable gap rather than a theoretical one.

Fix: `owner !== actor.id` (a `null` owner is never "safe," same as every other
ownership check in the codebase). Added a unit test
(`product-options.service.test.ts`: *"blocks a selection_type change when an
assigned variant belongs to an unassigned/shared product (createdBy and managedBy
both null)"*) that fails on the old condition and passes on the fix.

## 2 — Preview / assignment consistency

Traced `GET /api/catalog-assignments/preview` and `POST /api/catalog-assignments`
(`catalog-assignment.service.ts`) end to end:

- The POST path never trusts anything read by the preview — it re-reads current
  ownership (`findOwnership`), re-validates the target supervisor
  (`exists` / `role === SUPERVISOR` / `isActive`), and re-checks branch scope for a
  branch-exclusive product, all fresh at write time. A stale preview cannot grant
  authority based on outdated dependencies, branch assignments, actor/target status,
  or manager state, because the write path doesn't read the preview's output at all
  — only `resource_type`/`resource_id`/`supervisor_id`/`reason` cross the wire from
  the confirm dialog (`assign-management-dialog.tsx`).
- The actual race (two concurrent assignment attempts on the same resource) is
  protected by `casUpdateManagedBy`'s single atomic `UPDATE ... WHERE managedBy =
  <value read moments earlier>` — Postgres's own row-level consistency, no advisory
  lock needed since exactly one row is involved. A lost race surfaces as `409
  ASSIGNMENT_CONFLICT` with an actionable message ("Reload and try again"), verified
  by the existing `catalog-assignment.service.test.ts` race test and exercised again
  live in §3 below.
- No unrelated-row locking was added — the CAS already scopes to the one resource
  row being reassigned, matching the "don't lock what you don't need to" guidance.

No defect found in this path; no code change made here.

## 3 — Real-browser workflow

New spec: `tests/e2e/pos-perf-p35r2-catalog-assignment-browser.spec.ts`, run against
the live local stack (`pos_verify` Postgres + `apps/api` dev server on `:4000` +
`apps/web` dev server on `:3000`, both already running from this session).

**Test 1 (real browser, Chromium via Playwright) — Super Admin assignment UI:**
navigates to `/admin/catalog-assignment`, switches the resource-type picker to
Products, opens the impact-preview dialog on an unmanaged row, confirms the preview
text, picks a supervisor, fills the required audited reason, submits, and asserts
the "Catalog management assigned" success toast. This is the literal UI P35R's own
runbook flagged as "typecheck/lint-verified only, not exercised in a running
browser" — now exercised.

**Test 2 (API-level, exercising the real routes, chained in one ordered test since
each step consumes state the next step depends on):**
1. Assigns one genuinely-unowned (`created_by = NULL`) and one genuinely
   Admin-created (`created_by = ` the seeded super_admin's own user id) `PRODUCT` to
   a Supervisor — `201` both times.
2. That supervisor can then `PATCH` both newly-managed products — `200`.
3. A second supervisor, created fresh with zero pre-existing catalog ownership
   (never implicitly granted access through `createdBy`), is denied managing the
   first supervisor's newly-assigned product — `403`.
4. Shared-reference protection, exercised live: a `PRODUCT_OPTION_GROUP` still
   attached to the first supervisor's own variant is assigned to the second
   supervisor; the second supervisor's attempt to change its `selection_type` is
   rejected — `409 OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED` with the actionable message
   ("assigned to a product variant managed by another supervisor ... create a new
   option group for this change instead").
5. Admin is still denied `POST /api/products` (`403`) but `GET /api/products`
   (reporting) and `GET /api/catalog-assignments/preview` (assignment access) both
   still return `200`.
6. The newly-managed product's readiness endpoint still works for its supervisor
   (`200`), the Branch account's POS catalog read still works (`200`), and that same
   Branch account is denied managing an unrelated product (`403`).

Both tests pass, confirmed stable on an immediate re-run against the same
(now-mutated) database — the fixture-selection queries read from the plain
product/group list rather than the "/unmanaged"-only endpoint specifically so a
repeat run doesn't fail once a prior run's targets already carry an explicit
manager.

### A regression found and fixed along the way: P35 broke existing e2e fixtures

Running real specs against this permission model for the first time (per P35R's own
stated gap) surfaced that **P35's Admin→Supervisor product-write transfer broke three
existing e2e fixtures that still created products via the Admin token**:
`tests/e2e/fixtures/seed-catalog.ts` (used by `pos-workflow.spec.ts` and others),
`offline-sync.spec.ts`, and `void-transaction.spec.ts` all called
`createProduct(..., adminAccessToken: admin.accessToken)` against `POST
/api/products`, which is `supervisorOnly` since P35 — every one of these specs would
403 on its very first setup call. Fixed: `createProduct` now takes
`supervisorAccessToken`, and all three call sites pass their already-logged-in
Supervisor token instead. Confirmed the fix by actually running
`pos-workflow.spec.ts`'s `beforeAll` (which calls `seedCatalog`) successfully after
the change (it had been failing before).

Also fixed in the same pass: `seed-catalog.ts`'s branch lookup (`GET
/api/branches`) used no query filter, so on this long-lived database (30 branches
accumulated across prior verification sessions) the seeded `MAIN01` branch could
fall past the default page size — added `?search=MAIN01`.

## 4 — Full-suite results

Both suites run with `--pool=forks` (NOT `--pool=threads` — threads crashes with a
Windows access violation, exit code `3221225477`, on this machine; forks is stable).

| Suite | Result |
|---|---|
| `apps/api` full `vitest run` (first full pass, forks pool) | 2814 passed, 222 skipped, 0 failed (3036 total) |
| `apps/api` full `vitest run` (final pass, after the shared-reference fix + e2e fixture fixes) | 2783 passed, 253 skipped, 1 file failed (3036 total) — `inventory-approval.integration.test.ts` hook-timed-out (10000ms) connecting to the local Postgres while the API dev server, web dev server, and several Playwright browser runs were competing for it. Re-ran that file alone immediately after: **31/31 passed in 21.5s** — confirmed contention, not a regression, same pattern already documented in `pos-perf-p34r3-final-web-suite-check.md`. No file this task touched is in that test's import graph. |
| `apps/api` `product-options` suite (after the fix) | 31/31 passed |
| `apps/web` full `vitest run` | **1228/1228 passed, 0 failed** (141 test files) |
| `apps/api` `tsc --noEmit` | clean |
| `apps/api` `eslint` on touched files (`product-options.service.ts`, `.test.ts`) | clean |
| `apps/api` `build` (`tsc -p tsconfig.json`) | clean |
| `apps/web` `build` (`next build`) | clean — full route manifest generated, no errors |
| New e2e spec (`pos-perf-p35r2-catalog-assignment-browser.spec.ts`) | 2/2 passed, confirmed stable on a repeat run |

No eslint config covers `tests/e2e/` at the repo root or in either workspace (confirmed
by attempting it — `eslint` from `apps/web`'s config reports no matching files for a
`tests/e2e/...` path); this predates P35R2 and applies equally to every existing spec
in that directory.

## 5 — Deployment compatibility, onboarding, remaining limitations

- **Deployment compatibility:** the one code change (`product-options.service.ts`)
  is a strictly *narrower* permission (closing a gap that previously allowed a
  cross-owner-affecting edit), so it's safe to deploy standalone — no migration, no
  schema change, nothing a client needs to adapt to beyond the new 409 on the
  specific unsafe edit it previously (incorrectly) allowed.
- **Assignment onboarding:** unchanged from P35R — no bulk-assign, no backfill;
  every assignment is still one resource, one supervisor, one audited reason.
- **Remaining limitations:**
  - The real-browser spec covers Products and one `PRODUCT_OPTION_GROUP`
    end-to-end; it does not separately exercise every one of the 8 ownable
    resource types through the UI (Inventory Categories/Units/Conversions/Items,
    Product Categories/Options) — those share the identical assignment
    mechanism and ownership-check helper already covered by existing unit/router
    tests, so this is a coverage choice, not an unverified path.
  - `tests/e2e/` has no lint coverage in this repo (pre-existing, not introduced
    here).
  - The `inventory-approval` integration-test contention pattern under heavy local
    concurrency (multiple dev servers + Playwright + vitest all competing for the
    same local Postgres) is a known flaky-under-load pattern, not something this
    task's changes caused or fixed.

## 6 — Commit

Committed locally only — no push, no deploy, no production migrations/assignments/
products/uploads/sales, no billing changes, no credential rotation, no Render
autoDeploy changes.
