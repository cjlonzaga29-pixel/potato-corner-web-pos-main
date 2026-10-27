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
- **Deploy order (corrected in P40R).** The original "API first, then web" was not what the
  pipeline does. See §11.4 for the actual sequence and what each overlap does.
- **Rollback:** revert the commit.
  - Leftover `work_hours_policy:branch:*` rows are ignored by older code, which reads only the
    global key.
  - Overtime already recorded under an override stays as recorded.
- **Write gates** are unchanged. Every new write route goes through the existing `authenticate`,
  role guard, `requirePasswordChange`, zod validation and audit logging. The maintenance write
  gate does **not** cover them (see §11.4).

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
  only the Super Admin API remains. *(P40R: documented as the control, see §11.2.)*
- **Supervisor filter** uses current assignments, not historical ones. *(P40R: the label now
  says so, see §11.3.)*
- **Some branch pickers load at most 100 branches.** The local database has about 700 test branches,
  so this matters there; it may not matter in production. *(P40R: callers listed in §11.6.)*
- **Connection status** is sign-in presence on this API instance, held in memory (Socket.io has one
  in-memory adapter). It is not network uptime, and it is lost on restart.
- **Missing proof object** returns 500 `*_PROOF_URL_FAILED` with a generic message; the UI shows
  an error and retry. A specific "photo not in storage" 404 would be clearer. *(P40R: fixed, now
  410 `PROOF_FILE_MISSING` and "Photo unavailable", see §11.1.)*
- **Local `ENCRYPTION_KEY`** is 64 hex characters, but the code expects base64, so local
  encryption fails. Customer ID decryption in the PDF is covered by mocked unit tests only.
  `.env` was not changed.
- The sidebar highlight does not cover `/admin/employees/[id]` under Supervisors. *(P40R: fixed,
  see §11.3.)*

## 11. P40R — isolated final verification (2026-10-28)

Reviewed tip: `4cd9fe24d4a2add9ac89c056541727b1898dcebb` (P40 runbook commit, on top of
`ba4387cd2709b5ea578d8f1cf761241653339dec`). All P40R work ran in a separate worktree
(`C:/Users/kaile/Downloads/PTTO/p40r-review`, branch `review/pos-perf-p40r`). The shared
checkout, which holds another session's uncommitted P41 changes, was not edited, stashed or
staged. No push, deploy, production write, configuration change or credential change. No
`pos_verify` data was read or written: the worktree's `apps/api/.env` is a copy of
`.env.example` with both DB URLs pointed at an unreachable port (`127.0.0.1:1`).

### 11.1 Missing proof photo

**Storage behaviour, measured on local Supabase Storage** (one uniquely named 70-byte PNG
uploaded under `payment-proofs/p40r-fixture/`; nothing else in storage was touched):

| Case | What Storage returned |
| --- | --- |
| Valid object, `download` option | signed; GET 200, `Content-Disposition: attachment; filename=payment-proof-x.png`, 70 bytes |
| Missing object | `StorageApiError` HTTP 400, `statusCode "404"`, "Object not found" |
| Missing **bucket** | the same: HTTP 400, `statusCode "404"`, "Object not found" |
| Expired signed URL | GET 400 `InvalidJWT` ("exp" claim timestamp check failed) |
| Storage unreachable | `StorageUnknownError` "fetch failed" |
| `getBucket` on an existing / missing bucket | ok / `statusCode "404"` "Bucket not found" |

A missing bucket gives the same answer as a missing object. Reporting "permanently missing" from
that answer alone would turn a misconfigured bucket into "every photo is gone".

