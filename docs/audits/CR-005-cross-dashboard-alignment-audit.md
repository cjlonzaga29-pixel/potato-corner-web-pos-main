# CR-005 Cross-Dashboard Alignment + Multi-Tenant Audit Report

**Audit date:** 2026-07-25
**Branch audited:** `cr-005-product-builder-recipe-composition`
**HEAD:** `f68f502` — "docs(cr-005): mark Phases 1-3 shipped, log lessons learned"
**Scope:** Read-only. No code, schema, or dependency changes were made. This document is the only file written by this audit.

---

## Executive Summary

The three role dashboards (Super Admin `/admin`, Supervisor `/supervisor`, Branch/Staff `/branch`) are built on a genuinely well-factored shared foundation — one route-group per role, one shared `InventoryList`/`ReportsView`/`DashboardShiftCard` component set reused via a `basePath` prop, and one `SOCKET_EVENTS` constants file shared verbatim between client and server. The architecture is *capable* of clean role alignment. It is not currently *configured* that way in three specific places, and it is tightly coupled to one country's tax law and one brand's identity in ways that will block both goals in the brief (cross-dashboard alignment and cloning to another business).

**Top 5 most impactful problems, in order of severity:**

1. **Inventory governance is not enforced in the UI, and staff are locked out of the inventory duties the governance model assigns them.** The shared `InventoryList` component renders "Create Ingredient", full unrestricted "Adjust" (immediately-applied, no approval gate), "Waste", "Transfer", and "Physical Count" identically for `branch` and `supervisor` roles. The backend correctly blocks `branch` from creating ingredients (`adminOrSupervisor` only) and has no approval gate on adjustments at all for anyone — so the confirmed governance model ("staff: adjust needs approval," "supervisor: creates ingredient identities") is enforced nowhere, front or back. Separately, the `staff` role (cashiers) has **zero** inventory nav items and is excluded from every inventory endpoint's role guard (`adminSupervisorOrBranch` does not include `staff`) — so staff cannot do the receive/adjust/count/waste work the governance model assigns them at all; only the `branch` (manager) account can.
2. **Philippine tax law is a first-class, non-optional part of the database schema and every profit calculation**, not a configurable rule. `vatAmount`, `vatableCapAmount`, and a comment citing **RA 9994** (the actual Philippine Senior Citizen/PWD Act) live directly in `schema.prisma` on the `Transaction`/line-item tables, and `todayNetProfit = grossSales - vat - expenses` is computed this way in both the branch and admin stats aggregations. This is the single largest blocker to cloning this codebase to a business outside the Philippines — it requires a schema migration and a rewrite of net-profit math, not a config flag.
3. **The currency symbol (₱) and Philippine-only cash denominations are hardcoded at dozens of call sites**, not sourced from any settings/config layer. `CurrencyInput` renders a literal `₱` glyph inside the component itself (not a prop), and every dashboard KPI card passes `prefix="₱"` as a string literal. `PHILIPPINE_DENOMINATIONS` in `lib/constants.ts` is a fixed array of PHP bill/coin values used by the cash-count UI. None of this reads from the existing settings module.
4. **The Supervisor dashboard/reports view doesn't fulfill "view all-branch reports."** Both `/supervisor/dashboard` and `/supervisor/reports` use `useBranchStore((s) => s.activeBranchId)` — a single active branch, switched one at a time via a selector — the exact same single-branch pattern as the `/branch` dashboard. There is no supervisor-scoped aggregate/rollup across the branches assigned to that supervisor. The Super Admin dashboard, by contrast, has a proper aggregate (`useAllBranchStats()` summed across all branches). Supervisors get branch-by-branch drill-down, never the cross-branch rollup the governance model implies.
5. **The brand name "Potato Corner" is hardcoded in customer- and admin-facing strings that have no config-layer alternative**: the receipt template shown to every customer (`components/pos/receipt-modal.tsx`), password-reset and welcome email subjects (`api/src/lib/email.ts`), the browser tab title (`app/layout.tsx`), the login screen heading, and — notably — the **2FA TOTP issuer name** (`ISSUER = 'Potato Corner'` in `totp.service.ts`), which is baked into every admin's authenticator app entry. The existing settings module (`SecurityPolicy`, `NotificationPreferences`, per-branch `ReceiptConfig`/`PaymentMethodConfig`) has a `headerText`/`footerText` override for receipts but no branding/app-name field, so even the one place a tenant *could* override the brand name today is only a partial override, and everything else is compile-time literal text.

