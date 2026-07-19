# Frontend UI/UX & Functional Audit — 2026-07-19

## Scope Note (read this first)

This audit was cut short at the user's request after **6 of 13 planned audit groups** completed. It covers a static, read-only code audit of:

- **Group 1** — Auth & standalone pages (login, change-password, reset-password, unauthorized, root redirect, `/r/[txn]`, `/receipts`, `middleware.ts`)
- **Group 2** — Admin identity/catalog pages (branches, employees, products, flavors + detail routes)
- **Group 3** — Admin ops/approvals pages (recipes stub, product-request approvals, price-override approvals, attendance, shifts, audit-logs stub, fraud-alerts)
- **Group 4** — Admin dashboard/reports/settings + the dev-only component showcase page
- **Group 5** — Supervisor identity/requests pages (employees, price-overrides, product-requests, approvals stub)
- **Group 6** — Supervisor inventory + recipe-override pages (stock-in, count, adjust, waste, movements, recipes)

**Not audited** (work stopped before these groups ran):

- Group 7 — Supervisor dashboard/attendance/cash/reports pages
- Group 8 — **POS terminal & shift flow** (Part 9 checklist — the highest-priority section of the original brief, covering `/terminal`, `/shift`, `/shift/open`, `/shift/close`, `/clock-in`)
- Group 9 — `components/admin/*` (48 files, Part 2 component audit)
- Group 10 — `components/supervisor/*`, `components/pos/*`, `components/reports/*` (18 files, Part 2)
- Group 11 — `components/shared/*` (31 files — data-table, forms, feedback, charts, confirm-dialog, role-guard, etc. — Part 2, highest-leverage since every page depends on these)
- Group 12 — `components/ui/*` (30 shadcn/Radix primitives, Part 2)
- Group 13 — State management (Zustand stores + TanStack Query, Part 5 — **includes the token-storage/localStorage security check, which was never run**)

