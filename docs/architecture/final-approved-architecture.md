# Potato Corner Enterprise Web POS & Branch Management Platform — Final Approved Architecture

**Version:** 1.0 Final | **Status:** Approved for Development | **Scope:** Complete system architecture — modules, decisions, rules, and implementation specifications.

This document is reproduced verbatim (reformatted to Markdown) from the locked specification provided at project kickoff. It is the authoritative source for all business rules, algorithms, and schema decisions. Nothing here is open for discussion without a formal change request.

## Part 1 — System Overview

Unified web application serving three roles from one codebase: Staff (POS terminal), Supervisors (branch operations), Super Admin (company-wide management). Core principles: one web app for three interfaces (no mobile app, no separate deployments), offline-first POS, recipe-driven inventory, cash as a primary financial control (denomination-level reconciliation), immutable hash-chained audit trail, and Philippine legal compliance (PWD/Senior VAT, BIR receipts) built into the core transaction engine.

## Part 2 — Technology Stack

- **Frontend:** Next.js 14+ (App Router), TypeScript, Tailwind CSS + shadcn/ui, Zustand (client state), TanStack Query (server state), Socket.io client, Dexie.js (offline IndexedDB), next-pwa (Service Worker), Fuse.js (search), Recharts, React-PDF, client-preview + server Sharp compression for images.
- **Backend:** Node.js, Express.js, TypeScript, Prisma + PostgreSQL, JWT RS256, bcrypt (cost 12), Redis session blacklisting (Upstash), BullMQ, Socket.io server + Redis adapter, Supabase Storage + CDN, Zod validation, Sentry.
- **Database:** PostgreSQL 15 via Supabase, PgBouncer pooling, `pgcrypto` + `uuid-ossp` extensions, Prisma Migrate, automated daily backups with point-in-time recovery, monthly restoration test.
- **Infrastructure:** Vercel (frontend), Render.com Standard/Professional (backend — **must not** be free/starter tier, cold starts are operationally unacceptable), Supabase Pro in `ap-southeast-1` (Singapore), Upstash Redis, Cloudflare (DNS/CDN/DDoS), UptimeRobot + Sentry, GitHub Actions.

## Part 3 — System Architecture

Route groups: `(auth)`, `(admin)`, `(supervisor)`, `(pos)` — route protection enforced at Next.js middleware before render. Backend is a modular monolith: `modules/{auth,branches,products,flavors,inventory,transactions,discounts,receipts,employees,attendance,cash,reports,notifications,audit,fraud}`, each with router/service/repository/types. Modules call each other directly in-process; BullMQ handles async work only.

**Request authentication flow:** extract JWT → verify RS256 signature → check expiry → check Redis blacklist → attach identity to request → route-specific authorization. Any failure → 401, client clears token, redirects to login.

**Branch authorization logic:**
- `super_admin`: skip branch check, access all branches.
- `supervisor`: requested `branch_id` must be in the user's `branch_ids` array, else 403.
- `staff`: requested `branch_id` must match the assigned branch, AND an active shift must exist for POS endpoints.

**Real-time (Socket.io, room-based):** each branch is a room; Super Admin joins all rooms. Events: `transaction:completed`, `inventory:low_stock`, `inventory:out_of_stock`, `inventory:product_unavailable`, `cash:variance_flagged`, `void:requested`, `void:approved`, `attendance:clocked_in`, `attendance:clocked_out`, `fraud:alert_created`. All branch events also forward to the Super Admin channel.

**Background jobs (BullMQ):**
- *Inventory Deduction Queue* — triggered after every transaction; retry 10s/60s/300s; after 3 failures mark deduction `failed`, notify supervisor, add to manual reconciliation queue.
- *Notification Queue* — decoupled delivery (in-app/email/push) so failures never affect transactions.
- *Report Queue* — pre-computed reports refresh every 15 minutes; async large exports.
- *Fraud Detection Queue* — runs nightly against recent transaction data.

## Part 4 — Database Architecture