---

## Section 1: Dashboard Alignment

### Dashboard enumeration

| Role | Route group | Layout | Landing dashboard |
|---|---|---|---|
| Super Admin | `apps/web/app/(admin)/admin/*` | `app/(admin)/layout.tsx` | `app/(admin)/admin/dashboard/page.tsx` |
| Supervisor | `apps/web/app/(supervisor)/supervisor/*` | `app/(supervisor)/layout.tsx` | `app/(supervisor)/supervisor/dashboard/page.tsx` |
| Branch (manager) + Staff (cashier) | `apps/web/app/(branch)/branch/*` | `app/(branch)/layout.tsx` | `app/(branch)/branch/dashboard/page.tsx` (staff instead land on `/branch/terminal` per `ROLE_DASHBOARDS`) |

Full page-route inventory (from `apps/web/app/**/page.tsx`, 80+ routes) confirms:
- **Admin** (`(admin)`): dashboard, attendance, branch-accounts, branches (+ `[branchId]`), employees (+ `[employeeId]`), expenses (+ `[expenseId]`), payments (gcash-qr, maya-qr), shifts/`[shiftId]`, flavors (+ `[flavorId]`), products (+ `[productId]`), recipes, profile, settings, approvals/{product-requests, price-overrides, flavor-requests}, reports. **No `admin/inventory` route exists** — correctly matching the governance rule that Super Admin does no operational inventory work.
- **Supervisor** (`(supervisor)`): dashboard, cash (+ `[shiftId]`), flavor-requests (+ new), price-overrides (+ new), product-requests (+ new), profile, inventory-requests, inventory (list, stock-in, adjust, waste, count, movements, transfer), employees (+ `[employeeId]`), attendance, expenses, recipes, reports.
- **Branch** (`(branch)`, shared by `branch` + `staff`): terminal, clock-in, shift (+ open/close), receipts, dashboard, inventory (list, stock-in, adjust, waste, count, movements, transfer), employees (+ `[employeeId]`), attendance, cash (+ `[shiftId]`, reconciliation), expenses, recipes, reports, sales, activity-logs, analytics, notifications, profile, products, settings, select-employee.

Only one root layout file exists per role group (no nested layouts), confirming the "role folder = one shell" convention.

### What each dashboard currently shows

| Aspect | Super Admin (`/admin/dashboard`) | Supervisor (`/supervisor/dashboard`) | Branch/Staff (`/branch/dashboard`) |
|---|---|---|---|
| Scope selector | `BranchSelector` (all branches or one) | None — bound to `useBranchStore.activeBranchId` | None — bound to JWT's `branchIds[0]` |
| KPIs | Active/flagged shifts, live revenue, pending approvals, transactions, active cashiers, low stock, gross sales, expenses, net profit — all **summed across branches** via `useAllBranchStats` | Gross sales, transactions, discounts — from `useCurrentShift` (single branch, single active shift) | Today's revenue, transactions, AOV — from `useAllBranchStats(branchId)` (single branch) + `DashboardShiftCard` |
| Approvals shown | Pending product requests + price overrides (counts and lists) | None on dashboard | Pending product/flavor/price-override counts (read-only tiles, not an approval UI) |
| Realtime hooks | shifts, transactions, product-requests, price-overrides, branches, expenses, attendance, inventory, **admin inventory rollup** | shifts, transactions, inventory, attendance | shifts, transactions, inventory, attendance, product-requests, flavor-requests, price-overrides |
| Extra panels | Trends section, attendance overview, inventory alerts, shortcut cards, **Live Transaction Feed, Active Cashiers Panel, Live Alerts Stream, Branch Connection Panel** (monitoring components, admin-only) | Shift card, transactions feed, inventory alerts, attendance overview | Quick Actions card (POS/Shift/Stock-in/Expense shortcuts), transactions feed, inventory alerts, attendance overview |
| Shared components used | `DashboardInventoryAlerts` (admin variant), `KpiCard` | `DashboardInventoryAlerts`/`DashboardAttendanceOverview`/`DashboardTransactionsFeed`/`DashboardShiftCard` (supervisor variants), `KpiCard` | Same supervisor-namespaced components as Supervisor (imported directly from `components/supervisor/*`) |

