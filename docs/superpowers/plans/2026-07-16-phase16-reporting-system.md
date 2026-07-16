# Phase 16 — Reporting System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real Phase 16 reporting system — 13 report types across two tiers (real-time + 15-minute-stale pre-computed snapshots), CSV/PDF export via BullMQ + Supabase Storage, and admin/supervisor frontend pages — replacing the four stub files in `apps/api/src/modules/reports/` and extending the existing supervisor reports page.

**Architecture:** Follow the `fraud` module (Phase 17, most recently built) file-for-file as the template: repository → service → types → router, with Zod request/response schemas in `packages/shared`. Real-time reports query Prisma directly on each request (no raw SQL — day-bucketing done in JS since Prisma can't group by truncated dates). Pre-computed reports use a new `report_snapshots` table with stale-while-revalidate: serve the last snapshot immediately, enqueue a BullMQ refresh job if it's >15 min old. Exports either return a signed URL synchronously (CSV, <10k rows) or enqueue a BullMQ job that uploads to Supabase Storage and pushes `report:export_ready`/`report:export_failed` over Socket.io.

**Tech Stack:** Express 5, Prisma, BullMQ, Supabase Storage, Zod v4, `@react-pdf/renderer` (new dependency), Next.js 15 App Router, TanStack Query, Sonner.

## Global Constraints

- TypeScript strict mode, no `any`, no `!` without a comment. kebab-case files, camelCase Prisma fields mapped to snake_case wire JSON in every response.
- No raw SQL anywhere — Prisma only, including day-bucketing (done by fetching rows and grouping in JS, since Prisma has no `DATE_TRUNC` groupBy).
- No direct Prisma calls in routers — router → service → repository, exactly as `fraud.router.ts` → `fraud.service.ts` → `fraud.repository.ts`.
- Response envelope on every route: `{ data, error, meta }`.
- Every report view writes an audit log via `recordAuditLog()` (`apps/api/src/middleware/audit-log.js`), action `REPORT_ACCESSED`; every export writes one with action `REPORT_EXPORTED`. Never write to `prisma.auditLog` directly — always through `recordAuditLog`.
- 13 report types exactly: `DAILY_SALES`, `SHIFT_SUMMARY`, `CASH_RECONCILIATION`, `VOID_REFUND`, `DISCOUNT_COMPLIANCE`, `INVENTORY_MOVEMENT`, `ATTENDANCE_SUMMARY`, `FRAUD_ALERT_SUMMARY` (super_admin only), `PRODUCT_PERFORMANCE`, `FLAVOR_PERFORMANCE`, `EMPLOYEE_PERFORMANCE`, `INVENTORY_VALUATION`, `BRANCH_COMPARISON` (super_admin only). The other 11 reports: both roles, `branchGuard` applied.
- Pre-computed tier (5 types): `report_snapshots` table, 15-minute staleness threshold, stale-while-revalidate.
- CSV <10,000 rows: synchronous download (signed URL returned immediately). CSV ≥10,000 rows and all PDF exports: async BullMQ job. Export artifacts: Supabase Storage bucket `report-exports`, 24-hour (86400s) signed URLs.
- Async export UX: Socket.io push (`report:export_ready` / `report:export_failed`) + Sonner toast with download link.
- Manual refresh rate limit: once per minute per user, enforced client-side with a countdown timer.
- Supervisor reports page: EXTEND the existing real-time tabs with export/refresh/realtime controls only — do not change the existing 7 tabs' data-fetching logic.

## Corrections to the original spec (verified against the actual codebase — apply these, not the assumed paths)

- There is **no `requireRole` middleware**. Use `adminOnly` (`= authorize(ROLES.SUPER_ADMIN)`, from `apps/api/src/middleware/authorize.js`) for the two super-admin-only routes, and `adminOrSupervisor` for the rest.
- GET query params are validated with `Schema.safeParse(req.query)` inline in the router, **not** the `validate()` middleware — `validate()` is for POST/PATCH bodies only. This matches `fraud.router.ts` exactly.
- The frontend API client lives at `apps/web/lib/api-client.ts`, exporting `apiClient<T>(path, init?): Promise<{ data: T | null; error: ...; meta: unknown }>`. There is no `apps/web/lib/api.ts`.
- `DataTable` is imported from the barrel `@/components/shared/data-table` (backed by `data-table.tsx` + `columns.tsx`, not `index.tsx`). It is always manually-paginated — pass `pagination`/`onPaginationChange`/`rowCount`, or omit all three to render every row with no pagination footer (as the current supervisor reports page does).
- `useRealtimeInvalidate(events, queryKeyPrefixes)` only invalidates query keys — it has no payload callback. Since the export-ready toast needs the payload (`download_url`), `useReportsRealtimeSync` subscribes directly via `useSocket()`'s `on`/`off` instead, per the spec's own fallback instruction. `use-socket.ts` is not modified.
- `apps/web/lib/constants.ts` already defines `REPORT_CACHE_REFRESH_MINUTES = 15` (currently unused) — reuse it in `report-last-updated.tsx` instead of a new magic number.
- Inventory valuation and low-stock counts must derive current stock by summing `InventoryMovement.quantityChange` (see `inventory.repository.ts`'s `getCurrentStockMap` pattern) — **not** by reading `Ingredient.currentStock` directly, which is a stale, non-authoritative column per that repository's own convention. This applies to `getInventoryValuation` and `getBranchComparison`'s low-stock count.
- `createSignedUrl` has no prior usage anywhere in this codebase — it's new code in this plan, following the same `upload()` → check `{ error }` idiom as `products.service.ts`'s image upload.
- The `report-exports` Supabase bucket itself is not created by this plan (no migration mechanism for storage buckets exists in this codebase) — it must be created in the Supabase dashboard before this ships to a real environment, consistent with CLAUDE.md's "no external services wired up yet."
- `POST /api/reports/export`'s body shape is `{ report_type, filters: { branch_id, ... }, format }` — `branch_id` is nested under `filters`, but `branchGuard`'s `extractBranchId()` only reads a top-level `req.body.branch_id`. Using `branchGuard` on this route would incorrectly 400 every supervisor request. Task 13 instead does the same branch check `branchGuard` does, but reads `body.filters.branch_id` inline — this mirrors the existing precedent in `inventory.router.ts` ("branchGuard itself can't be used here... same allow/deny rule is applied inline instead").
- `@react-pdf/renderer` has a peer dependency on `react`, which `apps/api` does not currently have. Task 7 adds both. PDF generation code uses `React.createElement` calls (not JSX) to avoid changing `apps/api`'s `tsconfig.json` (no `jsx` compiler option is currently set, and it's a Node backend, not a React app).

## Design decisions made during planning (not specified field-by-field in the original request)

- **Row schemas**: the 13 report types' exact row fields aren't specified in the request beyond source tables and business intent. This plan defines them explicitly in Task 3 (`packages/shared/src/schemas/reports.schema.ts`) — see that task for the full field list per type.
- **Pre-computed snapshot window**: since the 15-minute refresh runs unattended (no per-viewer date range), each pre-computed report's snapshot always represents a fixed trailing **30-day window**, computed by `branchId` only. The requester's `date_from`/`date_to` filters do not apply to the 5 pre-computed types; only `branch_id` varies. This resolves an ambiguity between "refreshed every 15 minutes" and per-request filters.
- **`countRows` dispatch**: for report types that are one-row-per-underlying-record (`VOID_REFUND`, `INVENTORY_MOVEMENT`, `ATTENDANCE_SUMMARY`, `FRAUD_ALERT_SUMMARY`, `SHIFT_SUMMARY`, `CASH_RECONCILIATION`), count via `prisma.<model>.count()` with the same where-clause as the corresponding `get*` method (cheap). For aggregate/grouped types, the result set is inherently small (bounded by distinct dates/products/employees/branches), so `countRows` just computes the full result and returns `.length`.
- **`DAILY_SALES` net_sales**: `net_sales = totalAmount − vatAmount` per row (VAT-exclusive sales), a derived reporting metric — this does not touch or recompute the PWD/Senior VAT formula itself, which remains untouched inside the transactions module.
- **`POST /export` super-admin-only enforcement**: `adminOrSupervisor` alone would let a supervisor request an export of `FRAUD_ALERT_SUMMARY` or `BRANCH_COMPARISON`. The service layer additionally checks `requesterRole` against a `SUPER_ADMIN_ONLY_TYPES` set and throws a 403 `ReportError` if violated.

## File Structure

**New/replaced backend files:**
- `apps/api/prisma/migrations/20260716000000_phase16_report_snapshots/migration.sql` — new migration
- `apps/api/prisma/schema.prisma` — add `ReportType` enum + `ReportSnapshot` model (additive only)
- `packages/shared/src/constants/status.ts` — add `REPORT_TYPE` const (additive only)
- `packages/shared/src/constants/events.ts` — add `REPORT_EXPORT_READY`/`REPORT_EXPORT_FAILED` (additive only)
- `packages/shared/src/schemas/reports.schema.ts` — new, all Zod schemas
- `packages/shared/src/schemas/index.ts` — add one export line
- `apps/api/src/modules/reports/reports.types.ts` — replace stub
- `apps/api/src/modules/reports/reports.repository.ts` — replace stub
- `apps/api/src/modules/reports/reports.columns.ts` — new, CSV/PDF column defs + row-fetch dispatch (shared by service + queue)
- `apps/api/src/lib/reports/csv.ts` — new
- `apps/api/src/lib/reports/pdf.ts` — new
- `apps/api/src/modules/reports/reports.service.ts` — replace stub
- `apps/api/src/modules/reports/reports.router.ts` — replace stub
- `apps/api/src/queues/report.queue.ts` — replace stub worker
- `apps/api/package.json` — add `@react-pdf/renderer`, `react`
- Tests: `reports.repository.test.ts`, `reports.columns.test.ts`, `reports.service.test.ts`, `reports.router.test.ts`, `apps/api/src/queues/report.queue.test.ts`

**New/modified frontend files:**
- `apps/web/hooks/queries/use-reports.ts` — new
- `apps/web/hooks/queries/use-reports.test.ts` — new
- `apps/web/components/reports/report-filter-bar.tsx` — new
- `apps/web/components/reports/report-last-updated.tsx` — new
- `apps/web/app/(admin)/admin/reports/page.tsx` — replace placeholder
- `apps/web/app/(admin)/admin/reports/page.test.tsx` — new
- `apps/web/app/(supervisor)/supervisor/reports/page.tsx` — extend (do not rebuild)
- `apps/web/app/(supervisor)/supervisor/reports/page.test.tsx` — extend (do not remove existing tests)

---

### Task 1: Prisma migration — `report_snapshots` table + `ReportType` enum

**Files:**
- Create: `apps/api/prisma/migrations/20260716000000_phase16_report_snapshots/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: `ReportType` Prisma enum (13 values), `ReportSnapshot` Prisma model with fields `id, reportType, branchId, computedAt, payload (Json), parameters (Json)`.

- [ ] **Step 1: Write the migration SQL**

```sql
-- apps/api/prisma/migrations/20260716000000_phase16_report_snapshots/migration.sql
CREATE TYPE "ReportType" AS ENUM (
  'DAILY_SALES',
  'SHIFT_SUMMARY',
  'CASH_RECONCILIATION',
  'VOID_REFUND',
  'DISCOUNT_COMPLIANCE',
  'INVENTORY_MOVEMENT',
  'ATTENDANCE_SUMMARY',
  'FRAUD_ALERT_SUMMARY',
  'PRODUCT_PERFORMANCE',
  'FLAVOR_PERFORMANCE',
  'EMPLOYEE_PERFORMANCE',
  'INVENTORY_VALUATION',
  'BRANCH_COMPARISON'
);

CREATE TABLE report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type "ReportType" NOT NULL,
  branch_id TEXT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_report_snapshots_type_branch_computed
  ON report_snapshots (report_type, branch_id, computed_at DESC);

CREATE INDEX idx_report_snapshots_computed_at
  ON report_snapshots (computed_at);
```

- [ ] **Step 2: Add the enum and model to `schema.prisma`** (append near the other enums/models — do not touch any existing model or enum)

```prisma
enum ReportType {
  DAILY_SALES
  SHIFT_SUMMARY
  CASH_RECONCILIATION
  VOID_REFUND
  DISCOUNT_COMPLIANCE
  INVENTORY_MOVEMENT
  ATTENDANCE_SUMMARY
  FRAUD_ALERT_SUMMARY
  PRODUCT_PERFORMANCE
  FLAVOR_PERFORMANCE
  EMPLOYEE_PERFORMANCE
  INVENTORY_VALUATION
  BRANCH_COMPARISON
}

model ReportSnapshot {
  id         String     @id @default(uuid())
  reportType ReportType @map("report_type")
  branchId   String?    @map("branch_id")
  computedAt DateTime   @default(now()) @map("computed_at")
  payload    Json
  parameters Json       @default("{}")

  @@index([reportType, branchId, computedAt(sort: Desc)])
  @@index([computedAt])
  @@map("report_snapshots")
}
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `pnpm --filter @potato-corner/api exec prisma migrate dev --name phase16_report_snapshots`
Expected: migration applies cleanly, `report_snapshots` table exists.

Run: `pnpm --filter @potato-corner/api exec prisma generate`
Expected: 0 errors, `PrismaClient` now has `prisma.reportSnapshot` and the `ReportType` enum is exported from `@prisma/client`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/migrations/20260716000000_phase16_report_snapshots apps/api/prisma/schema.prisma
git commit -m "feat(db): add report_snapshots table and ReportType enum for Phase 16"
```

---

### Task 2: Shared constants — `REPORT_TYPE` and Socket.io export events

**Files:**
- Modify: `packages/shared/src/constants/status.ts`
- Modify: `packages/shared/src/constants/events.ts`

**Interfaces:**
- Produces: `REPORT_TYPE` const object + `ReportType` TS type (string values matching the Prisma enum exactly); `SOCKET_EVENTS.REPORT_EXPORT_READY = 'report:export_ready'`, `SOCKET_EVENTS.REPORT_EXPORT_FAILED = 'report:export_failed'`.

- [ ] **Step 1: Append to `packages/shared/src/constants/status.ts`** (after `FRAUD_ALERT_STATUS`, end of file)

```ts
export const REPORT_TYPE = {
  DAILY_SALES: 'DAILY_SALES',
  SHIFT_SUMMARY: 'SHIFT_SUMMARY',
  CASH_RECONCILIATION: 'CASH_RECONCILIATION',
  VOID_REFUND: 'VOID_REFUND',
  DISCOUNT_COMPLIANCE: 'DISCOUNT_COMPLIANCE',
  INVENTORY_MOVEMENT: 'INVENTORY_MOVEMENT',
  ATTENDANCE_SUMMARY: 'ATTENDANCE_SUMMARY',
  FRAUD_ALERT_SUMMARY: 'FRAUD_ALERT_SUMMARY',
  PRODUCT_PERFORMANCE: 'PRODUCT_PERFORMANCE',
  FLAVOR_PERFORMANCE: 'FLAVOR_PERFORMANCE',
  EMPLOYEE_PERFORMANCE: 'EMPLOYEE_PERFORMANCE',
  INVENTORY_VALUATION: 'INVENTORY_VALUATION',
  BRANCH_COMPARISON: 'BRANCH_COMPARISON',
} as const;
export type ReportType = (typeof REPORT_TYPE)[keyof typeof REPORT_TYPE];
```

- [ ] **Step 2: Add to `packages/shared/src/constants/events.ts`** inside the existing `SOCKET_EVENTS` object (append two keys, do not remove any existing key)

```ts
  REPORT_EXPORT_READY: 'report:export_ready',
  REPORT_EXPORT_FAILED: 'report:export_failed',
```

- [ ] **Step 3: Build the shared package and verify**

Run: `pnpm --filter @potato-corner/shared build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants/status.ts packages/shared/src/constants/events.ts
git commit -m "feat(shared): add REPORT_TYPE constant and report export socket events"
```

---

### Task 3: Shared Zod schemas — `packages/shared/src/schemas/reports.schema.ts`

**Files:**
- Create: `packages/shared/src/schemas/reports.schema.ts`
- Modify: `packages/shared/src/schemas/index.ts`

**Interfaces:**
- Consumes: `REPORT_TYPE` from `../constants/status.js` (Task 2).
- Produces: `ReportFiltersSchema`, `ExportRequestSchema`, `ExportJobResponseSchema`, `ExportReadyPayloadSchema`, one `*ReportRowSchema` per report type (13), plain TS generics `ReportResponse<T>`/`SnapshotResponse<T>`, `ExportFailedPayload` — all consumed by `apps/api/src/modules/reports/reports.types.ts` (Task 4) and `apps/web/hooks/queries/use-reports.ts` (Task 15).

- [ ] **Step 1: Write `reports.schema.ts`**

```ts
// packages/shared/src/schemas/reports.schema.ts
import { z } from 'zod';
import { REPORT_TYPE, type ReportType } from '../constants/status.js';

const reportTypeValues = Object.values(REPORT_TYPE) as [ReportType, ...ReportType[]];

export const ReportFiltersSchema = z.object({
  branch_id: z.uuid().optional(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ReportFiltersInput = z.infer<typeof ReportFiltersSchema>;

export const ExportRequestSchema = z.object({
  report_type: z.enum(reportTypeValues),
  filters: ReportFiltersSchema,
  format: z.enum(['csv', 'pdf']),
});
export type ExportRequestInput = z.infer<typeof ExportRequestSchema>;

export const ExportJobResponseSchema = z.object({
  job_id: z.string(),
  message: z.string(),
  estimated_seconds: z.number().int(),
});
export type ExportJobResponse = z.infer<typeof ExportJobResponseSchema>;

export const ExportReadyPayloadSchema = z.object({
  job_id: z.string(),
  report_type: z.enum(reportTypeValues),
  format: z.enum(['csv', 'pdf']),
  download_url: z.string(),
  expires_at: z.iso.datetime(),
  requester_id: z.uuid(),
});
export type ExportReadyPayload = z.infer<typeof ExportReadyPayloadSchema>;

export interface ExportFailedPayload {
  job_id: string;
  report_type: ReportType;
  error: string;
  requester_id: string;
}

// ---------- Row schemas (one per report type) ----------

export const DailySalesReportRowSchema = z.object({
  report_date: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  gross_sales: z.number(),
  discount_total: z.number(),
  vat_total: z.number(),
  net_sales: z.number(),
  completed_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
});
export type DailySalesReportRow = z.infer<typeof DailySalesReportRowSchema>;

export const ShiftSummaryReportRowSchema = z.object({
  shift_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_id: z.uuid(),
  cashier_name: z.string(),
  status: z.string(),
  started_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  opening_cash_amount: z.number(),
  closing_cash_amount: z.number().nullable(),
  expected_closing_cash: z.number().nullable(),
  cash_variance: z.number().nullable(),
  variance_approved: z.boolean().nullable(),
  cash_sales_total: z.number(),
  gcash_sales_total: z.number(),
  total_transaction_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
  total_discount_amount: z.number(),
  pwd_sc_transaction_count: z.number().int(),
});
export type ShiftSummaryReportRow = z.infer<typeof ShiftSummaryReportRowSchema>;

export const CashReconciliationReportRowSchema = z.object({
  shift_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_name: z.string(),
  status: z.string(),
  opening_counted_total: z.number(),
  closing_counted_total: z.number().nullable(),
  expected_closing_cash: z.number().nullable(),
  cash_variance: z.number().nullable(),
  variance_approved: z.boolean().nullable(),
  variance_explanation: z.string().nullable(),
});
export type CashReconciliationReportRow = z.infer<typeof CashReconciliationReportRowSchema>;

export const VoidRefundReportRowSchema = z.object({
  transaction_id: z.uuid(),
  transaction_number: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_name: z.string(),
  status: z.enum(['voided', 'refunded']),
  total_amount: z.number(),
  reason: z.string().nullable(),
  actioned_by_name: z.string().nullable(),
  actioned_at: z.iso.datetime().nullable(),
});
export type VoidRefundReportRow = z.infer<typeof VoidRefundReportRowSchema>;

export const DiscountComplianceReportRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  discount_type: z.string(),
  transaction_count: z.number().int(),
  total_discount_amount: z.number(),
  total_vat_exempt_amount: z.number(),
});
export type DiscountComplianceReportRow = z.infer<typeof DiscountComplianceReportRowSchema>;

export const InventoryMovementReportRowSchema = z.object({
  movement_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  unit: z.string(),
  movement_type: z.string(),
  quantity_change: z.number(),
  quantity_before: z.number(),
  quantity_after: z.number(),
  recorded_by_name: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type InventoryMovementReportRow = z.infer<typeof InventoryMovementReportRowSchema>;

export const AttendanceSummaryReportRowSchema = z.object({
  employee_id: z.uuid(),
  employee_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  clock_in: z.iso.datetime(),
  clock_out: z.iso.datetime().nullable(),
  actual_work_minutes: z.number().int().nullable(),
  overtime_minutes: z.number().int(),
  break_minutes: z.number().int(),
  status: z.string(),
});
export type AttendanceSummaryReportRow = z.infer<typeof AttendanceSummaryReportRowSchema>;

export const FraudAlertSummaryReportRowSchema = z.object({
  alert_id: z.uuid(),
  alert_type: z.string(),
  severity: z.string(),
  employee_id: z.uuid().nullable(),
  branch_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  status: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type FraudAlertSummaryReportRow = z.infer<typeof FraudAlertSummaryReportRowSchema>;

export const ProductPerformanceReportRowSchema = z.object({
  product_variant_id: z.uuid(),
  product_name: z.string(),
  variant_name: z.string(),
  units_sold: z.number().int(),
  gross_revenue: z.number(),
  transaction_count: z.number().int(),
});
export type ProductPerformanceReportRow = z.infer<typeof ProductPerformanceReportRowSchema>;

export const FlavorPerformanceReportRowSchema = z.object({
  flavor_id: z.uuid(),
  flavor_name: z.string(),
  units_sold: z.number().int(),
  gross_revenue: z.number(),
});
export type FlavorPerformanceReportRow = z.infer<typeof FlavorPerformanceReportRowSchema>;

export const EmployeePerformanceReportRowSchema = z.object({
  employee_id: z.uuid(),
  employee_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  transaction_count: z.number().int(),
  gross_sales: z.number(),
  hours_worked: z.number(),
});
export type EmployeePerformanceReportRow = z.infer<typeof EmployeePerformanceReportRowSchema>;

export const InventoryValuationReportRowSchema = z.object({
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  branch_id: z.uuid(),
  unit: z.string(),
  current_stock: z.number(),
  unit_cost: z.number().nullable(),
  total_value: z.number(),
  status: z.enum(['ok', 'low', 'critical']),
});
export type InventoryValuationReportRow = z.infer<typeof InventoryValuationReportRowSchema>;

export const BranchComparisonReportRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  gross_sales: z.number(),
  transaction_count: z.number().int(),
  active_shift_count: z.number().int(),
  low_stock_ingredient_count: z.number().int(),
});
export type BranchComparisonReportRow = z.infer<typeof BranchComparisonReportRowSchema>;

// ---------- Generic response wrappers (plain TS — not request-validated) ----------

export interface ReportResponse<T> {
  report_type: ReportType;
  generated_at: string;
  filters: { branch_id?: string; date_from?: string; date_to?: string; page: number; limit: number };
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface SnapshotResponse<T> {
  report_type: ReportType;
  computed_at: string;
  branch_id: string | null;
  data: T[];
}
```

- [ ] **Step 2: Register the new schema module**

Add to `packages/shared/src/schemas/index.ts` (after the `fraud.schema.js` line):

```ts
export * from './reports.schema.js';
```

- [ ] **Step 3: Build and typecheck**

Run: `pnpm --filter @potato-corner/shared build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas/reports.schema.ts packages/shared/src/schemas/index.ts
git commit -m "feat(shared): add Zod schemas for the 13 Phase 16 report types"
```

---

### Task 4: `apps/api/src/modules/reports/reports.types.ts` (replace stub)

**Files:**
- Modify: `apps/api/src/modules/reports/reports.types.ts`

**Interfaces:**
- Consumes: types from `@potato-corner/shared` (Task 3).
- Produces: `ReportError`, `ReportFilters`, `ExportRequest`, `ReportColumn<T>` — consumed by every subsequent backend task.

- [ ] **Step 1: Replace the stub**

```ts
// apps/api/src/modules/reports/reports.types.ts
export type {
  ReportType,
  ExportRequestInput,
  ExportJobResponse,
  ExportReadyPayload,
  ExportFailedPayload,
  ReportResponse,
  SnapshotResponse,
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  BranchComparisonReportRow,
} from '@potato-corner/shared';

import type { ReportType } from '@potato-corner/shared';

export class ReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/** Parsed, internal filter shape — dates are real Date objects, not wire strings. */
export interface ReportFilters {
  branchId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
}

export interface ExportRequest {
  reportType: ReportType;
  filters: ReportFilters;
  format: 'csv' | 'pdf';
}

/** Column definition shared by CSV and PDF generation (reports.columns.ts). */
export interface ReportColumn<T> {
  key: keyof T;
  header: string;
  /** Audit-only columns (e.g. raw ids) are appended after visible columns, headers prefixed with `_`. */
  isAudit?: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @potato-corner/api exec tsc --noEmit`
Expected: this file compiles (downstream files not yet updated will still error — that's expected until Task 5+).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reports/reports.types.ts
git commit -m "feat(api): define reports module types and ReportError"
```

---

### Task 5: `reports.repository.ts` — real-time tier (8 methods)

**Files:**
- Modify: `apps/api/src/modules/reports/reports.repository.ts`
- Create: `apps/api/src/modules/reports/reports.repository.test.ts`

**Interfaces:**
- Consumes: `ReportFilters` (Task 4), `prisma` singleton.
- Produces: `reportsRepository.getDailySales/getShiftSummary/getCashReconciliation/getVoidRefund/getDiscountCompliance/getInventoryMovement/getAttendanceSummary/getFraudAlertSummary(filters: ReportFilters): Promise<Row[]>` — consumed by `reports.columns.ts` (Task 8) and `reports.service.ts` (Task 10).

- [ ] **Step 1: Write the failing tests** (repository test file — mocks `prisma` directly, per `inventory.repository.test.ts`'s established pattern since no other repository test existed before it)

```ts
// apps/api/src/modules/reports/reports.repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    transaction: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    branch: { findMany: vi.fn(), findUnique: vi.fn() },
    shift: { findMany: vi.fn(), count: vi.fn() },
    inventoryMovement: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), count: vi.fn() },
    fraudAlert: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
    productVariant: { findMany: vi.fn() },
    flavor: { findMany: vi.fn() },
    ingredient: { findMany: vi.fn() },
    reportSnapshot: { create: vi.fn(), findFirst: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { reportsRepository } = await import('./reports.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const baseFilters = { page: 1, limit: 25 } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportsRepository.getDailySales', () => {
  it('buckets completed/voided/refunded transactions by report_date and branch', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', totalAmount: decimal(112), discountAmount: decimal(0), vatAmount: decimal(12), createdAt: new Date('2026-07-01T10:00:00.000Z') },
      { branchId: 'b1', status: 'voided', totalAmount: decimal(50), discountAmount: decimal(0), vatAmount: decimal(5), createdAt: new Date('2026-07-01T11:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([
      {
        report_date: '2026-07-01',
        branch_id: 'b1',
        branch_name: 'SM North',
        gross_sales: 112,
        discount_total: 0,
        vat_total: 12,
        net_sales: 100,
        completed_count: 1,
        voided_count: 1,
        refunded_count: 0,
      },
    ]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }),
    );
  });
});

describe('reportsRepository.getShiftSummary', () => {
  it('maps pre-computed Shift fields directly, without recomputing totals', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      {
        id: 'shift-1', branchId: 'b1', cashierId: 'u1', status: 'closed',
        startedAt: new Date('2026-07-01T08:00:00.000Z'), closedAt: new Date('2026-07-01T16:00:00.000Z'),
        openingCashAmount: decimal(1000), closingCashAmount: decimal(1500), expectedClosingCash: decimal(1500),
        cashVariance: decimal(0), varianceApproved: null, cashSalesTotal: decimal(400), gcashSalesTotal: decimal(100),
        totalTransactionCount: 10, voidedCount: 1, refundedCount: 0, totalDiscountAmount: decimal(20), pwdScTransactionCount: 2,
        branch: { name: 'SM North' }, cashier: { firstName: 'Juan', lastName: 'Cruz' },
      },
    ] as never);

    const [row] = await reportsRepository.getShiftSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(row).toMatchObject({ shift_id: 'shift-1', cashier_name: 'Juan Cruz', branch_name: 'SM North', total_transaction_count: 10 });
  });
});

describe('reportsRepository.getVoidRefund', () => {
  it('filters to voided/refunded statuses only', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    await reportsRepository.getVoidRefund(baseFilters);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['voided', 'refunded'] } }) }),
    );
  });
});

describe('reportsRepository.getDiscountCompliance', () => {
  it('groups by branch and discount type, excluding null discount_type', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'b1', discountType: 'pwd', _count: { _all: 3 }, _sum: { discountAmount: decimal(60), vatExemptAmount: decimal(30) } },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getDiscountCompliance(baseFilters);

    expect(rows).toEqual([{ branch_id: 'b1', branch_name: 'SM North', discount_type: 'pwd', transaction_count: 3, total_discount_amount: 60, total_vat_exempt_amount: 30 }]);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ discountType: { not: null } }) }),
    );
  });
});

describe('reportsRepository.getFraudAlertSummary', () => {
  it('returns [] gracefully when no alerts exist', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);

    const rows = await reportsRepository.getFraudAlertSummary(baseFilters);

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.repository.test.ts`
Expected: FAIL — `reportsRepository.getDailySales is not a function` (stub has no methods yet).

- [ ] **Step 3: Implement the real-time tier in `reports.repository.ts`**

```ts
// apps/api/src/modules/reports/reports.repository.ts
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type {
  ReportFilters,
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
} from './reports.types.js';

function dateRangeFilter(filters: ReportFilters): { gte?: Date; lte?: Date } | undefined {
  if (!filters.dateFrom && !filters.dateTo) return undefined;
  return {
    ...(filters.dateFrom && { gte: filters.dateFrom }),
    ...(filters.dateTo && { lte: filters.dateTo }),
  };
}

export const reportsRepository = {
  async getDailySales(filters: ReportFilters): Promise<DailySalesReportRow[]> {
    const createdAt = dateRangeFilter(filters);
    const where: Prisma.TransactionWhereInput = {
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(createdAt && { createdAt }),
    };
    const [rows, branches] = await Promise.all([
      prisma.transaction.findMany({
        where,
        select: { branchId: true, status: true, totalAmount: true, discountAmount: true, vatAmount: true, createdAt: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

    const buckets = new Map<string, DailySalesReportRow>();
    for (const row of rows) {
      const reportDate = row.createdAt.toISOString().slice(0, 10);
      const key = `${reportDate}_${row.branchId}`;
      const existing = buckets.get(key) ?? {
        report_date: reportDate,
        branch_id: row.branchId,
        branch_name: branchNameById.get(row.branchId) ?? 'Unknown Branch',
        gross_sales: 0,
        discount_total: 0,
        vat_total: 0,
        net_sales: 0,
        completed_count: 0,
        voided_count: 0,
        refunded_count: 0,
      };
      if (row.status === 'completed') {
        existing.gross_sales += row.totalAmount.toNumber();
        existing.discount_total += row.discountAmount.toNumber();
        existing.vat_total += row.vatAmount.toNumber();
        existing.net_sales += row.totalAmount.toNumber() - row.vatAmount.toNumber();
        existing.completed_count += 1;
      } else if (row.status === 'voided') {
        existing.voided_count += 1;
      } else if (row.status === 'refunded') {
        existing.refunded_count += 1;
      }
      buckets.set(key, existing);
    }
    return [...buckets.values()].sort(
      (a, b) => a.report_date.localeCompare(b.report_date) || a.branch_name.localeCompare(b.branch_name),
    );
  },

  async getShiftSummary(filters: ReportFilters): Promise<ShiftSummaryReportRow[]> {
    const startedAt = dateRangeFilter(filters);
    const shifts = await prisma.shift.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(startedAt && { startedAt }) },
      include: { branch: { select: { name: true } }, cashier: { select: { firstName: true, lastName: true } } },
      orderBy: { startedAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return shifts.map((shift) => ({
      shift_id: shift.id,
      branch_id: shift.branchId,
      branch_name: shift.branch.name,
      cashier_id: shift.cashierId,
      cashier_name: `${shift.cashier.firstName} ${shift.cashier.lastName}`,
      status: shift.status,
      started_at: shift.startedAt.toISOString(),
      closed_at: shift.closedAt ? shift.closedAt.toISOString() : null,
      opening_cash_amount: shift.openingCashAmount.toNumber(),
      closing_cash_amount: shift.closingCashAmount ? shift.closingCashAmount.toNumber() : null,
      expected_closing_cash: shift.expectedClosingCash ? shift.expectedClosingCash.toNumber() : null,
      cash_variance: shift.cashVariance ? shift.cashVariance.toNumber() : null,
      variance_approved: shift.varianceApproved,
      cash_sales_total: shift.cashSalesTotal.toNumber(),
      gcash_sales_total: shift.gcashSalesTotal.toNumber(),
      total_transaction_count: shift.totalTransactionCount,
      voided_count: shift.voidedCount,
      refunded_count: shift.refundedCount,
      total_discount_amount: shift.totalDiscountAmount.toNumber(),
      pwd_sc_transaction_count: shift.pwdScTransactionCount,
    }));
  },

  async getCashReconciliation(filters: ReportFilters): Promise<CashReconciliationReportRow[]> {
    const startedAt = dateRangeFilter(filters);
    const shifts = await prisma.shift.findMany({
      where: { status: { in: ['closed', 'flagged'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(startedAt && { startedAt }) },
      include: { branch: { select: { name: true } }, cashier: { select: { firstName: true, lastName: true } }, denominations: true },
      orderBy: { startedAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return shifts.map((shift) => {
      const openingCountedTotal = shift.denominations
        .filter((d) => d.countType === 'opening')
        .reduce((sum, d) => sum + d.totalValue.toNumber(), 0);
      const closingCountedTotal = shift.denominations
        .filter((d) => d.countType === 'closing')
        .reduce((sum, d) => sum + d.totalValue.toNumber(), 0);
      return {
        shift_id: shift.id,
        branch_id: shift.branchId,
        branch_name: shift.branch.name,
        cashier_name: `${shift.cashier.firstName} ${shift.cashier.lastName}`,
        status: shift.status,
        opening_counted_total: openingCountedTotal,
        closing_counted_total: shift.denominations.some((d) => d.countType === 'closing') ? closingCountedTotal : null,
        expected_closing_cash: shift.expectedClosingCash ? shift.expectedClosingCash.toNumber() : null,
        cash_variance: shift.cashVariance ? shift.cashVariance.toNumber() : null,
        variance_approved: shift.varianceApproved,
        variance_explanation: shift.varianceExplanation,
      };
    });
  },

  async getVoidRefund(filters: ReportFilters): Promise<VoidRefundReportRow[]> {
    const range = dateRangeFilter(filters);
    const transactions = await prisma.transaction.findMany({
      where: { status: { in: ['voided', 'refunded'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: {
        branch: { select: { name: true } },
        cashier: { select: { firstName: true, lastName: true } },
        voidedBy: { select: { firstName: true, lastName: true } },
        refundedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return transactions.map((tx) => {
      const isVoided = tx.status === 'voided';
      const actionedBy = isVoided ? tx.voidedBy : tx.refundedBy;
      return {
        transaction_id: tx.id,
        transaction_number: tx.transactionNumber,
        branch_id: tx.branchId,
        branch_name: tx.branch.name,
        cashier_name: `${tx.cashier.firstName} ${tx.cashier.lastName}`,
        status: tx.status as 'voided' | 'refunded',
        total_amount: tx.totalAmount.toNumber(),
        reason: isVoided ? tx.voidReason : tx.refundReason,
        actioned_by_name: actionedBy ? `${actionedBy.firstName} ${actionedBy.lastName}` : null,
        actioned_at: (isVoided ? tx.voidedAt : tx.refundedAt)?.toISOString() ?? null,
      };
    });
  },

  async getDiscountCompliance(filters: ReportFilters): Promise<DiscountComplianceReportRow[]> {
    const range = dateRangeFilter(filters);
    const [rows, branches] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['branchId', 'discountType'],
        where: { discountType: { not: null }, status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        _count: { _all: true },
        _sum: { discountAmount: true, vatExemptAmount: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    return rows
      .filter((row): row is typeof row & { discountType: string } => row.discountType !== null)
      .map((row) => ({
        branch_id: row.branchId,
        branch_name: branchNameById.get(row.branchId) ?? 'Unknown Branch',
        discount_type: row.discountType,
        transaction_count: row._count._all,
        total_discount_amount: row._sum.discountAmount?.toNumber() ?? 0,
        total_vat_exempt_amount: row._sum.vatExemptAmount?.toNumber() ?? 0,
      }));
  },

  async getInventoryMovement(filters: ReportFilters): Promise<InventoryMovementReportRow[]> {
    const range = dateRangeFilter(filters);
    const movements = await prisma.inventoryMovement.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: { branch: { select: { name: true } }, ingredient: { select: { name: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    const recorderIds = [...new Set(movements.map((m) => m.recordedBy).filter((id): id is string => id !== null))];
    const recorders = recorderIds.length
      ? await prisma.user.findMany({ where: { id: { in: recorderIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const recorderNameById = new Map(recorders.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    return movements.map((m) => ({
      movement_id: m.id,
      branch_id: m.branchId,
      branch_name: m.branch.name,
      ingredient_id: m.ingredientId,
      ingredient_name: m.ingredient.name,
      unit: m.ingredient.unit,
      movement_type: m.movementType,
      quantity_change: m.quantityChange.toNumber(),
      quantity_before: m.quantityBefore.toNumber(),
      quantity_after: m.quantityAfter.toNumber(),
      recorded_by_name: m.recordedBy ? (recorderNameById.get(m.recordedBy) ?? null) : null,
      created_at: m.createdAt.toISOString(),
    }));
  },

  async getAttendanceSummary(filters: ReportFilters): Promise<AttendanceSummaryReportRow[]> {
    const range = dateRangeFilter(filters);
    const records = await prisma.attendanceRecord.findMany({
      where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { clockInServerTime: range }) },
      include: { employee: { select: { firstName: true, lastName: true } }, branch: { select: { name: true } } },
      orderBy: { clockInServerTime: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return records.map((r) => ({
      employee_id: r.employeeId,
      employee_name: `${r.employee.firstName} ${r.employee.lastName}`,
      branch_id: r.branchId,
      branch_name: r.branch.name,
      clock_in: r.clockInServerTime.toISOString(),
      clock_out: r.clockOutServerTime ? r.clockOutServerTime.toISOString() : null,
      actual_work_minutes: r.actualWorkMinutes,
      overtime_minutes: r.overtimeMinutes,
      break_minutes: r.breakMinutes,
      status: r.status,
    }));
  },

  async getFraudAlertSummary(filters: ReportFilters): Promise<FraudAlertSummaryReportRow[]> {
    const range = dateRangeFilter(filters);
    const alerts = await prisma.fraudAlert.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: { branch: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return alerts.map((a) => ({
      alert_id: a.id,
      alert_type: a.alertType,
      severity: a.severity,
      employee_id: a.employeeId,
      branch_id: a.branchId,
      branch_name: a.branch?.name ?? null,
      status: a.status,
      created_at: a.createdAt.toISOString(),
      updated_at: a.updatedAt.toISOString(),
    }));
  },
};
```

(The pre-computed tier's five methods and the `saveSnapshot`/`getLatestSnapshot`/`countRows` methods are appended to this same `reportsRepository` object in Task 6 — do not export a second object.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.repository.test.ts`
Expected: PASS (5 describe blocks, all green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.repository.ts apps/api/src/modules/reports/reports.repository.test.ts
git commit -m "feat(api): implement real-time tier report queries"
```

---

### Task 6: `reports.repository.ts` — pre-computed tier (5 methods) + snapshot/countRows methods

**Files:**
- Modify: `apps/api/src/modules/reports/reports.repository.ts` (append to the `reportsRepository` object from Task 5)
- Modify: `apps/api/src/modules/reports/reports.repository.test.ts` (append)

**Interfaces:**
- Consumes: `ReportFilters`, `ReportType` (Task 4).
- Produces: `getProductPerformance/getFlavorPerformance/getEmployeePerformance/getInventoryValuation/getBranchComparison(filters): Promise<Row[]>`, `saveSnapshot(reportType, branchId, data, parameters): Promise<void>`, `getLatestSnapshot(reportType, branchId): Promise<ReportSnapshot | null>`, `countRows(reportType, filters): Promise<number>` — consumed by `reports.service.ts` (Tasks 10–12) and `report.queue.ts` (Task 14).

- [ ] **Step 1: Write the failing tests** (append to `reports.repository.test.ts`, inside the existing file — add these `describe` blocks after the ones from Task 5)

```ts
describe('reportsRepository.getProductPerformance', () => {
  it('does the two-step query: completed transaction ids first, then groupBy TransactionItem', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([{ id: 'tx-1' }, { id: 'tx-2' }] as never);
    vi.mocked(prisma.transactionItem.groupBy).mockResolvedValue([
      { productVariantId: 'pv-1', _sum: { quantity: 5, lineTotal: decimal(250) }, _count: { id: 3 } },
    ] as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([
      { id: 'pv-1', name: 'Regular', product: { name: 'Cheese Potato' } },
    ] as never);

    const rows = await reportsRepository.getProductPerformance({ branchId: 'b1', page: 1, limit: 25 });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'completed', branchId: 'b1' }), select: { id: true } }),
    );
    expect(prisma.transactionItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ transactionId: { in: ['tx-1', 'tx-2'] } }) }),
    );
    expect(rows).toEqual([{ product_variant_id: 'pv-1', product_name: 'Cheese Potato', variant_name: 'Regular', units_sold: 5, gross_revenue: 250, transaction_count: 3 }]);
  });

  it('short-circuits to [] without calling groupBy when there are no completed transactions', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    const rows = await reportsRepository.getProductPerformance({ page: 1, limit: 25 });

    expect(rows).toEqual([]);
    expect(prisma.transactionItem.groupBy).not.toHaveBeenCalled();
  });
});