**Change** (`transactions.service.ts`, one `signProofUrl` shared by view and download links):
- The photo is reported missing only on a 404 / "Object not found" answer **and** a successful
  `getBucket` for that bucket. The API then answers **410 `PROOF_FILE_MISSING`** ("This photo is
  no longer in storage, so it cannot be shown or downloaded.").
- Everything else keeps the old retryable 500 `PAYMENT_PROOF_URL_FAILED` /
  `DISCOUNT_PROOF_URL_FAILED`: network errors, a missing bucket, a failed or throwing bucket
  lookup, and any other Storage error.
- The router still checks the transaction's branch (`hasBranchAccess`) **before** any Storage
  call. An unauthorized caller gets 403 `BRANCH_ACCESS_DENIED` and learns nothing about the
  file. Neither error contains the storage key. Buckets stay private, and links are still fresh
  and short-lived (60 min view, 5 min download).
- **Web:**
  - `usePaymentProof` / `useDiscountProof` keep the API code (`TransactionApiError`) and do not
    retry `PROOF_FILE_MISSING`; other failures keep 2 retries.
  - `ProofPhotoViewer` shows **"Photo unavailable"** with an explanation and no retry or
    download button.
  - "Try again" (load failure) and "Reload photo" (expired link) are unchanged for temporary
    failures.
  - A download that finds the file gone switches to the same "Photo unavailable" state.

### 11.2 Work Hours roles (verified, global control documented)

- **Global default:** `PUT /api/settings/work-hours` is the control. It is `adminOnly`, and a
  supervisor gets 403 (new route test). The Admin UI editor stays removed, and no new UI was
  added.
  - To change it, a Super Admin sends `PUT /api/settings/work-hours` with
    `{"regularHours": <1–24>}`.
  - Admin Settings shows the result read-only.
- **Supervisor overrides:** `PUT/DELETE /api/settings/work-hours/branches/:branchId` require
  `hasBranchAccess`, so they apply to assigned branches only (existing tests). The body is parsed
  by `updateBranchWorkHoursSchema` (`z.object({ regularHours })`), which strips extra fields.
  - New test: a supervisor body with `key: 'work_hours_policy', scope: 'global'` reaches the
    service as `{ regularHours: 9 }` for that branch only.
  - `updateWorkHoursPolicy` is never called.
- **History:** overtime is stored per attendance record at clock-out or correction. The existing
  real-Postgres test (`p40-admin-management.integration.test.ts` › work hours) checks that stored
  attendance is not rewritten. P40R did not change that code. The test was not re-run here,
  because it needs a database (see §11.7).

### 11.3 Navigation and labels

- **Sidebar and breadcrumb:** `NavItem.activePrefixes` + `isNavItemActive`
  (`components/shared/nav-active.ts`).
  - Supervisors is highlighted on `/admin/supervisors`, on person pages at
    `/admin/employees/:id`, and on the redirecting `/admin/employees`.
  - Branches is highlighted on the redirecting `/admin/branch-accounts`.
  - The header breadcrumb now reads "Supervisors" on `/admin/employees/:id`. Before, it showed the
    person's id.
  - Unit-tested for 7 paths, including `/admin/employeesx`, which must not match.
- **Attendance:**
  - The filter is labelled **"Supervisor (current branches)"**, with the hint "Uses the branches
    this supervisor is assigned to now, not who supervised when each record was made." It is
    linked to the field by `aria-describedby`.
  - The scope line already read "<name>'s current branches (…)".

### 11.4 Deployment overlap (corrected)

**What the pipeline actually does.** `deploy-production.yml` runs on push to `main` in this order:
1. Full CI.
2. Manual approval (the "production" GitHub Environment).
3. `prisma migrate deploy`.
4. The Render deploy hook for `apps/api`.

`apps/web` has no step in that workflow: Vercel's GitHub integration deploys it **on the same push,
independently**. The web normally goes live first, and the API follows only after CI and
approval. This window can last hours if approval waits. "API first, then web" was never enforced.

**New web + old API** (the normal window). Checked route by route against `45aab2a`'s routers:

| New web call | Old API answer | Effect |
| --- | --- | --- |
| `GET /branches/presence` | matches `GET /:branchId` → not-found/validation error | Connection shows "unknown"; read only |
| `GET /attendance/admin` | no route → 404 | Admin Attendance shows its error state |
| `POST /employees/supervisors` | no route (old POSTs are `/` and `/:id/<action>`) → 404 | **Nothing written**; the dialog shows the error |
| `GET/PUT/DELETE /settings/work-hours/branches/*` | no route (old settings `/:branchId/*` routes need a different tail) → 404 | **Nothing written**; Admin overview and Supervisor Work Hours show errors |
| `GET /transactions/export/pdf` | matches `GET /:transactionId` → not found | No PDF; error shown |
| `GET …/payment-proof?download=1` | `?download` ignored; inline-view shape returned (no `download_url`) | **Defect found:** the new web built a link to `"undefined"` and clicked it. **Fixed**: the client now refuses and says Download is not available until the server update finishes (test added) |

No unsafe write path: every new write hits a 404 on the old API before any handler runs.

**Old web + new API** (cached tabs, a rollback, or a slow Vercel deploy). Every P40 schema change
is additive (an optional `receipt_search`, a new export schema), and no old route was removed or
narrowed.
- The old Admin Settings → Work Hours editor still calls `PUT /settings/work-hours`, which is
  still Super Admin only and still writes only the global key.
  - **Behaviour to know:** its text says the value "Applies to every branch's clock-out", but a
    branch with a supervisor override keeps the override.
  - This is not a write-safety issue, since no wrong key is written and no record is rewritten.
    Old tabs lose the editor on reload.
- Old supervisor builds have no per-branch editor, so supervisors can't write Work Hours from an
  old tab.
- The old Employees "create" dialog keeps using the unchanged `POST /employees` (role rules
  unchanged).

**Write gate.** The maintenance gate (`middleware/write-gate.ts`) covers checkout, inventory and
catalog paths only. It does **not** cover `/api/settings/*` or `/api/employees/*`, so the P40 writes
(branch Work Hours, Add Supervisor) are not blocked when the gate is closed. That matches the
gate's purpose (stock and sales consistency). Neither write touches stock or sales, and the
gate was not changed.

**Migration.** Checked, not assumed: the P40R diff touches nothing under `apps/api/prisma` or
`packages/shared` and adds no setting key or environment variable. **No migration.**

### 11.5 Test evidence

**Full web suite on committed P40.** This ran on the clean `4cd9fe2` worktree before any P40R
edit, with `vitest run --pool=forks --poolOptions.forks.maxForks=2`:
- **Exit code 1.** Test Files: 9 failed, 141 passed (150). Tests: 15 failed, 1,283 passed
  (1,298). 1,943 s.
- The rewritten P40 tests passed: `admin/dashboard/page.test.tsx` 13/13 and
  `admin/attendance/page.test.tsx` 7/7.
- 14 of the 15 failures were "Test timed out in 5000ms". The 15th (`InventoryAdjustForm`
  "Unable to find … Save Adjustment") followed a timeout in the same file.
- During the run the machine was at 99–100% CPU with about 0.1 GB of free RAM, from processes
  outside this session.

**Re-run of exactly the 9 failed files, single fork (`maxForks=1`):**
- 8 of 9 files passed, including P40's `daily-sales-drilldown.test.tsx`.
- `branch/terminal/page.test.tsx` still had 8 timeouts, with a different set of tests than the
  first run.

**Was the terminal page a P40 regression?** The terminal page's import graph reaches 6 modules
P40 changed. All of those changes are additive: new hooks it doesn't call, one optional query
param, and one formatter. It mocks `use-settings` entirely. Running the terminal test file
single-fork on the P40 tree and on the parent `45aab2a` (P39R3, separate worktree), in both
orders:

| Run | 45aab2a (pre-P40) | 4cd9fe2 (P40) |
| --- | --- | --- |
| baseline first | 121/121 | 117/121 (4 timeouts) |
| P40 first | 116/121 (5 timeouts) | 115/121 (6 timeouts) |

The pre-P40 parent times out the same way under load, on different tests each run. These
timeouts already existed and depend on load; they are **not a P40 regression**. The full suite was
**not** green on this machine and is not reported as green. Timeouts were not raised.

**P40R checks (worktree with P40R changes):**

| Check | Result |
| --- | --- |
| API: `transactions.service.test.ts`, `transactions.router.test.ts`, `p40-route-boundaries.test.ts`, `settings/*` (forks=1) | 5 files, **411/411** passed (9 new cases) |
| Web: proof viewer (new, 5), `transaction-export-client` (new, 3), `use-transactions` (+2), `admin-sidebar` (+7), attendance page (+1), drilldown, inventory movements, admin reports, branch receipts | **11 files, 119/119** passed on the final code (`maxForks=2`). The first run of the new viewer test needed a test-only `cleanup` fix |
| `tsc --noEmit` shared / api / web | clean |
| ESLint api / web | 0 errors. API 308 warnings, all pre-existing (changed API files lint clean). Web 1 warning, pre-existing (`profile/two-factor-section.tsx` `<img>`) |
| Real storage, real service code | **Incomplete.** The real `transactionsService` ran against local Storage, with only the DB row stubbed. By then local Storage had stopped responding: the container was `unhealthy`, and `GET /storage/v1/status` didn't answer in 60 s. The valid fixture's view link came back as the **retryable** 500 `PAYMENT_PROOF_URL_FAILED`, not as missing, and the message didn't contain the key. The next call hung until the 590 s timeout. This was an outage-path observation; the 410 path wasn't exercised against live Storage. The Storage error shapes it depends on were measured earlier while Storage was up (§11.1 table) |

### 11.6 Branch pickers capped at 100 (documented, not changed)

`useBranches({ … limit: 100 })` callers:
- **Admin:** `admin/attendance/page.tsx`, `admin/employees/add-supervisor-dialog.tsx`,
  `admin/employees/manage-branches-dialog.tsx`, `admin/expense-filter-bar.tsx`,
  `admin/expense-form.tsx`, `admin/inventory/admin-branch-select.tsx`,
  `reports/report-filter-bar.tsx`.
- **Supervisor:** `supervisor/inventory-catalog/[itemId]/page.tsx`, `supervisor/products/page.tsx`,
  `supervisor/branch-selector.tsx`, `supervisor/employees/assignment-manager-dialog.tsx`,
  `supervisor/employees/create-employee-dialog.tsx`.
- **Shared:** `hooks/use-selected-branch.ts`.

Supervisor callers get their branches scoped by the API, so they only notice the cap with more
than 100 assigned branches. Admin pickers show only the first 100 branches. Admin can still
reach any branch through Branches (server-paged) and the Branch Status counts (server totals).

### 11.7 Not done / remaining

- **Browser checks were not run in P40R.**
  - During this pass the machine was at 100% CPU with about 100 MB of free RAM, and a single
    `psql` query to the local Postgres container did not return within 2 minutes.
  - An isolated run needs a new database, `migrate deploy` + seed, the API, `next dev` and
    Chromium. Starting those would have competed with the other session's processes.
  - To run them on a quieter machine, use a **new** database, never `pos_verify`, and run the
    API and web from the worktree on their own ports:
    - Admin: `/admin/employees/<id>` highlights Supervisors and its breadcrumb reads
      "Supervisors".
    - Admin Attendance: the supervisor label and hint render.
    - Payment Proof dialog: on a transaction whose `payment_proof_key` points at a deleted
      object, it shows "Photo unavailable".
- **Not re-run:** the full API suite and the real-Postgres integration tests (no disposable
  database brought up, for the same reason).
- **Real-storage 410 check:** re-run `service-storage-check` (§11.5) once local Storage is
  healthy, so the 410 path is exercised against live Storage, not only against the
  measured error shapes.
- **Fixture left in local storage:** one 70-byte PNG under `payment-proofs/p40r-fixture/`. Storage
  stopped responding before it could be removed. It is local only; delete it when Storage
  recovers.
- **Not re-run:** the full web suite on the final P40R tree. The affected files above were run
  instead.
- Out of scope, unchanged: P41 cart/product dialogs, token-refresh performance, audit-chain
  concurrency, branch-picker pagination.