Notably, the **Branch dashboard imports its shared widgets from `components/supervisor/*`** (`DashboardShiftCard`, `DashboardInventoryAlerts`, `DashboardAttendanceOverview`, `DashboardTransactionsFeed`) rather than from a role-neutral `components/shared/dashboard/*` location — functionally shared, but organizationally mislabeled as supervisor-only, which will bite the next person who tries to find "all branch dashboard components."

### What each dashboard SHOULD show per the confirmed governance model

| Role | Should show |
|---|---|
| Staff | Own-shift KPIs, quick actions for receive/waste/void (immediate) and count, adjust flagged as pending-approval if submitted, no cross-branch data, no approvals queue |
| Supervisor | Aggregate view across **all assigned branches** (not one-at-a-time), pending approvals for adjustments/ingredient proposals, all-branch reports |
| Super Admin | Global rollup across every branch, proposal approvals (product/recipe/flavor), zero operational inventory actions |

### Concrete misalignments

| # | Misalignment | Fix scope |
|---|---|---|
| 1 | Supervisor dashboard/reports has no multi-branch aggregate (single `activeBranchId` only, same pattern as Branch role) | **M** — reuse `useAllBranchStats()` pattern already built for Admin, scoped to supervisor's assigned branch_ids |
| 2 | `InventoryList` shows "Create Ingredient" button to `branch` role even though backend 403s the POST — dead UI action | **S** — conditionally render button based on `useAuth().user.role` |
| 3 | Adjust flow has no approval gate for anyone; governance says staff adjustments need approval | **L** — needs an approval workflow analogous to the existing `inventory-requests` (stock in/out) flow, but for adjust specifically, plus UI to distinguish "immediate" vs "pending" actions |
| 4 | `staff` role has no inventory nav items and no backend route access at all, despite governance assigning them receive/adjust/count/waste duties | **L** — requires both a nav-visibility change and new/loosened authorize() rules, carefully scoped (staff should get scoped write access, not the same breadth as `branch`) |
| 5 | Branch dashboard's shared widgets live under `components/supervisor/*` rather than a role-neutral shared path | **S** — pure file move + import updates, no behavior change |
| 6 | Admin dashboard has "Live Activity" monitoring panels (transaction feed, active cashiers, alerts, connection status) with no equivalent on Supervisor/Branch, even though those roles would benefit from live-cashier/live-transaction visibility for their own scope | **M** — componentized already; needs branch-scoped variants |
| 7 | Pending-approval tiles appear on the Branch dashboard (read-only counts) but the actual review/approve UI lives only under Supervisor/Admin `*-requests`/`approvals/*` routes — consistent with governance, but the Branch tile's phrasing ("Pending Product Requests") doesn't make clear these are awaiting *someone else's* action | **S** — copy/UX clarification only |

---

## Section 2: Realtime Data Flow

**Total distinct events defined:** 40, in `packages/shared/src/constants/events.ts` (`SOCKET_EVENTS`), covering transactions, inventory (stock/movement/low-stock/out-of-stock/product-unavailable), cash/shift lifecycle, void requests, hold-order expiry, attendance, fraud (created/investigated/dismissed/escalated/scan-failed), notification-only events (large-adjustment-approval-needed, offline-sync, EOD summary), branch lifecycle (created/status/supervisor assigned-removed/online-offline), employee session revocation, product/price/flavor/inventory request workflows, report export lifecycle, and CR-005's variant/recipe events (submitted/approved/rejected/edited/archived, flavor-slot-changed, recipe-updated).

### Coverage matrix (which role dashboard subscribes to which events, via `useXRealtimeSync()` hooks called directly in the three `dashboard/page.tsx` files)

