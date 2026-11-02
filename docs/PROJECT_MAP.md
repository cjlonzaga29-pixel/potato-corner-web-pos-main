# Project Map

Navigation only, not proof of what the code does today. Rules live in [`.claude/CLAUDE.md`](../.claude/CLAUDE.md), architecture in [`SYSTEM_OVERVIEW.md`](SYSTEM_OVERVIEW.md), and
the current state of work in [`CURRENT_HANDOFF.md`](CURRENT_HANDOFF.md). Paths were checked against the working tree on
2026-11-02. Update the affected entries when files move. Keep this file under 180 lines and link runbooks, not details.

Shorthand: `API/` = `apps/api/src/modules/`, `WEB/` = `apps/web/`, `SHARED/` = `packages/shared/src/schemas/`,
`RUN/` = `docs/runbooks/`.

## Monorepo

| Package | Path | Scripts |
| --- | --- | --- |
| Root (Turborepo) | `package.json` | `build dev lint type-check test test:e2e format` |
| `@potato-corner/api` | `apps/api/package.json` | `dev build start lint type-check test`, `prisma:*`, `inventory:*`, `validate:inventory-setup` and others |
| `@potato-corner/web` | `apps/web/package.json` | `dev build start lint type-check test` |
| Shared schemas and types | `packages/shared/` | Zod schemas in `SHARED/`, types in `packages/shared/src/types/index.ts` |
| Config | `packages/config/` | ESLint, Prettier, TypeScript presets |

Each backend module follows `API/<name>/<name>.{router,service,repository,types}.ts`. Routers are mounted in
`apps/api/src/app.ts`; workers are started in `apps/api/src/server.ts`. Browser tests are in `tests/e2e/`, with the
Playwright config at `tests/e2e/playwright.config.ts`.

## POS terminal, cart, checkout

- **UI:** `WEB/app/(branch)/branch/terminal/page.tsx`, `WEB/components/pos/checkout-workspace.tsx`,
  `WEB/components/pos/payment-footer.tsx`
- **Client state:** `WEB/stores/cart.store.ts`, `WEB/lib/pos/`, `WEB/lib/checkout-recovery.ts`, `WEB/lib/detached-sales.ts`
- **API (authoritative totals):** `API/transactions/transactions.router.ts`, `API/transactions/transactions.service.ts`
- **Schema:** `SHARED/transaction.schema.ts`; model `Transaction`
- **Tests:** `WEB/components/pos/checkout-workspace.test.tsx`, `WEB/stores/cart.store.test.ts`,
  `API/transactions/transactions.service.test.ts`, `API/transactions/checkout-worker.integration.test.ts`, `tests/e2e/pos-workflow.spec.ts`
- **Runbooks:** `RUN/pos-perf-p15-fast-checkout.md`, `RUN/pos-perf-p41-cart-responsiveness-and-product-editor.md`,
  `RUN/pos-perf-p46-pos-keypad-and-customization-usability.md`, `RUN/pos-perf-p50-vat-settings-and-calculation-review.md`

## Inventory: availability, reservations, deduction

- **UI:** `WEB/app/(branch)/branch/inventory/page.tsx`, `WEB/app/(supervisor)/supervisor/inventory/page.tsx`,
  `WEB/app/(supervisor)/supervisor/inventory-catalog/page.tsx`, `WEB/components/branch-ops/inventory-list.tsx`
- **POS availability:** `WEB/hooks/use-cart-stock-validation.ts`, `WEB/lib/pos-product-availability.ts`
- **Availability calculation:** `API/stock-availability/stock-availability.service.ts`,
  `API/stock-availability/required-choice-combinations.ts`
- **Stock and reservations:** `API/universal-inventory/universal-inventory.router.ts`,
  `API/universal-inventory/universal-inventory.service.ts`, `API/transactions/transactions.service.ts`
- **Deduction worker:** `API/inventory-deduction/inventory-deduction.worker.ts`,
  `API/inventory-deduction/inventory-deduction.service.ts`; job runner in `apps/api/src/lib/job-runner.ts`
