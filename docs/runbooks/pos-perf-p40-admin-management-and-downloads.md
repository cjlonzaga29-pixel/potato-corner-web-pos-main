# POS-PERF-P40 — Simpler Admin management and report downloads

Starting HEAD: `45aab2a22c5374993f6b2b4a55ac1c9ffde5248e` (POS-PERF-P39R3), clean tree. P39 work is
kept as it is; P40 is a separate commit. No schema change, no migration, no new library, no new
notification channel or recipient. Nothing was pushed or deployed, and no production data,
configuration, storage bucket or credential was touched. Every check below ran against the local
`pos_verify` database, local Supabase storage, a built `apps/api` (:4000) and `next build` /
`next start` (:3000).

## 1. Admin dashboard

**Removed:** Low Stock Inventory, Low Stock Summary and Recent Activity. Only the Admin dashboard
sections were removed. Inventory data, low-stock notifications and the Supervisor inventory pages
are unchanged.

**Branch Performance — root cause of the wrong numbers.** The table read the
`BRANCH_COMPARISON` report snapshot. That snapshot covers 30 days, refreshes about every 15 minutes
and had no label saying either. It sat next to cards showing *today*, so the two disagreed. The
table now uses the same live "today (Asia/Manila)" per-branch stats as the cards above it.

| Column | Source |
| --- | --- |
| Branch (name + code) | `GET /api/branches` |
| Status | the Admin-set `Branch.status`: active / inactive / closed |
| Connection | new `GET /api/branches/presence`: online if at least one signed-in socket is in the branch room; "unknown" if presence couldn't be read |
| Gross Sales, Transactions, Avg. Order, Active Shifts, Clocked In | `useAllBranchStats` — same query as the cards |

- A scope line states the date and branches ("Today, 2026-10-27 (Manila) · All branches (n)").
- Status and Connection are separate columns. A closed branch can be online, and an active
  branch can be offline.
- **Branch Status card:** Active / Inactive / Closed now come from server totals
  (`useBranches({status, limit: 1}).total`). They used to be counted from the first 100 rows, and
  "closed" was counted as inactive.

## 2. Branches (Branches + Branch Accounts combined)

- There is one sidebar entry, **Branches**. "Branch Accounts" is removed from the nav, and
  `/admin/branch-accounts` redirects to `/admin/branches`.
- The list columns are Branch | Status | Assigned Supervisors | Branch Account | Manage.
- **Manage** opens a side panel with Details, Account and Supervisors tabs.
  - The URL (`?manage=<id>&tab=<tab>`) restores the panel, and the Back button closes it.
  - The panel reuses the existing dialogs and endpoints (edit, status change, create/edit branch
    account, assign/remove supervisor). Server-side permissions and audit entries are unchanged.
  - Passwords are never displayed.
  - Removing a supervisor requires confirmation.
- The Supervisors tab lists **supervisors only**. The assignments endpoint also returns staff and
  the branch login account. An early P40 build listed them all with a Remove button, which the
  browser check caught and P40 fixed.

## 3. Supervisors (renamed from Employees)

- The sidebar entry and page are now **Supervisors** (`/admin/supervisors`), and
  `/admin/employees` redirects there.
- Individual person pages (`/admin/employees/[id]`) keep their URLs. Their back link now goes to
  Supervisors.
- **Add Supervisor** posts to the new `POST /api/employees/supervisors`, validated by
  `createSupervisorSchema`. Any role other than `supervisor` is refused with 422 on the server, so
  the dialog is not the only check. The general `POST /api/employees` is unchanged.

## 4. Admin attendance

- New `GET /api/attendance/admin` (Super Admin only). Its filters are branch, supervisor, employee,
  Manila date range, and `open_only`.
- **Supervisor filter:** "the branches this supervisor is assigned to now". Assignment history is
  not reconstructed. Records are fetched once by `branchId IN (...)`, so a branch shared by two
  supervisors never produces duplicate rows.
- **Overnight shifts:** "Clocked in now" lists every record with no clock-out, whatever day it
  started. Before P40, the date-filtered view hid a shift that started the previous evening.
- **Reconciliation with the dashboard's Staff Clocked In:**
  - Every open record carries `counts_toward_clocked_in`, which is true when the branch is active,
    the employee is active, and the employee is still assigned to that branch. These are the same
    rules the dashboard uses.
  - The page shows the dashboard figure next to the counted / not-counted split.
  - Records are never edited to make the two match.