| Event family | Admin dashboard | Supervisor dashboard | Branch dashboard |
|---|---|---|---|
| Shifts (`useShiftsRealtimeSync`) | Yes | Yes | Yes |
| Transactions (`useTransactionsRealtimeSync`) | Yes | Yes | Yes |
| Product requests (`useProductRequestsRealtimeSync`) | Yes | No | Yes |
| Price overrides (`usePriceOverridesRealtimeSync`) | Yes | No | Yes |
| Flavor requests (`useFlavorRequestsRealtimeSync`) | No | No | Yes |
| Branches (`useBranchRealtimeSync`) | Yes | No (but mounted globally via `SocketInitializer`) | No (same) |
| Expenses (`useExpensesRealtimeSync`) | Yes | No | No |
| Attendance (`useAttendanceRealtimeSync`) | Yes | Yes | Yes |
| Inventory (`useInventoryRealtimeSync`) | Yes | Yes | Yes |
| Admin inventory rollup (`useAdminInventoryRollupRealtimeSync`) | Yes | No (no equivalent exists) | No |
| Fraud alerts | Only where `reports`/`fraud` panels are mounted (not the dashboard itself) | No | No |
| Cash variance | Not on dashboard directly (covered inside cash pages) | Not on dashboard | Not on dashboard |

### Missing subscriptions (should exist, per each dashboard's purpose, but don't)

- **Admin dashboard**: no direct `FRAUD_ALERT_CREATED` subscription on the dashboard itself (fraud is surfaced only in the Reports/fraud panel) — a global "Live Alerts Stream" component exists and likely covers this at the component level, but it's not obviously wired to fraud specifically from the dashboard's own hook list.
- **Supervisor dashboard**: missing `PRODUCT_REQUEST_*`, `PRICE_OVERRIDE_*`, `FLAVOR_REQUEST_*` — despite Supervisor being the primary approver for two of these three workflows, the dashboard doesn't live-update pending-approval counts; a supervisor must navigate to the dedicated request pages to see new submissions arrive. This is a real gap given "approve staff adjustments" is a core supervisor governance duty.
- **Supervisor dashboard**: missing `EXPENSE_CREATED/UPDATED/DELETED` — supervisors likely want live expense visibility for the branches they oversee, same as Admin has.
- **Branch dashboard**: missing `EXPENSE_CREATED/UPDATED/DELETED` — a branch account logs its own expenses; the dashboard doesn't live-refresh if logged from another tab/device.
- **Branch dashboard**: missing `BRANCH_OFFLINE`/`BRANCH_ONLINE` — arguably admin-only concern (monitoring other branches), correctly absent here, but worth confirming intentional.

### Dead events (no dashboard, and on inspection no page at all, subscribes)

Cross-referencing all `RealtimeSync`/`socket.on`/`useSocket` call sites (55 files across `apps/web`) against the 40 defined events, these appear to have **no consumer found**:
- `FRAUD_ALERT_INVESTIGATED`, `FRAUD_ALERT_DISMISSED`, `FRAUD_ALERT_ESCALATED` — the event constants file itself documents these as "not emitted yet" by `fraud.service.ts` (Phase 17 note), so they're dead on both the emit and consume side by design, not by oversight.
- `HOLD_ORDER_EXPIRED` — only relevant inside the POS terminal page itself; not a dashboard concern, but worth confirming it's actually wired at the terminal.
- `VARIANT_EDITED`, `VARIANT_ARCHIVED`, `VARIANT_FLAVOR_SLOTS_CHANGED` — CR-005 sub-phase events; likely consumed inside the admin products/recipes detail pages rather than dashboards, which is appropriate, but they don't show up in the dashboard-level hook list (expected, not a defect).

### Real-time gaps that would prevent live updates

1. Supervisors do not see pending product/price/flavor requests arrive live on their dashboard — they must poll by navigating to the request list pages. Given they are the primary reviewer, this is the most consequential gap for the "supervisor approves" workflow feeling real-time.
2. Neither Supervisor nor Branch dashboards get live expense updates, unlike Admin.
3. There's no dashboard-level rollup event for "a branch just went offline/online" outside Admin — acceptable if intentional, but should be an explicit product decision rather than an omission.

---

## Section 3: Multi-Tenant Hardcoding

### Category breakdown

An initial broad grep for `Potato Corner|potato-corner|potato_corner` matched 200+ files, but the overwhelming majority of those are the `@potato-corner/shared` **npm package import**, not brand text — that's a workspace-naming concern (renaming the internal package), not a UI/branding concern, and is comparatively cheap to fix (find/replace an import specifier) whenever it's tackled.

