# POS-PERF-P36R6 — Branch-Copy Real-Browser Verification

**Status:** Implemented and verified locally (a real Playwright browser
driving `apps/web` against a booted `apps/api` + local Postgres, plus the
affected real-Postgres integration suite, `tsc`, `eslint`, and both
production builds). Not pushed, not deployed, no production data,
migrations, or Render config touched. Starting HEAD
`1ef6c04ece5f3e6192b415f8cf66577c1addf5f1` (10 commits ahead of origin,
clean tree) — see §6 for the final state.

## 1. What this session closes

POS-PERF-P36R5's doc (`docs/decisions/POS-PERF-P36R5-branch-copy-ui-and-
replacement.md` §8) explicitly flagged "No browser/Playwright coverage" as
the one thing left unverified for the branch-copy/replace-source feature.
This session drives the real UI through the full lifecycle:

1. A supervisor with partial branch coverage over a shared product sees
   the read-only banner and the "Create Branch Copy" dialog, with the
   correct eligible-branch text and copy explanation.
2. Creating the copy, then retrying/reopening the dialog, resolves to the
   same copy — never a duplicate.
3. Editing the copy's price, recipe, and an assigned Option Group
   ("applicable choices") through the builder/detail UI.
4. Activating the copy and using the explicit "Replace Source Product"
   action.
5. A real POS checkout at Branch A, as a clocked-in cashier, reflects the
   copy's edited price and its own recipe — not the source's.
6. The pre-replacement sale against the source keeps referencing the
   source's product/variant ids, untouched by replacement.
7. Team/lifecycle checks: another supervisor actively assigned to the same
   branch can edit the copy; a cross-branch supervisor cannot (UI banner
   + 403 on a direct API attempt); revoking the original supervisor's
   branch assignment mid-session blocks them too, re-checked per request.
8. Archiving then restoring the source does not silently re-enable it
   alongside the replacement (this was a real bug — see §3).
9. A second, not-yet-ready branch copy's replace-source attempt is
   rejected without touching either row, leaving a recoverable draft.
10. A cart line built against the now-disabled source gets a clear
    `PRODUCT_UNAVAILABLE` (422) at checkout, never a false sale.

All ten scenarios are one Playwright spec,
`tests/e2e/pos-perf-p36r6-branch-copy-browser-verification.spec.ts`, run
serially against a real booted `apps/web` (:3000) + `apps/api` (:4000) +
local Postgres (`pos_verify`, the same disposable DB every other browser
spec in this repo uses) + local Supabase Storage (already running via
Docker, unused by this spec since no image upload is exercised).

## 2. Seeding a "shared" product — the one thing the API can no longer create

A branch-copy scenario needs a non-branch-exclusive product selling at two
branches. POS-PERF-P35 removed super_admin's catalog write access
entirely, and `createProduct` forces `branch_exclusive: true` for any
supervisor — so **no API caller can create this shape anymore**; every
shared product left in the fleet is a pre-P35 legacy row.
`tests/e2e/fixtures/seed-shared-branch-product.cjs` seeds one directly via
Prisma, the same precedent `seed-legacy-movement.cjs` already set for a
different now-unreachable shape (`products.replace-source.integration.
test.ts`, a vitest file, does the identical thing for the same reason).
Every other actor in the spec — branches, supervisors, the Option Group,
the pre-replacement sale — goes through the real admin/supervisor API.

Two setup snags worth recording for the next session:

- `require('@prisma/client')` resolves relative to the **requiring file's
  own path**, not the child process's `cwd`. A `.cjs` script living under
  `tests/e2e/fixtures/` walked all the way past the repo root into
  `C:\Users\<user>\node_modules\@prisma\client`, which had no generated
  client. Fixed by resolving `apps/api/node_modules/@prisma/client`
  explicitly by absolute path. `seed-legacy-movement.cjs` has the
  identical latent bug — not touched this session (out of scope), but it
  will hit the same `MODULE_NOT_FOUND` the next time it's actually run
  from a machine without that stray global install.
- `employees.service.ts`'s `createEmployee` forces `passwordHash:
  undefined` whenever `role === 'staff'`, regardless of whether
  `initial_password` is supplied — staff accounts authenticate by PIN now,
  with no API path left to provision an email/password staff login. Only
  `apps/api/prisma/seed.ts`'s seeded `staff@potatocorner.test` still has
  one (set directly at seed time). This session's POS-checkout step
  temporarily reassigns that seeded fixture from `MAIN01` to the new test
  branch for the duration of the spec and restores it in `afterAll`.
- A freshly created supervisor (`initial_password` set) starts with
  `must_change_password: true` — `requirePasswordChange` then 403s every
  further write with that account until `/api/auth/change-password` is
  called once, exactly like a real first login would. Direct-API setup
  has to do the same before acting as that user.

## 3. Two real defects found and fixed

### 3a. The supervisor product page's client-side `isOwner` was more permissive than the server

`apps/web/app/(supervisor)/supervisor/products/[productId]/page.tsx`'s
`isOwner` approximation (drives the read-only banner, "Create Branch
Copy" offer, and whether Edit/Change Status/Archive/Publish render at
all) used `sellingBranchIds.some(id => activeBranchIds.includes(id))` —
**any** overlap, filtered to currently-available branches only.

`apps/api/src/lib/catalog-authority.ts`'s real authority check
(`hasActiveCatalogAuthority`) requires `sellingBranchIds.every(id =>
activeBranchIds.includes(id))` — **full** coverage of every branch the
product is configured at (`branchScopeFromProduct` deliberately includes
a branch even while its availability is temporarily off, exactly the case
this bug mattered for).

Caught directly by this session's browser run: a supervisor assigned to
only Branch A of a shared product configured at A+B saw full Edit
Product/Change Status/Archive controls and a working-looking UI, when the
server would 403 every one of those writes. Fixed narrowly — `isOwner`
now mirrors `hasActiveCatalogAuthority` exactly (`.every()` over every
configured branch, not `.some()` over available ones). `eligibleCopyBranches`
(the "Create Branch Copy" branch picker) was already correct and
untouched — it's intersection logic, a different computation from
ownership.

### 3b. Restoring an archived shared product could silently re-enable it alongside its own replacement

`products.repository.ts`'s `cascadeBranchAvailabilityOn` (the
archived→active restore cascade, Task 34) re-enabled every currently-
unavailable branch row for a product, with no awareness that a
fork-to-branch copy might already be the sellable product at one of those
branches. POS-PERF-P36R5's doc (§3) flagged this exact scenario as a known
gap: *"restoring the source would put both the restored source and the
copy's availability on simultaneously... not special-cased further this
session."* This session's lifecycle test proved it reproduces exactly as
described, and closed it:

`cascadeBranchAvailabilityOn` now excludes any branch where an active
(`isAvailable: true`) fork-to-branch copy of this product already exists
— the source stays off at a branch its replacement already serves, while
every other branch (never replaced) restores exactly as before. This is a
safe default rather than a new interactive "conflict" dialog: the source
and its replacement can never both end up sellable at the same branch
from a restore, full stop, which is what "does not silently re-enable it"
actually requires. Verified by a new real-Postgres integration test,
`apps/api/src/modules/products/products.restore-cascade-skip-replaced-
branch.integration.test.ts`, and by the browser spec's own archive/restore
test (§1 scenario 8).

### 3c. Minor, not fixed — `AssignOptionGroupDialog`'s Select isn't labeled

`apps/web/components/admin/products/assign-option-group-dialog.tsx`'s
`<Label>Option Group</Label>` has no `htmlFor`/`id` pairing with its
`<SelectTrigger>` — a screen reader (or `getByLabel`) can't resolve the
control from the label. Purely cosmetic/a11y, not a functional defect;
not fixed this session (out of the branch-copy scope), noted here since
it's exactly the kind of thing the next accessibility pass should pick up.

## 4. A real, reproducible test-infra trap: local rate limiting during iterative runs

`apps/api/src/middleware/rate-limiter.ts`'s `apiLimiter` (100 requests/
minute, keyed by user id when authenticated, else IP — in-memory,
per-process since the Phase 21 Redis removal) and `loginLimiter` (10
logins/15 min per IP+device_id) are real, intentional protections, not a
bug. Re-running this spec repeatedly within the same dev-server process in
quick succession (debugging iterations) reliably exhausted the seeded
`admin@potatocorner.test`/`staff@potatocorner.test` fixtures' buckets,
surfacing as a generic "Product not found" on the product detail page
(its `ErrorState` fires on *any* `isError`, including a 429, not just a
literal `404`) or a `RATE_LIMIT_EXCEEDED` on login. Restarting the API dev
process (clears the in-memory store) resolved it immediately, and a clean
single run of the full spec passed with no rate-limit errors. Left
unmodified — correctly tightening a security control to make local
iteration more convenient would be the wrong trade.

## 5. Final validation

| Check | Result |
|---|---|
| Browser spec, real Playwright + Chromium against booted `apps/web`/`apps/api`/local Postgres (`npx playwright test tests/e2e/pos-perf-p36r6-branch-copy-browser-verification.spec.ts --project="Admin Dashboard (Desktop)"`) | **10/10 passed** |
| Affected API integration/unit suites (`products.restore-cascade-skip-replaced-branch.integration.test.ts`, `products.replace-source.integration.test.ts`, `products.service.test.ts`) | **171/171 passed** |
| API `tsc --noEmit` | clean |
| Web `tsc --noEmit` | clean |
| API `eslint` (changed/new files) | clean |
| Web `eslint` (changed file) | clean |
| API production build (`tsc -p tsconfig.json`) | clean |
| Web production build (`next build`) | clean |

Per CLAUDE.md's instruction not to repeat already-completed suites when no
source defect is found outside the two fixes above: the full API/web
`vitest run` suites, the full `eslint` passes, and the pre-P36 migration
replay were all exercised end-to-end in POS-PERF-P36R5's session (§5–6 of
that doc) against the same HEAD lineage and were not re-run wholesale here
— only the files this session's two fixes actually touch.

## 6. Files changed this session

- `apps/api/src/modules/products/products.repository.ts` —
  `cascadeBranchAvailabilityOn` excludes branches already replaced by an
  active fork-to-branch copy (§3b).
- `apps/api/src/modules/products/products.restore-cascade-skip-replaced-
  branch.integration.test.ts` (new, 1 test, real Express + Postgres).
- `apps/web/app/(supervisor)/supervisor/products/[productId]/page.tsx` —
  `isOwner` now requires full branch coverage (`.every()`), matching
  `hasActiveCatalogAuthority` exactly (§3a).
- `tests/e2e/pos-perf-p36r6-branch-copy-browser-verification.spec.ts`
  (new, 10 tests).
- `tests/e2e/fixtures/seed-shared-branch-product.cjs` (new) — direct-Prisma
  seed for the one shape no API path can create anymore (§2).
- `docs/decisions/POS-PERF-P36R6-branch-copy-browser-verification.md`
  (this doc).

No production migration, product, upload, assignment, sale, billing, or
credential-rotation action was taken. No Render `autoDeploy` config was
touched. Not pushed, not deployed.

## 7. Remaining limitations / not covered in this pass

- The browser spec runs only against the "Admin Dashboard (Desktop)"
  Playwright project (desktop Chrome) — not re-run against the "POS
  Terminal (Mobile)" device profile, since the builder/detail pages under
  test are desktop-oriented admin surfaces, matching every other
  branch-copy-adjacent spec's existing convention.
- §3c's missing `Select` label association is noted, not fixed.
- `seed-legacy-movement.cjs`'s identical Prisma-resolution fragility
  (§2) is noted, not fixed — out of this session's scope, flagged for
  whoever next relies on it from a clean environment.
- No production migration, catalog copy, upload, assignment, sale, or
  billing action was taken, and none of this was pushed or deployed.
