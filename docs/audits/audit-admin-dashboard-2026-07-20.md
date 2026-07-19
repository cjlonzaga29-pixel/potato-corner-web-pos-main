# Admin Dashboard Full Audit — 2026-07-20

## 1. Executive Summary

- **Pages audited (static):** 19 admin, 19 supervisor, 6 staff/POS = 44 total.
- **Empty/stub pages:** 3 (`audit-logs`, `recipes`, `settings` — all explicit "Phase 0 placeholder" under Admin).
- **Orphaned page:** 1 (`/admin/attendance` exists, builds, but has no sidebar entry — unreachable via nav).
- **Cross-role alignment:** Admin has no Inventory or Cash Management surface at all, despite both being core Supervisor domains with no admin-level rollup. Recipe naming diverges (Admin "Recipes" vs Supervisor "Recipe Overrides" — different scope, but same sidebar icon/position invites confusion).
- **UI/UX gaps:** Shared `data-table` component used consistently across roles (good) — no duplicated table implementations found. One page (`/admin/reports`) fetches data with no error-state handling.
- **Blocking infra bug:** The Playwright E2E login helper (`tests/e2e/global-setup.ts`) is broken for every role — `getByLabel('Password')` ambiguously matches both the password input and the "Show password" toggle button, throwing a strict-mode violation. **This blocked the entire visual/responsive/navigation audit (Steps 7–9).** No screenshots were captured this session.