Filtering to the literal phrase **"Potato Corner"** (with a space — i.e., actual brand text, not the package name) found it in 14 non-generated files:

| File | Context |
|---|---|
| `apps/web/app/layout.tsx` | `title: 'Potato Corner POS'` — browser tab / metadata |
| `apps/web/app/(auth)/login/page.tsx` | `<CardTitle>Potato Corner POS</CardTitle>` — login screen heading |
| `apps/web/components/pos/receipt-modal.tsx` | `<p>Potato Corner</p>` — customer-facing printed/digital receipt |
| `apps/api/src/lib/email.ts` | Password-reset and welcome email subjects |
| `apps/api/src/modules/auth/totp.service.ts` | `const ISSUER = 'Potato Corner'` — 2FA authenticator app issuer label |
| `apps/web/components/branch/branch-sidebar.tsx`, `admin-sidebar.tsx`, `supervisor-sidebar.tsx` | Sidebar header brand text ("PC" logo mark + "Potato Corner" label) |
| `apps/web/public/manifest.json` | PWA app name/short_name |
| `apps/web/app/globals.css` | Likely a comment/theme-name reference |
| `apps/web/app/r/[txn]/page.tsx` | Public receipt-link page (same customer-facing concern as the receipt modal) |
| `apps/web/public/icons/README.md` | Icon asset documentation (cosmetic) |
| `apps/api/src/queues/notification.queue.test.ts`, `apps/api/src/queues/inventory.queue.test.ts` | Test fixtures (cosmetic) |

**CRITICAL (blocks non-PH / non-food deployment — schema and business-logic level, not swappable via config):**
- `apps/api/prisma/schema.prisma` — `vatAmount` and `vatableCapAmount` are permanent columns on the transaction/line-item tables; a code comment explicitly cites **RA 9994** (the real Philippine Senior Citizen/PWD discount law) as the reason a sale's `vatAmount` is zeroed out.
- `apps/api/src/modules/branches/branches.repository.ts` — both branch-level and all-branch stats aggregations compute `todayNetProfit = todayGrossSales - todayVat - todayExpenses`, i.e., a 12%-VAT-shaped profit formula baked into every dashboard's headline number.
- `apps/web/components/shared/forms/currency-input.tsx` — the `₱` glyph is drawn directly inside the component (not a prop), so every currency field in the app renders the peso sign unconditionally.
- `apps/web/lib/constants.ts` — `PHILIPPINE_DENOMINATIONS` and `DENOMINATION_LABELS` hardcode PHP bill/coin values (₱1000 down to 1¢) used throughout cash-count/reconciliation UI; a non-PH clone with different denominations (or a non-cash-heavy business) cannot use this UI without a code change.
- GCash/Maya-specific payment method fields (`gcashEnabled`, dedicated `payments/gcash-qr` and `payments/maya-qr` admin routes, `BulkAssignGcashQrResult`, `useUploadBranchGcashQr`) — these are named after specific Philippine e-wallet products rather than a generic "digital wallet N" concept, so adding a different country's payment method requires new schema/routes rather than configuring an existing generic slot.