- Times are shown in Asia/Manila, and an Overnight badge marks shifts that cross midnight.

## 5. Reports transaction panel and downloads

**Root cause of the missing rows:** the panel loaded at most 100 rows and paged them on the client,
while `DataTable` uses manual pagination. Past row 100 nothing showed, and "next page" didn't change
the rows. Paging and receipt search now run on the server (`receipt_search`, 25 per page). The panel
is wider (`min(96vw, 92rem)`), amounts are right-aligned and kept on one line, and an empty payment
proof reads "Not uploaded" on one line.

**Download Transaction PDF:** `GET /api/transactions/export/pdf`, Super Admin or Supervisor.
- "Download PDF (n matching)" exports **every** transaction matching the filters, not only the
  visible page. The per-row button exports one transaction. The PDF header states which of the two
  it is and lists the filters.
- **Access:**
  - A single transaction is checked against its own branch.
  - A `branch_id` filter must pass `hasBranchAccess`.
  - With no branch filter, a supervisor gets only the branches they can access.
- **Contents:**
  - Landscape layout. The header row repeats on every page, with "Page X of Y" at the foot.
  - Stored amounts are printed as stored, and missing values print as "—".
  - Customer ID is decrypted only for Super Admin or Supervisor; the access is audited as
    `DISCOUNT_AUDIT_PII_ACCESSED`, and an undecryptable value prints "Unreadable".
- **Size cap:** more than 2,000 rows is refused with 422 `EXPORT_TOO_LARGE` and a clear message.
  The export is never silently truncated.
- **Visual check:** the first render hyphenated words and doubled every row's height. The fix
  renders at one point below the computed layout size. 32 rows now fit on 3 pages, one line each.

**Download Photo** (Payment Proof and Discount Proof dialogs):
- Each click calls `GET .../payment-proof?download=1` (or `discount-proof`).
- The API answers with a fresh 300-second signed URL created with Supabase's `download` option, so
  Storage returns `Content-Disposition: attachment; filename=payment-proof-<receipt>.png`.
- Buckets stay private, and no signed URL is stored.
- Verified: the downloaded bytes are identical to the 68-byte source image.
- If the inline image fails to load (for example, an expired link), the viewer offers "Reload
  photo".

## 6. Notifications