**Top 5 most-impactful fixes:**
1. Fix `global-setup.ts` password locator (blocks all E2E testing, not just this audit — likely blocks CI's own Playwright runs too).
2. Wire `/admin/attendance` into the admin sidebar, or remove the page if superseded by supervisor-side attendance.
3. Add error-state UI to `/admin/reports` for failed report queries.
4. Decide/implement admin-level Inventory and Cash visibility (currently supervisor-only, no admin oversight path).
5. Replace the 3 "Phase 0 placeholder" stub pages (`audit-logs`, `recipes`, `settings`) or explicitly schedule them — they're linked in the sidebar and currently dead-end.

## 2. Empty Sections Inventory

| Page | What's missing | Severity |
|---|---|---|
| `apps/web/app/(admin)/admin/audit-logs/page.tsx` | Literal "Phase 0 placeholder" text, 8 lines, no content | High — linked in sidebar, promises a feature that doesn't exist |
| `apps/web/app/(admin)/admin/recipes/page.tsx` | Same placeholder | High — same reason |
| `apps/web/app/(admin)/admin/settings/page.tsx` | Same placeholder | High — admin settings is a baseline expectation |
| `apps/web/app/(admin)/admin/attendance/page.tsx` | Fully built (173 lines) but **not in sidebar nav** — orphaned | Medium — dead code or a missed nav wiring step |

No pages were found under 30 lines other than the three explicit placeholders and the intentionally thin `shifts/[shiftId]/page.tsx` (7 lines, which is a clean delegate to `ShiftDetailView` — not a stub).

## 3. Cross-Role Alignment Table

| Domain | Admin | Supervisor | Staff | Gap |
|---|---|---|---|---|
| Dashboard | `/admin/dashboard` ✅ | `/supervisor/dashboard` ✅ | `/terminal` (POS, not a dashboard) ✅ | None — expected shape difference |
| Products/Catalog | `/admin/products` ✅ complete | — (none; supervisor works via product-requests) | — | By design: supervisor requests changes, admin approves |
| Flavors | `/admin/flavors` ✅ | — | — | Admin-only, consistent with catalog ownership |
| Recipes | `/admin/recipes` **stub** | `/supervisor/recipes` ("Recipe Overrides") ✅ | — | Admin master-recipe page is a placeholder while supervisor override page is fully built — inverted priority |
| Inventory | **absent** | `/supervisor/inventory` (+4 subpages: adjust, count, movements, stock-in, waste) ✅ | — | Admin has no inventory visibility/rollup at all |
| Cash Management | **absent** (Shifts page covers denominations, not cash mgmt) | `/supervisor/cash` ✅ | shift open/close pages | Admin has no cross-branch cash oversight page |
| Attendance | `/admin/attendance` built but **orphaned (no nav link)** | `/supervisor/attendance` ✅ linked | `/clock-in` ✅ | Admin page exists but unreachable |
| Employees | `/admin/employees` ✅ | `/supervisor/employees` ✅ | — | Aligned |
| Product Requests | `/admin/approvals/product-requests` ✅ | `/supervisor/product-requests` (+`/new`) ✅ | — | Aligned, consistent naming |
| Price Overrides | `/admin/approvals/price-overrides` ✅ | `/supervisor/price-overrides` (+`/new`) ✅ | — | Aligned |
| Reports | `/admin/reports` ✅ (519 lines, no error state) | `/supervisor/reports` ✅ | receipts | Aligned in presence, gap in error handling on admin side |
| Fraud Alerts | `/admin/fraud-alerts` ✅ | — | — | Admin-only, reasonable |
| Audit Logs | `/admin/audit-logs` **stub** | — | — | Admin-only feature not yet built |
| Settings | `/admin/settings` **stub** | — | — | Admin-only feature not yet built |
| Branches | `/admin/branches` (+detail) ✅ | — | — | Admin-only, reasonable (supervisors are branch-scoped already) |

## 4. Terminology Consistency Check

No hard inconsistencies found for Product/Branch/Employee naming — all roles consistently say "Product", "Branch", "Employee" where the concept overlaps.

One soft inconsistency: **"Recipes"** (Admin sidebar label) vs **"Recipe Overrides"** (Supervisor sidebar label) refer to different scopes (master recipe vs branch-level override) but share icon/position, which risks users conflating them. Recommend admin label something more explicit like "Master Recipes" once that page is built out.

## 5. UI/UX Gaps by Category

- **Loading states:** present in all 19 admin page files and all 19 supervisor page files (grep hit count matched file count) — no gap at page level.
- **Error states:** 15/19 admin files, 10/19 supervisor files reference error handling. At the page-fetch level specifically, only **`/admin/reports`** was found to fetch data (`useQuery`) without any `isError`/`onError` handling — KPI cards and tables will silently show stale/empty state on query failure instead of surfacing an error.
- **Empty states:** `EmptyState` component used consistently (15 admin, 12 supervisor file hits) — no gap found.
- **Component consistency:** Admin and supervisor page-level imports from `@/components/ui/*` overlap heavily (badge, button, card, input, label, select, tabs in both). Differences (admin: dropdown-menu, switch; supervisor: dialog, form, textarea) track real feature differences, not duplicated/reinvented components. All roles share the single `components/shared/data-table` implementation — no custom one-off tables per role.
- **Responsive / visual / accessibility:** **Not assessed** — blocked by the Playwright auth bug (see below).

## 6. Blocking Issue: E2E Auth Helper Broken

`tests/e2e/global-setup.ts:25` — `page.getByLabel('Password').fill(...)` throws a Playwright strict-mode violation because the password field's "Show password" toggle button (`apps/web/app/(auth)/login/_components/login-form.tsx:89`, `aria-label="Show password"`) is a substring match for the locator `getByLabel('Password')`, resolving to 2 elements.

This runs for **every** seeded role (`super_admin`, `supervisor`, `staff`) before any spec executes, so it blocks the entire E2E suite, not just this audit. A stale, differently-shaped auth fixture (`tests/e2e/tests/e2e/.auth/admin.json`, from an older script version/working directory) is the only surviving evidence a login-based E2E run ever completed — the current `global-setup.ts` (added Phase 19, commit `6b08a1f`) appears to have never successfully produced `tests/e2e/fixtures/*.auth.json`.

**Steps 7–9 (visual sweep, responsive audit, navigation flow audit) could not be performed.** No screenshots exist for this session. Recommend fixing the locator (e.g., `page.getByLabel('Password', { exact: true })` or scoping to the input via `getByRole('textbox', { name: 'Password' })`) before re-running this audit's visual phase.

A throwaway spec was written to `tests/e2e/dashboard-audit.spec.ts` (sweeps all admin/supervisor/staff pages, captures console errors/broken images/screenshots, plus a 3-viewport responsive check) — ready to run once the login helper is fixed.

## 7. Prioritized Fix Batches

**Batch 1 (fix now, blocks daily admin use / blocks testing infra):**
- Fix `global-setup.ts` password locator ambiguity.
- Add error-state handling to `/admin/reports`.
- Wire `/admin/attendance` into the admin sidebar (or remove the page).

**Batch 2 (pre-pilot polish):**
- Build out `/admin/recipes` (master recipe management) — currently blocking behind a Supervisor-only override workflow with nothing to override against from the admin side.
- Decide on admin-level Inventory/Cash oversight (dashboard rollup, or explicit "not applicable, supervisor-owned" decision).
- Re-run the Playwright visual/responsive/navigation audit (Steps 7–9) once auth is fixed.

**Batch 3 (post-pilot backlog):**
- Build out `/admin/audit-logs` and `/admin/settings`.
- Rename Admin "Recipes" sidebar label to reduce ambiguity with Supervisor "Recipe Overrides" once the admin page has real content.

## 8. Cross-Role Alignment Recommendations

- **Data model:** No schema changes indicated by this audit — gaps found are UI/routing gaps (missing pages, missing nav links), not data-model gaps.
- **Terminology standardization:** Clarify "Recipes" (admin) vs "Recipe Overrides" (supervisor) once the admin recipe page is real; no other terminology conflicts found.
- **Component consolidation:** None needed — `data-table` is already the single shared implementation; no duplicated Table/Dialog/Toast components found across roles.

## Notes on Scope

This audit covered Steps 1–6 and 10 in full via static analysis (grep/wc/git). Steps 7–9 (Playwright visual sweep, responsive audit, navigation flow) are blocked on the `global-setup.ts` bug documented in Section 6 and were not run. No code was modified in this session (Phase 1, audit-only) except adding the new throwaway spec file `tests/e2e/dashboard-audit.spec.ts`, which contains no fixes — only audit instrumentation.
