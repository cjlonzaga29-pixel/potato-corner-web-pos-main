# POS-PERF-P47 — Dashboards, supervisor/staff management and PINs

Second batch from the October 29 video review. Starting HEAD: `7084291` (`main`, equal to `origin/main`, clean tree).
Final commit: the one adding this file (`git log -1 -- docs/runbooks/pos-perf-p47-dashboard-and-management.md`).
No migration and no schema change. Not pushed or deployed; no production data, settings, smoke accounts or terminal
queues were touched. Payroll, breaks, VAT, promotions/discounts and the transfer page were not touched; P46 work was not
reopened.

## 1. Causes and final behaviour

| Area | Cause / before | After |
| --- | --- | --- |
| Admin dashboard (only Super Admin uses `/admin/dashboard`; Supervisor and Branch have their own pages) | Low Stock Items and Inventory Alerts cards; a second KPI row half-filled after removal; the period sales total sat alone in a full-width card; Payment Breakdown (Today) was a tall half-width card | Both inventory cards and their queries/realtime syncs removed from this page only. Row 2 is Today's Expenses · Staff Clocked In · Branch Status (KPI-height). The period total now heads the Gross Sales chart (shared section, so Supervisor/Branch get the same fix); the donut is titled "Payment Breakdown — <period>" to tell it apart from today's. Payment Breakdown (Today) is full width: total left, four methods in one row (stacked below `lg`). Sales definitions, date windows, branch filter and Branch Performance unchanged. |
| Supervisor cards | Low Stock Items came from branch stats (`on hand ≤ low threshold`), Inventory Alerts from the alerts endpoint — two formulas, neither clickable | Both come from the alerts payload: **Low Stock Items** = severity `low`, **Inventory Alerts** = low + critical (card turns red when any are critical). Each card is a real link (keyboard focusable, "View low stock" / "View alerts (N critical)") to `/supervisor/inventory?status=low|alerts`. The existing inventory page gained a status filter (All / Needs attention / Low / Critical, `aria-pressed`), using each row's server-computed status, so the count on the card equals the rows shown. No new alert page. |
| Branch switching | Panels could keep the previous branch's response while refetching (`keepPreviousData` on attendance); staff list ignored the selected branch entirely | Every branch-scoped payload is used only if its `branch_id` matches the active branch (loading state otherwise): stats, alerts, attendance, inventory rows. The staff list is queried with `branch_id` = active branch and rows not assigned to it are dropped. The dashboard header no longer shows a branch UUID after a reload (the branch object isn't persisted, only its id). |
| Attendance Overview | Listed records clocked in since browser-local midnight (missed overnight clock-ins, counted deactivated/reassigned staff, capped at 100) — could disagree with the Staff Clocked In KPI | New `GET /api/attendance/branch/:id/summary` (admin/supervisor, `branchGuard`): **clocked in now** = open record + employee active + still assigned here (same rule as the KPI's `countStaffTimedIn`); **clocked out today** = latest clock-out per employee in the Manila day, excluding anyone clocked in again. Open rows that don't count are reported as `excluded_open_count` and explained. Only attendance records are read — never logins, sessions or socket presence. The Supervisor Staff Clocked In card now uses this summary and links to the attendance page. Times shown in Asia/Manila. No break tracking. |
| Supervisor management | No edit/delete in the Admin UI ("edit from the Supervisor console"); server only checked branch overlap, so a supervisor could edit, deactivate or reset the password of a **peer supervisor** (or branch account) sharing a branch | Admin Supervisors list and detail page have Edit, Change Status and Delete. Server rules below. |
| Staff PIN | PIN action buried in a "…" menu; detail page had no PIN at all; status labels "Active/Inactive/Not Set" read like account status | Row shows **PIN set / PIN off / No PIN** and a visible **Set PIN** / **Reset PIN** button; detail page has the same button plus a PIN card ("since <date>"). The PIN dialog shows the current state. PINs are never displayed. Storage/verification unchanged. |
| Staff edit/delete | Edit and status hidden in "…"; no delete | Visible Edit / Status / Delete per staff row (and on the detail page). Supervisor rows in the Supervisor console show "Managed by Super Admin". Actions sit right after the name and wrap on phones so they are on screen without horizontal scrolling. |
| Focus | Row buttons are re-created when the table re-renders, so Radix returned focus to `<body>` | `lib/refocus-row-action.ts` re-finds the trigger by a stable `data-row-action` key after close. Dialog save/validation/server errors are shown inline (`role="alert"`), not only as toasts. |

## 2. Role and branch permissions (server-enforced)

`assertCanManageTarget` (employees.service.ts) runs after the existing branch check (`assertEmployeeAccess`) on update,
status, deactivate, reactivate, deletion-eligibility and delete:

| Actor → target | staff (own branch) | staff (other branch) | supervisor | branch account | super_admin | self |
| --- | --- | --- | --- | --- | --- | --- |
| Super Admin | ✓ | ✓ | ✓ | ✓ (never hard-deleted) | ✗ `PRIVILEGED_ACCOUNT_PROTECTED` | ✗ |
| Supervisor | ✓ | ✗ `EMPLOYEE_ACCESS_DENIED` | ✗ `TARGET_ROLE_FORBIDDEN` | ✗ `TARGET_ROLE_FORBIDDEN` | ✗ | ✗ `SELF_ACTION_FORBIDDEN` |
| Branch / Staff | routes are `adminOrSupervisor` → 403 | | | | | |

Reset-password keeps its documented rule that a same-branch supervisor may reset a **branch account** password; it now
refuses supervisor targets (for non-admins), super_admin targets and self. Profile self-edits still go through
`/api/auth/profile`. `GET /api/staff-pin/:userId` (PIN status) previously had **no branch check**; it now applies the same
scope as set/revoke (non-admins: target must be assigned to one of the caller's branches; unknown ids also get 403).

## 3. Delete versus deactivate

- `GET /api/employees/:id/deletion-eligibility` → `{ can_delete, blocked_reason, references }`;
  `DELETE /api/employees/:id` → permanent delete, or `409 EMPLOYEE_HAS_HISTORY` with the counts.
- History that blocks permanent deletion (`countHistoryReferences`): sales/checkouts/hold orders (cashier, void, refund, proof
  verifier), shifts and shift reviews, attendance (own or as corrector), audit log/outbox as actor, fraud alerts, every
  inventory movement/approval/cost-correction/operation/evidence column, expenses, catalog and inventory-definition
  ownership (created/managed/changed), settings changes, init runs, PINs this person set for others, accounts this person
  deactivated, and any verification of this person's own PIN. Many of these are plain user-id columns without FKs, so
  Postgres alone would not have protected them.
- With no history, the delete runs in one transaction that re-counts first, then removes only what belongs to the account
  (refresh/reset tokens, device PIN credentials, staff PIN + lookups, own notifications/preferences, idempotency keys, branch
  assignments) and the user. A late write to an FK'd table is refused by Postgres (P2003 → 409) and rolls back.
- Branch accounts are never hard-deleted (`BRANCH_ACCOUNT_NOT_DELETABLE`).
- The audit entry `EMPLOYEE_DELETED` stores the full before-snapshot (name, employee ID, branches); existing audit entries
  about the person are kept.
- With history, the same dialog offers **Deactivate (keep history)**: status `inactive` via the existing status endpoint
  (reason ≥ 10 chars, active-shift acknowledgement inline). That path already revokes refresh tokens, pushes the forced
  logout, removes branch assignments and PIN lookups — so cashier access ends immediately — and leaves every transaction,
  attendance row and audit entry attributed by name. Already-inactive people with history get an explanation, no action.

## 4. Verification

Disposable LOCAL databases `p47_*` (new each run; not `pos_verify`, no other session's DB) in container
`potato-corner-pos-postgres-1` at 127.0.0.1:5432, via `prisma migrate deploy` + `prisma/seed.ts` + a P47 fixture (second
branch, staff with/without history, an inactive employee with an open clock-in, a peer supervisor, low/critical/healthy
stock). A scratchpad env with throwaway local secrets; a guard refused any URL other than `127.0.0.1:5432/p47_<digits>` (and
any `PRODUCTION_DATABASE_URL_DIRECT`) before every migrate, seed, fixture, test and server start; fixtures also ran
`tests/e2e/fixtures/local-db-guard.cjs`. API `node dist/server.js` on **4497**, web `next start -p 3497`. All seven
`p47_*` databases were dropped afterwards and the env/keys deleted.

| Check | Result |
| --- | --- |
| API unit, new P47 auth/delete cases (`employees.service.test.ts`) | 69/69 (2 existing reset-password tests first failed under a too-broad guard; guard narrowed, they pass unchanged) |
| API integration `p47-management.integration.test.ts` (real Postgres) | 8/8 — summary vs KPI agreement, no cross-branch mixing, history refusal keeps attribution, unused delete incl. PIN + named audit, cross-branch/peer delete refused, PIN-status scope |
| **API full suite** (local DB) | **188 files passed, 8 skipped; 3220 tests passed, 104 skipped, 0 failed** |
| **Web full suite** | **159 files, 1447/1447 passed** |
| `turbo run type-check lint` | 7/7 tasks; 0 errors (308 pre-existing `no-console` warnings, none in P47 files) |
| `next build` (web), `tsc` build (API) | Pass. The first web build failed: `useSearchParams` on `/supervisor/inventory` needed a Suspense boundary — fixed. |
| HTTP checks against the live API (supervisor assigned to Main only) | **21/21** — own-branch summary (Carlo in, Dina out, 1 excluded) equals the KPI; other-branch summary/alerts/delete/eligibility/PIN status/edit → 403; peer-supervisor edit/status/delete/reset-password → 403 `TARGET_ROLE_FORBIDDEN`; self status → 403; branch account DELETE → 403; history staff → 409; unused staff/supervisor deletable; super_admin self-delete → 403 |
| Real browser (Playwright Chromium, SW blocked; 1440×900, 820×1180, 390×844) | **52/52** on the final build: Admin has no inventory cards, Staff Clocked In = 2 from attendance; no horizontal overflow on any viewport; Edit dialog opens from keyboard and focus returns to the row button on Escape; supervisor edit saved; unused supervisor deleted after confirm. Supervisor Main: Low 2 / Alerts 3 / Clocked In 1; attendance panel and exclusion note correct; keyboard Enter on the Low card opens `?status=low` with exactly 2 rows; Alerts → 3 rows; switching branch on the filtered list shows only North's item; North dashboard 1/0/1 with no Main names; switching back restores 3. Staff list shows No PIN → Set PIN (focus returns) → PIN set / Reset PIN, PIN never rendered; Main list hides North staff; required-position validation visible; unused staff deleted; history staff gets Deactivate only, then Clocked In drops to 0 and the attendance page still shows "Carlo Clockedin". Remove dialog fits the phone viewport; staff and supervisor row actions are on screen on phones. |

Failures found and fixed during browser runs: focus not returning to row buttons; branch UUID in the dashboard header after
reload; staff list not scoped to the selected branch; row actions off screen on phones (an earlier `isVisible` check had
passed despite this; the check now requires the button inside the viewport).

## 5. Limitations

1. Deactivation (existing behaviour) removes branch assignments, so a deactivated staff member disappears from the
   Supervisor's list and only a Super Admin can reactivate/reassign them. Inactive staff who still had an assignment (fixture
   data) do show, with a Set PIN button the server refuses (`USER_INACTIVE`, shown inline).
2. The global API limiter (100 req/min, keyed before auth, so per IP) was hit by the scripted browser run; the script was
   paced. A real user won't approach it, but several busy sessions behind one NAT share that bucket. Not changed here.
3. The history check is count-then-delete in one transaction; a write to one of the non-FK columns landing in the same
   instant could still slip through (FK'd tables are protected by Postgres).
4. Physical tablets/phones were not tested; viewport sizes were proxies. Screen readers were not tested beyond roles/labels.
5. Clock-outs are bucketed by the Manila day of the clock-out; a person who clocked out just after midnight appears under the
   new day.

## 6. State

Starting SHA `7084291`; final SHA = the commit that adds this runbook. Working tree clean after commit; `main` is one commit
ahead of `origin/main`. Nothing pushed or deployed.