- **Approvals:** `API/inventory-approval/inventory-approval.router.ts`, `WEB/components/branch-ops/inventory-approvals/`
- **Schema:** `SHARED/universal-inventory.schema.ts`, `SHARED/inventory-approval.schema.ts`; models `InventoryStock`,
  `InventoryStockMovement`, `InventoryDeductionJob`
- **Tests:** `API/stock-availability/stock-availability.service.test.ts`,
  `API/stock-availability/p57-mix-max-shortages.integration.test.ts`,
  `API/inventory-deduction/inventory-deduction.service.test.ts`, `API/inventory-approval/inventory-approval.integration.test.ts`
- **Runbooks:** `RUN/pos-perf-p56-ui-and-stock-consistency.md`,
  `RUN/pos-perf-p57-shortages-and-workflow-simplification.md` (§2), `RUN/pos-perf-p44r-worker-routing-and-smoke-guards.md`,
  `RUN/pos-perf-p28-inventory-approval-rollout.md`

## Products, builder, product types

- **UI:** `WEB/app/(supervisor)/supervisor/products/page.tsx`, `WEB/app/(supervisor)/supervisor/products/builder/page.tsx`,
  `WEB/app/(supervisor)/supervisor/products/[productId]/page.tsx`, `WEB/app/(admin)/admin/products/page.tsx`,
  `WEB/app/(branch)/branch/products/page.tsx`
- **Builder state and data:** `WEB/stores/product-builder.store.ts`, `WEB/hooks/queries/use-products.ts`
- **API:** `API/products/products.router.ts`, `API/products/products.service.ts`,
  `API/product-components/product-components.service.ts`, `API/catalog-assignment/catalog-assignment.service.ts`
- **Schema:** `SHARED/product.schema.ts`, `SHARED/product-catalog.schema.ts`, `SHARED/product-component.schema.ts`,
  `SHARED/catalog-assignment.schema.ts`
- **Tests:** `API/products/products.service.test.ts`, `API/products/products.integration.test.ts`,
  `WEB/stores/product-builder.store.test.ts`, `WEB/app/(supervisor)/supervisor/products/page.test.tsx`
- **Runbooks:** `RUN/pos-perf-p34r-supervisor-product-configuration.md`, `RUN/pos-perf-p37-multi-branch-product-selection.md`,
  `RUN/pos-perf-p38-automatic-branch-setup.md`, `RUN/pos-perf-p39-product-ui-consistency.md`

**Custom product types (P58, P58R): committed on `feat/pos-perf-p58-custom-product-types`, not merged or deployed. See the handoff.**

- **UI:** `WEB/components/supervisor/products/product-type-nav.tsx`, `product-type-select.tsx`,
  `product-type-form-dialog.tsx`, `product-type-active-dialog.tsx` (same folder); `WEB/hooks/queries/use-product-types.ts`,
  `WEB/lib/product-types.ts`
- **API:** `API/product-types/product-types.router.ts`, `API/product-types/product-types.service.ts`
- **Schema:** `SHARED/product-type.schema.ts`; model `ProductType`
- **Type-scope lock:** `lockAndAssertMayEnable` in `API/products/products.service.ts`, `productCatalogLockId` in `apps/api/src/lib/pg-lock.ts`
- **Tests:** `API/product-types/p58-product-types.integration.test.ts`, `API/product-types/p58r-type-scope-race.integration.test.ts`,
  `WEB/app/(supervisor)/supervisor/products/page.types.test.tsx`, `WEB/lib/product-types.test.ts`,
  `apps/api/scripts/test-p58-migration-on-populated-data.ts`, `apps/api/scripts/p58r-browser-fixtures.ts`
- **Runbook:** `RUN/pos-perf-p58-custom-product-types.md`

## Manual discounts and proof uploads

- **UI (cashier):** `WEB/components/pos/manual-discount-fields.tsx`, `WEB/components/pos/payment-footer.tsx`
- **UI (supervisor and review):** `WEB/app/(supervisor)/supervisor/discounts/page.tsx`,
  `WEB/components/shared/transactions/view-discount-proof-dialog.tsx`
- **API (types):** `API/discounts/discounts.router.ts`, `API/discounts/discounts.service.ts`
- **API (calculation and proof):** `API/transactions/transactions.service.ts`; upload and signed-URL routes
  in `API/transactions/transactions.router.ts`; storage client in `apps/api/src/lib/supabase.ts`