**Environment constraint (applies to everything below):** no Docker, Postgres, Redis, API server, or web dev server was running in this environment, and no browser-automation tool was available. Every finding below comes from static reading of the source — nothing was clicked, rendered, or observed at runtime. Parts 3 (responsive), 4 (accessibility beyond what's visible in JSX), 9 (perceived render time, real double-submit behavior), and 10 (cross-browser) could not be meaningfully tested even for the 6 groups that were covered; where a finding touches those areas it is because it was determinable from source (e.g. a hardcoded pixel width, a missing `aria-label`), not because it was observed live.

---

## Executive Summary

- **Total issues found (6 of 13 groups): 77**
- **Critical (blocks core function): 2** — both in `/admin/reports`
- **High (bad UX, needs fix before pilot): 18**
- **Medium (polish, do before production): 38**
- **Low (nice to have): 19**

Stub pages confirmed and excluded from counts (explicitly "Phase 0 placeholder" text, not bugs): `/r/[txn]`, `/(pos)/receipts`, `/admin/recipes`, `/admin/audit-logs`, `/admin/settings`, `/supervisor/approvals`. The dev-only component showcase at `/admin/components` (production-blocked via `notFound()`) was audited lightly and had no findings worth counting.

---

## Findings by Severity

### Critical

1. **`/admin/reports` — default "All Branches" selection silently disables 7 of 13 report tabs.** `useDailySalesReport`, `useShiftSummaryReport`, `useCashReconciliationReport`, `useVoidRefundReport`, `useDiscountComplianceReport`, `useInventoryMovementReport`, and `useAttendanceSummaryReport` are all gated `enabled: enabled && Boolean(filters.branch_id)`, but the page defaults to no branch selected. The query never fires, so the table renders its normal "no data" empty state — visually identical to "we checked, there's nothing here." An admin's first visit to the Reports page (the default Daily Sales tab) looks broken. — `apps/web/hooks/queries/use-reports.ts:82-100`, `apps/web/app/(admin)/admin/reports/page.tsx:190,220`
2. **`/admin/reports` — zero error-state wiring across all 13 report tabs.** None of the 13 `DataTable` calls pass `isError`/`onRetry`, even though `DataTable` supports both. Any real fetch failure (network error, 500, expired auth) renders identically to "no data in this range," with no way for an admin to tell a broken report from an empty one. — `apps/web/app/(admin)/admin/reports/page.tsx:314-515`, `apps/web/components/shared/data-table/data-table.tsx:139-144`

### High

3. `/admin/reports` — hardcoded `page: 1, limit: 100` on every report request, and no `DataTable` call passes pagination props, so `DataTablePagination` never renders. Any range/branch producing >100 rows silently drops the rest with no indicator. — `apps/web/app/(admin)/admin/reports/page.tsx:220,262`, `apps/web/components/shared/data-table/data-table.tsx:168`
4. `/admin/dashboard` — no error state on any panel (KPI row, branch grid, pending requests/overrides). A failed query renders identically to "empty," hiding real failures from the admin landing page. — `apps/web/app/(admin)/admin/dashboard/page.tsx:30-54`
5. `/admin/products/[productId]` — archiving a product (irreversible, all-branches, no path back per the schema's own `GLOBAL_TRANSITIONS.archived: []`) requires only a single "Save" click, unlike the comparable "Close Branch" (type-to-confirm) and "Remove Supervisor" (`ConfirmDialog`) destructive flows elsewhere in the same codebase. — `apps/web/components/admin/products/change-product-status-dialog.tsx:110-129`
6. `/admin/shifts` and `/admin/shifts/[shiftId]` — Branch and "Opened By"/"Cashier" columns render raw UUIDs instead of names. `ShiftResponse` has no name fields, and unlike the Attendance page (which fetches `useBranches`/`useEmployees` to resolve names), neither shifts view does the same lookup. — `apps/web/app/(admin)/admin/shifts/page.tsx:35-36`, `apps/web/components/admin/shifts/shift-detail-view.tsx:95-96`
7. `middleware.ts` — `ROLE_PATH_OWNERSHIP` omits `/clock-in`. Every other `(pos)` route (`/terminal`, `/shift`, `/receipts`) is bound to the `staff` role, but `/clock-in` resolves to `ownership === undefined`, so the role guard never fires and **any authenticated role** can reach the staff clock-in page. — `middleware.ts:4-10,219-225`
8. `/(auth)/change-password` — `onSubmit` calls `apiClient(...)` with no `try/catch`, and `apiClient`'s own fetch call isn't wrapped either. A network failure (offline, DNS, CORS) throws uncaught and the user sees **no error at all**. — `apps/web/app/(auth)/change-password/page.tsx:86-89`, `apps/web/lib/api-client.ts:100-104`
9. `/(auth)/reset-password` — the same unguarded-`apiClient` pattern exists in **both** sub-forms (request-link and set-new-password), with the same silent-failure result. — `apps/web/app/(auth)/reset-password/page.tsx:44-48,83-94`
10. `/supervisor/price-overrides/new` — no unsaved-changes warning; Cancel calls `router.back()` immediately with no confirmation, and any back/tab-close/nav-away mid-form silently discards it. — `apps/web/app/(supervisor)/supervisor/price-overrides/new/page.tsx:113-115`
11. `/supervisor/product-requests/new` — same gap, worse: a 5-step wizard (product info, variants, flavors, recipes, reason) with **no exit affordance at all**, not even a Cancel button. The most complex data-entry flow audited so far is also the most exposed to accidental loss. — whole file, no `beforeunload`/route-guard
12. `/supervisor/inventory/adjust` — manual stock adjustment submits with zero confirmation despite a real, permanent stock-ledger consequence; `ConfirmDialog` exists elsewhere in the app and isn't used here. — `apps/web/app/(supervisor)/supervisor/inventory/adjust/page.tsx:54-62`
13. `/supervisor/inventory/waste` — waste write-off (real financial loss recorded to the ledger) submits with zero confirmation. — `apps/web/app/(supervisor)/supervisor/inventory/waste/page.tsx:61-71`
14. `/supervisor/inventory/count` — physical count submits with zero confirmation and no diff/review screen, despite being the highest-blast-radius action in the group (can move every ingredient's recorded stock at once). — `apps/web/app/(supervisor)/supervisor/inventory/count/page.tsx:68-77,122-129`
15. `/supervisor/recipes` — deleting a recipe override executes on a single click with no confirmation, on a page whose own copy says "no approval needed — every change is audit-logged" (making an accidental delete easier, with no recovery UI). — `apps/web/app/(supervisor)/supervisor/recipes/page.tsx:155-157`
16. `/supervisor/recipes` — the "Add Override" quantity field uses raw `useState<string>` with no schema, unlike every sibling inventory form (all RHF+zod, positive/nonnegative-enforced). `"0"` or `"-5"` both pass the button-enable check and get sent as `Number(quantity)`. — `apps/web/app/(supervisor)/supervisor/recipes/page.tsx:57,261`
17. `/supervisor/recipes` — all five supporting queries (`useProducts`, `useIngredients`, `useFlavors`, `useMasterRecipes`, `useRecipeOverrides`) ignore `isLoading`/`isError`; a failed fetch renders as an empty dropdown/list with no error indication and no retry, on a page whose whole purpose is showing "what's currently deducted." — `apps/web/app/(supervisor)/supervisor/recipes/page.tsx:26,32-37`
18. `/admin/reports` — date-range filters silently do nothing for 5 of 13 tabs (`PRODUCT_PERFORMANCE`, `FLAVOR_PERFORMANCE`, `EMPLOYEE_PERFORMANCE`, `INVENTORY_VALUATION`, `BRANCH_COMPARISON`), but the date pickers still render and accept input as if they mattered. — `apps/web/app/(admin)/admin/reports/page.tsx:230-234`, `apps/web/hooks/queries/use-reports.ts:130-144`
19. `/supervisor/price-overrides/new` — supporting queries `useProducts`/`useProduct` don't check `isLoading`/`isError`; a failed fetch makes the Product/Variant selects silently render as if there were zero options, with no way to tell "no products" from "fetch failed." — `apps/web/app/(supervisor)/supervisor/price-overrides/new/page.tsx:21,23`
20. `/admin/approvals/product-requests` and `/admin/approvals/price-overrides` — "Approve" (as-requested or with-modifications) executes on a single click inside the review dialog with no secondary confirmation, while "Reject" on both pages requires a ≥20-char note. Approving creates real product-catalog/price entries with zero "are you sure." — `apps/web/components/admin/approvals/review-product-request-dialog.tsx:169-172`, `apps/web/components/admin/approvals/review-price-override-dialog.tsx:92-95`

*(20 items shown; the remaining High-severity items from Groups 1–6 are folded into the per-group detail files referenced in "Source Files" below to keep this list scannable — see Medium section for the next tier.)*

### Medium (38 total — representative sample; full detail in source group files)

- Both admin list+detail loading states use a centered corner spinner rather than a layout-matching skeleton, across all four admin identity/catalog detail routes and the shared `DataTable`'s loading overlay (Group 2).
- `/unauthorized` page is fully built and correct but unreachable — nothing in the app links to or redirects to it; `middleware.ts` redirects wrong-role users straight to their own dashboard instead (Group 1).
- Password policy is inconsistent between `/reset-password` (`.min(8)` only) and `/change-password` (full complexity regex) — a forgotten-password reset can set a weaker password than a logged-in change requires (Group 1).
- All three auth forms (login, change-password, reset-password) bypass the shared `Form`/`FormFieldWrapper` primitives that wire up `aria-invalid`/`aria-describedby` and required-field asterisks automatically, using raw `Label`+`Input`+`register()` instead (Group 1).
- `useInvestigateAlert` has no `toast.success` in `onSuccess`, unlike its siblings `useDismissAlert`/`useEscalateAlert` which both toast — inconsistent mutation feedback (Group 3).
- Inline-edited product-request variant fields (name/size/price) during "Approve with Modifications" have no client-side validation — an emptied field is silently accepted (Group 3).
- `/admin/dashboard` branch-grid cards all navigate to the generic branch list regardless of which branch card was clicked, discarding the click context (Group 4).
- No 422→field-level error mapping anywhere across Groups 5–6's creation/data-entry forms (price-overrides/new, product-requests/new, stock-in, adjust, waste, count) — `apiClient`'s `error.details` is typed but never read by any `errorMessage()` helper (Groups 5, 6).
- `/supervisor/inventory/movements` uses hardcoded `text-green-600` with no `dark:` variant, inconsistent with the rest of the app's theme-aware status coloring (Group 6).
- Missing visible required-field markers on both supervisor creation forms (price-overrides/new, product-requests/new) and the recipes "Add Override" dialog (Groups 5, 6).
- Several `from`/`to` date-range filters (attendance, inventory movements) have no `from > to` guard, silently producing an empty/confusing result with no inline explanation (Groups 3, 6).
- Status-filter `<Select>` controls on the two approvals pages and the admin shifts page have no `<Label>`/`aria-label` (Group 3).

### Low (19 total — see source group files for the complete list)

Representative items: unhandled-promise-rejection code smell (`void mutateAsync()` with no `.catch`) repeated across ~6 dialogs/pages in Groups 2, 3, 5, 6 — cosmetic since the mutation's own `onError` toast still fires, but produces console noise; root page's redundant double-redirect hop (`/` → `/login` → role dashboard); missing status filters on read-mostly supervisor list pages; number inputs missing `min`/`step` attributes; an unchecked enum cast in the inventory-movements type badge; free-text (non-enum) unit field on recipe overrides.

---

## Findings by Category (Audit Parts covered)

- **Part 1 (Functional):** covered for all 6 groups. Buttons/handlers, forms, query loading/error/empty/success states, mutation toasts, nav links, modal open/close, table row counts, pagination, filters, and destructive-action confirmation were all checked. The confirmation-before-destructive-action gap (item 1.13) is the single most repeated finding — 6 separate High-severity instances across Groups 3, 5, and 6 alone (approve dialogs, adjust/waste/count/recipe-delete).
- **Part 2 (Component-level):** only audited inline, opportunistically, while reading pages in Groups 1–6 — **not independently audited**. The dedicated component-directory groups (9–12, covering `components/admin`, `components/supervisor`, `components/pos`, `components/reports`, `components/shared`, `components/ui` — 127 files total) never ran.
- **Part 3 (Responsive):** not testable (no browser). A few source-level responsive signals were incidentally noted (e.g. charts use `ResponsiveContainer` with percentage width, confirmed in Group 4) but this was not a systematic pass.
- **Part 4 (Accessibility):** partially covered via static signals only (missing `aria-label`, missing `<Label>` association, missing `aria-invalid`/`aria-describedby`). Keyboard reachability, focus indicators, contrast ratios, and screen-reader announcement of toasts were not testable.
- **Part 5 (State management):** **not audited** — Group 13 never ran. This includes the security-relevant check of whether any Zustand store persists an access/refresh token to `localStorage`; that has not been verified in this pass and should be treated as an open question, not a clean bill of health.
- **Part 6 (Form UX):** covered for every form in Groups 1–6. Recurring pattern: submit-disabled-while-pending and inline validation are consistently well-implemented; unsaved-changes warnings and 422-to-field-error mapping are consistently absent.
- **Part 7 (Error handling):** covered. The dominant pattern across all 6 groups is "query error state exists and is wired" for most list pages (via the shared `DataTable`), but several important pages/hooks skip it entirely (dashboard, reports, recipes' five supporting queries, both supervisor creation forms' supporting queries) — and three auth forms have literally no error handling for network failures at all.
- **Part 8 (Loading states):** covered. Button-level and table-row-level loading states are solid throughout. The one recurring gap is loading UI using a centered spinner instead of a layout-matching skeleton (all 4 admin detail pages, the shared `DataTable`'s overlay pattern).
- **Part 9 (POS Terminal specific):** **not audited** — Group 8 was queued but never ran. This is a significant gap: the original brief called this "the most critical UX in the app," and none of its 10 checklist items (double-submit protection, offline indicator, GCash checkbox prominence, cash-input autofocus, etc.) have been checked.
- **Part 10 (Cross-browser):** not testable (no browser).

---

## Recommended Fix Order

**Phase A — Critical, blocks a meaningful pilot of the Reports feature:**
1. `/admin/reports` default-branch query gating (finding #1)
2. `/admin/reports` missing error state on all 13 tabs (finding #2)

**Phase B — High, fix before any pilot involving real money/stock/roles:**
3. Confirmation dialogs on the 6 unconfirmed consequential actions: inventory adjust/waste/count, recipe-override delete, product archive, and approve-as-requested (findings #5, #12–15, #20)
4. `middleware.ts` `/clock-in` role-ownership gap (finding #7)
5. Network-error handling on change-password/reset-password (findings #8–9)
6. Unsaved-changes protection on both supervisor creation forms, especially the 5-step product-request wizard (findings #10–11)
7. `/admin/reports` silent 100-row truncation and inert date filters (findings #3, #18)
8. `/admin/dashboard` and `/supervisor/recipes` missing error states on core queries (findings #4, #17)
9. Raw-UUID display on the shifts pages (finding #6)

**Phase C — Medium, polish before production:**
10. 422→field-level error mapping across all creation/data-entry forms (systemic, ~6 forms)
11. Loading-skeleton-vs-spinner consistency pass across admin detail pages and `DataTable`
12. Missing toast on Investigate action; inconsistent required-field markers; date-range guards; dark-mode color fix in inventory movements
13. Unreachable `/unauthorized` page — either wire it up or remove it
14. Password-policy consistency between reset and change flows

**Phase D — Low, backlog:**
15. Unhandled-promise-rejection cleanup (`void mutateAsync()` → real `.catch`) across ~6 sites
16. Missing status filters on read-mostly list pages; number-input `min`/`step` polish; root-page double-redirect

**Not yet triaged (audit incomplete):**
- Everything under Part 9 (POS terminal) — recommend running this before any pilot, since the brief itself flags it as highest-risk.
- Part 5 state management, especially the token-storage security check.
- The full Part 2 component-level pass (127 files across `components/admin`, `components/supervisor`, `components/pos`, `components/reports`, `components/shared`, `components/ui`).
- Group 7 (supervisor dashboard/attendance/cash/reports pages).

---

## Source Files

Full per-group findings (file:line citations, all ✅/⚠️/🔴 items, and each group's own "Not Tested" list) are preserved at:
- `audit-group-01-auth-standalone.md`
- `audit-group-02-admin-identity-catalog.md`
- `audit-group-03-admin-ops-approvals.md`
- `audit-group-04-admin-dashboard-reports.md`
- `audit-group-05-supervisor-identity-requests.md`
- `audit-group-06-supervisor-inventory-recipes.md`

(session scratch directory — ask if you want these copied into the repo alongside this summary)