**MAJOR (blocks re-branding away from "Potato Corner" specifically, but not the country/currency):**
- All 14 files in the "Potato Corner" phrase table above. Highest-impact subset: `receipt-modal.tsx` and `app/r/[txn]/page.tsx` (customer-facing), `email.ts` (customer/admin-facing), `totp.service.ts` (silently embeds the brand into every admin's authenticator app — easy to miss since it's not rendered in this app's own UI).
- Sidebar "PC" logo badges and brand label across all three sidebars (`admin-sidebar.tsx`, `supervisor-sidebar.tsx`, `branch-sidebar.tsx`) — three separate hardcoded copies rather than one shared header component reading from config.
- `apps/web/public/manifest.json` — PWA install name/icons.

**MINOR (cosmetic — comments, docs, seed/test fixtures):**
- Product-specific terms (`fries`, `Cheese Curly Fries`, etc.) appear almost entirely in seed/fixture/test files (`cr005-fixture-catalog.ts`, `seed-catalog.ts`, `*.test.ts`, `*.integration.test.ts`) — these are sample data, not code paths, and are the cheapest category to swap (delete/replace the seed file).
- Two non-test hits for food-specific placeholder text: `components/admin/products/edit-product-dialog.tsx` and `app/(supervisor)/supervisor/product-requests/new/page.tsx` — both are input placeholder examples (e.g. "e.g., Cheese Fries"), not logic; trivial to genericize.
- `public/icons/README.md` — documentation only.

### Existing config/settings layer capability

`apps/api/src/modules/settings/` (`settings.service.ts`, `settings.repository.ts`, `settings.types.ts`, `settings.router.ts`) currently manages exactly four things:
1. **Security policy** — session timeout, password length/complexity, 2FA requirement flags, lockout thresholds (global, single `SystemSetting` row keyed `security_policy`).
2. **Notification preferences** — per-user email digest/alert toggles.
3. **Per-branch receipt config** — `headerText`, `footerText`, `showBranchLogo` (the *only* branding lever that exists today, and it's branch-scoped, not tenant-scoped, and only covers the receipt footer/header text, not the brand name itself).
4. **Per-branch payment method config** — `cashEnabled`/`gcashEnabled` booleans (still GCash-named specifically, not a generic payment-method list).

**Nothing** in the settings layer manages: currency/currency symbol, tax/VAT rate or rules, app name/logo/favicon, email sender branding, TOTP issuer, or denomination sets. There is no `TenantConfig`/`BrandingConfig` model anywhere in `apps/api/src` or `packages/shared/src` — confirmed by search; `SystemSetting` is a generic key/value table currently used only for the security policy blob, so the storage mechanism for a future tenant-config row already exists, but no schema/type/service code reads or writes anything branding- or currency-shaped through it yet.

### Gap: what needs to be built for multi-tenant

- A `TenantConfig`/`BrandingConfig` shape (name, logo, currency code + symbol, locale) persisted the same way `security_policy` already is (a `SystemSetting` row), with a settings-service method and a cached client-side hook, then plumbed into: page metadata, login screen, sidebars, receipts (modal + public link), emails, and the TOTP issuer.
- A currency/formatting abstraction (`formatCurrency`, `CurrencyInput`, denomination list) parameterized by tenant config instead of literal `₱`/PHP values.
- A pluggable tax-rule module replacing the hardcoded VAT/RA-9994 computation in `branches.repository.ts` and the transaction service — this is schema-affecting and the largest single piece of work in this list.
- A generalized payment-method model (list of `{key, label, enabled}` instead of named `cashEnabled`/`gcashEnabled` columns) to support non-Philippine wallets without new schema per method.

---

## Section 4: Component Duplication

### Shared cleanly across 2+ roles (good)

- `components/branch-ops/*` — `InventoryList`, `InventoryAdjustForm`, `InventoryStockInForm`, `InventoryWasteForm`, `InventoryCountForm`, `InventoryMovementsView`, `InventoryTransferForm`, `CashShiftsList`, `CashReconciliationView`, `AttendanceView`, `ExpensesView`, `RecipeOverridesView`, `ReportsView`, `EmployeesList`, `EmployeeDetailView` — all parameterized by a `basePath` prop and reused verbatim between `/supervisor/*` and `/branch/*`. This is the strongest part of the codebase's alignment story: one real implementation, two thin page wrappers.
- `components/shared/*` — data table, charts (`kpi-card`, `area-chart`, `bar-chart`, `donut-chart`, `line-chart`), forms (`currency-input`, `denomination-input`, `search-input`), feedback states, `dashboard-header.tsx`, `socket-initializer.tsx` — genuinely role-neutral and used by all three dashboards.
- `components/monitoring/*` (`live-transaction-feed`, `active-cashiers-panel`, `live-alerts-stream`, `branch-connection-panel`) — built as standalone, reusable panels but currently only wired into the Admin dashboard (see Section 1, misalignment #6) — a missed reuse opportunity rather than a duplication problem.

### Duplicated / divergent (bad)

- **`IngredientDialog`** lives at `components/supervisor/inventory/ingredient-dialog.tsx` but is imported directly by the shared `InventoryList` component and thus rendered on `/branch/inventory` too — it's not actually duplicated code, but its *location* implies supervisor-only ownership while its *usage* is cross-role, which is exactly the kind of mislabeling that leads future contributors to assume (incorrectly) that branch/staff have no ingredient-creation UI, or to duplicate it "for branch" not realizing one already renders there.
- **Dashboard "gadget" components are supervisor-namespaced but branch-consumed**: `DashboardShiftCard`, `DashboardInventoryAlerts`, `DashboardAttendanceOverview`, `DashboardTransactionsFeed` all live under `components/supervisor/*` and are imported directly (not re-exported from a shared path) by `app/(branch)/branch/dashboard/page.tsx`. Functionally fine; organizationally these should be under `components/shared/dashboard/*`.
- **Three separate sidebar components** (`admin-sidebar.tsx`, `supervisor-sidebar.tsx`, `branch-sidebar.tsx`) each hardcode their own "PC" logo mark and "Potato Corner"/role label markup rather than sharing one `<BrandHeader>` component — this is the component-duplication counterpart to the branding hardcoding in Section 3: fixing branding requires editing three files, not one.
- **Admin's KPI/dashboard aggregation components** (`dashboard-kpi-row.tsx`, `dashboard-trends-section.tsx`, `dashboard-pending-requests.tsx`, `dashboard-pending-overrides.tsx`, `dashboard-attendance-overview.tsx`, `dashboard-inventory-alerts.tsx`) are a **separate, admin-namespaced set** from the supervisor/branch versions of conceptually the same widgets (attendance overview, inventory alerts both exist in both `components/admin/*` and `components/supervisor/*` with different implementations) rather than one shared, role-agnostic component family with role-scoped data. This is the most consequential duplication: two parallel component families doing the same visual job with different data-fetching assumptions, which is exactly why Admin's inventory-alerts panel and Supervisor's inventory-alerts panel can (and did, per Section 1) diverge in scope/behavior without anyone having to notice.

### Divergence pattern summary

The duplication is not random — it follows one consistent pattern: **branch-ops workflow screens (forms, lists, detail views) are shared via `basePath`; dashboard-summary widgets are not.** Whoever built CR-003's branch-ops layer clearly established and followed the shared-component convention; the original admin dashboard predates that convention and was never retrofitted, so Admin still has its own parallel `dashboard-*` component family instead of participating in the shared one.

---

## Section 5: Recommended Phased Plan

- **Phase 4 (POS deduction)** — proceeds unchanged; nothing found in this audit touches or blocks the recipe/POS deduction work already scoped for CR-005 Phase 4.
- **Phase 5 (UI alignment)**, proposed sub-phases:
  - 5a. Move mislabeled shared dashboard components (`components/supervisor/dashboard-*`) into `components/shared/dashboard/*`; update Branch's imports. — **S**
  - 5b. Consolidate Admin's parallel `dashboard-attendance-overview`/`dashboard-inventory-alerts` with the Supervisor/Branch versions into one role-agnostic component family, parameterized like `InventoryList` is. — **M**
  - 5c. Gate the "Create Ingredient" and unrestricted "Adjust" actions in `InventoryList`/`InventoryAdjustForm` by role, matching what the backend already enforces (or loosens the backend to match a deliberately-chosen UI policy) — requires a product decision on whether `branch` keeps ingredient-create rights or not. — **M**
  - 5d. Design and build an approval gate for stock adjustments (extending the existing `inventory-requests` pattern to cover `adjust`, not just stock in/out) so "staff adjust needs approval" becomes real. — **L**
  - 5e. Decide and implement `staff` role's actual inventory permissions (currently zero) — likely a new, narrower `authorize()` group plus new nav-visibility rules. — **L**
  - 5f. Build a supervisor multi-branch rollup dashboard/report (reusing the `useAllBranchStats` pattern, scoped to the supervisor's assigned branches) instead of the current one-branch-at-a-time view. — **M**
  - 5g. Wire missing realtime subscriptions identified in Section 2 (product/price/flavor requests + expenses on the Supervisor dashboard; expenses on Branch dashboard). — **S**
  - 5h. Extend the Live Activity monitoring panels (currently admin-only) to branch-scoped variants for Supervisor/Branch. — **M**

- **CR-006 (multi-tenant extraction)**, proposed sub-phases:
  - 6a. Introduce a `TenantConfig`/`BrandingConfig` `SystemSetting` row + service + client hook (name, logo, favicon, locale). — **M**
  - 6b. Replace hardcoded "Potato Corner" strings (14 files, Section 3) with reads from 6a's config; consolidate the three sidebar brand headers into one shared component. — **M**
  - 6c. Currency abstraction: tenant-configurable currency code/symbol, generalized `formatCurrency`, and a configurable denomination set replacing `PHILIPPINE_DENOMINATIONS`. — **M**
  - 6d. Generalize the payment-method model (`gcashEnabled`/`cashEnabled` → a list of configurable methods) and the dedicated GCash/Maya QR routes into a generic "payment method QR/config" pattern. — **L**
  - 6e. Extract the VAT/RA-9994 tax computation out of `branches.repository.ts`/transaction service into a pluggable tax-rule module; migrate `vatAmount`/`vatableCapAmount` schema fields to a more general "tax_amount"/jurisdiction-aware shape. — **XL** (schema migration + every dashboard's net-profit math + reports + receipts all depend on this field)
  - 6f. (Longer-term, "eventually non-food") Generalize product/recipe/ingredient domain language away from food-specific assumptions once 6a–6e are stable — out of scope for a near-term estimate; flagged as a distinct, later initiative.

**Parallel vs sequential:** 5a/5b/5g/5h (component reorg + realtime wiring) can proceed in parallel with each other and with Phase 4, since they don't touch schema. 5c/5d/5e (governance enforcement) should be sequenced together since they share the same authorization surface and a product decision about staff/branch inventory scope needs to land before backend authorize() rules change. CR-006's 6a–6d can start in parallel with Phase 5 (no shared files), but 6e (tax extraction) should not start until 5c–5e's governance work has landed, since both touch the inventory/transaction data model and stacking two structural changes on the same files concurrently is asking for merge pain.

**Total realistic effort estimate:** Phase 5 in full: roughly 3–4 weeks for one engineer (dominated by 5c/5d/5e's governance/approval workflow design and testing). CR-006 in full: roughly 6–10 weeks, dominated entirely by 6e (tax extraction touches schema, every stats aggregation, and every report/receipt that reads `vatAmount`). Realistic combined estimate for "both phases done, cloneable to a new PH food brand": ~5–6 weeks. Add another 4–6 weeks specifically for 6e if cloning to a non-Philippine jurisdiction (different tax regime) is actually required, since that work cannot be shortcut by config alone.

---

## Section 6: What Can Ship This Week vs Longer

**Quick wins (days):**
- Hide/disable the "Create Ingredient" button for the `branch` role in `InventoryList` so the UI stops offering an action the backend already rejects (Section 1, #2).
- Move `components/supervisor/dashboard-*` widgets to a shared path and fix Branch's imports (Section 4, cosmetic reorg, zero behavior change).
- Consolidate the three sidebars' brand-header markup into one component (doesn't require the config layer to exist yet — can hardcode the same string in one place instead of three, as a stepping stone to CR-006).
- Wire the missing Supervisor-dashboard realtime subscriptions for product/price/flavor requests and expenses (Section 2) — the hooks (`useProductRequestsRealtimeSync` etc.) already exist and are used elsewhere; this is adding 3–4 lines to one page.
- Genericize the two non-test product-specific placeholder strings (Section 3, MINOR).

**Real work (weeks):**
- Supervisor multi-branch rollup dashboard (5f).
- Stock-adjustment approval workflow (5d) and the staff-role inventory permission redesign (5e) — these require actual product decisions, not just refactoring, and should probably be scoped and reviewed together since they both touch "what can staff actually do to inventory."
- `TenantConfig`/`BrandingConfig` layer + wiring all hardcoded brand strings through it (6a/6b).
- Currency/denomination abstraction (6c).

**Long-term architectural work:**
- Extracting VAT/RA-9994 tax logic into a pluggable, jurisdiction-aware tax module and migrating the `vatAmount`/`vatableCapAmount` schema fields (6e) — this is the one piece of work in this entire audit that touches the database schema, every profit calculation, every report, and every receipt simultaneously, and should be treated as its own carefully-planned migration project, not a sub-task squeezed into a sprint.
- Generalizing the payment-method model beyond GCash/Maya-specific fields (6d).
- The eventual "beyond food" domain generalization (6f) — explicitly deferred; not worth estimating until 6a–6e are done and a concrete non-food pilot tenant exists to design against.