- **Promotions:** `WEB/app/(supervisor)/supervisor/promotions/page.tsx`, `API/discounts/promotion-pricing.ts`,
  `SHARED/promotion.schema.ts`
- **Schema:** `SHARED/manual-discount.schema.ts`; models `ManualDiscountType`, `ManualDiscountTypeProduct`
- **Tests:** `API/transactions/p55-manual-discounts.integration.test.ts`,
  `API/transactions/p57-shortages-and-discount-modes.integration.test.ts`, `API/discounts/p49-promotions.integration.test.ts`
- **Runbooks:** `RUN/pos-perf-p55-manual-discounts-and-proof.md` (P55R2 note at the top supersedes parts of it),
  `RUN/pos-perf-p55r3-compat-readers.md`, `RUN/pos-perf-p57-shortages-and-workflow-simplification.md` (§4–7)

## Attendance, PIN, breaks, cashier sessions

- **UI:** `WEB/app/(branch)/branch/clock-in/page.tsx`, `WEB/app/(branch)/branch/attendance/page.tsx`,
  `WEB/components/branch-ops/attendance-view.tsx`, `WEB/components/pos/pin-keypad.tsx`
- **Cashier session (browser):** `WEB/stores/terminal-operator.store.ts`, `WEB/hooks/use-terminal-operator.ts`
- **API:** `API/attendance/attendance.router.ts`, `API/attendance/attendance.service.ts`,
  `API/staff-pin/staff-pin.router.ts`, `API/staff-pin/staff-pin.service.ts`
- **Schema:** `SHARED/attendance.schema.ts`, `SHARED/staff-pin.schema.ts`; models `AttendanceRecord`, `AttendanceBreak`,
  `StaffPin`, `StaffPinVerification`
- **Tests:** `API/attendance/attendance.service.test.ts`, `API/attendance/attendance-breaks.integration.test.ts`,
  `API/staff-pin/staff-pin.integration.test.ts`, `WEB/hooks/use-terminal-operator.test.ts`
- **Runbooks:** `RUN/pos-perf-p29-staff-pin-rollout.md`, `RUN/pos-perf-p30-supervisor-pin-pos-clockin.md`,
  `RUN/pos-perf-p30r-session-security-verification.md`, `RUN/pos-perf-p51-break-time-tracking.md`

## Payroll

- **UI:** `WEB/app/(supervisor)/supervisor/reports/payroll/page.tsx`, `WEB/app/(admin)/admin/reports/payroll/page.tsx`,
  `WEB/components/payroll/payroll-page.tsx`, `WEB/components/payroll/payroll-settings-panel.tsx`,
  `WEB/hooks/queries/use-payroll.ts`
- **API:** `API/payroll/payroll.router.ts`, `API/payroll/payroll.service.ts`
- **Authoritative calculation:** `API/payroll/payroll-calc.ts`, `API/payroll/payroll-money.ts`, `API/payroll/payroll-time.ts`
- **Schema:** `SHARED/payroll.schema.ts`; models `PayrollPolicy`, `PayrollRun`, `PayrollRunLine`, `PayrollAdjustment`
- **Tests:** `API/payroll/payroll-calc.test.ts`, `API/payroll/payroll.integration.test.ts`,
  `API/payroll/p54-payroll-breaks.integration.test.ts`, `WEB/components/payroll/payroll-components.test.tsx`
- **Runbooks:** `RUN/pos-perf-p52-payroll-settings-and-reports.md`, `RUN/pos-perf-p54-payroll-discounts-breaks-integration.md`,
  `RUN/pos-perf-p57-shortages-and-workflow-simplification.md` (§3)

## Dashboards and stock alerts

- **UI:** `WEB/app/(admin)/admin/dashboard/page.tsx`, `WEB/app/(supervisor)/supervisor/dashboard/page.tsx`,
  `WEB/app/(branch)/branch/dashboard/page.tsx`, `WEB/components/admin/dashboard-low-stock-summary.tsx`,
  `WEB/components/supervisor/dashboard-inventory-alerts.tsx`
- **API:** `API/reports/reports.router.ts`, `API/reports/reports.service.ts`; shortage counts in
  `API/stock-availability/stock-availability.service.ts`