UUID primary keys everywhere, `created_at`/`updated_at` on every table, soft delete via status fields or `deleted_at` — no hard deletes. See `docs/architecture/database-schema.md` for the full table-by-table reference (reproduced from this document's Part 4).

Government ID fields (`sss_number`, `philhealth_number`, `tin_number`, `pagibig_number`) use **application-layer AES-256 encryption** before storage, decrypted only on explicit Super Admin request, never in standard API responses.

## Part 5 — Authentication System

- **Access token:** JWT RS256, payload `{ user_id, role, branch_ids?, email, iat, exp }`, 15-minute expiry, memory-only storage (never localStorage/cookies).
- **Refresh token:** opaque random string, HttpOnly cookie, 7-day expiry, rotated on every use.
- **JWT payload structure** (canonical — never modify without explicit instruction):
  - Super Admin: `{ user_id, role, email }`
  - Supervisor: `{ user_id, role, email, branch_ids: [uuid, uuid] }`
  - Staff: `{ user_id, role, email, branch_ids: [uuid] }`
- **Security controls:** account lockout after 5 failed attempts (30-min auto-unlock, or manual Super Admin unlock); Redis token-ID blacklist checked on every request, password change blacklists all active tokens; device registration via localStorage UUID + browser fingerprint; PIN login for staff only on a device that previously completed full email/password auth.

## Part 6 — Product and Flavor System

Product lifecycle: `draft → active` (Super Admin) → `temporarily_unavailable` ↔ `active` (Super Admin or Supervisor, branch-scoped for Supervisor) → `discontinued` (Super Admin only, not reversible without Super Admin) → `archived` (Super Admin only, fully read-only). When a product goes `discontinued`/`archived`, all `branch_product_availability` rows cascade to unavailable (Product Service, audit-logged).

Flavors are first-class entities: branch availability, price premium per variant, recipe contribution, display order, color code.

## Part 7 — Inventory System

### 7.1 Recipe Deduction Algorithm (authoritative — never modify without explicit instruction)

```
Inputs: product_variant_id, flavor_id, quantity sold

Step 1 — Collect base ingredients: recipes WHERE product_variant_id = X AND flavor_id IS NULL
Step 2 — Collect flavor-specific ingredients: recipes WHERE product_variant_id = X AND flavor_id = selected
Step 3 — Override rule: start with the base list; for each flavor-specific ingredient,
         if the same ingredient_id exists in the base list, REPLACE its quantity;
         otherwise ADD it as a new entry.
Step 4 — Multiply every quantity in the combined list by units sold.
Step 5 — Deduct atomically: one DB transaction, decrement current_stock per ingredient,
         one inventory_movements row per ingredient (movement_type = 'sale_deduction'),
         record quantity_before/quantity_after.
Step 6 — Check thresholds: low_stock_threshold -> warning alert;
         critical_threshold -> critical alert; stock == 0 -> out-of-stock cascade.
```

Runs via BullMQ; never blocks the POS API response.

### 7.2 Out-of-Stock Cascade Algorithm

1. Find all recipe rows referencing the depleted ingredient.
2. Collect distinct `flavor_id`s from those rows.
3. For each affected flavor, set `branch_flavor_availability.is_available = false`, `unavailable_reason = 'out_of_stock'`.
4. Find `product_variant_flavors` rows referencing those flavors.
5. For each affected product, check whether any other flavor remains available at the branch.
6. If zero flavors remain available, set `branch_product_availability.is_available = false`.
7. Broadcast `inventory:product_unavailable` to the branch room with the newly unavailable products/variants/flavors.
8. POS grid refreshes in real time, no reload.

### 7.3 Physical Count — Live Count Approach

No freeze mechanism. Sales continue normally during a count. Supervisor opens a count session, records start time, counts stock, enters quantities, system calculates variance, supervisor notes any transactions during the window, submits. Large variances require Super Admin approval. Recorded as `inventory_movements` with `movement_type = 'physical_count'`; before/after audit-logged.

### 7.4 Movement Types

`stock_in` (image proof, no approval) · `sale_deduction` (automated) · `manual_adjustment` (approval for large quantities) · `waste` (image proof, no approval) · `physical_count` (approval for large variances) · `transfer_in`/`transfer_out` (Super Admin approval).

### 7.5 Image Proof Policy

Live camera capture preferred; gallery upload is the fallback if camera access fails. `image_proof_type` records which method was used.

## Part 8 — Transaction and POS Workflow

Shift prerequisites: active account, assigned to branch, opening cash count entered and confirmed (if a supervisor opens on behalf of staff, the supervisor personally enters the count and is recorded as such).

**Transaction flow:** product selection (branch-filtered, unavailable items hidden) → size/flavor drawer (Add to Order disabled until both selected; closing without completing discards silently) → cart management → discount application → payment → receipt generation → async inventory deduction (BullMQ, non-blocking).

**Discounts:** only one per transaction. PWD (20%, ID required), Senior Citizen (20%, ID required), Employee (configurable %), Manager Override (requires supervisor PIN), Promotional (only if no statutory discount applies — PWD/Senior always take precedence over promotional, never combined).

**PWD/Senior Citizen VAT formula (Philippine law — never modify without explicit instruction):**

```
Step 1: VATable base    = total ÷ 1.12
Step 2: Discount amount = VATable base × 0.20
Step 3: Discounted base = VATable base − discount amount
Step 4: VAT              = discounted base × 0.12
Step 5: Final total       = discounted base + VAT
```

**Payment:** Cash (denomination quick-buttons, change calculated) or GCash (reference number: numeric only, 10–20 characters, cashier must check a fraud-acknowledgment checkbox; supervisor notified on validation failure).

**Receipt:** generated immediately after payment. `transaction_number` **is** the receipt number — same field, same value, used everywhere; there is no separate receipt number.

**Hold orders:** max 3 per terminal, 15-minute expiry, non-blocking toast on expiry, logged as `held_order_expired`, no supervisor action required.

**Void workflow:** cashier submits a void request with mandatory reason (within the current shift) → supervisor approves/rejects → on approval, status → `voided`, inventory deductions reversed via a new `manual_adjustment` movement, audit-logged with both identities.

## Part 9 — Cash Management

Opening count: cashier enters denomination breakdown, system totals it as `opening_cash_amount`. Closing count: `expected_closing_cash = opening_cash + cash_sales_total`; `cash_variance = actual_closing_cash − expected_closing_cash`. Within tolerance → auto-close. Outside tolerance → cashier must explain, supervisor approves/rejects.

Only Super Admin configures variance tolerance (default: zero). Supervisor approval of a variance requires a written explanation of **minimum 50 characters** — one-word approvals rejected.

**Variance pattern detection:** if a cashier has variances in >30% of their last 10 closing counts, a `cash_variance_pattern` fraud alert (High severity) is created.

**Cashier handover:** if a new shift opens within 30 minutes of the previous shift closing at the same branch, the incoming cashier independently counts cash before confirming; both counts are recorded; discrepancies flagged for supervisor review.

## Part 10 — Offline Strategy

Service Worker: network-first for all API calls, falls back to cache on failure. Product catalog cache refreshes on connect and at least every 30 minutes during active use.

**Offline transaction processing:** processed locally against the cached catalog, stored in IndexedDB with a provisional number, receipt shown with the provisional number, queued for sync.

**Provisional number format:** `PC-[BRANCH_CODE]-[DATE]-OFFLINE-[LOCAL_SEQ]` — `LOCAL_SEQ` is a per-device, per-day counter in IndexedDB, increments atomically, **resets to 1 at midnight**. On reconnect, the sync queue processes transactions **in chronological order**; the server assigns the official number; the IndexedDB record and all future references are updated to it.

`transaction_number` and receipt number are the same value everywhere — no separate receipt number field exists anywhere in the system.

Offline price limitations are accepted behavior (cached prices used during outages); supervisor dashboard surfaces a review notice when a shift included offline transactions. Conflict resolution: offline transactions are always accepted as valid; resulting negative stock is allowed to persist temporarily and is resolved via the supervisor's morning checklist (physical count or manual adjustment).

## Part 11 — Reporting System

13 report types across two freshness tiers: **real-time** (Daily Sales, Shift Summary, Cash Reconciliation, Void/Refund, Discount Compliance, Inventory Movement, Attendance Summary, Fraud Alert Summary — query on request, max 3s) and **pre-computed** (Product/Flavor/Employee Performance, Inventory Valuation, Branch Comparison — refreshed every 15 minutes). Every report shows a "Last Updated" timestamp; manual refresh is rate-limited to once/minute/user.

Export: CSV under 10,000 rows downloads synchronously; CSV over 10,000 rows and all PDF exports are BullMQ jobs with a download-link notification. PDF includes logo, branch, report params, timestamp, page numbers. CSV includes hidden audit columns (record UUIDs, `created_at`).

Every report view/export creates an audit log entry (`REPORT_ACCESSED`/`REPORT_EXPORTED`) recording report type, date range, branch scope, and accessing user.

## Part 12 — Fraud Detection System

| Rule | Condition | Severity |
|---|---|---|
| Excessive voids | >3 voids in one shift | Medium |
| Discount abuse | >5 discounted transactions in one shift | Medium |
| Cash variance pattern | Variance in >30% of last 10 closing counts | High |
| GCash volume anomaly | GCash transactions significantly above branch average | Medium |
| Discount ID reuse | Same customer ID for statutory discount >3× in 30 days | High |
| End of shift void | Void submitted in the last 10 minutes of a shift | Low |
| Employee self-discount frequency | Employee discount applied >2× per shift | Low |

Runs nightly. Investigation workflow: **Investigate** (Super Admin takes ownership, status → `investigating`), **Dismiss** (mandatory written reason, status → `dismissed`, remains permanently visible, never deleted), **Escalate** (status → `escalated`, investigating admin recorded). All actions audit-logged.

## Part 13 — Notification System

Types: low/critical stock, out of stock, product auto-unavailable, cash variance flagged, void request, large adjustment approval needed, fraud alert created, inventory deduction failed, offline transactions synced, EOD summary — delivered in-app/WebSocket, some also email.

**EOD summary:** nightly at 11:59 PM to all Super Admins — total revenue (company + per-branch), transaction count, void count, unresolved cash variances, open fraud alerts created that day.

## Part 14 — Deployment and CI/CD

Environments: Development (manual), Staging (merge to `staging`), Production (merge to `main`). `main` requires ≥1 review approval, all checks passing, up-to-date branch, restricted merge access. `staging` requires checks passing + 1 reviewer.

CI/CD steps: lint → unit tests → integration tests → build web → build API → migration safety check → deploy → smoke tests → notify.

Cost baseline: Vercel Pro (~$20), Render Standard (~$25), Supabase Pro (~$25), Upstash (~$5–15), Cloudflare ($0–20) — **~$75–105/month total**.

## Part 15 — Development Sequence (high-level; see `docs/architecture/master-execution-plan.md` for the detailed 20-phase roadmap actually followed)

Phase 0 Setup → Phase 1 POS Core → Phase 2 Inventory → Phase 3 Attendance → Phase 4 Supervisor Dashboard → Phase 5 Super Admin Dashboard → Phase 6 Reporting and Final. This condensed 7-phase view is the original architecture-document sequence; the Master Execution Plan's 20-phase breakdown is the authoritative execution-level roadmap.

## Part 16 — Pre-Development Checklist (critical items — confirmed complete before Phase 0 began)

- Recipe deduction algorithm formally documented, reviewed, signed off.
- Offline provisional receipt number policy documented (format, post-sync update, training script).
- JWT specification confirmed (`branch_ids` array for supervisors/staff).
- Physical count live approach formalized (no freeze mechanism).

## Final Sign-Off

**Decision:** Conditional GO. **Score:** 7.8/10 (≈8.5/10 after critical fixes). This document is the Phase 1 scope boundary — any feature not described here requires a formal change request with Product Manager approval and timeline impact assessment.