Research: Facebook's Help Center loads its content in the browser and couldn't be fetched, so the
interaction model comes from third-party guides and notification-design references:
- [How-To Geek](https://www.howtogeek.com/876077/how-to-delete-facebook-notifications/) and
  [MakeUseOf](https://www.makeuseof.com/tag/how-to-delete-facebook-notifications/) — the bell,
  "Mark all as read", per-item read, and read items that stay in the list.
- [Courier](https://www.courier.com/blog/in-app-notification-center-design) and
  [SaaS UI](https://www.saasui.design/blog/saas-notification-center-ux-patterns) — grouping,
  filters, and empty/error states.
- [MagicBell](https://magicbell.com/blog/ux-accessibility-tips-and-tricks) — accessibility.
- [Wikimedia T115528](https://phabricator.wikimedia.org/T115528) — bundling and unread semantics.

Defects fixed:
1. **Wrong unread badge.** It counted unread items among the 25 loaded rows. It now uses the
   server's `unreadCount` (shown as 99+ beyond 99).
2. **Cache not tied to the account.** The cached list wasn't keyed by user, so after switching
   accounts the bell could show the previous person's notifications for a moment. The query key is
   now `['notifications', userId, page, limit]`.

Added:
- An All / Unread filter.
- Grouping of repeated alerts by type, branch and subject (shown as ×N, expandable). Marking a
  group as read marks every item in it.
- For branch outages, "Back online" appears only when an actual `branch_online` event exists;
  otherwise the group says "No recovery received yet".
- Destinations: branch alerts open `/admin/branches?manage=<id>&tab=details`.
- Loading skeleton, error with Retry, a stale-data notice, a reconnecting notice and
  "Updated X ago".
- Unread / read state announced to screen readers.

## 7. Work Hours

- **Supervisor Settings → Work Hours** shows one card per assigned branch.
- Branch overrides are stored as `SystemSetting` keys `work_hours_policy:branch:<branchId>`, so
  there is **no migration**. The existing global `work_hours_policy` stays the fallback.
- **"Use default"** removes the override, after a confirmation.
- **Routes:**
  - `GET/PUT/DELETE /api/settings/work-hours/branches/:branchId`: Admin or Supervisor, plus
    `hasBranchAccess`, which returns 403 for a branch the supervisor isn't assigned to.
  - `GET /api/settings/work-hours/branches`: Admin only.
- Each change is audited as `BRANCH_WORK_HOURS_UPDATED` or `BRANCH_WORK_HOURS_CLEARED`.
- **Admin Settings** shows a read-only table (branch, effective hours, source, last change). The
  Admin editor for the global value was removed from the UI. `PUT /api/settings/work-hours`
  remains, Super Admin only.
- **Effective dating:** clock-out and manual corrections now call
  `getRegularShiftMinutes(branchId)`. Overtime is stored on each attendance record when it's
  calculated, so a change applies only to clock-outs and corrections saved afterwards. Past
  records keep their overtime; the browser spec checks this on a closed record.

## 8. Deployment, rollback, compatibility

- **No migration and no new environment variable.**
- **Deploy order:** API first, then web. A previous web build keeps working against the new API.
  The new web build calls `/presence`, `/attendance/admin`, `/employees/supervisors`,
  `/export/pdf`, `?download=1` and `/work-hours/branches/*`, so it needs the new API.
- **Rollback:** revert the commit.
  - Leftover `work_hours_policy:branch:*` rows are ignored by older code, which reads only the
    global key.
  - Overtime already recorded under an override stays as recorded.
- **Write gates** are unchanged. Every new write route goes through the existing `authenticate`,
  role guard, `requirePasswordChange`, zod validation and audit logging.

## 9. Verification

| Check | Result |
| --- | --- |
| API full suite | 178 files passed, 16 skipped; 3,026 tests passed, 232 skipped, 0 failed |
| New: `p40-admin-management.integration.test.ts` (real Postgres) | 7/7 |
| New: `p40-route-boundaries.test.ts` | 16/16 |
| New: `transactions.export.test.ts` | 5/5 |
| Web full suite | 149/151 files and 1,291/1,309 tests passed on the first full run. The 18 failures were all in the pre-P40 dashboard and attendance page tests, which were rewritten for the new pages; they now pass 13/13 and 7/7 |
| `tsc` (shared, api, web), lint, `apps/api` build, `next build` | clean (one lint warning existed before P40) |
| Browser: `tests/e2e/pos-perf-p40-admin-management.spec.ts`, 8 tests | all 8 passed on the final build (dashboard, branches, supervisors in one run; attendance, reports, notifications, work hours, narrow viewport in the next) |
| Direct API checks | presence, admin attendance, PDF `%PDF-` with an attachment header, photo download byte-identical |

Mistakes in the test itself, found and fixed while running it:
- an exact-match label where the field reads "Password*";
- a wrong `authedGet` argument order;
- an expectation for a removed photo. When the object is missing, the API refuses to sign a link
  and the dialog shows its error state with "Try again".

Also fixed: a first-assertion wait that was too short while branch stats loaded (the rows sit
under a spinner until then).

The verification machine was at 100% CPU with about 0.5 GB of free RAM. The local Postgres
container dropped connections (P1001, 38 times) and the connection pool timed out (P2024, 9
times), so some runs failed before any test started. Those runs were repeated after the database
recovered and are not counted as passes. Browser screenshots and downloads are in
`.p39-local/p40/` (local only, not committed).

## 10. Known limitations and policy questions

- **Who changes the global Work Hours default now?** The Admin UI editor was removed as requested;
  only the Super Admin API remains.
- **Supervisor filter** uses current assignments, not historical ones.
- **Some branch pickers load at most 100 branches.** The local database has about 700 test branches,
  so this matters there; it may not matter in production.
- **Connection status** is sign-in presence on this API instance, held in memory (Socket.io has one
  in-memory adapter). It is not network uptime, and it is lost on restart.
- **Missing proof object** returns 500 `*_PROOF_URL_FAILED` with a generic message; the UI shows
  an error and retry. A specific "photo not in storage" 404 would be clearer.
- **Local `ENCRYPTION_KEY`** is 64 hex characters, but the code expects base64, so local
  encryption fails. Customer ID decryption in the PDF is covered by mocked unit tests only.
  `.env` was not changed.
- The sidebar highlight does not cover `/admin/employees/[id]` under Supervisors.