- **Schema:** `SHARED/reports.schema.ts`
- **Tests:** `WEB/components/admin/dashboard-low-stock-summary.test.tsx`,
  `WEB/components/supervisor/dashboard-inventory-alerts.test.tsx`, `API/reports/reports.service.test.ts`
- **Runbooks:** `RUN/pos-perf-p47-dashboard-and-management.md`, `RUN/pos-perf-p57-shortages-and-workflow-simplification.md` (§2)

## Stock transfers

- **UI:** `WEB/app/(branch)/branch/inventory/transfer/page.tsx`, `WEB/app/(supervisor)/supervisor/inventory/transfer/page.tsx`,
  `WEB/components/branch-ops/inventory-transfer-form.tsx`, `WEB/components/branch-ops/transfer-stock-needs-panel.tsx`
- **API:** `API/universal-inventory/universal-inventory.router.ts` (`/:branchId/inventory-stock/transfer`),
  `API/universal-inventory/universal-inventory.service.ts`; destination scope in `apps/api/src/lib/branch-access.ts`
- **Schema:** `SHARED/universal-inventory.schema.ts`; models `InventoryStock`, `InventoryStockMovement`
- **Tests:** `API/universal-inventory/p48-transfer.integration.test.ts`, `WEB/components/branch-ops/inventory-transfer-form.test.tsx`
- **Runbook:** `RUN/pos-perf-p48-stock-needs-and-transfer.md`

## Authorization and branch scope

- **Web routing:** `apps/web/middleware.ts`, `WEB/stores/auth.store.ts`, `WEB/stores/selected-branch.store.ts`
- **API middleware:** `apps/api/src/middleware/authenticate.ts`, `authorize.ts`, `branch-guard.ts`,
  `require-active-employee.ts`, `write-gate.ts` (same folder)
- **Branch and catalog scope:** `apps/api/src/lib/branch-access.ts`, `apps/api/src/lib/catalog-authority.ts`
- **Auth module:** `API/auth/auth.router.ts`, `API/auth/auth.service.ts`; schema `SHARED/auth.schema.ts`
- **Tests:** `apps/api/src/middleware/rbac.test.ts`, `apps/api/src/lib/branch-access.test.ts`,
  `API/p40-route-boundaries.test.ts`, `API/products/products.branch-isolation.integration.test.ts`
- **Runbooks:** `RUN/pos-perf-p16-write-gate.md`, `RUN/pos-perf-p40-admin-management-and-downloads.md`, `docs/security/`

## Migrations

- **Schema and history:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`
- **Safety rules:** "Database & Migration Safety" in [`.claude/CLAUDE.md`](../.claude/CLAUDE.md). Read it before any `prisma migrate` command.
- **Rehearsals on disposable data:** `apps/api/scripts/with-test-postgres.ts`, `apps/api/scripts/test-p57-migration-on-populated-data.ts`,
  and the other `apps/api/scripts/test-*-migration*-on-populated-data.ts` scripts
- **Rollback notes:** `docs/migrations/`
- **Runbook example:** `RUN/pos-perf-p57-shortages-and-workflow-simplification.md` (§9)

## Deployment and rollout

- **Workflows:** `.github/workflows/ci.yml` (PRs), `.github/workflows/deploy-production.yml` (push to `main`; it has
  no manual trigger), `.github/workflows/deploy-staging.yml`
- **Rollout script:** `.github/scripts/deploy-rollout.mjs` (`render-preflight`, `render`, `vercel-promote`, `vercel-verify`);
  tests in `.github/scripts/deploy-rollout.test.mjs`
- **Smoke tests:** `tests/e2e/production-smoke.spec.ts`, `tests/e2e/playwright.production-smoke.config.ts`,
  `tests/e2e/pilot-smoke.spec.ts`, `tests/e2e/playwright.pilot.config.ts`
- **Runbooks:** `RUN/pos-perf-p42r-production-test-gate.md`, `RUN/pos-perf-p43-gated-web-and-rollout-verification.md`,
  `RUN/pos-perf-p44-pilot-and-e2e-readiness.md`, `RUN/pilot-on-call.md`, `RUN/backup-and-restore.md`
