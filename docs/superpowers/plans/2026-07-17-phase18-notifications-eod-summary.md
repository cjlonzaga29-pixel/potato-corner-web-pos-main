# Phase 18 — Notifications & EOD Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-0 `notifications` module skeleton and the dead-code branches of `notification.queue.ts` into the full Part 13 notification system — all 11 notification types persisted to a new `Notification` table, read/dismiss API endpoints, a nightly EOD summary service (23:59 Asia/Manila) that reuses existing reports/fraud/cash logic rather than re-deriving it, and Resend email delivery for the three types the locked decisions select (fraud alert, EOD summary, large adjustment approval).

**Architecture:** `notification.queue.ts` (currently: two real handlers — `employee_welcome`, `low_stock_alert` — plus two stub handlers that only `console.log`/`console.warn`, plus a catch-all TODO) becomes the single BullMQ consumer for all 11 notification job types; each handler persists a `Notification` row via a new `notifications.repository.ts`, emits the existing `SOCKET_EVENTS` constant for that type, and — for the three selected types — calls a new `apps/api/src/lib/email.ts` sender through Resend. A new `eod-summary.service.ts` (its own file, not folded into `reports.service.ts`) runs once nightly, calling into `reportsRepository.getDailySales`, `fraudRepository.findOpenAlertsByType`-style queries, and `cashRepository`'s variance-approval fields to assemble the summary payload, then enqueues one `eod_summary` job per Super Admin. The nightly cron is registered in `fraud.queue.ts`'s pattern (a second `scheduleNightly*` function, same file family) but fires at `23:59 Asia/Manila`, one minute after the fraud scan's `23:00` slot, so the EOD summary's "open fraud alerts created today" figure reflects that night's fraud run. `notifications.router.ts` gains three routes (list, mark-read, mark-all-read) following every other module's thin-router-calls-service pattern.

**Tech Stack:** Express 5, Prisma 5.x/PostgreSQL, BullMQ 5.x + Upstash Redis, Zod 4, Vitest 3, Resend (already integrated in `apps/api/src/lib/email.ts` for password-reset and welcome email).

## Global Constraints

- TypeScript strict mode, no `any`, no `!` without a comment explaining why it's safe.
- No raw SQL anywhere — Prisma only, migrations are the one place hand-written SQL is expected (Prisma-generated DDL).
- No direct Prisma calls outside a module's own `*.repository.ts` file — this plan adds all persistence through `notifications.repository.ts`; the EOD service reads through the existing `reportsRepository`/`fraudRepository`/`cashRepository`, never a raw Prisma client.
- snake_case in every JSON response field; camelCase in TypeScript; kebab-case file names.
- Conventional commits (`feat|fix|test|refactor`, imperative mood), one commit per task as shown.
- Backoff for the notification queue's job types: `[10_000, 60_000, 300_000]` ms, `attempts: 3`, `backoff: { type: 'custom' }` — identical to `inventory.queue.ts`'s `RETRY_DELAYS_MS`/`retryDelayMs` pattern (Decision 7).
- Nightly EOD cron fires at `23:59 Asia/Manila`, registered after the fraud queue's `23:00 Asia/Manila` scan in the boot sequence (Decision 5), so "open fraud alerts created that day" (Architecture doc Part 13) reflects that night's fraud run.
- `RESEND_API_KEY` remains optional (mirrors the existing `sendPasswordResetEmail`/`sendWelcomeEmail` dev-log fallback) — no new required env var this plan needs to introduce for email itself.
- In-app notifications persist to a DB table (Decision 3); they are never socket-only or queue-only — every one of the 11 types writes a `Notification` row before/alongside its socket emission.

---

## 1. Decisions Locked

| # | Decision | Value |
|---|---|---|
| 1 | Email transport provider | Resend (already wired into `apps/api/src/lib/email.ts`) |
| 2 | Email-delivered notification types | Fraud alert, EOD summary, Large adjustment approval — all other 8 types are in-app/WebSocket only |
| 3 | In-app persistence | New `Notification` DB table (Prisma model), not ephemeral socket-only delivery |
| 4 | Read/dismiss endpoints | In scope for Phase 18 (`GET /list`, `PATCH /:id/read`, `PATCH /read-all`) |
| 5 | EOD cron timing | `23:59 Asia/Manila`, nightly |
| 6 | EOD scope | A separate `eod-summary.service.ts`, reusing `reportsRepository`/`fraudRepository`/`cashRepository` query logic rather than re-implementing revenue/void/variance/fraud aggregation |
| 7 | Retry policy | Match `inventory.queue.ts`: `[10_000, 60_000, 300_000]` ms backoff, 3 attempts |
| 8 | `inventory_product_unavailable` handler | Audit-and-fix first (Task 4) — it is currently a `console.warn`-only stub per its own `TODO(Phase 18)` comment; bring it to the same shape as the other 10 handlers before adding new ones |

The 11 notification types (Architecture doc Part 13): `low_stock`, `critical_stock`, `out_of_stock`, `product_auto_unavailable`, `cash_variance_flagged`, `void_requested`, `large_adjustment_approval_needed`, `fraud_alert_created`, `inventory_deduction_failed`, `offline_transactions_synced`, `eod_summary`.

---

### Task 2: Notification payload TypeScript interfaces (all 11 types)