describe('reportsRepository.getFlavorPerformance', () => {
  it('does the same two-step query pattern, grouping by flavorId', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([{ id: 'tx-1' }] as never);
    vi.mocked(prisma.transactionItem.groupBy).mockResolvedValue([
      { flavorId: 'fl-1', _sum: { quantity: 2, lineTotal: decimal(100) } },
    ] as never);
    vi.mocked(prisma.flavor.findMany).mockResolvedValue([{ id: 'fl-1', name: 'Sour Cream' }] as never);

    const rows = await reportsRepository.getFlavorPerformance({ page: 1, limit: 25 });

    expect(prisma.transactionItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['flavorId'], where: expect.objectContaining({ flavorId: { not: null } }) }),
    );
    expect(rows).toEqual([{ flavor_id: 'fl-1', flavor_name: 'Sour Cream', units_sold: 2, gross_revenue: 100 }]);
  });
});

describe('reportsRepository.getInventoryValuation', () => {
  it('derives current_stock from summed InventoryMovement.quantityChange, not Ingredient.currentStock', async () => {
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue([
      { id: 'ing-1', name: 'Potato', branchId: 'b1', unit: 'kg', unitCost: decimal(50), lowStockThreshold: decimal(10), criticalThreshold: decimal(5) },
    ] as never);
    vi.mocked(prisma.inventoryMovement.groupBy).mockResolvedValue([{ ingredientId: 'ing-1', _sum: { quantityChange: decimal(20) } }] as never);

    const rows = await reportsRepository.getInventoryValuation({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([{ ingredient_id: 'ing-1', ingredient_name: 'Potato', branch_id: 'b1', unit: 'kg', current_stock: 20, unit_cost: 50, total_value: 1000, status: 'ok' }]);
  });
});

describe('reportsRepository.saveSnapshot', () => {
  it('writes a new ReportSnapshot row with the given payload and parameters', async () => {
    vi.mocked(prisma.reportSnapshot.create).mockResolvedValue({} as never);

    await reportsRepository.saveSnapshot('PRODUCT_PERFORMANCE', 'b1', [{ foo: 'bar' }], { branchId: 'b1' });

    expect(prisma.reportSnapshot.create).toHaveBeenCalledWith({
      data: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', payload: [{ foo: 'bar' }], parameters: { branchId: 'b1' } },
    });
  });
});

describe('reportsRepository.getLatestSnapshot', () => {
  it('returns null when no snapshots exist', async () => {
    vi.mocked(prisma.reportSnapshot.findFirst).mockResolvedValue(null);

    const result = await reportsRepository.getLatestSnapshot('PRODUCT_PERFORMANCE', 'b1');

    expect(result).toBeNull();
  });

  it('orders by computedAt desc to return the most recent snapshot', async () => {
    vi.mocked(prisma.reportSnapshot.findFirst).mockResolvedValue({ id: 'snap-2' } as never);

    await reportsRepository.getLatestSnapshot('PRODUCT_PERFORMANCE', 'b1');

    expect(prisma.reportSnapshot.findFirst).toHaveBeenCalledWith({
      where: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1' },
      orderBy: { computedAt: 'desc' },
    });
  });
});

describe('reportsRepository.countRows', () => {
  it('dispatches VOID_REFUND to a direct transaction.count with the matching where clause', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(7);

    const count = await reportsRepository.countRows('VOID_REFUND', { branchId: 'b1', page: 1, limit: 25 });

    expect(count).toBe(7);
    expect(prisma.transaction.count).toHaveBeenCalledWith({ where: expect.objectContaining({ status: { in: ['voided', 'refunded'] }, branchId: 'b1' }) });
  });

  it('dispatches INVENTORY_MOVEMENT to inventoryMovement.count', async () => {
    vi.mocked(prisma.inventoryMovement.count).mockResolvedValue(3);

    const count = await reportsRepository.countRows('INVENTORY_MOVEMENT', { page: 1, limit: 25 });

    expect(count).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.repository.test.ts`
Expected: FAIL — `getProductPerformance is not a function`, etc.

- [ ] **Step 3: Append the pre-computed tier + snapshot methods to `reportsRepository`** (add these as additional keys in the same object literal from Task 5 — insert a comma after `getFraudAlertSummary`'s closing `},` and before the final `};`)

```ts
  async getProductPerformance(filters: ReportFilters): Promise<ProductPerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const completedTransactionIds = await prisma.transaction
      .findMany({
        where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));
    if (completedTransactionIds.length === 0) return [];

    const grouped = await prisma.transactionItem.groupBy({
      by: ['productVariantId'],
      where: { transactionId: { in: completedTransactionIds } },
      _sum: { quantity: true, lineTotal: true },
      _count: { id: true },
    });
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: grouped.map((g) => g.productVariantId) } },
      include: { product: { select: { name: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    return grouped
      .map((g) => {
        const variant = variantById.get(g.productVariantId);
        return {
          product_variant_id: g.productVariantId,
          product_name: variant?.product.name ?? 'Unknown Product',
          variant_name: variant?.name ?? 'Unknown Variant',
          units_sold: g._sum.quantity ?? 0,
          gross_revenue: g._sum.lineTotal?.toNumber() ?? 0,
          transaction_count: g._count.id,
        };
      })
      .sort((a, b) => b.gross_revenue - a.gross_revenue);
  },

  async getFlavorPerformance(filters: ReportFilters): Promise<FlavorPerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const completedTransactionIds = await prisma.transaction
      .findMany({
        where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));
    if (completedTransactionIds.length === 0) return [];

    const grouped = await prisma.transactionItem.groupBy({
      by: ['flavorId'],
      where: { transactionId: { in: completedTransactionIds }, flavorId: { not: null } },
      _sum: { quantity: true, lineTotal: true },
    });
    const flavorIds = grouped.map((g) => g.flavorId).filter((id): id is string => id !== null);
    const flavors = await prisma.flavor.findMany({ where: { id: { in: flavorIds } }, select: { id: true, name: true } });
    const flavorNameById = new Map(flavors.map((f) => [f.id, f.name]));

    return grouped
      .filter((g): g is typeof g & { flavorId: string } => g.flavorId !== null)
      .map((g) => ({
        flavor_id: g.flavorId,
        flavor_name: flavorNameById.get(g.flavorId) ?? 'Unknown Flavor',
        units_sold: g._sum.quantity ?? 0,
        gross_revenue: g._sum.lineTotal?.toNumber() ?? 0,
      }))
      .sort((a, b) => b.gross_revenue - a.gross_revenue);
  },

  async getEmployeePerformance(filters: ReportFilters): Promise<EmployeePerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const salesGrouped = await prisma.transaction.groupBy({
      by: ['cashierId', 'branchId'],
      where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    if (salesGrouped.length === 0) return [];

    const employeeIds = [...new Set(salesGrouped.map((g) => g.cashierId))];
    const [employees, attendanceRecords, branches] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
      prisma.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, deletedAt: null, ...(range && { clockInServerTime: range }) },
        select: { employeeId: true, actualWorkMinutes: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const employeeById = new Map(employees.map((e) => [e.id, e]));
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const minutesByEmployee = new Map<string, number>();
    for (const record of attendanceRecords) {
      minutesByEmployee.set(record.employeeId, (minutesByEmployee.get(record.employeeId) ?? 0) + (record.actualWorkMinutes ?? 0));
    }

    return salesGrouped
      .map((g) => {
        const employee = employeeById.get(g.cashierId);
        return {
          employee_id: g.cashierId,
          employee_name: employee ? `${employee.firstName} ${employee.lastName}` : 'Unknown Employee',
          branch_id: g.branchId,
          branch_name: branchNameById.get(g.branchId) ?? 'Unknown Branch',
          transaction_count: g._count._all,
          gross_sales: g._sum.totalAmount?.toNumber() ?? 0,
          hours_worked: Math.round(((minutesByEmployee.get(g.cashierId) ?? 0) / 60) * 100) / 100,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  async getInventoryValuation(filters: ReportFilters): Promise<InventoryValuationReportRow[]> {
    const ingredients = await prisma.ingredient.findMany({
      where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }) },
      select: { id: true, name: true, branchId: true, unit: true, unitCost: true, lowStockThreshold: true, criticalThreshold: true },
    });
    if (ingredients.length === 0) return [];

    const movementSums = await prisma.inventoryMovement.groupBy({
      by: ['ingredientId'],
      where: { ingredientId: { in: ingredients.map((i) => i.id) } },
      _sum: { quantityChange: true },
    });
    const stockById = new Map(movementSums.map((m) => [m.ingredientId, m._sum.quantityChange?.toNumber() ?? 0]));

    return ingredients
      .map((ingredient) => {
        const currentStock = stockById.get(ingredient.id) ?? 0;
        const unitCost = ingredient.unitCost?.toNumber() ?? null;
        const status =
          currentStock <= ingredient.criticalThreshold.toNumber() ? 'critical' : currentStock <= ingredient.lowStockThreshold.toNumber() ? 'low' : 'ok';
        return {
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          branch_id: ingredient.branchId,
          unit: ingredient.unit,
          current_stock: currentStock,
          unit_cost: unitCost,
          total_value: unitCost !== null ? Math.round(currentStock * unitCost * 100) / 100 : 0,
          status: status as 'ok' | 'low' | 'critical',
        };
      })
      .sort((a, b) => b.total_value - a.total_value);
  },

  async getBranchComparison(filters: ReportFilters): Promise<BranchComparisonReportRow[]> {
    const range = dateRangeFilter(filters);
    const [salesGrouped, activeShifts, ingredients, branches] = await Promise.all([
      prisma.transaction.groupBy({ by: ['branchId'], where: { status: 'completed', ...(range && { createdAt: range }) }, _sum: { totalAmount: true }, _count: { _all: true } }),
      prisma.shift.findMany({ where: { status: 'active' }, select: { branchId: true } }),
      prisma.ingredient.findMany({ where: { deletedAt: null }, select: { id: true, branchId: true, lowStockThreshold: true } }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);

    const activeShiftCountByBranch = new Map<string, number>();
    for (const shift of activeShifts) activeShiftCountByBranch.set(shift.branchId, (activeShiftCountByBranch.get(shift.branchId) ?? 0) + 1);

    const movementSums = ingredients.length
      ? await prisma.inventoryMovement.groupBy({ by: ['ingredientId'], where: { ingredientId: { in: ingredients.map((i) => i.id) } }, _sum: { quantityChange: true } })
      : [];
    const stockById = new Map(movementSums.map((m) => [m.ingredientId, m._sum.quantityChange?.toNumber() ?? 0]));
    const lowStockCountByBranch = new Map<string, number>();
    for (const ingredient of ingredients) {
      const stock = stockById.get(ingredient.id) ?? 0;
      if (stock <= ingredient.lowStockThreshold.toNumber()) lowStockCountByBranch.set(ingredient.branchId, (lowStockCountByBranch.get(ingredient.branchId) ?? 0) + 1);
    }

    const salesByBranch = new Map(salesGrouped.map((g) => [g.branchId, g]));
    return branches
      .map((branch) => {
        const sales = salesByBranch.get(branch.id);
        return {
          branch_id: branch.id,
          branch_name: branch.name,
          gross_sales: sales?._sum.totalAmount?.toNumber() ?? 0,
          transaction_count: sales?._count._all ?? 0,
          active_shift_count: activeShiftCountByBranch.get(branch.id) ?? 0,
          low_stock_ingredient_count: lowStockCountByBranch.get(branch.id) ?? 0,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  async saveSnapshot(reportType: ReportType, branchId: string | null, data: unknown, parameters: unknown): Promise<void> {
    await prisma.reportSnapshot.create({ data: { reportType, branchId, payload: data as Prisma.InputJsonValue, parameters: parameters as Prisma.InputJsonValue } });
  },

  async getLatestSnapshot(reportType: ReportType, branchId: string | null) {
    return prisma.reportSnapshot.findFirst({ where: { reportType, branchId }, orderBy: { computedAt: 'desc' } });
  },

  async countRows(reportType: ReportType, filters: ReportFilters): Promise<number> {
    const range = dateRangeFilter(filters);
    switch (reportType) {
      case 'VOID_REFUND':
        return prisma.transaction.count({ where: { status: { in: ['voided', 'refunded'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'INVENTORY_MOVEMENT':
        return prisma.inventoryMovement.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'ATTENDANCE_SUMMARY':
        return prisma.attendanceRecord.count({ where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { clockInServerTime: range }) } });
      case 'FRAUD_ALERT_SUMMARY':
        return prisma.fraudAlert.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'SHIFT_SUMMARY':
        return prisma.shift.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { startedAt: range }) } });
      case 'CASH_RECONCILIATION':
        return prisma.shift.count({ where: { status: { in: ['closed', 'flagged'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { startedAt: range }) } });
      case 'DAILY_SALES':
        return this.getDailySales(filters).then((rows) => rows.length);
      case 'DISCOUNT_COMPLIANCE':
        return this.getDiscountCompliance(filters).then((rows) => rows.length);
      case 'PRODUCT_PERFORMANCE':
        return this.getProductPerformance(filters).then((rows) => rows.length);
      case 'FLAVOR_PERFORMANCE':
        return this.getFlavorPerformance(filters).then((rows) => rows.length);
      case 'EMPLOYEE_PERFORMANCE':
        return this.getEmployeePerformance(filters).then((rows) => rows.length);
      case 'INVENTORY_VALUATION':
        return this.getInventoryValuation(filters).then((rows) => rows.length);
      case 'BRANCH_COMPARISON':
        return this.getBranchComparison(filters).then((rows) => rows.length);
      default:
        return 0;
    }
  },
```

Also update the file's import line to pull in the remaining row types and `ReportType`:

```ts
import type {
  ReportFilters,
  ReportType,
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  BranchComparisonReportRow,
} from './reports.types.js';
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.repository.test.ts`
Expected: PASS, all `describe` blocks green (repository test file complete: 13 methods + snapshot/count covered).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.repository.ts apps/api/src/modules/reports/reports.repository.test.ts
git commit -m "feat(api): implement pre-computed tier report queries and snapshot persistence"
```

---

### Task 7: Add `@react-pdf/renderer` + `react` to `apps/api/package.json`

**Files:**
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `react` and `@react-pdf/renderer` available for import in `apps/api/src/lib/reports/pdf.ts` (Task 9).

- [ ] **Step 1: Add the two dependencies** (`apps/web/package.json` pins `"react": "19.1.0"` — match that exact version so both apps resolve the same React major/minor if pnpm hoists)

```json
    "@potato-corner/shared": "workspace:*",
    "@prisma/client": "^5.22.0",
    "@react-pdf/renderer": "^4.1.6",
    "@sentry/node": "^8.47.0",
    "@socket.io/redis-adapter": "^8.3.0",
    "@supabase/supabase-js": "^2.47.10",
    "bcrypt": "^5.1.1",
    "bullmq": "^5.34.6",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^5.0.1",
    "express-rate-limit": "^7.5.0",
    "helmet": "^8.0.0",
    "ioredis": "5.10.1",
    "jsonwebtoken": "^9.0.2",
    "morgan": "^1.10.0",
    "multer": "^2.2.0",
    "rate-limit-redis": "^4.2.0",
    "react": "19.1.0",
    "resend": "^4.0.1",
    "sharp": "^0.35.3",
    "socket.io": "^4.8.1",
    "zod": "^4.0.0"
```

(Insert `@react-pdf/renderer` and `react` alphabetically into the existing `dependencies` block — do not remove or reorder any other entry.)

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates, `@react-pdf/renderer` and `react` resolve into `apps/api`'s `node_modules`, 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore(api): add @react-pdf/renderer for report PDF export"
```

---

### Task 8: `reports.columns.ts` — CSV/PDF column definitions + row-fetch dispatch

**Files:**
- Create: `apps/api/src/modules/reports/reports.columns.ts`
- Create: `apps/api/src/modules/reports/reports.columns.test.ts`

**Interfaces:**
- Consumes: `reportsRepository` (Tasks 5–6), `ReportColumn<T>`, `ReportFilters`, `ReportType` (Task 4).
- Produces: `REPORT_COLUMNS: Record<ReportType, ReportColumn<any>[]>`, `getReportRows(reportType, filters): Promise<Record<string, unknown>[]>` — consumed by `reports.service.ts` (Task 12) and `report.queue.ts` (Task 14), so both the sync CSV export path and the async job use the exact same dispatch and column list (no duplicated 13-way switch).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/reports/reports.columns.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn().mockResolvedValue([{ report_date: '2026-07-01' }]),
    getShiftSummary: vi.fn().mockResolvedValue([]),
    getCashReconciliation: vi.fn().mockResolvedValue([]),
    getVoidRefund: vi.fn().mockResolvedValue([]),
    getDiscountCompliance: vi.fn().mockResolvedValue([]),
    getInventoryMovement: vi.fn().mockResolvedValue([]),
    getAttendanceSummary: vi.fn().mockResolvedValue([]),
    getFraudAlertSummary: vi.fn().mockResolvedValue([]),
    getProductPerformance: vi.fn().mockResolvedValue([]),
    getFlavorPerformance: vi.fn().mockResolvedValue([]),
    getEmployeePerformance: vi.fn().mockResolvedValue([]),
    getInventoryValuation: vi.fn().mockResolvedValue([]),
    getBranchComparison: vi.fn().mockResolvedValue([]),
  },
}));

const { reportsRepository } = await import('./reports.repository.js');
const { getReportRows, REPORT_COLUMNS } = await import('./reports.columns.js');

beforeEach(() => vi.clearAllMocks());

describe('getReportRows', () => {
  it('dispatches DAILY_SALES to reportsRepository.getDailySales', async () => {
    const rows = await getReportRows('DAILY_SALES', { page: 1, limit: 25 });
    expect(reportsRepository.getDailySales).toHaveBeenCalledWith({ page: 1, limit: 25 });
    expect(rows).toEqual([{ report_date: '2026-07-01' }]);
  });

  it('dispatches BRANCH_COMPARISON to reportsRepository.getBranchComparison', async () => {
    await getReportRows('BRANCH_COMPARISON', { page: 1, limit: 25 });
    expect(reportsRepository.getBranchComparison).toHaveBeenCalled();
  });
});

describe('REPORT_COLUMNS', () => {
  it('defines a non-empty column list for every one of the 13 report types', () => {
    const types = [
      'DAILY_SALES', 'SHIFT_SUMMARY', 'CASH_RECONCILIATION', 'VOID_REFUND', 'DISCOUNT_COMPLIANCE',
      'INVENTORY_MOVEMENT', 'ATTENDANCE_SUMMARY', 'FRAUD_ALERT_SUMMARY', 'PRODUCT_PERFORMANCE',
      'FLAVOR_PERFORMANCE', 'EMPLOYEE_PERFORMANCE', 'INVENTORY_VALUATION', 'BRANCH_COMPARISON',
    ] as const;
    for (const type of types) {
      expect(REPORT_COLUMNS[type].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.columns.test.ts`
Expected: FAIL — module `./reports.columns.js` does not exist.

- [ ] **Step 3: Implement `reports.columns.ts`**

```ts
// apps/api/src/modules/reports/reports.columns.ts
import { reportsRepository } from './reports.repository.js';
import type { ReportColumn, ReportFilters } from './reports.types.js';
import type { ReportType } from '@potato-corner/shared';

export const REPORT_COLUMNS: Record<ReportType, ReportColumn<Record<string, unknown>>[]> = {
  DAILY_SALES: [
    { key: 'report_date', header: 'Date' },
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'discount_total', header: 'Discounts' },
    { key: 'vat_total', header: 'VAT' },
    { key: 'net_sales', header: 'Net Sales' },
    { key: 'completed_count', header: 'Completed' },
    { key: 'voided_count', header: 'Voided' },
    { key: 'refunded_count', header: 'Refunded' },
  ],
  SHIFT_SUMMARY: [
    { key: 'shift_id', header: 'Shift ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'started_at', header: 'Started At' },
    { key: 'closed_at', header: 'Closed At' },
    { key: 'opening_cash_amount', header: 'Opening Cash' },
    { key: 'closing_cash_amount', header: 'Closing Cash' },
    { key: 'expected_closing_cash', header: 'Expected Closing' },
    { key: 'cash_variance', header: 'Variance' },
    { key: 'cash_sales_total', header: 'Cash Sales' },
    { key: 'gcash_sales_total', header: 'GCash Sales' },
    { key: 'total_transaction_count', header: 'Transactions' },
    { key: 'voided_count', header: 'Voided' },
    { key: 'refunded_count', header: 'Refunded' },
    { key: 'total_discount_amount', header: 'Discounts' },
    { key: 'pwd_sc_transaction_count', header: 'PWD/SC Txns' },
  ],
  CASH_RECONCILIATION: [
    { key: 'shift_id', header: 'Shift ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'opening_counted_total', header: 'Opening Counted' },
    { key: 'closing_counted_total', header: 'Closing Counted' },
    { key: 'expected_closing_cash', header: 'Expected Closing' },
    { key: 'cash_variance', header: 'Variance' },
    { key: 'variance_approved', header: 'Variance Approved' },
    { key: 'variance_explanation', header: 'Explanation' },
  ],
  VOID_REFUND: [
    { key: 'transaction_id', header: 'Transaction ID', isAudit: true },
    { key: 'transaction_number', header: 'Receipt #' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'total_amount', header: 'Amount' },
    { key: 'reason', header: 'Reason' },
    { key: 'actioned_by_name', header: 'Actioned By' },
    { key: 'actioned_at', header: 'Actioned At' },
  ],
  DISCOUNT_COMPLIANCE: [
    { key: 'branch_name', header: 'Branch' },
    { key: 'discount_type', header: 'Discount Type' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'total_discount_amount', header: 'Total Discount' },
    { key: 'total_vat_exempt_amount', header: 'VAT Exempt Total' },
  ],
  INVENTORY_MOVEMENT: [
    { key: 'movement_id', header: 'Movement ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'unit', header: 'Unit' },
    { key: 'movement_type', header: 'Type' },
    { key: 'quantity_change', header: 'Change' },
    { key: 'quantity_before', header: 'Before' },
    { key: 'quantity_after', header: 'After' },
    { key: 'recorded_by_name', header: 'Recorded By' },
    { key: 'created_at', header: 'Date' },
  ],
  ATTENDANCE_SUMMARY: [
    { key: 'employee_id', header: 'Employee ID', isAudit: true },
    { key: 'employee_name', header: 'Employee' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'clock_in', header: 'Clock In' },
    { key: 'clock_out', header: 'Clock Out' },
    { key: 'actual_work_minutes', header: 'Minutes Worked' },
    { key: 'overtime_minutes', header: 'Overtime Minutes' },
    { key: 'break_minutes', header: 'Break Minutes' },
    { key: 'status', header: 'Status' },
  ],
  FRAUD_ALERT_SUMMARY: [
    { key: 'alert_id', header: 'Alert ID', isAudit: true },
    { key: 'alert_type', header: 'Type' },
    { key: 'severity', header: 'Severity' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'status', header: 'Status' },
    { key: 'created_at', header: 'Created At' },
    { key: 'updated_at', header: 'Updated At' },
  ],
  PRODUCT_PERFORMANCE: [
    { key: 'product_variant_id', header: 'Variant ID', isAudit: true },
    { key: 'product_name', header: 'Product' },
    { key: 'variant_name', header: 'Variant' },
    { key: 'units_sold', header: 'Units Sold' },
    { key: 'gross_revenue', header: 'Revenue' },
    { key: 'transaction_count', header: 'Transactions' },
  ],
  FLAVOR_PERFORMANCE: [
    { key: 'flavor_id', header: 'Flavor ID', isAudit: true },
    { key: 'flavor_name', header: 'Flavor' },
    { key: 'units_sold', header: 'Units Sold' },
    { key: 'gross_revenue', header: 'Revenue' },
  ],
  EMPLOYEE_PERFORMANCE: [
    { key: 'employee_id', header: 'Employee ID', isAudit: true },
    { key: 'employee_name', header: 'Employee' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'hours_worked', header: 'Hours Worked' },
  ],
  INVENTORY_VALUATION: [
    { key: 'ingredient_id', header: 'Ingredient ID', isAudit: true },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'unit', header: 'Unit' },
    { key: 'current_stock', header: 'Current Stock' },
    { key: 'unit_cost', header: 'Unit Cost' },
    { key: 'total_value', header: 'Total Value' },
    { key: 'status', header: 'Status' },
  ],
  BRANCH_COMPARISON: [
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'active_shift_count', header: 'Active Shifts' },
    { key: 'low_stock_ingredient_count', header: 'Low Stock Items' },
  ],
};

export async function getReportRows(reportType: ReportType, filters: ReportFilters): Promise<Record<string, unknown>[]> {
  switch (reportType) {
    case 'DAILY_SALES':
      return reportsRepository.getDailySales(filters);
    case 'SHIFT_SUMMARY':
      return reportsRepository.getShiftSummary(filters);
    case 'CASH_RECONCILIATION':
      return reportsRepository.getCashReconciliation(filters);
    case 'VOID_REFUND':
      return reportsRepository.getVoidRefund(filters);
    case 'DISCOUNT_COMPLIANCE':
      return reportsRepository.getDiscountCompliance(filters);
    case 'INVENTORY_MOVEMENT':
      return reportsRepository.getInventoryMovement(filters);
    case 'ATTENDANCE_SUMMARY':
      return reportsRepository.getAttendanceSummary(filters);
    case 'FRAUD_ALERT_SUMMARY':
      return reportsRepository.getFraudAlertSummary(filters);
    case 'PRODUCT_PERFORMANCE':
      return reportsRepository.getProductPerformance(filters);
    case 'FLAVOR_PERFORMANCE':
      return reportsRepository.getFlavorPerformance(filters);
    case 'EMPLOYEE_PERFORMANCE':
      return reportsRepository.getEmployeePerformance(filters);
    case 'INVENTORY_VALUATION':
      return reportsRepository.getInventoryValuation(filters);
    case 'BRANCH_COMPARISON':
      return reportsRepository.getBranchComparison(filters);
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.columns.ts apps/api/src/modules/reports/reports.columns.test.ts
git commit -m "feat(api): add report column definitions and row-fetch dispatch"
```

---

### Task 9: `lib/reports/csv.ts` and `lib/reports/pdf.ts`

**Files:**
- Create: `apps/api/src/lib/reports/csv.ts`
- Create: `apps/api/src/lib/reports/csv.test.ts`
- Create: `apps/api/src/lib/reports/pdf.ts`
- Create: `apps/api/src/lib/reports/pdf.test.ts`

**Interfaces:**
- Consumes: `ReportColumn<T>`, `ReportFilters` (Task 4).
- Produces: `generateCsv<T>(data, columns): Buffer`, `generatePdf<T>(reportType, filters, data, columns, branchName): Promise<Buffer>` — consumed by `reports.service.ts` (Task 12) and `report.queue.ts` (Task 14).

- [ ] **Step 1: Write the failing CSV test**

```ts
// apps/api/src/lib/reports/csv.test.ts
import { describe, it, expect } from 'vitest';
import { generateCsv } from './csv.js';

describe('generateCsv', () => {
  it('builds a header row from visible columns and escapes commas/quotes/newlines', () => {
    const buffer = generateCsv(
      [{ name: 'Cheese, Bacon "Deluxe"', amount: 199.5 }],
      [{ key: 'name', header: 'Name' }, { key: 'amount', header: 'Amount' }],
    );
    const csv = buffer.toString('utf-8');
    expect(csv).toBe('Name,Amount\n"Cheese, Bacon ""Deluxe""",199.5');
  });

  it('appends audit-only columns at the end with an underscore-prefixed header', () => {
    const buffer = generateCsv(
      [{ name: 'Regular', id: 'pv-1', created_at: '2026-07-01T00:00:00.000Z' }],
      [
        { key: 'name', header: 'Name' },
        { key: 'id', header: 'ID', isAudit: true },
        { key: 'created_at', header: 'Created At', isAudit: true },
      ],
    );
    const csv = buffer.toString('utf-8');
    expect(csv).toBe('Name,_ID,_Created At\nRegular,pv-1,2026-07-01T00:00:00.000Z');
  });

  it('renders null/undefined fields as empty strings', () => {
    const buffer = generateCsv([{ reason: null }], [{ key: 'reason', header: 'Reason' }]);
    expect(buffer.toString('utf-8')).toBe('Reason\n');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/lib/reports/csv.test.ts`
Expected: FAIL — `./csv.js` does not exist.

- [ ] **Step 3: Implement `csv.ts`**

```ts
// apps/api/src/lib/reports/csv.ts
import type { ReportColumn } from '../../modules/reports/reports.types.js';

function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Peso amounts are written as plain numbers (no currency symbol) for
 * spreadsheet compatibility — formatting is the viewer's job, not ours.
 */
export function generateCsv<T extends Record<string, unknown>>(data: T[], columns: Array<ReportColumn<T>>): Buffer {
  const visibleColumns = columns.filter((c) => !c.isAudit);
  const auditColumns = columns.filter((c) => c.isAudit);
  const orderedColumns = [...visibleColumns, ...auditColumns];

  const headerRow = [...visibleColumns.map((c) => c.header), ...auditColumns.map((c) => `_${c.header}`)].join(',');
  const dataRows = data.map((row) => orderedColumns.map((c) => escapeCsvField(row[c.key])).join(','));

  return Buffer.from([headerRow, ...dataRows].join('\n'), 'utf-8');
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/lib/reports/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing PDF test**

```ts
// apps/api/src/lib/reports/pdf.test.ts
import { describe, it, expect } from 'vitest';
import { generatePdf } from './pdf.js';

describe('generatePdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes', async () => {
    const buffer = await generatePdf(
      'DAILY_SALES',
      { page: 1, limit: 25 },
      [{ report_date: '2026-07-01', branch_name: 'SM North', gross_sales: 1000 }],
      [
        { key: 'report_date', header: 'Date' },
        { key: 'branch_name', header: 'Branch' },
        { key: 'gross_sales', header: 'Gross Sales' },
      ],
      'SM North',
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('omits isAudit columns from the rendered table', async () => {
    const buffer = await generatePdf(
      'PRODUCT_PERFORMANCE',
      { page: 1, limit: 25 },
      [{ product_variant_id: 'pv-1', product_name: 'Cheese Potato' }],
      [
        { key: 'product_variant_id', header: 'Variant ID', isAudit: true },
        { key: 'product_name', header: 'Product' },
      ],
      null,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `pnpm --filter @potato-corner/api exec vitest run src/lib/reports/pdf.test.ts`
Expected: FAIL — `./pdf.js` does not exist.

- [ ] **Step 7: Implement `pdf.ts`** (uses `React.createElement` instead of JSX — see "Corrections to the original spec": `apps/api`'s `tsconfig.json` has no `jsx` compiler option, and this stays a plain `.ts` file)

```ts
// apps/api/src/lib/reports/pdf.ts
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReportColumn, ReportFilters } from '../../modules/reports/reports.types.js';
import type { ReportType } from '@potato-corner/shared';

const e = React.createElement;

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 9, fontFamily: 'Helvetica' },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { flex: 1, padding: 4 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

function reportTypeLabel(reportType: ReportType): string {
  return reportType
    .split('_')
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Black-and-white, legible, minimal — matches the spec's "no color styling
 * needed for reports." Header: brand name (logo placeholder), report title,
 * branch, date range, generated timestamp. Footer: "Page X of Y" via
 * @react-pdf/renderer's `render` prop, which re-runs per rendered page.
 */
export async function generatePdf<T extends Record<string, unknown>>(
  reportType: ReportType,
  filters: ReportFilters,
  data: T[],
  columns: Array<ReportColumn<T>>,
  branchName: string | null,
): Promise<Buffer> {
  const visibleColumns = columns.filter((c) => !c.isAudit);
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom?.toISOString().slice(0, 10) ?? '...'} to ${filters.dateTo?.toISOString().slice(0, 10) ?? '...'}`
      : 'All dates';

  const headerCells = visibleColumns.map((c) => e(Text, { key: String(c.key), style: styles.cell }, c.header));
  const bodyRows = data.map((row, i) =>
    e(
      View,
      { key: i, style: styles.row, wrap: false },
      ...visibleColumns.map((c) => e(Text, { key: String(c.key), style: styles.cell }, String(row[c.key] ?? ''))),
    ),
  );

  const doc = e(
    Document,
    null,
    e(
      Page,
      { size: 'A4', style: styles.page, orientation: 'landscape' },
      e(
        View,
        { style: styles.header },
        e(Text, { style: styles.brand }, 'POTATO CORNER'),
        e(Text, { style: styles.title }, `${reportTypeLabel(reportType)} Report`),
        e(Text, { style: styles.meta }, `Branch: ${branchName ?? 'All Branches'} | Date range: ${dateRangeLabel} | Generated: ${generatedAt}`),
      ),
      e(
        View,
        { style: styles.table },
        e(View, { style: styles.headerRow, fixed: true }, ...headerCells),
        ...bodyRows,
      ),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `pnpm --filter @potato-corner/api exec vitest run src/lib/reports/pdf.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/reports/csv.ts apps/api/src/lib/reports/csv.test.ts apps/api/src/lib/reports/pdf.ts apps/api/src/lib/reports/pdf.test.ts
git commit -m "feat(api): add CSV and PDF report generation utilities"
```

---

### Task 10: `reports.service.ts` — real-time report methods (8)

**Files:**
- Modify: `apps/api/src/modules/reports/reports.service.ts`
- Create: `apps/api/src/modules/reports/reports.service.test.ts`

**Interfaces:**
- Consumes: `reportsRepository` (Tasks 5–6), `recordAuditLog` (`apps/api/src/middleware/audit-log.js`), `ReportFilters`/`ReportResponse<T>` (Task 4).
- Produces: `reportsService.getDailySalesReport/getShiftSummaryReport/getCashReconciliationReport/getVoidRefundReport/getDiscountComplianceReport/getInventoryMovementReport/getAttendanceSummaryReport/getFraudAlertSummaryReport(filters, actorId, actorRole): Promise<ReportResponse<Row>>` — consumed by `reports.router.ts` (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/reports/reports.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn(),
    getShiftSummary: vi.fn(),
    getCashReconciliation: vi.fn(),
    getVoidRefund: vi.fn(),
    getDiscountCompliance: vi.fn(),
    getInventoryMovement: vi.fn(),
    getAttendanceSummary: vi.fn(),
    getFraudAlertSummary: vi.fn(),
    getProductPerformance: vi.fn(),
    getFlavorPerformance: vi.fn(),
    getEmployeePerformance: vi.fn(),
    getInventoryValuation: vi.fn(),
    getBranchComparison: vi.fn(),
    getLatestSnapshot: vi.fn(),
    saveSnapshot: vi.fn(),
    countRows: vi.fn(),
  },
}));
vi.mock('../../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./reports.columns.js', () => ({
  getReportRows: vi.fn(),
  REPORT_COLUMNS: { DAILY_SALES: [{ key: 'report_date', header: 'Date' }] },
}));
vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: { storage: { from: vi.fn() } },
}));
vi.mock('../../queues/report.queue.js', () => ({
  enqueueGenerateExport: vi.fn(),
  enqueueRefreshSnapshot: vi.fn(),
}));

const { reportsRepository } = await import('./reports.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { reportsService } = await import('./reports.service.js');

beforeEach(() => vi.clearAllMocks());

describe('reportsService.getDailySalesReport', () => {
  it('defaults to the last 7 days when no date range is given, then writes REPORT_ACCESSED', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([{ report_date: '2026-07-01' } as never]);

    const result = await reportsService.getDailySalesReport({ page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getDailySales).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: expect.any(Date), dateTo: expect.any(Date) }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_ACCESSED', entityType: 'report', entityId: 'DAILY_SALES', actorId: 'user-1', actorRole: 'supervisor' }),
    );
    expect(result.report_type).toBe('DAILY_SALES');
    expect(result.data).toEqual([{ report_date: '2026-07-01' }]);
    expect(result.total).toBe(1);
  });

  it('respects an explicit date range instead of applying the 7-day default', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([]);
    const dateFrom = new Date('2026-06-01T00:00:00.000Z');
    const dateTo = new Date('2026-06-30T23:59:59.999Z');

    await reportsService.getDailySalesReport({ dateFrom, dateTo, page: 1, limit: 25 }, 'user-1', 'supervisor');

    expect(reportsRepository.getDailySales).toHaveBeenCalledWith(expect.objectContaining({ dateFrom, dateTo }));
  });

  it('paginates the full result set client-side (repository returns unpaginated rows for this type)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ report_date: `2026-07-${String(i + 1).padStart(2, '0')}` }));
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue(rows as never);

    const result = await reportsService.getDailySalesReport({ page: 2, limit: 10 }, 'user-1', 'supervisor');

    expect(result.data).toHaveLength(10);
    expect(result.data[0]).toEqual(rows[10]);
    expect(result.total).toBe(30);
    expect(result.page).toBe(2);
  });
});

describe('reportsService.getFraudAlertSummaryReport', () => {
  it('calls the repository and writes an audit log the same as any other real-time report', async () => {
    vi.mocked(reportsRepository.getFraudAlertSummary).mockResolvedValue([]);

    await reportsService.getFraudAlertSummaryReport({ page: 1, limit: 25 }, 'admin-1', 'super_admin');

    expect(reportsRepository.getFraudAlertSummary).toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'FRAUD_ALERT_SUMMARY', actorRole: 'super_admin' }));
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: FAIL — `reportsService.getDailySalesReport is not a function`.

- [ ] **Step 3: Implement the real-time methods in `reports.service.ts`**

```ts
// apps/api/src/modules/reports/reports.service.ts
import type { ReportType } from '@potato-corner/shared';
import { reportsRepository } from './reports.repository.js';
import type { ReportFilters, ReportResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

const DEFAULT_REALTIME_RANGE_DAYS = 7;

function defaultRealtimeFilters(filters: ReportFilters): ReportFilters {
  if (filters.dateFrom || filters.dateTo) return filters;
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - DEFAULT_REALTIME_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { ...filters, dateFrom, dateTo };
}

function toWireFilters(filters: ReportFilters) {
  return {
    branch_id: filters.branchId,
    date_from: filters.dateFrom?.toISOString(),
    date_to: filters.dateTo?.toISOString(),
    page: filters.page,
    limit: filters.limit,
  };
}

async function accessAudit(reportType: ReportType, filters: ReportFilters, actorId: string, actorRole: string, rowCount: number): Promise<void> {
  await recordAuditLog({
    action: 'REPORT_ACCESSED',
    entityType: 'report',
    entityId: reportType,
    actorId,
    actorRole,
    branchId: filters.branchId ?? null,
    afterState: { reportType, filters: toWireFilters(filters), rowCount },
  });
}

async function realtimeReport<T>(
  reportType: ReportType,
  rawFilters: ReportFilters,
  actorId: string,
  actorRole: string,
  fetchRows: (filters: ReportFilters) => Promise<T[]>,
): Promise<ReportResponse<T>> {
  const filters = defaultRealtimeFilters(rawFilters);
  const allRows = await fetchRows(filters);
  const start = (filters.page - 1) * filters.limit;
  const page = allRows.slice(start, start + filters.limit);

  await accessAudit(reportType, filters, actorId, actorRole, allRows.length);

  return {
    report_type: reportType,
    generated_at: new Date().toISOString(),
    filters: toWireFilters(filters),
    data: page,
    total: allRows.length,
    page: filters.page,
    limit: filters.limit,
  };
}

export const reportsService = {
  getDailySalesReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('DAILY_SALES', filters, actorId, actorRole, (f) => reportsRepository.getDailySales(f)),
  getShiftSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('SHIFT_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getShiftSummary(f)),
  getCashReconciliationReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('CASH_RECONCILIATION', filters, actorId, actorRole, (f) => reportsRepository.getCashReconciliation(f)),
  getVoidRefundReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('VOID_REFUND', filters, actorId, actorRole, (f) => reportsRepository.getVoidRefund(f)),
  getDiscountComplianceReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('DISCOUNT_COMPLIANCE', filters, actorId, actorRole, (f) => reportsRepository.getDiscountCompliance(f)),
  getInventoryMovementReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('INVENTORY_MOVEMENT', filters, actorId, actorRole, (f) => reportsRepository.getInventoryMovement(f)),
  getAttendanceSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('ATTENDANCE_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getAttendanceSummary(f)),
  getFraudAlertSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('FRAUD_ALERT_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getFraudAlertSummary(f)),
};
```

(The pre-computed methods and `requestExport` are added to this same `reportsService` object in Tasks 11–12 — do not export a second object. `defaultRealtimeFilters`, `toWireFilters`, `accessAudit`, and `realtimeReport` are module-scope helpers reused by those later tasks.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.service.ts apps/api/src/modules/reports/reports.service.test.ts
git commit -m "feat(api): implement real-time report service methods with audit logging"
```

---

### Task 11: `reports.service.ts` — pre-computed report methods (stale-while-revalidate)

**Files:**
- Modify: `apps/api/src/modules/reports/reports.service.ts` (append to the `reportsService` object from Task 10)
- Modify: `apps/api/src/modules/reports/reports.service.test.ts` (append)

**Interfaces:**
- Consumes: `reportsRepository.getLatestSnapshot/saveSnapshot` (Task 6), `getReportRows` (Task 8), `enqueueRefreshSnapshot` (Task 14 — mocked here, implemented there).
- Produces: `reportsService.getProductPerformanceReport/getFlavorPerformanceReport/getEmployeePerformanceReport/getInventoryValuationReport/getBranchComparisonReport(branchId, actorId, actorRole): Promise<SnapshotResponse<Row>>` — consumed by `reports.router.ts` (Task 13).

- [ ] **Step 1: Write the failing tests** (append to `reports.service.test.ts`)

```ts
describe('reportsService.getProductPerformanceReport', () => {
  it('computes fresh and saves a snapshot when none exists yet', async () => {
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue(null);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([{ product_variant_id: 'pv-1' } as never]);

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(reportsRepository.saveSnapshot).toHaveBeenCalledWith('PRODUCT_PERFORMANCE', 'b1', [{ product_variant_id: 'pv-1' }], expect.anything());
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });

  it('returns the snapshot immediately without recomputing when it is fresh (<15 min old)', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue({
      id: 'snap-1', reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', computedAt: fiveMinAgo, payload: [{ product_variant_id: 'pv-1' }], parameters: {},
    } as never);
    const { getReportRows } = await import('./reports.columns.js');

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(getReportRows).not.toHaveBeenCalled();
    expect(reportsRepository.saveSnapshot).not.toHaveBeenCalled();
    expect(result.computed_at).toBe(fiveMinAgo.toISOString());
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });

  it('serves the stale snapshot immediately and enqueues a background refresh when it is >15 min old', async () => {
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue({
      id: 'snap-1', reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', computedAt: twentyMinAgo, payload: [{ product_variant_id: 'pv-1' }], parameters: {},
    } as never);
    const { enqueueRefreshSnapshot } = await import('../../queues/report.queue.js');

    const result = await reportsService.getProductPerformanceReport('b1', 'user-1', 'supervisor');

    expect(enqueueRefreshSnapshot).toHaveBeenCalledWith(expect.objectContaining({ reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1' }));
    expect(result.data).toEqual([{ product_variant_id: 'pv-1' }]);
  });
});

describe('reportsService.getBranchComparisonReport', () => {
  it('writes REPORT_ACCESSED for the super-admin-only global report', async () => {
    vi.mocked(reportsRepository.getLatestSnapshot).mockResolvedValue(null);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([]);

    await reportsService.getBranchComparisonReport(null, 'admin-1', 'super_admin');

    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'BRANCH_COMPARISON', actorRole: 'super_admin', branchId: null }));
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: FAIL — `reportsService.getProductPerformanceReport is not a function`.

- [ ] **Step 3: Append the pre-computed methods** (add these constants/helpers above `export const reportsService = {`, and add the five keys inside the object, after `getFraudAlertSummaryReport`)

```ts
import { getReportRows } from './reports.columns.js';
import { enqueueRefreshSnapshot } from '../../queues/report.queue.js';
import type { SnapshotResponse } from './reports.types.js';

const PRECOMPUTED_WINDOW_DAYS = 30;
const SNAPSHOT_STALE_MS = 15 * 60 * 1000;

function precomputedWindowFilters(branchId: string | null): ReportFilters {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - PRECOMPUTED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { branchId: branchId ?? undefined, dateFrom, dateTo, page: 1, limit: 100 };
}

async function precomputedReport<T>(
  reportType: ReportType,
  branchId: string | null,
  actorId: string,
  actorRole: string,
): Promise<SnapshotResponse<T>> {
  const existing = await reportsRepository.getLatestSnapshot(reportType, branchId);

  if (!existing) {
    const filters = precomputedWindowFilters(branchId);
    const rows = (await getReportRows(reportType, filters)) as T[];
    await reportsRepository.saveSnapshot(reportType, branchId, rows, filters);
    await accessAudit(reportType, filters, actorId, actorRole, rows.length);
    return { report_type: reportType, computed_at: new Date().toISOString(), branch_id: branchId, data: rows };
  }

  const isStale = Date.now() - existing.computedAt.getTime() > SNAPSHOT_STALE_MS;
  if (isStale) {
    void enqueueRefreshSnapshot({ reportType, branchId, filters: precomputedWindowFilters(branchId) });
  }

  await accessAudit(reportType, { branchId: branchId ?? undefined, page: 1, limit: 100 }, actorId, actorRole, (existing.payload as T[]).length);
  return { report_type: reportType, computed_at: existing.computedAt.toISOString(), branch_id: branchId, data: existing.payload as T[] };
}
```

Add to the `reportsService` object (after `getFraudAlertSummaryReport`):

```ts
  getProductPerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('PRODUCT_PERFORMANCE', branchId, actorId, actorRole),
  getFlavorPerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('FLAVOR_PERFORMANCE', branchId, actorId, actorRole),
  getEmployeePerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('EMPLOYEE_PERFORMANCE', branchId, actorId, actorRole),
  getInventoryValuationReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('INVENTORY_VALUATION', branchId, actorId, actorRole),
  getBranchComparisonReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('BRANCH_COMPARISON', branchId, actorId, actorRole),
```

**Note on import order:** `reports.service.ts` now imports from `../../queues/report.queue.js`, and Task 14 makes `report.queue.ts` import `reportsRepository` from `./reports.repository.js` (not from the service) for its `refresh_snapshot` handler — this avoids a circular import between the service and the queue. Double-check this when implementing Task 14.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.service.ts apps/api/src/modules/reports/reports.service.test.ts
git commit -m "feat(api): implement pre-computed report service methods with stale-while-revalidate"
```

---

### Task 12: `reports.service.ts` — `requestExport`

**Files:**
- Modify: `apps/api/src/modules/reports/reports.service.ts` (append to the `reportsService` object from Tasks 10–11)
- Modify: `apps/api/src/modules/reports/reports.service.test.ts` (append)

**Interfaces:**
- Consumes: `reportsRepository.countRows` (Task 6), `getReportRows`/`REPORT_COLUMNS` (Task 8), `generateCsv` (Task 9), `supabaseAdmin` (`apps/api/src/lib/supabase.js`), `enqueueGenerateExport` (Task 14 — mocked here, implemented there).
- Produces: `reportsService.requestExport(reportType, filters, format, requesterId, requesterRole, branchId): Promise<{ download_url, expires_at } | ExportJobResponse>` — consumed by `reports.router.ts` (Task 13).

- [ ] **Step 1: Write the failing tests** (append to `reports.service.test.ts`)

```ts
describe('reportsService.requestExport', () => {
  it('CSV sync path: uploads to storage and returns a signed download_url when count < 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(5);
    const { getReportRows } = await import('./reports.columns.js');
    vi.mocked(getReportRows).mockResolvedValue([{ report_date: '2026-07-01' } as never]);
    const { supabaseAdmin } = await import('../../lib/supabase.js');
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/report.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.csv$/), expect.any(Buffer), { contentType: 'text/csv', upsert: false });
    expect(result).toEqual({ download_url: 'https://signed.example/report.csv', expires_at: expect.any(String) });
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_EXPORTED' }));
  });

  it('CSV async path: enqueues a job and returns job_id when count >= 10,000', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(15_000);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-1' } as never);

    const result = await reportsService.requestExport('VOID_REFUND', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', 'b1');

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect(result).toEqual({ job_id: 'job-1', message: expect.any(String), estimated_seconds: 120 });
  });

  it('PDF always enqueues a job, regardless of row count', async () => {
    vi.mocked(reportsRepository.countRows).mockResolvedValue(3);
    const { enqueueGenerateExport } = await import('../../queues/report.queue.js');
    vi.mocked(enqueueGenerateExport).mockResolvedValue({ id: 'job-2' } as never);

    const result = await reportsService.requestExport('DAILY_SALES', { page: 1, limit: 25 }, 'pdf', 'user-1', 'supervisor', 'b1');

    expect(enqueueGenerateExport).toHaveBeenCalled();
    expect('job_id' in result && result.job_id).toBe('job-2');
  });

  it('rejects a supervisor exporting a super-admin-only report type with 403', async () => {
    await expect(
      reportsService.requestExport('BRANCH_COMPARISON', { page: 1, limit: 25 }, 'csv', 'user-1', 'supervisor', null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_REPORT_TYPE', statusCode: 403 });
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: FAIL — `reportsService.requestExport is not a function`.

- [ ] **Step 3: Append `requestExport`** (add imports at the top, the `SYNC_CSV_ROW_LIMIT`/`SUPER_ADMIN_ONLY_TYPES` constants above `reportsService`, and the method as the last key in the `reportsService` object)

```ts
import { ROLES } from '@potato-corner/shared';
import { REPORT_COLUMNS } from './reports.columns.js';
import { ReportError } from './reports.types.js';
import { generateCsv } from '../../lib/reports/csv.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { enqueueGenerateExport } from '../../queues/report.queue.js';

const SYNC_CSV_ROW_LIMIT = 10_000;
const SUPER_ADMIN_ONLY_TYPES = new Set<ReportType>(['FRAUD_ALERT_SUMMARY', 'BRANCH_COMPARISON']);
const PRECOMPUTED_TYPES = new Set<ReportType>(['PRODUCT_PERFORMANCE', 'FLAVOR_PERFORMANCE', 'EMPLOYEE_PERFORMANCE', 'INVENTORY_VALUATION', 'BRANCH_COMPARISON']);
```

```ts
  async requestExport(
    reportType: ReportType,
    filters: ReportFilters,
    format: 'csv' | 'pdf',
    requesterId: string,
    requesterRole: string,
    branchId: string | null,
  ): Promise<{ download_url: string; expires_at: string } | { job_id: string; message: string; estimated_seconds: number }> {
    if (SUPER_ADMIN_ONLY_TYPES.has(reportType) && requesterRole !== ROLES.SUPER_ADMIN) {
      throw new ReportError('FORBIDDEN_REPORT_TYPE', `${reportType} can only be exported by a super admin`, 403);
    }

    const resolvedFilters = PRECOMPUTED_TYPES.has(reportType) ? precomputedWindowFilters(branchId) : defaultRealtimeFilters(filters);
    const count = await reportsRepository.countRows(reportType, resolvedFilters);

    if (format === 'csv' && count < SYNC_CSV_ROW_LIMIT) {
      const rows = await getReportRows(reportType, { ...resolvedFilters, page: 1, limit: count || 1 });
      const columns = REPORT_COLUMNS[reportType];
      const buffer = generateCsv(rows, columns);
      const path = `reports/${requesterId}/${Date.now()}-${reportType}.csv`;

      const { error: uploadError } = await supabaseAdmin.storage.from('report-exports').upload(path, buffer, { contentType: 'text/csv', upsert: false });
      if (uploadError) throw new ReportError('EXPORT_UPLOAD_FAILED', 'Failed to upload the report export', 502);

      const { data: signed, error: signError } = await supabaseAdmin.storage.from('report-exports').createSignedUrl(path, 86_400);
      if (signError || !signed) throw new ReportError('EXPORT_SIGN_FAILED', 'Failed to create a download link for the export', 502);

      const expiresAt = new Date(Date.now() + 86_400 * 1000).toISOString();
      await recordAuditLog({
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: reportType,
        actorId: requesterId,
        actorRole: requesterRole,
        branchId,
        afterState: { reportType, format, path, async: false, rowCount: rows.length },
      });
      return { download_url: signed.signedUrl, expires_at: expiresAt };
    }

    const job = await enqueueGenerateExport({ reportType, filters: resolvedFilters, format, requesterId, branchId });
    await recordAuditLog({
      action: 'REPORT_EXPORTED',
      entityType: 'report',
      entityId: reportType,
      actorId: requesterId,
      actorRole: requesterRole,
      branchId,
      afterState: { reportType, format, async: true, jobId: job.id, rowCount: count },
    });
    return {
      job_id: job.id ?? '',
      message: "Export queued — you'll be notified when it's ready",
      estimated_seconds: count < 1000 ? 10 : count < 10_000 ? 30 : 120,
    };
  },
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.service.test.ts`
Expected: PASS. Then run the full service test file once more to confirm nothing from Tasks 10–11 regressed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/reports.service.ts apps/api/src/modules/reports/reports.service.test.ts
git commit -m "feat(api): implement report export (sync CSV / async CSV+PDF) with audit logging"
```

---

### Task 13: `reports.router.ts` — all 14 routes

**Files:**
- Modify: `apps/api/src/modules/reports/reports.router.ts`
- Create: `apps/api/src/modules/reports/reports.router.test.ts`

**Interfaces:**
- Consumes: `reportsService` (Tasks 10–12), `ReportFiltersSchema`/`ExportRequestSchema` (Task 3), `authenticate`/`adminOnly`/`adminOrSupervisor`/`branchGuard`/`requirePasswordChange`/`validate` middleware.
- Produces: mounted at `/api/reports` in `app.ts` (already wired — confirm, do not re-mount).

- [ ] **Step 1: Write the failing router tests** (uses the exact `getRouteHandlers`/`runHandlers`/`mockReq`/`mockRes` harness from `fraud.router.test.ts` — no supertest dependency exists in this codebase)

```ts
// apps/api/src/modules/reports/reports.router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

vi.mock('./reports.service.js', () => ({
  reportsService: {
    getDailySalesReport: vi.fn(),
    getShiftSummaryReport: vi.fn(),
    getCashReconciliationReport: vi.fn(),
    getVoidRefundReport: vi.fn(),
    getDiscountComplianceReport: vi.fn(),
    getInventoryMovementReport: vi.fn(),
    getAttendanceSummaryReport: vi.fn(),
    getFraudAlertSummaryReport: vi.fn(),
    getProductPerformanceReport: vi.fn(),
    getFlavorPerformanceReport: vi.fn(),
    getEmployeePerformanceReport: vi.fn(),
    getInventoryValuationReport: vi.fn(),
    getBranchComparisonReport: vi.fn(),
    requestExport: vi.fn(),
  },
}));

const { reportsService } = await import('./reports.service.js');
const { reportsRouter } = await import('./reports.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');
const { ReportError } = await import('./reports.types.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/reports/test', ...overrides } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response & { statusCode?: number; jsonBody?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  res.send = vi.fn(() => res) as unknown as Response['send'];
  return res;
}

function authHeader(token: string): Partial<Request> {
  return { headers: { authorization: `Bearer ${token}` } };
}

function getRouteHandlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runHandlers(handlers: Middleware[], req: Request, res: Response): Promise<void> {
  for (const handler of handlers) {
    let calledNext = false;
    await handler(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) return;
  }
}

const BRANCH_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reports routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'get', path: '/daily-sales' },
    { method: 'get', path: '/shift-summary' },
    { method: 'get', path: '/cash-reconciliation' },
    { method: 'get', path: '/void-refund' },
    { method: 'get', path: '/discount-compliance' },
    { method: 'get', path: '/inventory-movement' },
    { method: 'get', path: '/attendance-summary' },
    { method: 'get', path: '/fraud-alert-summary' },
    { method: 'get', path: '/product-performance' },
    { method: 'get', path: '/flavor-performance' },
    { method: 'get', path: '/employee-performance' },
    { method: 'get', path: '/inventory-valuation' },
    { method: 'get', path: '/branch-comparison' },
    { method: 'post', path: '/export' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(reportsRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET /fraud-alert-summary — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/fraud-alert-summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reportsService.getFraudAlertSummaryReport).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/fraud-alert-summary');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(reportsService.getFraudAlertSummaryReport).mockResolvedValue({ report_type: 'FRAUD_ALERT_SUMMARY', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /branch-comparison — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/branch-comparison');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reportsService.getBranchComparisonReport).not.toHaveBeenCalled();
  });
});

describe('GET /daily-sales', () => {
  it('returns 200 for supervisor with valid filters', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1, date_from: '2026-07-01', date_to: '2026-07-15' } });
    const res = mockRes();
    vi.mocked(reportsService.getDailySalesReport).mockResolvedValue({ report_type: 'DAILY_SALES', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(reportsService.getDailySalesReport).toHaveBeenCalled();
  });

  it('returns 422 when date_from is not a valid date string', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1, date_from: 'not-a-date' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(reportsService.getDailySalesReport).not.toHaveBeenCalled();
  });

  it('returns 403 for a staff member requesting a branch outside their assignment', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateStaffToken(randomUUID());
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('GET /product-performance', () => {
  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/product-performance');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(reportsService.getProductPerformanceReport).mockResolvedValue({ report_type: 'PRODUCT_PERFORMANCE', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /export', () => {
  it('returns 422 when report_type is missing', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { filters: { branch_id: BRANCH_1, page: 1, limit: 25 }, format: 'csv' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(reportsService.requestExport).not.toHaveBeenCalled();
  });

  it('returns 422 when format is missing', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { report_type: 'DAILY_SALES', filters: { branch_id: BRANCH_1, page: 1, limit: 25 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('returns 200 for a valid supervisor export request', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      body: { report_type: 'DAILY_SALES', filters: { branch_id: BRANCH_1, page: 1, limit: 25 }, format: 'csv' },
    });
    const res = mockRes();
    vi.mocked(reportsService.requestExport).mockResolvedValue({ download_url: 'https://signed.example/x.csv', expires_at: '2026-07-17T00:00:00.000Z' });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(reportsService.requestExport).toHaveBeenCalledWith('DAILY_SALES', expect.any(Object), 'csv', expect.any(String), 'supervisor', BRANCH_1);
  });

  it('propagates a 403 ReportError from the service (super-admin-only report type)', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      body: { report_type: 'BRANCH_COMPARISON', filters: { page: 1, limit: 25 }, format: 'csv' },
    });
    const res = mockRes();
    vi.mocked(reportsService.requestExport).mockRejectedValue(new ReportError('FORBIDDEN_REPORT_TYPE', 'not allowed', 403));

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.router.test.ts`
Expected: FAIL — no routes are registered on the stub router.

- [ ] **Step 3: Implement `reports.router.ts`**

```ts
// apps/api/src/modules/reports/reports.router.ts
import { Router, type NextFunction, type Request, type Response } from 'express';
import { ExportRequestSchema, ReportFiltersSchema, ROLES, type ExportRequestInput, type ReportType } from '@potato-corner/shared';
import { reportsService } from './reports.service.js';
import { ReportError } from './reports.types.js';
import type { ReportFilters } from './reports.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleReportError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ReportError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function toBoundaryDate(value: string | undefined, boundary: 'start' | 'end'): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  return new Date(value);
}

function parseFilters(query: unknown): { ok: true; filters: ReportFilters } | { ok: false; issues: Array<{ field: string; message: string }> } {
  const parsed = ReportFiltersSchema.safeParse(query);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) };
  return {
    ok: true,
    filters: {
      branchId: parsed.data.branch_id,
      dateFrom: toBoundaryDate(parsed.data.date_from, 'start'),
      dateTo: toBoundaryDate(parsed.data.date_to, 'end'),
      page: parsed.data.page,
      limit: parsed.data.limit,
    },
  };
}

// ---------- Real-time reports (7): both roles, branchGuard applied ----------

function realtimeRoute(path: string, handler: (filters: ReportFilters, actorId: string, actorRole: string) => Promise<unknown>): void {
  router.get(path, authenticate, adminOrSupervisor, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = parseFilters(req.query);
      if (!result.ok) {
        res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: result.issues }, meta: null });
        return;
      }
      const data = await handler(result.filters, req.user.user_id, req.user.role);
      res.status(200).json({ data, error: null, meta: null });
    } catch (error) {
      handleReportError(error, res, next);
    }
  });
}

realtimeRoute('/daily-sales', (f, id, role) => reportsService.getDailySalesReport(f, id, role));
realtimeRoute('/shift-summary', (f, id, role) => reportsService.getShiftSummaryReport(f, id, role));
realtimeRoute('/cash-reconciliation', (f, id, role) => reportsService.getCashReconciliationReport(f, id, role));
realtimeRoute('/void-refund', (f, id, role) => reportsService.getVoidRefundReport(f, id, role));
realtimeRoute('/discount-compliance', (f, id, role) => reportsService.getDiscountComplianceReport(f, id, role));
realtimeRoute('/inventory-movement', (f, id, role) => reportsService.getInventoryMovementReport(f, id, role));
realtimeRoute('/attendance-summary', (f, id, role) => reportsService.getAttendanceSummaryReport(f, id, role));

// ---------- Fraud Alert Summary (real-time, super_admin only, no branchGuard) ----------

router.get('/fraud-alert-summary', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = parseFilters(req.query);
    if (!result.ok) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: result.issues }, meta: null });
      return;
    }
    const data = await reportsService.getFraudAlertSummaryReport(result.filters, req.user.user_id, req.user.role);
    res.status(200).json({ data, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

// ---------- Pre-computed reports (4): both roles, branchGuard applied ----------

function precomputedRoute(path: string, handler: (branchId: string | null, actorId: string, actorRole: string) => Promise<unknown>): void {
  router.get(path, authenticate, adminOrSupervisor, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
      const data = await handler(branchId, req.user.user_id, req.user.role);
      res.status(200).json({ data, error: null, meta: null });
    } catch (error) {
      handleReportError(error, res, next);
    }
  });
}

precomputedRoute('/product-performance', (b, id, role) => reportsService.getProductPerformanceReport(b, id, role));
precomputedRoute('/flavor-performance', (b, id, role) => reportsService.getFlavorPerformanceReport(b, id, role));
precomputedRoute('/employee-performance', (b, id, role) => reportsService.getEmployeePerformanceReport(b, id, role));
precomputedRoute('/inventory-valuation', (b, id, role) => reportsService.getInventoryValuationReport(b, id, role));

// ---------- Branch Comparison (pre-computed, super_admin only, no branchGuard) ----------

router.get('/branch-comparison', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
    const data = await reportsService.getBranchComparisonReport(branchId, req.user.user_id, req.user.role);
    res.status(200).json({ data, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

// ---------- Export ----------
//
// branchGuard is intentionally NOT used here: its extractBranchId() only
// reads a top-level req.body.branch_id, but this endpoint's body nests
// branch_id under `filters`. The same allow/deny rule is applied inline
// instead, reading `body.filters.branch_id` — mirroring the existing
// precedent in inventory.router.ts for routes branchGuard can't cover.
router.post('/export', authenticate, adminOrSupervisor, requirePasswordChange, validate(ExportRequestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const body = req.body as ExportRequestInput;

    if (req.user.role !== ROLES.SUPER_ADMIN) {
      const branchId = body.filters.branch_id;
      if (!branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
        return;
      }
      if (!req.user.branch_ids.includes(branchId)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
    }

    const filters: ReportFilters = {
      branchId: body.filters.branch_id,
      dateFrom: toBoundaryDate(body.filters.date_from, 'start'),
      dateTo: toBoundaryDate(body.filters.date_to, 'end'),
      page: body.filters.page,
      limit: body.filters.limit,
    };
    const branchId = filters.branchId ?? null;
    const result = await reportsService.requestExport(body.report_type as ReportType, filters, body.format, req.user.user_id, req.user.role, branchId);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

export { router as reportsRouter };
```

- [ ] **Step 4: Confirm the mount point** (should already be correct — no change expected)

Run: `grep -n "reportsRouter" apps/api/src/app.ts`
Expected: `app.use('/api/reports', reportsRouter);` — already present from the Phase-0 scaffold; no edit needed.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/reports/reports.router.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/reports/reports.router.ts apps/api/src/modules/reports/reports.router.test.ts
git commit -m "feat(api): wire up all 14 reports routes with role/branch guards"
```

---

### Task 14: `report.queue.ts` — real worker (replaces the no-op stub)

**Files:**
- Modify: `apps/api/src/queues/report.queue.ts`
- Create: `apps/api/src/queues/report.queue.test.ts`

**Interfaces:**
- Consumes: `reportsRepository` (Tasks 5–6), `getReportRows`/`REPORT_COLUMNS` (Task 8) — **imported directly, not via `reports.service.ts`**, to avoid a circular import (the service already imports `enqueueGenerateExport`/`enqueueRefreshSnapshot` from this file — see the note at the end of Task 11).
- Produces: `enqueueGenerateExport(data): Promise<Job>`, `enqueueRefreshSnapshot(data): Promise<Job>` — consumed by `reports.service.ts` (Tasks 11–12).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/queues/report.queue.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn(() => ({ on: vi.fn() })),
}));
vi.mock('bullmq', () => {
  class Queue {
    add = vi.fn().mockResolvedValue({ id: 'job-1' });
  }
  class Worker {
    handler: (job: unknown) => Promise<void>;
    constructor(_name: string, handler: (job: unknown) => Promise<void>) {
      this.handler = handler;
    }
    on = vi.fn();
  }
  return { Queue, Worker };
});
vi.mock('../lib/supabase.js', () => ({ supabaseAdmin: { storage: { from: vi.fn() } } }));
vi.mock('../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));
vi.mock('../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../modules/reports/reports.columns.js', () => ({
  getReportRows: vi.fn().mockResolvedValue([{ report_date: '2026-07-01' }]),
  REPORT_COLUMNS: { DAILY_SALES: [{ key: 'report_date', header: 'Date' }] },
}));
vi.mock('../modules/reports/reports.repository.js', () => ({ reportsRepository: { saveSnapshot: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ prisma: { branch: { findUnique: vi.fn().mockResolvedValue({ name: 'SM North' }) } } }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const { supabaseAdmin } = await import('../lib/supabase.js');
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
const { recordAuditLog } = await import('../middleware/audit-log.js');
const { reportsRepository } = await import('../modules/reports/reports.repository.js');
const Sentry = await import('@sentry/node');
const { reportWorker } = await import('./report.queue.js');

beforeEach(() => vi.clearAllMocks());

describe('report worker — generate_export (CSV)', () => {
  it('generates CSV, uploads to storage, and emits report:export_ready', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.csv' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-1',
      name: 'generate_export',
      data: { reportType: 'DAILY_SALES', filters: { page: 1, limit: 100 }, format: 'csv', requesterId: 'user-1', branchId: 'b1' },
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.csv$/), expect.any(Buffer), { contentType: 'text/csv', upsert: false });
    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), 86_400);
    expect(notifySuperAdmin).toHaveBeenCalledWith('report:export_ready', expect.objectContaining({ download_url: 'https://signed.example/x.csv' }));
    expect(notifyBranch).toHaveBeenCalledWith('b1', 'report:export_ready', expect.anything());
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_EXPORTED' }));
  });
});

describe('report worker — generate_export (PDF)', () => {
  it('generates a PDF buffer, uploads, and emits report:export_ready', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.pdf' }, error: null });
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue({ upload, createSignedUrl } as never);

    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-2',
      name: 'generate_export',
      data: { reportType: 'DAILY_SALES', filters: { page: 1, limit: 100 }, format: 'pdf', requesterId: 'user-1', branchId: 'b1' },
    });

    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^reports\/user-1\/\d+-DAILY_SALES\.pdf$/), expect.any(Buffer), { contentType: 'application/pdf', upsert: false });
  });
});