**Dependencies:** Task 1 (this document).

**Files:**
- Modify: `apps/api/src/modules/notifications/notifications.types.ts`

**Interfaces:**
- Produces: one payload interface per notification type, a `NotificationType` union, and a discriminated-union `NotificationPayload` consumed by Task 3's Prisma model (`payload: Json`) and Task 6's queue handlers.

Description: Define the 11 payload shapes (`LowStockPayload` … `EodSummaryPayload`) plus `NotificationType`/`NotificationPayload` in `notifications.types.ts`, matching the field names already used by the existing `LowStockAlertJobData`/`InventoryProductUnavailableJobData` shapes in `notification.queue.ts` so Task 6 can reuse them without renaming.
Acceptance criteria: `pnpm --filter @potato-corner/api run type-check` passes with the new exports and zero `any`.
Estimated effort: 0.5 day.

- [ ] **Step 1: Confirm existing job-data shapes to avoid inventing a second name for the same field set**

Run:
```bash
grep -n "interface.*JobData" apps/api/src/queues/notification.queue.ts
```
Expected: `EmployeeWelcomeJobData`, `LowStockAlertJobData`, `InventoryDeductionFailedJobData`, `InventoryProductUnavailableJobData` — the new payload interfaces for these 3 overlapping types (`low_stock`/`critical_stock` share `LowStockAlertJobData`'s shape, `inventory_deduction_failed`, `product_auto_unavailable`) must match these field-for-field so Task 6 can import one interface instead of keeping two parallel shapes.

- [ ] **Step 2: Add `NotificationType` union and the 11 payload interfaces to `notifications.types.ts`**

Pseudocode (shape only — see Step 1's confirmed fields for the 3 that already exist as job-data interfaces):
```ts
export type NotificationType =
  | 'low_stock' | 'critical_stock' | 'out_of_stock' | 'product_auto_unavailable'
  | 'cash_variance_flagged' | 'void_requested' | 'large_adjustment_approval_needed'
  | 'fraud_alert_created' | 'inventory_deduction_failed' | 'offline_transactions_synced'
  | 'eod_summary';

export interface EodSummaryPayload {
  evaluationDate: string;           // ISO date, Manila calendar day
  totalRevenue: number;             // company-wide
  branchRevenue: { branchId: string; branchCode: string; revenue: number }[];
  transactionCount: number;
  voidCount: number;
  unresolvedCashVarianceCount: number;
  openFraudAlertsCreatedTodayCount: number;
}
// ... one interface per remaining type, each carrying only the fields its
// handler/socket event already need (mirror LowStockAlertJobData's field
// set for low_stock/critical_stock; InventoryProductUnavailableJobData's
// for product_auto_unavailable, etc.)

export type NotificationPayload =
  | { type: 'eod_summary'; data: EodSummaryPayload }
  | /* ... one arm per remaining type ... */;
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/notifications/notifications.types.ts
git commit -m "feat(notifications): define payload interfaces for all 11 notification types"
```

**Deviation protocol:** If `LowStockAlertJobData`/`InventoryProductUnavailableJobData` field names have drifted from what Step 1 confirms, use the actual current field names — do not rename the live queue's job-data interfaces to match this plan's assumption.

---

### Task 3: Prisma migration — create `Notification` model (DB persistence)

**Dependencies:** Task 2 (payload union informs the `payload: Json` column's TS-side type, not the DDL itself).

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260717010000_phase18_notifications/migration.sql`

**Interfaces:**
- Produces: `model Notification` (`id`, `type`, `payload: Json`, `recipientUserId`, `branchId: String?`, `readAt: DateTime?`, `createdAt`), `@@index([recipientUserId, readAt])`, `@@index([type, createdAt])`. Task 4's repository and Task 9's endpoints depend on this shape.

Description: Add the `Notification` model to `schema.prisma` (recipient-scoped, `readAt` nullable = unread) and hand-write the matching `migration.sql`, following the same additive-only convention as the Phase 17 migration.
Acceptance criteria: `pnpm --filter @potato-corner/api run prisma:generate` reports `Generated Prisma Client` with `Notification` in the generated types; typecheck passes.
Estimated effort: 0.5 day.

- [ ] **Step 1: Confirm the next-free migration timestamp**

Run:
```bash
ls apps/api/prisma/migrations | sort | tail -3
```
Expected: most recent is `20260717000000_phase17_fraud_detection_hash_and_indexes`. This task's folder is `20260717010000_phase18_notifications` — if a same-or-later timestamp already exists, bump forward by one second per collision so migrations still apply in creation order.

- [ ] **Step 2: Add `model Notification` to `schema.prisma`**

Pseudocode (field list only — match the project's existing `@map`/`@@map` snake_case convention, see `model FraudAlert` for the pattern to copy):
```prisma
model Notification {
  id              String    @id @default(uuid())
  type            String
  payload         Json
  recipientUserId String    @map("recipient_user_id")
  branchId        String?   @map("branch_id")
  readAt          DateTime? @map("read_at")
  createdAt       DateTime  @default(now()) @map("created_at")

  recipient User @relation(fields: [recipientUserId], references: [id])

  @@index([recipientUserId, readAt])
  @@index([type, createdAt])
  @@map("notifications")
}
```
Add the inverse relation field to `model User` alongside its other back-relations.

- [ ] **Step 3: Write `migration.sql` by hand**

Create `apps/api/prisma/migrations/20260717010000_phase18_notifications/migration.sql` with `CREATE TABLE "notifications" (...)`, the FK to `users`, and both indexes — mirror the Phase 17 migration's header-comment convention (one sentence on why the table exists).

- [ ] **Step 4: Regenerate the Prisma client**

Run:
```bash
pnpm --filter @potato-corner/api run prisma:generate
```
Expected: succeeds, `Notification` present in generated types.

- [ ] **Step 5: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0 — no code references `Notification` yet, so this only confirms the schema is valid.

- [ ] **Step 6: Migration verification**

Run:
```bash
pnpm --filter @potato-corner/api exec prisma migrate diff --from-migrations apps/api/prisma/migrations --to-schema-datamodel apps/api/prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"
```
Expected: no diff reported (the hand-written SQL matches the schema exactly). If no shadow database is reachable in this environment, instead visually diff `migration.sql` against the `model Notification` block field-by-field and note the untested-against-a-real-DB caveat in this task's completion notes — do not switch to `prisma db push` or skip the migration file (same deviation protocol as the Phase 17 plan's Task 2).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260717010000_phase18_notifications/migration.sql
git commit -m "feat(db): add Notification model for Phase 18 in-app persistence"
```

**Deviation protocol:** If `model User` already has an unrelated field or relation named `notifications`, rename the inverse relation field (not the `Notification` model) to avoid a collision.

---

### Task 4: Audit-and-fix existing notification handlers

**Dependencies:** Task 3 (`Notification` model exists for the repository calls this task adds).

**Files:**
- Modify: `apps/api/src/queues/notification.queue.ts`
- Modify: `apps/api/src/queues/notification.queue.test.ts`
- Create: `apps/api/src/modules/notifications/notifications.repository.ts` (persistence method only — full CRUD arrives in Task 6/9)

**Interfaces:**
- Produces: `notificationsRepository.createNotification(data): Promise<NotificationRow>`. Consumed by this task's fix to `inventory_deduction_failed` and `inventory_product_unavailable`, and by every handler Task 6 adds.

Description: Per Decision 8, bring the two stub handlers (`inventory_deduction_failed`: `console.error`-only; `inventory_product_unavailable`: `console.warn`-only per its own `TODO(Phase 18)` comment) up to the same shape as `employee_welcome`/`low_stock_alert` — persist a `Notification` row and emit the correct existing `SOCKET_EVENTS` constant — before Task 6 adds the 9 remaining types on top of an already-consistent baseline.
Acceptance criteria: both previously-stub handlers now call `notificationsRepository.createNotification` and emit a socket event; existing `low_stock_alert`/`employee_welcome` tests still pass unchanged.
Estimated effort: 1 day.

- [ ] **Step 1: Confirm current stub behavior**

Run:
```bash
grep -n "TODO(Phase 18)\|console.error\|console.warn" apps/api/src/queues/notification.queue.ts
```
Expected: matches inside the `inventory_deduction_failed` and `inventory_product_unavailable` branches, confirming both are still log-only as read during investigation.

- [ ] **Step 2: Write the minimal `notificationsRepository.createNotification` method + failing test**

`notifications.repository.ts` gets one method (`create(data: CreateNotificationData): Promise<Notification>` → `prisma.notification.create({ data })`); test asserts the Prisma call shape, following the exact pattern of `fraudRepository.createAlert`'s test in the Phase 17 plan (Task 4, Step 2).

- [ ] **Step 3: Run it to verify it fails, then implement, then verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/notifications/notifications.repository.test.ts
```
Expected: FAIL then PASS across the TDD cycle (RED → implement → GREEN), same discipline as every task in the Phase 17 plan.

- [ ] **Step 4: Fix `inventory_deduction_failed` — persist + no socket event (matches its existing comment: "no socket event constant exists for this case")**

Add a `notificationsRepository.create({ type: 'inventory_deduction_failed', payload: {...}, recipientUserId: <resolve via existing super-admin lookup used elsewhere>, branchId: data.branchId })` call before the existing `console.error`; keep the `console.error` (still useful for ops tailing logs).

- [ ] **Step 5: Fix `inventory_product_unavailable` — persist + emit `SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE`**

Replace the `console.warn`-only body with a `notificationsRepository.create(...)` call followed by `notifyBranch`/`notifySuperAdmin(SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, ...)`, matching the already-correct `low_stock_alert` branch's two-call shape immediately above it in the same file.

- [ ] **Step 6: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api exec vitest run src/queues/notification.queue.test.ts src/modules/notifications/notifications.repository.test.ts
```
Expected: 0 type errors; all tests (existing + new) pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/queues/notification.queue.ts apps/api/src/queues/notification.queue.test.ts apps/api/src/modules/notifications/notifications.repository.ts
git commit -m "fix(notifications): persist and broadcast inventory_deduction_failed and inventory_product_unavailable instead of log-only stubs"
```

**Deviation protocol:** If a super-admin recipient lookup helper doesn't already exist anywhere in the codebase (check `notify.ts` / `fraud.service.ts` for how `notifySuperAdmin` resolves its audience first), add a minimal `findSuperAdminUserIds()` to whichever repository already owns `User` reads (do not add a new Prisma call site outside a repository file).

---

### Task 5: Wire notification triggers (enqueue calls at event sources)

**Dependencies:** Task 2 (payload shapes), Task 4 (queue handlers are consistent baseline).

**Files:**
- Modify: `apps/api/src/modules/cash/cash.service.ts` (variance flagged)
- Modify: `apps/api/src/modules/cash/cash.service.test.ts`
- Modify: `apps/api/src/modules/transactions/transactions.service.ts` (void requested, large adjustment approval needed)
- Modify: `apps/api/src/modules/transactions/transactions.service.test.ts`
- Modify: `apps/api/src/modules/fraud/detection.service.ts` (fraud alert created — add enqueue alongside existing `notifySuperAdmin` call)
- Modify: `apps/api/src/modules/fraud/detection.service.test.ts`

**Interfaces:**
- Consumes: `notificationQueue.add(type, payload, retryOpts)` from `notification.queue.ts` (exported for the first time in this task, mirroring `enqueueManualFraudScan`'s export pattern from `fraud.queue.ts`).
- Produces: an `.add()` call at each of the 6 remaining event sources not already covered by Task 4 (`out_of_stock`/`product_auto_unavailable` write paths already emit sockets directly from `inventory.queue.ts` per Corrections in the Phase 17 plan — this task only adds the queue `.add()` call, not new business logic).

Description: At each business-logic site that currently only calls `notifyBranch`/`notifySuperAdmin` directly (cash variance flag, void request, large adjustment approval, fraud alert creation) or nowhere yet (offline sync completion), add a `notificationQueue.add(...)` call so the event also persists via Task 4's `Notification` model, without duplicating the socket-emission logic that already exists at each site.
Acceptance criteria: each of the 6 sites has exactly one new `.add()` call with a matching unit test asserting the job name/payload; no existing socket-emission test changes.
Estimated effort: 1.5 days.

- [ ] **Step 1: Confirm which sites already emit sockets directly (do not duplicate emission, only add persistence)**

Run:
```bash
grep -rn "notifyBranch\|notifySuperAdmin" apps/api/src/modules --include=*.ts | grep -v test
```
Expected output enumerates every current call site; cross-reference against the 6 remaining types (`cash_variance_flagged`, `void_requested`, `large_adjustment_approval_needed`, `fraud_alert_created`, `offline_transactions_synced`, plus `out_of_stock`/`product_auto_unavailable` already fixed in Task 4) to confirm no site is missed or duplicated.

- [ ] **Step 2: Export `notificationQueue.add` wrapper from `notification.queue.ts`**

Add one small exported function per Decision-7 retry shape (mirrors `enqueueManualFraudScan`'s shape from the Phase 17 plan's Task 7):
```ts
export function enqueueNotification(type: NotificationType, payload: unknown, recipientSelector: {...}) {
  return notificationQueue.add(type, { payload, ...recipientSelector }, { attempts: 3, backoff: { type: 'custom' } });
}
```

- [ ] **Step 3: Write failing tests, then wire the `.add()` call, at each of the 6 sites (repeat per site)**

Same TDD shape at each site: mock `enqueueNotification`, assert it's called with the right type/payload after the existing socket emission, run RED, implement, run GREEN.

- [ ] **Step 4: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: 0 type errors; full suite passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/cash/cash.service.ts apps/api/src/modules/cash/cash.service.test.ts apps/api/src/modules/transactions/transactions.service.ts apps/api/src/modules/transactions/transactions.service.test.ts apps/api/src/modules/fraud/detection.service.ts apps/api/src/modules/fraud/detection.service.test.ts apps/api/src/queues/notification.queue.ts
git commit -m "feat(notifications): enqueue persisted notifications at cash, void, adjustment, and fraud event sources"
```

**Deviation protocol:** If `offline_transactions_synced` has no current trigger site at all (the sync-reconciliation endpoint may not exist yet outside this plan's scope), stop and report rather than inventing a call site — this type may depend on offline-sync work tracked in a different phase.

---

### Task 6: Extend `notification.queue.ts` handlers for all remaining types

**Dependencies:** Task 2 (payload types), Task 4 (baseline), Task 5 (jobs are now actually enqueued for these types).

**Files:**
- Modify: `apps/api/src/queues/notification.queue.ts`
- Modify: `apps/api/src/queues/notification.queue.test.ts`

**Interfaces:**
- Produces: a `job.name` branch for each of the 6 types wired in Task 5 plus `cash_variance_flagged`, `void_requested`, `large_adjustment_approval_needed` (whichever of the 11 aren't already handled after Task 4) — each branch persists via `notificationsRepository.create`, emits the matching `SOCKET_EVENTS` constant, and (for the 3 selected types) calls the Task 10 email sender.

Description: Replace the remaining `// TODO(Phase 8+): implement remaining notification types.` catch-all with one explicit branch per type, following the exact two-call shape (`notificationsRepository.create` then `notifyBranch`/`notifySuperAdmin`) already established by Task 4's fixed handlers.
Acceptance criteria: the catch-all TODO comment is gone; every one of the 11 `job.name` values has an explicit branch with a passing unit test.
Estimated effort: 1.5 days.

- [ ] **Step 1: Write failing tests for each remaining branch**

One `it(...)` per type not yet covered by Task 4, asserting `notificationsRepository.create` is called with the right `type`/`payload` and the right `SOCKET_EVENTS` constant fires.

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/queues/notification.queue.test.ts
```
Expected: FAIL — new branches don't exist yet, worker falls through to the old catch-all.

- [ ] **Step 3: Implement each branch, remove the catch-all TODO comment**

Pseudocode per branch (repeat 8×, one per remaining type):
```ts
if (job.name === '<type>') {
  const data = job.data as <TypePayload>;
  await notificationsRepository.create({ type: '<type>', payload: data, recipientUserId: ..., branchId: ... });
  notifyBranch/notifySuperAdmin(SOCKET_EVENTS.<CONSTANT>, data);
  if (<type> is one of fraud_alert_created | eod_summary | large_adjustment_approval_needed) await sendNotificationEmail(...); // Task 10 wires the real implementation
  return;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/queues/notification.queue.test.ts
```
Expected: PASS, all 11 type branches covered.

- [ ] **Step 5: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/queues/notification.queue.ts apps/api/src/queues/notification.queue.test.ts
git commit -m "feat(notifications): implement remaining notification.queue.ts handlers for all 11 types"
```

**Deviation protocol:** If a `SOCKET_EVENTS` constant is missing for one of the 8 new types (only `FRAUD_SCAN_FAILED`-style additions were made in Phase 17), add it to `packages/shared/src/constants/events.ts` in this task rather than inventing an ad hoc string inline, and rebuild `@potato-corner/shared` before re-running the typecheck.

---

### Task 7: Implement EOD aggregation service (reuse reports + fraud + cash logic)

**Dependencies:** Task 2 (`EodSummaryPayload`), Task 6 (`eod_summary` handler exists to receive the enqueued job).

**Files:**
- Create: `apps/api/src/modules/reports/eod-summary.service.ts`
- Create: `apps/api/src/modules/reports/eod-summary.service.test.ts`

**Interfaces:**
- Consumes: `reportsRepository.getDailySales` (revenue, company + per-branch), `reportsRepository.getVoidRefund` (void count), `cashRepository` variance-approval fields (unresolved = `varianceApproved === null` for shifts closed that day, same predicate Rule 3 of Phase 17 uses), `fraudRepository.findOpenAlertsByType`-style query filtered to alerts created that Manila day.
- Produces: `buildEodSummary(evaluationDate: Date): Promise<EodSummaryPayload>`. Task 8's cron handler calls this once nightly.

Description: A standalone service (not folded into `reports.service.ts`, per Decision 6) that assembles the Part 13 EOD fields by calling existing repository methods across three modules — no new aggregation SQL, no duplicated revenue/void/variance logic.
Acceptance criteria: `buildEodSummary` returns a payload matching `EodSummaryPayload` for a mocked day's data, verified against hand-computed totals in the test.
Estimated effort: 1.5 days.

- [ ] **Step 1: Confirm the Manila-day boundary helper is reusable**

Run:
```bash
grep -n "export function dayBounds" apps/api/src/modules/fraud/rules/fraud-rule.utils.ts
```
Expected: `dayBounds(evaluationDate: Date): { dayStart: Date; dayEnd: Date }` exists from the Phase 17 plan. Reuse it directly (`import { dayBounds } from '../fraud/rules/fraud-rule.utils.js'`) rather than writing a second Manila-offset calculation — if it's been moved or renamed, adjust the import path, don't reimplement the offset math.

- [ ] **Step 2: Write the failing test**

Mock `reportsRepository.getDailySales`, `reportsRepository.getVoidRefund`, `cashRepository.findClosedShiftTransactionSummaries`-or-equivalent (whichever exposes `varianceApproved`), and `fraudRepository.findOpenAlertsByType` (called once per alert type, or a new `findAlertsCreatedInWindow` if a single cross-type query is cleaner — see Deviation protocol); assert `buildEodSummary` sums/counts them into the exact `EodSummaryPayload` shape from Task 2.

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/reports/eod-summary.service.test.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Implement `eod-summary.service.ts`**

Pseudocode:
```ts
export async function buildEodSummary(evaluationDate: Date): Promise<EodSummaryPayload> {
  const { dayStart, dayEnd } = dayBounds(evaluationDate);
  const dailySales = await reportsRepository.getDailySales({ dateFrom: dayStart, dateTo: dayEnd, branchId: null });
  const voidRefund = await reportsRepository.getVoidRefund({ dateFrom: dayStart, dateTo: dayEnd, branchId: null });
  const unresolvedVariances = await countUnresolvedVariances(dayStart, dayEnd); // varianceApproved === null, closedAt in window
  const openFraudAlertsToday = await countFraudAlertsCreatedInWindow(dayStart, dayEnd);
  return {
    evaluationDate: dayStart.toISOString().slice(0, 10),
    totalRevenue: sum(dailySales, 'revenue'),
    branchRevenue: dailySales.map(row => ({ branchId: row.branchId, branchCode: row.branchCode, revenue: row.revenue })),
    transactionCount: sum(dailySales, 'transactionCount'),
    voidCount: voidRefund.length,
    unresolvedCashVarianceCount: unresolvedVariances,
    openFraudAlertsCreatedTodayCount: openFraudAlertsToday,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/reports/eod-summary.service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/reports/eod-summary.service.ts apps/api/src/modules/reports/eod-summary.service.test.ts
git commit -m "feat(reports): implement EOD summary aggregation reusing reports/fraud/cash repository queries"
```

**Deviation protocol:** If no existing repository method exposes "fraud alerts created within [dayStart, dayEnd]" (Task 4 of the Phase 17 plan's `findOpenAlertsByType` filters by type+status, not by a date window), add one narrowly-scoped read method to `fraud.repository.ts` (e.g. `countAlertsCreatedInWindow(dayStart, dayEnd)`) rather than filtering the unbounded `findOpenAlertsByType` result set in the service layer — the same "reads live in the repository" rule the Phase 17 plan's Corrections #3 already established for this codebase.

---

### Task 8: Register nightly EOD cron at 23:59 Asia/Manila (after fraud cron)

**Dependencies:** Task 7 (`buildEodSummary`).

**Files:**
- Modify: `apps/api/src/queues/notification.queue.ts` (or a new `apps/api/src/queues/eod.queue.ts` if the notification queue shouldn't own a repeatable job — see Deviation protocol)
- Modify: `apps/api/src/queues/notification.queue.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Produces: `scheduleNightlyEodSummary(): Promise<Job>`, registered in `server.ts`'s boot sequence directly after `scheduleNightlyFraudScan()` (Task 7 of the Phase 17 plan).

Description: Register BullMQ's second-ever repeatable job (`{ repeat: { pattern: '59 23 * * *', tz: 'Asia/Manila' } }`) — one minute after the fraud scan's `0 23 * * *` slot — whose worker branch calls `buildEodSummary()` then enqueues one `eod_summary` notification job per active Super Admin.
Acceptance criteria: `scheduleNightlyEodSummary()` is called exactly once in `server.ts`, guarded the same way `scheduleNightlyFraudScan()` is guarded (on Redis reachability); a manual `.add()` with a fixed date produces the expected `eod_summary` job payload in a test.
Estimated effort: 1 day.

- [ ] **Step 1: Confirm `scheduleNightlyFraudScan()`'s exact registration point in `server.ts`**

Run:
```bash
grep -n "scheduleNightlyFraudScan\|redisOk" apps/api/src/server.ts
```
Expected: one call inside the Redis-reachability guard from the Phase 17 plan's Task 7. This task's `scheduleNightlyEodSummary()` call goes immediately after it, inside the same guard.

- [ ] **Step 2: Write the failing test**

Assert `scheduleNightlyEodSummary()` calls the underlying queue's `.add()` (or a dedicated `Queue`'s) with `{ repeat: { pattern: '59 23 * * *', tz: 'Asia/Manila' } }` and a stable `jobId` (BullMQ dedups repeatable jobs by `jobId`, same as the fraud cron).

- [ ] **Step 3: Run it to verify it fails, implement, verify it passes**

Same RED → implement → GREEN cycle as every other task; the worker-side handler calls `buildEodSummary(new Date())`, then loops over Super Admin recipients enqueuing one `eod_summary` job each via Task 6's `enqueueNotification`.

- [ ] **Step 4: Wire into `server.ts` boot sequence**

Add the `scheduleNightlyEodSummary()` call directly after `scheduleNightlyFraudScan()`, inside the existing `redisOk` guard.

- [ ] **Step 5: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/queues/notification.queue.ts apps/api/src/queues/notification.queue.test.ts apps/api/src/server.ts
git commit -m "feat(notifications): register nightly EOD summary cron at 23:59 Asia/Manila"
```

**Deviation protocol:** If putting a repeatable-job registration inside `notification.queue.ts` (a queue whose existing jobs are all one-shot `.add()` calls from request-handling code, same as the Phase 17 plan's Corrections #2 observed for the pre-Phase-17 codebase) reads as mixing concerns, create `apps/api/src/queues/eod.queue.ts` instead, following `fraud.queue.ts`'s file shape exactly (own `Queue`/`Worker` pair, own repeat registration function) — either is acceptable, but do not scatter the repeat registration across two files.

---

### Task 9: Implement notifications API endpoints (list, mark-read, mark-all-read)

**Dependencies:** Task 3 (`Notification` model), Task 4 (repository's `create` exists as a pattern to extend).

**Files:**
- Modify: `apps/api/src/modules/notifications/notifications.repository.ts`
- Modify: `apps/api/src/modules/notifications/notifications.repository.test.ts`
- Modify: `apps/api/src/modules/notifications/notifications.service.ts`
- Modify: `apps/api/src/modules/notifications/notifications.service.test.ts`
- Modify: `apps/api/src/modules/notifications/notifications.router.ts`
- Modify: `apps/api/src/modules/notifications/notifications.router.test.ts`
- Modify: `packages/shared/src/schemas/` (Zod schema for list query params, if pagination params are accepted)

**Interfaces:**
- Produces: `GET /api/notifications` (paginated, recipient-scoped), `PATCH /api/notifications/:id/read`, `PATCH /api/notifications/read-all` — all behind `authenticate` (every authenticated role reads only their own notifications; no role-gating beyond identity, per Decision 4's "in scope" note not specifying admin-only).

Description: Replace the two Phase-0 stub files (router with only a `TODO` comment and a `void notificationsService`; service with only a `TODO` comment and `void notificationsRepository`) with real implementations following the thin-router-calls-service, service-calls-repository pattern used by every other module (e.g. `fraud.router.ts`/`fraud.service.ts`).
Acceptance criteria: all 3 routes return `{ data, error: null, meta: null }` shape on success, 401 with no token (covered by the existing route-auth `it.each` pattern), and a recipient can never read/mark another user's notification (403 or empty result, not a 500).
Estimated effort: 1.5 days.

- [ ] **Step 1: Write failing repository tests for `findForRecipient`, `markRead`, `markAllRead`**

Follow the exact assertion style of `fraudRepository.findRecentOpenAlert`'s test (Phase 17 plan Task 4, Step 2) — assert the Prisma `where`/`orderBy`/`take` shape, not implementation internals.

- [ ] **Step 2: Run it to verify it fails, implement in `notifications.repository.ts`, verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/notifications/notifications.repository.test.ts
```
Expected: FAIL then PASS.

- [ ] **Step 3: Write failing service tests, implement `notificationsService`, verify it passes**

`listForRecipient(userId, pagination)`, `markRead(id, userId)` (must verify `recipientUserId === userId` before updating — ownership check lives in the service, matching how `fraud.service.ts`'s `investigateAlert` etc. check actor authorization before delegating to the repository), `markAllRead(userId)`.

- [ ] **Step 4: Write failing router tests, implement the 3 routes, verify it passes**

Follow `fraud.router.ts`'s thin-wrapper shape exactly (see the Phase 17 plan's Task 8, Step 7 for the reference three-line handler pattern): `authenticate` middleware only (no `adminOnly` — every role reads its own notifications), delegate to `notificationsService`, wrap the response in `{ data, error: null, meta: null }`.

- [ ] **Step 5: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/notifications packages/shared/src/schemas
git commit -m "feat(notifications): implement list, mark-read, and mark-all-read endpoints"
```

**Deviation protocol:** If `packages/shared`'s Zod schema conventions require every request/response schema to live in a dedicated file per module (check `packages/shared/src/schemas/fraud.schema.ts` for the pattern first), create `notifications.schema.ts` there rather than inlining `z.object(...)` calls in the router.

---

### Task 10: Integrate Resend email delivery (selected types only)

**Dependencies:** Task 6 (handlers exist with a placeholder email call-site), Task 7 (`EodSummaryPayload` shape for the EOD email body).

**Files:**
- Modify: `apps/api/src/lib/email.ts`
- Modify: `apps/api/src/lib/email.test.ts`
- Modify: `apps/api/src/queues/notification.queue.ts` (replace Task 6's placeholder call with the real one)

**Interfaces:**
- Produces: `sendFraudAlertEmail(toEmail, payload: FraudAlertPayload): Promise<void>`, `sendEodSummaryEmail(toEmail, payload: EodSummaryPayload): Promise<void>`, `sendLargeAdjustmentApprovalEmail(toEmail, payload: LargeAdjustmentApprovalPayload): Promise<void>` — same signature/fallback shape as the existing `sendPasswordResetEmail`/`sendWelcomeEmail` (best-effort in development via `console.log`, throws outside development when `RESEND_API_KEY` is absent).

Description: Add 3 new Resend-backed senders to the existing `email.ts` (which already initializes the `Resend` client conditionally on `RESEND_API_KEY`), following the exact dev-fallback contract already documented on the two existing senders, and wire them into Task 6's 3 selected handler branches (Decision 2: fraud alert, EOD summary, large adjustment approval only — the other 8 types never call Resend).
Acceptance criteria: all 3 senders throw outside `development` when `RESEND_API_KEY` is absent (never silently drop an email in staging/production); in development, absence logs instead of throwing, matching `sendWelcomeEmail`'s existing behavior exactly.
Estimated effort: 1 day.

- [ ] **Step 1: Confirm the existing dev-fallback contract to replicate exactly**

Run:
```bash
grep -n "config.nodeEnv !== 'development'" apps/api/src/lib/email.ts
```
Expected: two matches (one per existing sender), each throwing outside development. The 3 new senders must follow the identical branch shape — this is a correctness-critical pattern (silently dropping a fraud-alert email in production would defeat the point of the alert), not a style preference.

- [ ] **Step 2: Write failing tests for the 3 new senders**

Mirror the existing `email.test.ts` structure (if none exists yet, create it following the mock-`Resend`-client pattern any current caller of `sendWelcomeEmail` already uses in its own test file).

- [ ] **Step 3: Run it to verify it fails, implement the 3 senders, verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/lib/email.test.ts
```
Expected: FAIL then PASS.

- [ ] **Step 4: Wire the 3 senders into Task 6's handler branches**

Replace Task 6's placeholder `if (<type> is one of ...) await sendNotificationEmail(...)` comment with the real per-type call inside each of the 3 relevant branches only.

- [ ] **Step 5: Typecheck + test checkpoint**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
pnpm --filter @potato-corner/api run test
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/email.ts apps/api/src/lib/email.test.ts apps/api/src/queues/notification.queue.ts
git commit -m "feat(notifications): send Resend email for fraud alert, EOD summary, and large adjustment approval"
```

**Deviation protocol:** If `RESEND_API_KEY`/`EMAIL_FROM` env vars are found to already be marked required (not optional) somewhere in `config/index.ts` by the time this task runs, follow whatever the current schema says rather than this plan's "still optional" assumption — re-read `config/index.ts` before Step 3.

---

### Task 11: Tests (queue behavior, retry/backoff, EOD accuracy, read/dismiss flows)

**Dependencies:** Tasks 2–10 complete.

**Files:** none new — this task closes coverage gaps found by re-reading Tasks 2–10's tests as a set, not by adding a parallel test suite.

**Interfaces:** none — verification-oriented task.

Description: Read back every test file touched by Tasks 2–10 as a set and add any missing case: retry/backoff timing (`attemptsMade` → correct delay, matching `inventory.queue.ts`'s `retryDelayMs` test if one exists), EOD accuracy against a hand-computed fixture spanning 2+ branches, and the read/dismiss ownership check (Task 9, Step 3) rejecting a different user's notification ID.
Acceptance criteria: full API suite passes; the specific 3 gaps named above (retry timing, EOD multi-branch accuracy, cross-user read/dismiss rejection) each have at least one explicit test, confirmed present by name in the completion notes.
Estimated effort: 1 day.

- [ ] **Step 1: Grep for existing retry/backoff test coverage to avoid duplicating it**

Run:
```bash
grep -rn "retryDelayMs\|attemptsMade" apps/api/src/queues/*.test.ts
```
Expected: at least `inventory.queue.test.ts` and `fraud.queue.test.ts` already assert this; if `notification.queue.test.ts` doesn't have an equivalent after Tasks 4/6, add one following the same pattern.

- [ ] **Step 2: Add the EOD multi-branch accuracy test if Task 7's test only covered a single branch**

Extend `eod-summary.service.test.ts` with a 2-branch fixture, asserting `branchRevenue` sums to `totalRevenue` and per-branch figures are correct individually.

- [ ] **Step 3: Add the cross-user rejection test if Task 9's service test only covered the happy path**

Extend `notifications.service.test.ts`: `markRead(notificationBelongingToUserA, userB)` must not update the row (either throws or is a no-op — match whatever `investigateAlert`'s existing ownership-check pattern does for consistency).

- [ ] **Step 4: Full checkpoint — typecheck, API tests, web tests, lint**

Run:
```bash
pnpm run type-check
pnpm --filter @potato-corner/api run test
pnpm --filter @potato-corner/web run test
pnpm run lint
```
Expected: 0 errors across all four; web test count unchanged (this plan touches no frontend files).

- [ ] **Step 5: Record and report**

Document, in this task's completion notes: total API test count before vs. after this plan; whether `prisma:generate`/migration-diff (Task 3) ran against a real database or only validated syntax; confirmation all four Step 4 commands exited 0.

**Deviation protocol:** If any test fails, do not mark this task complete and do not loosen an assertion to make it pass — return to the task whose code the failing test belongs to, fix the implementation, and re-run Step 4 from the top.

---

### Task 12: Quality gate checklist before PR

**Dependencies:** Task 11 (all checkpoints green).

**Files:** none — checklist only.

Description: Final pre-PR gate mirroring the Phase 17 plan's end-to-end verification task, scoped to what Phase 18 actually touched.
Acceptance criteria: every box below is checked with evidence (command output), not assumed.
Estimated effort: 0.5 day.

- [ ] `pnpm --filter @potato-corner/api run prisma:generate` succeeds (or the Task 3 Step 6 caveat is documented if no live DB was reachable).
- [ ] `pnpm run type-check` — 0 errors across all workspaces.
- [ ] `pnpm --filter @potato-corner/api run test` — 0 failures; new-test count matches Task 11's recorded delta.
- [ ] `pnpm --filter @potato-corner/web run test` — unchanged pass count (no frontend files touched).
- [ ] `pnpm run lint` — 0 errors, nothing suppressed with an inline disable comment.
- [ ] Every one of the 11 notification types has: a payload interface (Task 2), a queue handler that persists + broadcasts (Tasks 4/6), and — for the 3 selected types only — an email send call (Task 10).
- [ ] `git log --oneline` for this branch shows one commit per task (12 tasks → up to 11 commits, Task 1/12 being documentation/checklist-only).
- [ ] No `console.log`/`console.warn` remains as the *only* side effect of any notification handler (Task 4's audit target) — logging alongside real persistence is fine, logging instead of it is not.

**Production verification checklist** (post-deploy, not part of the PR itself):

- [ ] `RESEND_API_KEY` and `EMAIL_FROM` are set in the production environment (or the dev-log fallback is confirmed acceptable for this environment's launch state).
- [ ] The `59 23 * * *` Asia/Manila repeatable job is confirmed registered exactly once in the production Redis instance (BullMQ's `Queue.getRepeatableJobs()`) — not duplicated across multiple server instances/deploys.
- [ ] A manual `POST`-triggered (or first-night) EOD summary email/in-app notification is confirmed received by at least one real Super Admin account, with figures cross-checked against the Daily Sales report for the same date.
- [ ] `GET /api/notifications` confirmed to return only the authenticated user's own rows in production (not just in the unit test) — spot-check with two distinct accounts.
- [ ] Fraud-alert and large-adjustment-approval emails confirmed delivered (not just enqueued) for at least one real event of each type post-deploy.