describe('report worker — refresh_snapshot', () => {
  it('recomputes rows and saves a new snapshot', async () => {
    await (reportWorker as unknown as { handler: (job: unknown) => Promise<void> }).handler({
      id: 'job-3',
      name: 'refresh_snapshot',
      data: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', filters: { branchId: 'b1', page: 1, limit: 100 } },
    });

    expect(reportsRepository.saveSnapshot).toHaveBeenCalledWith('PRODUCT_PERFORMANCE', 'b1', [{ report_date: '2026-07-01' }], expect.anything());
  });
});

describe('report worker — failed handler', () => {
  it('emits report:export_failed to notifySuperAdmin and notifyBranch after max retries, and reports to Sentry', () => {
    const failedHandler = vi.mocked(reportWorker.on).mock.calls.find(([event]) => event === 'failed')?.[1] as
      | ((job: unknown, error: Error) => void)
      | undefined;
    expect(failedHandler).toBeDefined();

    failedHandler?.(
      { id: 'job-4', name: 'generate_export', attemptsMade: 3, opts: { attempts: 3 }, data: { reportType: 'DAILY_SALES', requesterId: 'user-1', branchId: 'b1' } },
      new Error('upload failed'),
    );

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(notifySuperAdmin).toHaveBeenCalledWith('report:export_failed', expect.objectContaining({ job_id: 'job-4', error: 'upload failed' }));
    expect(notifyBranch).toHaveBeenCalledWith('b1', 'report:export_failed', expect.anything());
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/queues/report.queue.test.ts`
Expected: FAIL — worker is a no-op stub, nothing is uploaded or emitted.

- [ ] **Step 3: Implement the worker**

```ts
// apps/api/src/queues/report.queue.ts
import { Queue, Worker, type Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { SOCKET_EVENTS, type ReportType } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
import { generateCsv } from '../lib/reports/csv.js';
import { generatePdf } from '../lib/reports/pdf.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { prisma } from '../lib/prisma.js';
import { reportsRepository } from '../modules/reports/reports.repository.js';
import { getReportRows, REPORT_COLUMNS } from '../modules/reports/reports.columns.js';
import type { ReportFilters } from '../modules/reports/reports.types.js';

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

export interface GenerateExportJobData {
  reportType: ReportType;
  filters: ReportFilters;
  format: 'csv' | 'pdf';
  requesterId: string;
  branchId: string | null;
}

export interface RefreshSnapshotJobData {
  reportType: ReportType;
  branchId: string | null;
  filters: ReportFilters;
}

export const reportQueue = new Queue('report', { connection: redis });

export function enqueueGenerateExport(data: GenerateExportJobData): Promise<Job> {
  return reportQueue.add('generate_export', data, { attempts: MAX_ATTEMPTS, backoff: { type: 'custom' } });
}

export function enqueueRefreshSnapshot(data: RefreshSnapshotJobData): Promise<Job> {
  return reportQueue.add('refresh_snapshot', data, { attempts: 1 });
}

async function processGenerateExport(job: Job<GenerateExportJobData>): Promise<void> {
  const { reportType, filters, format, requesterId, branchId } = job.data;
  const rows = await getReportRows(reportType, filters);
  const columns = REPORT_COLUMNS[reportType];
  const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;

  const buffer = format === 'csv' ? generateCsv(rows, columns) : await generatePdf(reportType, filters, rows, columns, branch?.name ?? null);
  const extension = format === 'csv' ? 'csv' : 'pdf';
  const contentType = format === 'csv' ? 'text/csv' : 'application/pdf';
  const path = `reports/${requesterId}/${Date.now()}-${reportType}.${extension}`;

  const { error: uploadError } = await supabaseAdmin.storage.from('report-exports').upload(path, buffer, { contentType, upsert: false });
  if (uploadError) throw new Error(`Failed to upload report export: ${uploadError.message}`);

  const { data: signed, error: signError } = await supabaseAdmin.storage.from('report-exports').createSignedUrl(path, 86_400);
  if (signError || !signed) throw new Error(`Failed to create signed URL for report export: ${signError?.message}`);

  const expiresAt = new Date(Date.now() + 86_400 * 1000).toISOString();
  const payload = { job_id: job.id ?? '', report_type: reportType, format, download_url: signed.signedUrl, expires_at: expiresAt, requester_id: requesterId };

  notifySuperAdmin(SOCKET_EVENTS.REPORT_EXPORT_READY, payload);
  if (branchId) notifyBranch(branchId, SOCKET_EVENTS.REPORT_EXPORT_READY, payload);

  await recordAuditLog({
    action: 'REPORT_EXPORTED',
    entityType: 'report',
    entityId: reportType,
    actorId: requesterId,
    actorRole: 'system',
    branchId,
    afterState: { reportType, format, path, async: true },
  });
}

async function processRefreshSnapshot(job: Job<RefreshSnapshotJobData>): Promise<void> {
  const { reportType, branchId, filters } = job.data;
  const rows = await getReportRows(reportType, filters);
  await reportsRepository.saveSnapshot(reportType, branchId, rows, filters);
}

export const reportWorker = new Worker(
  'report',
  async (job: Job) => {
    if (job.name === 'generate_export') {
      await processGenerateExport(job as Job<GenerateExportJobData>);
      return;
    }
    if (job.name === 'refresh_snapshot') {
      await processRefreshSnapshot(job as Job<RefreshSnapshotJobData>);
      return;
    }
  },
  { connection: createWorkerConnection(), settings: { backoffStrategy: retryDelayMs } },
);

reportWorker.on('failed', (job, error) => {
  if (!job || job.name !== 'generate_export') return;
  if (job.attemptsMade < (job.opts.attempts ?? MAX_ATTEMPTS)) return;

  Sentry.captureException(error);
  const { reportType, requesterId, branchId } = job.data as GenerateExportJobData;
  const payload = { job_id: job.id ?? '', report_type: reportType, error: error.message, requester_id: requesterId };
  notifySuperAdmin(SOCKET_EVENTS.REPORT_EXPORT_FAILED, payload);
  if (branchId) notifyBranch(branchId, SOCKET_EVENTS.REPORT_EXPORT_FAILED, payload);
});
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/queues/report.queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once to confirm nothing regressed**

Run: `pnpm --filter @potato-corner/api test`
Expected: all report-module tests (Tasks 5, 6, 8, 9, 10, 11, 12, 13, 14) plus every pre-existing test pass, 0 failed.

Run: `pnpm --filter @potato-corner/api exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/queues/report.queue.ts apps/api/src/queues/report.queue.test.ts
git commit -m "feat(api): implement report export and snapshot-refresh BullMQ worker"
```

---

### Task 15: `apps/web/hooks/queries/use-reports.ts` — frontend query hooks

**Files:**
- Create: `apps/web/hooks/queries/use-reports.ts`
- Create: `apps/web/hooks/queries/use-reports.test.ts`

**Interfaces:**
- Consumes: `apiClient` (`@/lib/api-client`), `useSocket` (`@/hooks/use-socket`), row/response types + `SOCKET_EVENTS` from `@potato-corner/shared` (Task 3).
- Produces: 13 report query hooks, `useRequestExport()`, `useReportsRealtimeSync(onExportReady?)` — consumed by Task 18 (admin page) and Task 19 (supervisor page extension).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/hooks/queries/use-reports.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockOn = vi.fn();
const mockOff = vi.fn();
vi.mock('@/hooks/use-socket', () => ({ useSocket: () => ({ isConnected: true, socket: null, on: mockOn, off: mockOff, emit: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const {
  useDailySalesReport,
  useBranchComparisonReport,
  useRequestExport,
  useReportsRealtimeSync,
} = await import('./use-reports.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useDailySalesReport', () => {
  it('is disabled when branch_id is falsy (not a global report type)', () => {
    const { result } = renderHook(() => useDailySalesReport({}), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches when branch_id is provided', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { report_type: 'DAILY_SALES', data: [], total: 0, page: 1, limit: 25 }, error: null, meta: null });
    const { result } = renderHook(() => useDailySalesReport({ branch_id: 'b1' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith(expect.stringContaining('/api/reports/daily-sales?'));
  });
});

describe('useBranchComparisonReport', () => {
  it('is enabled without a branch_id, since it is a global report type', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { report_type: 'BRANCH_COMPARISON', computed_at: '2026-07-16T00:00:00.000Z', branch_id: null, data: [] }, error: null, meta: null });
    const { result } = renderHook(() => useBranchComparisonReport(undefined), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith(expect.stringContaining('/api/reports/branch-comparison'));
  });
});

describe('useRequestExport', () => {
  it('shows a success toast on mutation success', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { job_id: 'job-1', message: 'queued', estimated_seconds: 10 }, error: null, meta: null });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('shows an error toast on mutation failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'EXPORT_UPLOAD_FAILED', message: 'boom' }, meta: null });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
  });
});

describe('useReportsRealtimeSync', () => {
  it('subscribes to REPORT_EXPORT_READY and REPORT_EXPORT_FAILED on mount', () => {
    renderHook(() => useReportsRealtimeSync(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith('report:export_ready', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('report:export_failed', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @potato-corner/web exec vitest run hooks/queries/use-reports.test.ts`
Expected: FAIL — `./use-reports.js` does not exist.

- [ ] **Step 3: Implement `use-reports.ts`**

```tsx
// apps/web/hooks/queries/use-reports.ts
'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SOCKET_EVENTS,
  type ReportType,
  type ReportResponse,
  type SnapshotResponse,
  type ExportRequestInput,
  type ExportReadyPayload,
  type DailySalesReportRow,
  type ShiftSummaryReportRow,
  type CashReconciliationReportRow,
  type VoidRefundReportRow,
  type DiscountComplianceReportRow,
  type InventoryMovementReportRow,
  type AttendanceSummaryReportRow,
  type FraudAlertSummaryReportRow,
  type ProductPerformanceReportRow,
  type FlavorPerformanceReportRow,
  type EmployeePerformanceReportRow,
  type InventoryValuationReportRow,
  type BranchComparisonReportRow,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useSocket } from '@/hooks/use-socket';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}
function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface ReportQueryFilters {
  branch_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

function buildReportQueryString(filters: ReportQueryFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

const REALTIME_ENDPOINTS: Record<string, string> = {
  DAILY_SALES: 'daily-sales',
  SHIFT_SUMMARY: 'shift-summary',
  CASH_RECONCILIATION: 'cash-reconciliation',
  VOID_REFUND: 'void-refund',
  DISCOUNT_COMPLIANCE: 'discount-compliance',
  INVENTORY_MOVEMENT: 'inventory-movement',
  ATTENDANCE_SUMMARY: 'attendance-summary',
  FRAUD_ALERT_SUMMARY: 'fraud-alert-summary',
};

function useRealtimeReport<T>(reportType: ReportType, filters: ReportQueryFilters, enabled: boolean) {
  const endpoint = REALTIME_ENDPOINTS[reportType];
  return useQuery({
    queryKey: ['reports', reportType, filters],
    queryFn: async () => {
      const response = await apiClient<ReportResponse<T>>(`/api/reports/${endpoint}?${buildReportQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, `Failed to load ${reportType} report`));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useDailySalesReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DailySalesReportRow>('DAILY_SALES', filters, enabled && Boolean(filters.branch_id));
}
export function useShiftSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<ShiftSummaryReportRow>('SHIFT_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
export function useCashReconciliationReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<CashReconciliationReportRow>('CASH_RECONCILIATION', filters, enabled && Boolean(filters.branch_id));
}
export function useVoidRefundReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<VoidRefundReportRow>('VOID_REFUND', filters, enabled && Boolean(filters.branch_id));
}
export function useDiscountComplianceReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DiscountComplianceReportRow>('DISCOUNT_COMPLIANCE', filters, enabled && Boolean(filters.branch_id));
}
export function useInventoryMovementReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<InventoryMovementReportRow>('INVENTORY_MOVEMENT', filters, enabled && Boolean(filters.branch_id));
}
export function useAttendanceSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<AttendanceSummaryReportRow>('ATTENDANCE_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
/** Admin-only report — no branch_id required, so `enabled` is not gated on it. */
export function useFraudAlertSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<FraudAlertSummaryReportRow>('FRAUD_ALERT_SUMMARY', filters, enabled);
}

const PRECOMPUTED_ENDPOINTS: Record<string, string> = {
  PRODUCT_PERFORMANCE: 'product-performance',
  FLAVOR_PERFORMANCE: 'flavor-performance',
  EMPLOYEE_PERFORMANCE: 'employee-performance',
  INVENTORY_VALUATION: 'inventory-valuation',
  BRANCH_COMPARISON: 'branch-comparison',
};

function usePrecomputedReport<T>(reportType: ReportType, branchId: string | undefined, enabled: boolean) {
  const endpoint = PRECOMPUTED_ENDPOINTS[reportType];
  return useQuery({
    queryKey: ['reports', reportType, branchId ?? null],
    queryFn: async () => {
      const qs = branchId ? `?branch_id=${branchId}` : '';
      const response = await apiClient<SnapshotResponse<T>>(`/api/reports/${endpoint}${qs}`);
      if (!response.data) throw new Error(errorMessage(response, `Failed to load ${reportType} report`));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useProductPerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<ProductPerformanceReportRow>('PRODUCT_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
export function useFlavorPerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<FlavorPerformanceReportRow>('FLAVOR_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
export function useEmployeePerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<EmployeePerformanceReportRow>('EMPLOYEE_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
export function useInventoryValuationReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<InventoryValuationReportRow>('INVENTORY_VALUATION', branchId, enabled && Boolean(branchId));
}
/** Admin-only report — no branch_id required, so `enabled` is not gated on it. */
export function useBranchComparisonReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<BranchComparisonReportRow>('BRANCH_COMPARISON', branchId, enabled);
}

interface ExportResult {
  download_url?: string;
  expires_at?: string;
  job_id?: string;
  message?: string;
  estimated_seconds?: number;
}

export function useRequestExport() {
  return useMutation({
    mutationFn: async (input: ExportRequestInput) => {
      const response = await apiClient<ExportResult>('/api/reports/export', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to request report export'));
      return response.data;
    },
    onSuccess: (data) => {
      if (data.download_url) {
        toast.success('Export ready', { description: 'Your download link is ready.' });
      } else {
        toast.success("Generating your report… you'll be notified when it's ready");
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/**
 * useRealtimeInvalidate only invalidates query keys — it has no payload
 * callback, and the export-ready toast needs `download_url` from the
 * payload. Subscribes directly via useSocket()'s on/off instead (the
 * spec's documented fallback) rather than modifying use-socket.ts.
 */
export function useReportsRealtimeSync(onExportReady?: (payload: ExportReadyPayload) => void): void {
  const { on, off } = useSocket();
  const queryClient = useQueryClient();

  useEffect(() => {
    function handleReady(...args: unknown[]) {
      const payload = args[0] as ExportReadyPayload;
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onExportReady?.(payload);
    }
    function handleFailed() {
      toast.error('Report export failed — please try again');
    }
    on(SOCKET_EVENTS.REPORT_EXPORT_READY, handleReady);
    on(SOCKET_EVENTS.REPORT_EXPORT_FAILED, handleFailed);
    return () => {
      off(SOCKET_EVENTS.REPORT_EXPORT_READY, handleReady);
      off(SOCKET_EVENTS.REPORT_EXPORT_FAILED, handleFailed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, onExportReady]);
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @potato-corner/web exec vitest run hooks/queries/use-reports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/hooks/queries/use-reports.ts apps/web/hooks/queries/use-reports.test.ts
git commit -m "feat(web): add report query/export/realtime hooks"
```

---

### Task 16: `apps/web/components/reports/report-filter-bar.tsx`

**Files:**
- Create: `apps/web/components/reports/report-filter-bar.tsx`

**Interfaces:**
- Consumes: `useBranches` (`@/hooks/queries/use-branches`), shadcn `Select`/`Input`/`Button`.
- Produces: `<ReportFilterBar />` — consumed by Task 18 (admin page) and Task 19 (supervisor page extension).

This is a pure display component (no data fetching of its own beyond the branch dropdown's list), so it is implemented directly rather than via a red/green TDD cycle — its correctness is exercised through the page-level tests in Tasks 18–19, consistent with how `report-filter-bar`'s sibling components (`kpi-card`, `empty-state`) are tested in this codebase (through their consuming pages, not in isolation).

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/components/reports/report-filter-bar.tsx
'use client';

import { Loader2, Download, FileText, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';

export interface ReportFilterBarProps {
  branchId: string | null;
  onBranchChange: (id: string | null) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  onRefresh: () => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
  isRefreshDisabled: boolean;
  refreshCooldownSeconds: number;
  isExporting: boolean;
  showBranchSelector: boolean;
}

export function ReportFilterBar({
  branchId,
  onBranchChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  onRefresh,
  onExportCsv,
  onExportPdf,
  isRefreshDisabled,
  refreshCooldownSeconds,
  isExporting,
  showBranchSelector,
}: ReportFilterBarProps) {
  // useBranches(filters) takes a single filters argument (no `enabled` gate) — called
  // unconditionally per the rules of hooks; when showBranchSelector is false the fetched
  // list is simply never rendered, which is a cheap, cached, harmless request.
  const { data: branchesData } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-wrap items-end gap-4">
      {showBranchSelector && (
        <div>
          <Label htmlFor="report-filter-branch">Branch</Label>
          <Select value={branchId ?? 'all'} onValueChange={(value) => onBranchChange(value === 'all' ? null : value)}>
            <SelectTrigger id="report-filter-branch" className="w-[200px]">
              <SelectValue placeholder="All Branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="report-filter-from">From</Label>
        <Input id="report-filter-from" type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="report-filter-to">To</Label>
        <Input id="report-filter-to" type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} />
      </div>
      <Button variant="outline" onClick={onRefresh} disabled={isRefreshDisabled}>
        <RotateCw className="mr-2 h-4 w-4" />
        {isRefreshDisabled ? `Refresh (${refreshCooldownSeconds}s)` : 'Refresh'}
      </Button>
      <Button variant="outline" onClick={onExportCsv} disabled={isExporting}>
        {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        Export CSV
      </Button>
      <Button variant="outline" onClick={onExportPdf} disabled={isExporting}>
        {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
        Export PDF
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: 0 new errors from this file (existing unrelated errors, if any, are out of scope).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/reports/report-filter-bar.tsx
git commit -m "feat(web): add ReportFilterBar component"
```

---

### Task 17: `apps/web/components/reports/report-last-updated.tsx`

**Files:**
- Create: `apps/web/components/reports/report-last-updated.tsx`

**Interfaces:**
- Consumes: `formatTimeAgo` (`@/lib/utils`), `REPORT_CACHE_REFRESH_MINUTES` (`@/lib/constants`, already defined, previously unused).
- Produces: `<ReportLastUpdated />` — consumed by Task 18 and Task 19.

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/components/reports/report-last-updated.tsx
import { Skeleton } from '@/components/ui/skeleton';
import { formatTimeAgo } from '@/lib/utils';
import { REPORT_CACHE_REFRESH_MINUTES } from '@/lib/constants';

export interface ReportLastUpdatedProps {
  timestamp: string | undefined;
  isLoading: boolean;
  label?: string;
}

export function ReportLastUpdated({ timestamp, isLoading, label = 'Last updated' }: ReportLastUpdatedProps) {
  if (isLoading) return <Skeleton className="h-4 w-40" />;
  if (!timestamp) return <p className="text-muted-foreground text-xs">Not yet computed</p>;

  return (
    <p className="text-muted-foreground text-xs">
      {label}: {formatTimeAgo(timestamp)}
      <span className="ml-1">(refreshes every {REPORT_CACHE_REFRESH_MINUTES} min)</span>
    </p>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: 0 new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/reports/report-last-updated.tsx
git commit -m "feat(web): add ReportLastUpdated component"
```

---

### Task 18: `apps/web/app/(admin)/admin/reports/page.tsx` — replace the 9-line placeholder

**Files:**
- Modify: `apps/web/app/(admin)/admin/reports/page.tsx`
- Create: `apps/web/app/(admin)/admin/reports/page.test.tsx`

**Interfaces:**
- Consumes: all 13 hooks + `useRequestExport`/`useReportsRealtimeSync` (Task 15), `ReportFilterBar` (Task 16), `ReportLastUpdated` (Task 17), `DataTable`/`KpiCard`/`EmptyState` (existing shared components).

The current file is a 9-line static placeholder with no imports and no `'use client'` — this task replaces it entirely (nothing to preserve).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/app/(admin)/admin/reports/page.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockUseRequestExport = { mutate: vi.fn(), isPending: false };
let realtimeSyncCallback: ((payload: unknown) => void) | undefined;

vi.mock('@/hooks/queries/use-reports', () => {
  const emptyRealtime = { data: undefined, isLoading: false, refetch: vi.fn() };
  const emptyPrecomputed = { data: undefined, isLoading: false, refetch: vi.fn() };
  return {
    useDailySalesReport: vi.fn(() => emptyRealtime),
    useShiftSummaryReport: vi.fn(() => emptyRealtime),
    useCashReconciliationReport: vi.fn(() => emptyRealtime),
    useVoidRefundReport: vi.fn(() => emptyRealtime),
    useDiscountComplianceReport: vi.fn(() => emptyRealtime),
    useInventoryMovementReport: vi.fn(() => emptyRealtime),
    useAttendanceSummaryReport: vi.fn(() => emptyRealtime),
    useFraudAlertSummaryReport: vi.fn(() => emptyRealtime),
    useProductPerformanceReport: vi.fn(() => emptyPrecomputed),
    useFlavorPerformanceReport: vi.fn(() => emptyPrecomputed),
    useEmployeePerformanceReport: vi.fn(() => emptyPrecomputed),
    useInventoryValuationReport: vi.fn(() => emptyPrecomputed),
    useBranchComparisonReport: vi.fn(() => emptyPrecomputed),
    useRequestExport: vi.fn(() => mockUseRequestExport),
    useReportsRealtimeSync: vi.fn((cb: (payload: unknown) => void) => {
      realtimeSyncCallback = cb;
    }),
  };
});
vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: vi.fn(() => ({ data: { branches: [] } })) }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: vi.fn((selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: 'admin-1' } })) }));
vi.mock('@/stores/socket.store', () => ({ useSocketStore: vi.fn((selector: (s: { isConnected: boolean }) => unknown) => selector({ isConnected: true })) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const reportsHooks = await import('@/hooks/queries/use-reports');
const { toast } = await import('sonner');
const { default: AdminReportsPage } = await import('./page.js');

beforeEach(() => {
  vi.clearAllMocks();
  realtimeSyncCallback = undefined;
});

describe('AdminReportsPage', () => {
  it('renders all 13 report tabs', () => {
    render(<AdminReportsPage />);
    const tabLabels = [
      'Daily Sales', 'Shift Summary', 'Cash Reconciliation', 'Void/Refund', 'Discount Compliance',
      'Inventory Movement', 'Attendance Summary', 'Fraud Alert Summary', 'Product Performance',
      'Flavor Performance', 'Employee Performance', 'Inventory Valuation', 'Branch Comparison',
    ];
    for (const label of tabLabels) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
  });

  it('only enables the active tab\'s data hook', () => {
    render(<AdminReportsPage />);
    expect(reportsHooks.useDailySalesReport).toHaveBeenCalledWith(expect.anything(), true);
    expect(reportsHooks.useShiftSummaryReport).toHaveBeenCalledWith(expect.anything(), false);
    expect(reportsHooks.useBranchComparisonReport).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('disables the refresh button for 60 seconds after click, showing a countdown', async () => {
    vi.useFakeTimers();
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(screen.getByRole('button', { name: /refresh \(60s\)/i })).toBeDisabled();

    vi.advanceTimersByTime(1000);
    expect(screen.getByRole('button', { name: /refresh \(59s\)/i })).toBeDisabled();

    vi.useRealTimers();
  });

  it('calls useRequestExport.mutate with format csv on Export CSV click', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useRequestExport.mutate with format pdf on Export PDF click', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useReportsRealtimeSync on mount', () => {
    render(<AdminReportsPage />);
    expect(reportsHooks.useReportsRealtimeSync).toHaveBeenCalled();
  });

  it('shows a download toast when an export-ready payload arrives for the current user', async () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'admin-1', report_type: 'DAILY_SALES', download_url: 'https://signed.example/x.csv' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Export ready', expect.objectContaining({ description: expect.stringContaining('DAILY_SALES') })));
  });

  it('does not show a download toast for another user\'s export', () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'someone-else', report_type: 'DAILY_SALES', download_url: 'https://signed.example/x.csv' });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders an empty state for the active tab when data is empty', () => {
    render(<AdminReportsPage />);
    expect(screen.getByText(/no sales in this range/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton for the active tab', () => {
    vi.mocked(reportsHooks.useDailySalesReport).mockReturnValue({ data: undefined, isLoading: true, refetch: vi.fn() } as never);
    render(<AdminReportsPage />);
    expect(screen.getByText(/not yet computed|last updated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @potato-corner/web exec vitest run "app/(admin)/admin/reports/page.test.tsx"`
Expected: FAIL — the placeholder page has no tabs, no filter bar, no export buttons.

- [ ] **Step 3: Implement the page**

```tsx
// apps/web/app/(admin)/admin/reports/page.tsx
'use client';

import { useEffect, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type {
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  BranchComparisonReportRow,
  ExportReadyPayload,
  ExportRequestInput,
} from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';
import {
  useDailySalesReport,
  useShiftSummaryReport,
  useCashReconciliationReport,
  useVoidRefundReport,
  useDiscountComplianceReport,
  useInventoryMovementReport,
  useAttendanceSummaryReport,
  useFraudAlertSummaryReport,
  useProductPerformanceReport,
  useFlavorPerformanceReport,
  useEmployeePerformanceReport,
  useInventoryValuationReport,
  useBranchComparisonReport,
  useRequestExport,
  useReportsRealtimeSync,
} from '@/hooks/queries/use-reports';

const REFRESH_COOLDOWN_SECONDS = 60;
const DEFAULT_RANGE_DAYS = 7;

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoDateString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const dailySalesColumns: ColumnDef<DailySalesReportRow>[] = [
  { accessorKey: 'report_date', header: 'Date' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'discount_total', header: 'Discounts', cell: ({ row }) => formatCurrency(row.original.discount_total) },
  { accessorKey: 'net_sales', header: 'Net Sales', cell: ({ row }) => formatCurrency(row.original.net_sales) },
  { accessorKey: 'completed_count', header: 'Completed' },
  { accessorKey: 'voided_count', header: 'Voided' },
  { accessorKey: 'refunded_count', header: 'Refunded' },
];

const shiftSummaryColumns: ColumnDef<ShiftSummaryReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'started_at', header: 'Started', cell: ({ row }) => formatDateTime(row.original.started_at) },
  { accessorKey: 'closed_at', header: 'Closed', cell: ({ row }) => (row.original.closed_at ? formatDateTime(row.original.closed_at) : '—') },
  { accessorKey: 'cash_sales_total', header: 'Cash Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total) },
  { accessorKey: 'gcash_sales_total', header: 'GCash Sales', cell: ({ row }) => formatCurrency(row.original.gcash_sales_total) },
  { accessorKey: 'total_transaction_count', header: 'Transactions' },
];

const cashReconciliationColumns: ColumnDef<CashReconciliationReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'opening_counted_total', header: 'Opening', cell: ({ row }) => formatCurrency(row.original.opening_counted_total) },
  {
    accessorKey: 'closing_counted_total',
    header: 'Closing',
    cell: ({ row }) => (row.original.closing_counted_total !== null ? formatCurrency(row.original.closing_counted_total) : '—'),
  },
  {
    accessorKey: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => (row.original.cash_variance !== null ? formatCurrency(row.original.cash_variance) : '—'),
  },
  {
    accessorKey: 'variance_approved',
    header: 'Approved',
    cell: ({ row }) => (row.original.variance_approved === null ? '—' : row.original.variance_approved ? 'Yes' : 'No'),
  },
];

const voidRefundColumns: ColumnDef<VoidRefundReportRow>[] = [
  { accessorKey: 'transaction_number', header: 'Receipt #' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'total_amount', header: 'Amount', cell: ({ row }) => formatCurrency(row.original.total_amount) },
  { accessorKey: 'reason', header: 'Reason', cell: ({ row }) => row.original.reason ?? '—' },
  { accessorKey: 'actioned_by_name', header: 'Actioned By', cell: ({ row }) => row.original.actioned_by_name ?? '—' },
];

const discountComplianceColumns: ColumnDef<DiscountComplianceReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'discount_type', header: 'Discount Type' },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'total_discount_amount', header: 'Total Discount', cell: ({ row }) => formatCurrency(row.original.total_discount_amount) },
];

const inventoryMovementColumns: ColumnDef<InventoryMovementReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'movement_type', header: 'Type' },
  { accessorKey: 'quantity_change', header: 'Change' },
  { accessorKey: 'quantity_after', header: 'Balance After' },
  { accessorKey: 'recorded_by_name', header: 'Recorded By', cell: ({ row }) => row.original.recorded_by_name ?? '—' },
  { accessorKey: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const attendanceSummaryColumns: ColumnDef<AttendanceSummaryReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'clock_in', header: 'Clock In', cell: ({ row }) => formatDateTime(row.original.clock_in) },
  { accessorKey: 'clock_out', header: 'Clock Out', cell: ({ row }) => (row.original.clock_out ? formatDateTime(row.original.clock_out) : '—') },
  { accessorKey: 'actual_work_minutes', header: 'Minutes Worked', cell: ({ row }) => row.original.actual_work_minutes ?? '—' },
  { accessorKey: 'status', header: 'Status' },
];

const fraudAlertSummaryColumns: ColumnDef<FraudAlertSummaryReportRow>[] = [
  { accessorKey: 'alert_type', header: 'Type' },
  { accessorKey: 'severity', header: 'Severity' },
  { accessorKey: 'branch_name', header: 'Branch', cell: ({ row }) => row.original.branch_name ?? 'All Branches' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'created_at', header: 'Created', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const productPerformanceColumns: ColumnDef<ProductPerformanceReportRow>[] = [
  { accessorKey: 'product_name', header: 'Product' },
  { accessorKey: 'variant_name', header: 'Variant' },
  { accessorKey: 'units_sold', header: 'Units Sold' },
  { accessorKey: 'gross_revenue', header: 'Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const flavorPerformanceColumns: ColumnDef<FlavorPerformanceReportRow>[] = [
  { accessorKey: 'flavor_name', header: 'Flavor' },
  { accessorKey: 'units_sold', header: 'Units Sold' },
  { accessorKey: 'gross_revenue', header: 'Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const employeePerformanceColumns: ColumnDef<EmployeePerformanceReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'hours_worked', header: 'Hours Worked' },
];

const inventoryValuationColumns: ColumnDef<InventoryValuationReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { accessorKey: 'unit', header: 'Unit' },
  { accessorKey: 'current_stock', header: 'Current Stock' },
  { accessorKey: 'unit_cost', header: 'Unit Cost', cell: ({ row }) => (row.original.unit_cost !== null ? formatCurrency(row.original.unit_cost) : '—') },
  { accessorKey: 'total_value', header: 'Total Value', cell: ({ row }) => formatCurrency(row.original.total_value) },
  { accessorKey: 'status', header: 'Status' },
];

const branchComparisonColumns: ColumnDef<BranchComparisonReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'active_shift_count', header: 'Active Shifts' },
  { accessorKey: 'low_stock_ingredient_count', header: 'Low Stock Items' },
];

export default function AdminReportsPage() {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSocketConnected = useSocketStore((s) => s.isConnected);

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => todayDateString());
  const [activeTab, setActiveTab] = useState('DAILY_SALES');
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const requestExport = useRequestExport();

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${payload.report_type} export is ready`,
      action: { label: 'Download', onClick: () => window.open(payload.download_url, '_blank') },
      duration: 30_000,
    });
    setIsExporting(false);
  });

  useEffect(() => {
    if (!refreshDisabled) return;
    if (refreshCooldown <= 0) {
      setRefreshDisabled(false);
      return;
    }
    const timer = setInterval(() => setRefreshCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshDisabled, refreshCooldown]);

  const realtimeFilters = { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };

  const dailySales = useDailySalesReport(realtimeFilters, activeTab === 'DAILY_SALES');
  const shiftSummary = useShiftSummaryReport(realtimeFilters, activeTab === 'SHIFT_SUMMARY');
  const cashReconciliation = useCashReconciliationReport(realtimeFilters, activeTab === 'CASH_RECONCILIATION');
  const voidRefund = useVoidRefundReport(realtimeFilters, activeTab === 'VOID_REFUND');
  const discountCompliance = useDiscountComplianceReport(realtimeFilters, activeTab === 'DISCOUNT_COMPLIANCE');
  const inventoryMovement = useInventoryMovementReport(realtimeFilters, activeTab === 'INVENTORY_MOVEMENT');
  const attendanceSummary = useAttendanceSummaryReport(realtimeFilters, activeTab === 'ATTENDANCE_SUMMARY');
  const fraudAlertSummary = useFraudAlertSummaryReport(realtimeFilters, activeTab === 'FRAUD_ALERT_SUMMARY');
  const productPerformance = useProductPerformanceReport(selectedBranchId ?? undefined, activeTab === 'PRODUCT_PERFORMANCE');
  const flavorPerformance = useFlavorPerformanceReport(selectedBranchId ?? undefined, activeTab === 'FLAVOR_PERFORMANCE');
  const employeePerformance = useEmployeePerformanceReport(selectedBranchId ?? undefined, activeTab === 'EMPLOYEE_PERFORMANCE');
  const inventoryValuation = useInventoryValuationReport(selectedBranchId ?? undefined, activeTab === 'INVENTORY_VALUATION');
  const branchComparison = useBranchComparisonReport(selectedBranchId ?? undefined, activeTab === 'BRANCH_COMPARISON');

  const activeQueryByTab: Record<string, { refetch: () => void }> = {
    DAILY_SALES: dailySales,
    SHIFT_SUMMARY: shiftSummary,
    CASH_RECONCILIATION: cashReconciliation,
    VOID_REFUND: voidRefund,
    DISCOUNT_COMPLIANCE: discountCompliance,
    INVENTORY_MOVEMENT: inventoryMovement,
    ATTENDANCE_SUMMARY: attendanceSummary,
    FRAUD_ALERT_SUMMARY: fraudAlertSummary,
    PRODUCT_PERFORMANCE: productPerformance,
    FLAVOR_PERFORMANCE: flavorPerformance,
    EMPLOYEE_PERFORMANCE: employeePerformance,
    INVENTORY_VALUATION: inventoryValuation,
    BRANCH_COMPARISON: branchComparison,
  };

  function handleRefresh() {
    activeQueryByTab[activeTab]?.refetch();
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    setIsExporting(true);
    const input: ExportRequestInput = {
      report_type: activeTab as ExportRequestInput['report_type'],
      filters: { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 },
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-muted-foreground text-sm">Real-time and pre-computed reporting across all branches.</p>
        </div>
        <span
          className={`h-2 w-2 rounded-full ${isSocketConnected ? 'bg-green-500' : 'bg-red-500'}`}
          title={isSocketConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      <ReportFilterBar
        branchId={selectedBranchId}
        onBranchChange={setSelectedBranchId}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onRefresh={handleRefresh}
        onExportCsv={() => handleExport('csv')}
        onExportPdf={() => handleExport('pdf')}
        isRefreshDisabled={refreshDisabled}
        refreshCooldownSeconds={refreshCooldown}
        isExporting={isExporting}
        showBranchSelector
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="DAILY_SALES">Daily Sales</TabsTrigger>
          <TabsTrigger value="SHIFT_SUMMARY">Shift Summary</TabsTrigger>
          <TabsTrigger value="CASH_RECONCILIATION">Cash Reconciliation</TabsTrigger>
          <TabsTrigger value="VOID_REFUND">Void/Refund</TabsTrigger>
          <TabsTrigger value="DISCOUNT_COMPLIANCE">Discount Compliance</TabsTrigger>
          <TabsTrigger value="INVENTORY_MOVEMENT">Inventory Movement</TabsTrigger>
          <TabsTrigger value="ATTENDANCE_SUMMARY">Attendance Summary</TabsTrigger>
          <TabsTrigger value="FRAUD_ALERT_SUMMARY">Fraud Alert Summary</TabsTrigger>
          <TabsTrigger value="PRODUCT_PERFORMANCE">Product Performance</TabsTrigger>
          <TabsTrigger value="FLAVOR_PERFORMANCE">Flavor Performance</TabsTrigger>
          <TabsTrigger value="EMPLOYEE_PERFORMANCE">Employee Performance</TabsTrigger>
          <TabsTrigger value="INVENTORY_VALUATION">Inventory Valuation</TabsTrigger>
          <TabsTrigger value="BRANCH_COMPARISON">Branch Comparison</TabsTrigger>
        </TabsList>

        <TabsContent value="DAILY_SALES">
          <ReportLastUpdated timestamp={dailySales.data?.generated_at} isLoading={dailySales.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Gross Sales" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Completed" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.completed_count, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Voided" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.voided_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
            <KpiCard title="Refunded" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.refunded_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
          </div>
          <DataTable columns={dailySalesColumns} data={dailySales.data?.data ?? []} isLoading={dailySales.isLoading} emptyState={<EmptyState title="No sales in this range" />} />
        </TabsContent>

        <TabsContent value="SHIFT_SUMMARY">
          <ReportLastUpdated timestamp={shiftSummary.data?.generated_at} isLoading={shiftSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Shifts" value={(shiftSummary.data?.data ?? []).length} isLoading={shiftSummary.isLoading} />
            <KpiCard title="Cash Sales" value={(shiftSummary.data?.data ?? []).reduce((sum, r) => sum + r.cash_sales_total, 0)} isLoading={shiftSummary.isLoading} />
            <KpiCard title="GCash Sales" value={(shiftSummary.data?.data ?? []).reduce((sum, r) => sum + r.gcash_sales_total, 0)} isLoading={shiftSummary.isLoading} />
          </div>
          <DataTable columns={shiftSummaryColumns} data={shiftSummary.data?.data ?? []} isLoading={shiftSummary.isLoading} emptyState={<EmptyState title="No shifts in this range" />} />
        </TabsContent>

        <TabsContent value="CASH_RECONCILIATION">
          <ReportLastUpdated timestamp={cashReconciliation.data?.generated_at} isLoading={cashReconciliation.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Closed/Flagged Shifts" value={(cashReconciliation.data?.data ?? []).length} isLoading={cashReconciliation.isLoading} />
            <KpiCard
              title="Flagged"
              value={(cashReconciliation.data?.data ?? []).filter((r) => r.status === 'flagged').length}
              isLoading={cashReconciliation.isLoading}
              tone="danger"
            />
            <KpiCard
              title="Unapproved Variance"
              value={(cashReconciliation.data?.data ?? []).filter((r) => r.cash_variance !== null && r.cash_variance !== 0 && !r.variance_approved).length}
              isLoading={cashReconciliation.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={cashReconciliationColumns}
            data={cashReconciliation.data?.data ?? []}
            isLoading={cashReconciliation.isLoading}
            emptyState={<EmptyState title="No closed or flagged shifts in this range" />}
          />
        </TabsContent>

        <TabsContent value="VOID_REFUND">
          <ReportLastUpdated timestamp={voidRefund.data?.generated_at} isLoading={voidRefund.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Voided" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'voided').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Refunded" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'refunded').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Total Amount" value={(voidRefund.data?.data ?? []).reduce((sum, r) => sum + r.total_amount, 0)} isLoading={voidRefund.isLoading} tone="warning" />
          </div>
          <DataTable columns={voidRefundColumns} data={voidRefund.data?.data ?? []} isLoading={voidRefund.isLoading} emptyState={<EmptyState title="No voids or refunds in this range" />} />
        </TabsContent>

        <TabsContent value="DISCOUNT_COMPLIANCE">
          <ReportLastUpdated timestamp={discountCompliance.data?.generated_at} isLoading={discountCompliance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Discounted Transactions" value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.transaction_count, 0)} isLoading={discountCompliance.isLoading} />
            <KpiCard title="Total Discount" value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.total_discount_amount, 0)} isLoading={discountCompliance.isLoading} />
          </div>
          <DataTable
            columns={discountComplianceColumns}
            data={discountCompliance.data?.data ?? []}
            isLoading={discountCompliance.isLoading}
            emptyState={<EmptyState title="No discounted transactions in this range" />}
          />
        </TabsContent>

        <TabsContent value="INVENTORY_MOVEMENT">
          <ReportLastUpdated timestamp={inventoryMovement.data?.generated_at} isLoading={inventoryMovement.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Movements" value={(inventoryMovement.data?.data ?? []).length} isLoading={inventoryMovement.isLoading} />
            <KpiCard
              title="Waste Events"
              value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'waste').length}
              isLoading={inventoryMovement.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={inventoryMovementColumns}
            data={inventoryMovement.data?.data ?? []}
            isLoading={inventoryMovement.isLoading}
            emptyState={<EmptyState title="No inventory movements in this range" />}
          />
        </TabsContent>

        <TabsContent value="ATTENDANCE_SUMMARY">
          <ReportLastUpdated timestamp={attendanceSummary.data?.generated_at} isLoading={attendanceSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Records" value={(attendanceSummary.data?.data ?? []).length} isLoading={attendanceSummary.isLoading} />
            <KpiCard
              title="Total Overtime Minutes"
              value={(attendanceSummary.data?.data ?? []).reduce((sum, r) => sum + r.overtime_minutes, 0)}
              isLoading={attendanceSummary.isLoading}
            />
          </div>
          <DataTable
            columns={attendanceSummaryColumns}
            data={attendanceSummary.data?.data ?? []}
            isLoading={attendanceSummary.isLoading}
            emptyState={<EmptyState title="No attendance records in this range" />}
          />
        </TabsContent>

        <TabsContent value="FRAUD_ALERT_SUMMARY">
          <ReportLastUpdated timestamp={fraudAlertSummary.data?.generated_at} isLoading={fraudAlertSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Alerts" value={(fraudAlertSummary.data?.data ?? []).length} isLoading={fraudAlertSummary.isLoading} />
            <KpiCard
              title="Critical/High"
              value={(fraudAlertSummary.data?.data ?? []).filter((r) => r.severity === 'critical' || r.severity === 'high').length}
              isLoading={fraudAlertSummary.isLoading}
              tone="danger"
            />
          </div>
          <DataTable
            columns={fraudAlertSummaryColumns}
            data={fraudAlertSummary.data?.data ?? []}
            isLoading={fraudAlertSummary.isLoading}
            emptyState={<EmptyState title="No fraud alerts in this range" />}
          />
        </TabsContent>

        <TabsContent value="PRODUCT_PERFORMANCE">
          <ReportLastUpdated timestamp={productPerformance.data?.computed_at} isLoading={productPerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Products" value={(productPerformance.data?.data ?? []).length} isLoading={productPerformance.isLoading} />
            <KpiCard title="Total Revenue" value={(productPerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_revenue, 0)} isLoading={productPerformance.isLoading} />
          </div>
          <DataTable
            columns={productPerformanceColumns}
            data={productPerformance.data?.data ?? []}
            isLoading={productPerformance.isLoading}
            emptyState={<EmptyState title="No product sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="FLAVOR_PERFORMANCE">
          <ReportLastUpdated timestamp={flavorPerformance.data?.computed_at} isLoading={flavorPerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Flavors" value={(flavorPerformance.data?.data ?? []).length} isLoading={flavorPerformance.isLoading} />
            <KpiCard title="Total Revenue" value={(flavorPerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_revenue, 0)} isLoading={flavorPerformance.isLoading} />
          </div>
          <DataTable
            columns={flavorPerformanceColumns}
            data={flavorPerformance.data?.data ?? []}
            isLoading={flavorPerformance.isLoading}
            emptyState={<EmptyState title="No flavor sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="EMPLOYEE_PERFORMANCE">
          <ReportLastUpdated timestamp={employeePerformance.data?.computed_at} isLoading={employeePerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Employees" value={(employeePerformance.data?.data ?? []).length} isLoading={employeePerformance.isLoading} />
            <KpiCard title="Total Sales" value={(employeePerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={employeePerformance.isLoading} />
          </div>
          <DataTable
            columns={employeePerformanceColumns}
            data={employeePerformance.data?.data ?? []}
            isLoading={employeePerformance.isLoading}
            emptyState={<EmptyState title="No employee sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="INVENTORY_VALUATION">
          <ReportLastUpdated timestamp={inventoryValuation.data?.computed_at} isLoading={inventoryValuation.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Ingredients" value={(inventoryValuation.data?.data ?? []).length} isLoading={inventoryValuation.isLoading} />
            <KpiCard title="Total Value" value={(inventoryValuation.data?.data ?? []).reduce((sum, r) => sum + r.total_value, 0)} isLoading={inventoryValuation.isLoading} />
            <KpiCard
              title="Low/Critical"
              value={(inventoryValuation.data?.data ?? []).filter((r) => r.status !== 'ok').length}
              isLoading={inventoryValuation.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={inventoryValuationColumns}
            data={inventoryValuation.data?.data ?? []}
            isLoading={inventoryValuation.isLoading}
            emptyState={<EmptyState title="No ingredients found" />}
          />
        </TabsContent>

        <TabsContent value="BRANCH_COMPARISON">
          <ReportLastUpdated timestamp={branchComparison.data?.computed_at} isLoading={branchComparison.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Branches" value={(branchComparison.data?.data ?? []).length} isLoading={branchComparison.isLoading} />
            <KpiCard title="Total Sales" value={(branchComparison.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={branchComparison.isLoading} />
            <KpiCard title="Active Shifts" value={(branchComparison.data?.data ?? []).reduce((sum, r) => sum + r.active_shift_count, 0)} isLoading={branchComparison.isLoading} />
          </div>
          <DataTable
            columns={branchComparisonColumns}
            data={branchComparison.data?.data ?? []}
            isLoading={branchComparison.isLoading}
            emptyState={<EmptyState title="No branch data available" />}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @potato-corner/web exec vitest run "app/(admin)/admin/reports/page.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(admin)/admin/reports/page.tsx" "apps/web/app/(admin)/admin/reports/page.test.tsx"
git commit -m "feat(web): build admin reports page with 13 tabs, export, and refresh"
```

---

### Task 19: Extend `apps/web/app/(supervisor)/supervisor/reports/page.tsx` (do not rebuild)

**Files:**
- Modify: `apps/web/app/(supervisor)/supervisor/reports/page.tsx` (505 lines — read in full first; every edit below is additive/targeted, the existing 7 tabs' data-fetching queries at lines 256–281 are never touched)
- Modify: `apps/web/app/(supervisor)/supervisor/reports/page.test.tsx` (extend — do not remove existing tests)

**Interfaces:**
- Consumes: `useRequestExport`/`useReportsRealtimeSync` (Task 15), `ReportLastUpdated` (Task 17).

**Design note — why this task does *not* use `<ReportFilterBar>` wholesale:** `ReportFilterBar` has no "Apply" step — `onDateFromChange`/`onDateToChange` fire immediately. This page's existing flow deliberately decouples typed date input (`fromInput`/`toInput`) from the value that actually drives the 7 queries (`dateRange`), gated behind a button click, specifically so typing a date doesn't refetch until the user is done. Swapping in `ReportFilterBar` as-is would either break that gate or require changing the query-triggering logic — both violate "do not change existing data-fetching logic." Instead: the existing "Apply" button is renamed **"Refresh"** and takes on the 60-second cooldown (it already was the thing that re-triggers fetching by updating `dateRange` — a manual refetch trigger under a new name is not a change in fetching behavior, just consolidating two buttons into one). Export CSV/PDF buttons are added standalone next to it.

- [ ] **Step 1: Write the failing test additions** (append to `page.test.tsx` — the existing mocks/helpers from the current file stay as-is; add these alongside them, following the same `vi.hoisted` pattern)

```ts
// Add to the vi.hoisted(...) block's returned object, alongside the existing mocks:
mockUseRequestExport: vi.fn(),
mockUseReportsRealtimeSync: vi.fn(),

// Add a new vi.mock alongside the existing ones:
vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: mockUseRequestExport,
  useReportsRealtimeSync: mockUseReportsRealtimeSync,
}));

// In the test bodies below, mockUseRequestExport.mockReturnValue({ mutate: vi.fn(), isPending: false })
// must be set in beforeEach (or per-test) the same way the existing mocks are — see the current
// beforeEach block in page.test.tsx for the pattern to follow.

describe('export controls', () => {
  it('renders Export CSV and Export PDF buttons', () => {
    render(<SupervisorReportsPage />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export pdf/i })).toBeInTheDocument();
  });

  it('calls useRequestExport().mutate with format csv and the active tab report_type on Export CSV click', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useRequestExport().mutate with format pdf on Export PDF click', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' }), expect.anything());
  });
});

describe('refresh cooldown', () => {
  it('disables the Refresh button for 60 seconds after click', () => {
    vi.useFakeTimers();
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /^refresh/i }));

    expect(screen.getByRole('button', { name: /refresh \(60s\)/i })).toBeDisabled();
    vi.useRealTimers();
  });
});

describe('realtime sync', () => {
  it('calls useReportsRealtimeSync on mount', () => {
    render(<SupervisorReportsPage />);
    expect(mockUseReportsRealtimeSync).toHaveBeenCalled();
  });
});

describe('branch selector', () => {
  it('does not render a branch selector (branch is implicit from useBranchStore)', () => {
    render(<SupervisorReportsPage />);
    expect(screen.queryByLabelText(/branch/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests, verify the new ones fail**

Run: `pnpm --filter @potato-corner/web exec vitest run "app/(supervisor)/supervisor/reports/page.test.tsx"`
Expected: existing tests still PASS; new ones FAIL (no Export/Refresh-with-cooldown UI exists yet).

- [ ] **Step 3: Apply the targeted edits to `page.tsx`**

Add imports (after the existing `useEmployees` import on line 22):

```tsx
import { useAuthStore } from '@/stores/auth.store';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { useRequestExport, useReportsRealtimeSync } from '@/hooks/queries/use-reports';
import type { ExportRequestInput, ExportReadyPayload } from '@potato-corner/shared';
import { toast } from 'sonner';
```

Add a tab-id-to-report-type map (after the `REFRESH_COOLDOWN_SECONDS` constant you add below `QUERY_LIMIT`):

```tsx
const REFRESH_COOLDOWN_SECONDS = 60;

const TAB_TO_REPORT_TYPE: Record<string, ExportRequestInput['report_type']> = {
  'daily-sales': 'DAILY_SALES',
  'shift-summary': 'SHIFT_SUMMARY',
  'cash-reconciliation': 'CASH_RECONCILIATION',
  'void-refund': 'VOID_REFUND',
  'discount-compliance': 'DISCOUNT_COMPLIANCE',
  'inventory-movement': 'INVENTORY_MOVEMENT',
  'attendance-summary': 'ATTENDANCE_SUMMARY',
};
```

Inside the component, after the existing realtime-sync hook calls (`useShiftsRealtimeSync(); ... useAttendanceRealtimeSync();`), add:

```tsx
  const currentUserId = useAuthStore((s) => s.user?.id);
  const requestExport = useRequestExport();
  const [activeTab, setActiveTab] = useState('daily-sales');
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${payload.report_type} export is ready`,
      action: { label: 'Download', onClick: () => window.open(payload.download_url, '_blank') },
      duration: 30_000,
    });
  });

  useEffect(() => {
    if (!refreshDisabled) return;
    if (refreshCooldown <= 0) {
      setRefreshDisabled(false);
      return;
    }
    const timer = setInterval(() => setRefreshCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshDisabled, refreshCooldown]);
```

(Add `useEffect` to the existing `import { useState } from 'react';` on line 3, making it `import { useEffect, useState } from 'react';`.)

Replace `function applyDateRange() { setDateRange({ from: fromInput, to: toInput }); }` with a renamed, cooldown-aware version:

```tsx
  function handleRefresh() {
    setDateRange({ from: fromInput, to: toInput });
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    const input: ExportRequestInput = {
      report_type: TAB_TO_REPORT_TYPE[activeTab] ?? 'DAILY_SALES',
      filters: { branch_id: activeBranchId ?? undefined, date_from: dateRange.from, date_to: dateRange.to, page: 1, limit: QUERY_LIMIT },
      format,
    };
    requestExport.mutate(input);
  }
```

Replace the date-range/Apply block (lines 358–368) with the same date inputs plus Refresh (renamed) and the two Export buttons:

```tsx
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="reports-from">From</Label>
          <Input id="reports-from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="reports-to">To</Label>
          <Input id="reports-to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />
        </div>
        <Button onClick={handleRefresh} disabled={refreshDisabled}>
          {refreshDisabled ? `Refresh (${refreshCooldown}s)` : 'Refresh'}
        </Button>
        <Button variant="outline" onClick={() => handleExport('csv')} disabled={requestExport.isPending}>
          Export CSV
        </Button>
        <Button variant="outline" onClick={() => handleExport('pdf')} disabled={requestExport.isPending}>
          Export PDF
        </Button>
      </div>
```

Make the `Tabs` component controlled, so `activeTab` tracks which report is showing (replace `<Tabs defaultValue="daily-sales" className="space-y-4">` with):

```tsx
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
```

Add a `<ReportLastUpdated>` line as the first child of each of the 7 `TabsContent` blocks, sourcing the timestamp from that tab's query `dataUpdatedAt` (a standard TanStack Query field — no backend change needed since this page's tabs stay on the client-composed real-time tier). Example for the `daily-sales` tab (repeat the same one-line addition, with the matching query variable, for the other 6: `allShiftsQuery`, `closedShiftsQuery`, `voidedQuery`/`refundedQuery` combined, `completedQuery` again for discount-compliance, `movementsQuery`, `attendanceQuery`):

```tsx
        <TabsContent value="daily-sales" className="space-y-4">
          <ReportLastUpdated
            timestamp={completedQuery.dataUpdatedAt ? new Date(completedQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={completedQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
```

- [ ] **Step 4: Run the tests, verify they all pass**

Run: `pnpm --filter @potato-corner/web exec vitest run "app/(supervisor)/supervisor/reports/page.test.tsx"`
Expected: PASS — all pre-existing tests plus the new ones from Step 1.

- [ ] **Step 5: Update the scope-lock JSDoc comment** (lines 224–241) to reflect that export/refresh/realtime are now layered on top — replace the sentence `"...no new backend endpoints, no pre-computed snapshots, no export."` with:

```
 * (Phase 16 note: export, manual refresh with a cooldown, and export-ready
 * realtime notifications are layered on top via the new /api/reports/export
 * endpoint — the 7 tabs' underlying data still come from this lightweight
 * client-composed tier, unchanged.)
```

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(supervisor)/supervisor/reports/page.tsx" "apps/web/app/(supervisor)/supervisor/reports/page.test.tsx"
git commit -m "feat(web): add export, refresh cooldown, and realtime sync to supervisor reports page"
```

---

## Quality Gates (run after Task 19, before considering Phase 16 done)

- [ ] `pnpm --filter @potato-corner/api exec prisma migrate dev --name phase16_report_snapshots` applies cleanly (Task 1)
- [ ] `pnpm --filter @potato-corner/api exec prisma generate` — 0 errors
- [ ] `pnpm --filter @potato-corner/shared build` — 0 errors
- [ ] `pnpm --filter @potato-corner/api test` — all report-module tests plus every pre-existing test pass, 0 failed
- [ ] `pnpm --filter @potato-corner/web test` — all report-page/hook tests plus every pre-existing test pass, 0 failed
- [ ] `pnpm --filter @potato-corner/api exec tsc --noEmit` — 0 errors
- [ ] `pnpm --filter @potato-corner/web exec tsc --noEmit` — 0 errors
- [ ] `pnpm --filter @potato-corner/api exec eslint .` and `pnpm --filter @potato-corner/web exec eslint .` — 0 errors
- [ ] `/admin/reports` renders all 13 tabs (verify manually or via Task 18's test)
- [ ] `/supervisor/reports` retains its original 7 tabs' data-fetching untouched, plus gains export/refresh/realtime controls (Task 19)
- [ ] `GET /api/reports/fraud-alert-summary` returns 403 for a supervisor token
- [ ] `GET /api/reports/branch-comparison` returns 403 for a supervisor token
- [ ] `POST /api/reports/export` with `format: 'csv'` and `count < 10000` returns `{ download_url, expires_at }` synchronously
- [ ] `POST /api/reports/export` with `format: 'pdf'` returns `{ job_id, message, estimated_seconds }`
- [ ] `report_snapshots` table exists in the local database after migration
- [ ] `REPORT_EXPORT_READY`/`REPORT_EXPORT_FAILED` present in `packages/shared/src/constants/events.ts`
- [ ] `@react-pdf/renderer` present in `apps/api/package.json`
- [ ] No raw SQL anywhere in the reports module (`grep -rn "\$queryRaw\|\$executeRaw" apps/api/src/modules/reports apps/api/src/queues/report.queue.ts` returns nothing)
- [ ] `AuditLog` written on every report view (`REPORT_ACCESSED`) and every export (`REPORT_EXPORTED`) — spot-check via the repository/service tests' `recordAuditLog` assertions

## Self-Review Notes (spec coverage, fixed during planning)

- **Spec coverage:** all 13 report types (Task 3 schemas, Tasks 5–6 repository, Tasks 10–11 service, Task 13 router), export sync/async CSV + async PDF (Task 12, Task 14), Socket.io push + Sonner toast (Tasks 14–15, 18–19), 15-minute stale-while-revalidate (Task 11), manual-refresh 60s client cooldown (Tasks 18–19), audit logging on every view/export (Tasks 10–12, 14), `@react-pdf/renderer` dependency (Task 7), migration (Task 1), admin page 13 tabs (Task 18), supervisor page extension without touching existing data-fetching (Task 19) — all present.
- **Fixed during planning (see "Corrections to the original spec" at the top):** `requireRole` → `adminOnly`; `apps/web/lib/api.ts` → `apps/web/lib/api-client.ts`; `DataTable` barrel path; `useRealtimeInvalidate`'s lack of a payload callback → direct `useSocket()` subscription in `useReportsRealtimeSync`; `branchGuard` incompatibility with `POST /export`'s nested `filters.branch_id` body shape → inline branch check (Task 13); `Ingredient.currentStock` staleness → derive from summed `InventoryMovement.quantityChange` (Tasks 6, 11); missing super-admin-only enforcement on `POST /export` → `SUPER_ADMIN_ONLY_TYPES` check added in Task 12; `useBranches` has no `enabled` parameter → fixed in Task 16.
- **No placeholder scan:** every task's code steps contain complete, real implementations — no `TODO`, no "similar to Task N," no elided logic. The one deliberately-abbreviated area is Task 19's `TabsContent` edits, which give one full worked example (`daily-sales`) and name the exact query variable to substitute for the other six — each substitution is a one-line, mechanical repetition of the same pattern, not an unspecified step.
- **Type consistency check:** `ReportFilters` (Task 4: `{ branchId?, dateFrom?, dateTo?, page, limit }`) is used identically across Tasks 5, 6, 10, 11, 12, 13, 14. `ReportColumn<T>` (Task 4) is used identically in Tasks 8, 9, 12, 14. `ReportType` string values match exactly between the Prisma enum (Task 1), the shared `REPORT_TYPE` const (Task 2), and every `switch`/`Record` keyed by it (Tasks 6, 8, 13, 15, 18, 19).

---
