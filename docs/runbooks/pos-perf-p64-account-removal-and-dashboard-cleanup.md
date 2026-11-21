# POS-PERF-P64: account removal, E2E/smoke cleanup, Reports-only Admin views, dashboard cleanup

Owner-requested batch of six changes:
1. A Super Admin can delete a supervisor account even when it has history.
2. Confirmed E2E/smoke test accounts can be cleaned up safely.
3. The Branch dashboard's Extra Supplies summary moves below the main content.
4. Admin Extra Supplies is available only under Reports.
5. Admin Attendance is available only under Reports (added mid-batch).
6. The dashboard Connected/Connecting/Reconnecting badges are removed.

Branch `feat/pos-perf-p64-account-removal-and-dashboard-cleanup`, cut from `origin/main` at `27e7114`. 27e7114 is PR #46, the last **reported** deployment. This batch did not independently verify production.

**Nothing was pushed, deployed or run against production.** No production account was looked up, removed or changed. A code change alone does not clean the live system; §4 is the procedure to do that later, after review.

## 1. Removal versus physical deletion

What **Delete** does depends on the account. The server enforces every rule; the dialog only explains them.

| Account | What Delete does |
| --- | --- |
| Any account with **no** history (staff or supervisor) | Physical delete, unchanged from P47. The row is gone and an `EMPLOYEE_DELETED` audit entry keeps a snapshot. |
| **Supervisor with history**, Super Admin only | **Removal.** Access is removed for good and the row stays as a non-login historical record. Audit action: `EMPLOYEE_REMOVED`. |
| Staff with history | Refused, unchanged (`EMPLOYEE_HAS_HISTORY`); deactivate them instead. The owner's request was for supervisors. |
| Branch account, Super Admin, yourself | Refused, unchanged: `BRANCH_ACCOUNT_NOT_DELETABLE`, `PRIVILEGED_ACCOUNT_PROTECTED`, `SELF_ACTION_FORBIDDEN`. A supervisor can never act on another supervisor (`TARGET_ROLE_FORBIDDEN`). |

The dialog says "removed" and "history kept". It never calls a retained row deleted. The toast reads "Account removed — history kept".

**A removed account** has these properties:
- `users.deleted_at` and `deleted_by` are set.
- It is always `is_active = false` with a non-active `status`. Status `active` becomes `inactive`; an existing `resigned`/`terminated` status is kept.
- It is absent from every operational list, search and count. That covers the employee and supervisor lists, `findByBranchIds` (selectors) and branch supervisor lists, which go through active assignments that removal ends. Notifications already filter on `is_active`.
- It stays distinct from an ordinary inactive account. An inactive account still appears with the Inactive filter and can be reactivated; a removed one cannot.

**History is never touched.**
- Sales, expenses, attendance, breaks, payroll lines, stock movements, proofs and audit entries keep their actor IDs.
- Joins keep resolving the real name.
- Nothing is cascaded or reassigned. Catalog `managed_by` ownership stays as recorded, the same as after a deactivation.

**Repeated and concurrent deletes:**
- A repeat delete returns `outcome: already_removed` and writes an `EMPLOYEE_REMOVAL_REPEATED` audit entry.
- Two simultaneous deletes produce exactly one removal. The first write in the transaction takes the user row lock.

## 2. Access removal and things that can no longer revive the account

Inside one transaction (`employeesRepository.removeWithHistory`):
1. Mark the row.
2. Re-check prerequisites under the row lock (§3).
3. Revoke all refresh tokens, delete reset tokens and device PINs (`PinCredential`), and end branch assignments.
4. Write a **removed-account marker** into `revoked_tokens` (`removedAccountRevocationHash`, 24 h).

Every access token is checked against its owner's marker as well as its own hash (`verifyAccessToken`). Already-issued 15-minute tokens therefore stop working on every route and on the socket handshake, not only on branch-scoped routes.

After the commit:
- In-process caches are cleared (`forgetAccountStatus`, `forgetActiveStatus`).
- A socket push (`EMPLOYEE_SESSION_REVOKED`) signs the browser out at once.

| Path | Result for a removed account |
| --- | --- |
| Login | `ACCOUNT_INACTIVE` (checks `is_active` and `deleted_at`) |
| Refresh, including the rotation-grace path | `REFRESH_INVALID` |
| PIN login | refused (`is_active`); device PINs deleted |
| Existing access token, HTTP and socket | `TOKEN_REVOKED` |
| Self-service reset request / reset | no email sent; `RESET_TOKEN_INVALID` |
| Admin password reset, edit, branch change, deactivate, reactivate, status | `EMPLOYEE_REMOVED` (409) |
| Branch → assign supervisor | `USER_REMOVED` (409) |
| Super Admin unlock | `ACCOUNT_REMOVED` (409) |

**Races.**
- Ordinary writes match only `deleted_at IS NULL`; a write that loses the race gets P2025 and is mapped to `EMPLOYEE_REMOVED`.
- Branch assignment takes the same row lock (`lockNonRemovedUser`).
- The database CHECK constraint `users_removed_account_inactive_chk` (`deleted_at IS NULL OR (is_active = false AND status <> 'active')`) is the backstop.
- A login that wins the race holds tokens that are already dead: the marker refuses the access token and refresh refuses `is_active = false`.

**Residual window, documented rather than fixed.** Opening a shift does not lock the user row. A shift opened in the milliseconds between the removal's prerequisite check and its commit could survive the removal. The removed person cannot use it, because every later request is refused, and it stays visible for a supervisor to close.

**Delay outside this process.** The fixture script (§4) runs in its own process. There, the API's 60-second "token not revoked" cache can delay the refusal of an already-checked token by up to 60 seconds. Refresh and login refuse at once.

## 3. Operational prerequisites (no silent changes)

Two conditions block a removal. Under them nothing changes, and the reply (`EMPLOYEE_HAS_OPEN_OPERATIONS`) says what to do:

- **An open shift** where the person is the cashier or opener: close the shift and count the cash first.
- **An open clock-in**: clock out, or correct the attendance record, first.

Reported but **not** blocking (shown in the dialog and recorded in the audit `afterState`):
- Held orders. They expire on their own and stay on their branch.
- Pending inventory approvals the person submitted. Reviewers can still decide them.
- **Branches left without any active supervisor.** A Super Admin can assign one from Branches.

`GET /api/employees/:id/deletion-eligibility` now also returns `mode` (`permanent` | `remove_keep_history`) and `prerequisites`. `blocked_reason` gains `open_operations` and `already_removed`. An older client ignores the extra fields.

## 4. E2E / smoke fixture cleanup (exact IDs, dry run first)

Tool: `apps/api/scripts/p64-fixture-account-cleanup.ts`, backed by `src/modules/employees/fixture-account-cleanup.ts`. It goes through the normal `employeesService` lifecycle as a named, active Super Admin, with the same authorization, prerequisites, audit and history retention as the Delete button.

It never matches names or email substrings. "test", "demo", "e2e" and "smoke" mean nothing to it. Each account must be listed by exact `id`, `email` and `role`, plus a written `evidence` note. At execution the tool re-reads every account and refuses it if the email or role no longer matches. Refusals:
- Super Admin accounts: always, never broadened. They need the manual procedure below.
- Branch accounts, and the actor's own account.
- Staff with history: deactivate them instead.
- Anything with an open shift or clock-in.

Automated tests, fixture code, CI guards and GitHub secrets are untouched.

**Later production procedure. Not run; needs the owner's review.**
1. **Inventory, read-only.** With the owner, list the candidate accounts by exact ID from evidence that does not rest on a name:
   - the account emails held in the GitHub `E2E_*` / smoke secrets (`.github/workflows/deploy-production.yml`);
   - accounts created by the documented smoke runs (P42R/P43/P44 runbooks);
   - creation audit entries.

   Record each `id`, `email`, `role` and the evidence in a manifest:
   ```json
   { "actor_user_id": "<active Super Admin uuid>",
     "accounts": [ { "id": "<uuid>", "email": "<exact>", "role": "supervisor", "evidence": "<why this is a confirmed fixture>" } ] }
   ```
2. **Dry run** (changes nothing): `npx tsx scripts/p64-fixture-account-cleanup.ts --manifest m.json --database-host <host>`. It prints the target host (never credentials) and refuses if `--database-host` does not match `DATABASE_URL`. For each account it reports:
   - role, status and current branches;
   - history counts per category;
   - open shifts, clock-ins, held orders, pending approvals and branches left uncovered;
   - the planned action or refusal;
   - a confirmation token.
3. **Review** the report with the owner. Resolve any open shift or clock-in through the normal screens.
4. **Execute** the reviewed manifest unchanged: add `--execute --confirm <token>`. The token binds the run to that exact manifest text and host. A repeat run is safe and audited.
5. **Super Admin fixtures** are out of scope for the tool. They need an explicit owner decision and a separate, reviewed procedure. The tool will not do it.
6. If the smoke accounts are removed, the production smoke workflow needs new owner-provisioned accounts before it runs again. This batch does not provision any.

Removed accounts keep their email, because the unique email preserves identity for audit. The same address cannot be re-created as a new account.

## 5. UI, reports and navigation

- **Branch dashboard.** Today's Extra Supplies moved to the end of the page, after the sales KPIs, collections, Quick Actions, Sales Trend, Inventory Status and Recent Transactions. This is real DOM order, not CSS ordering. Its branch/date scope, amounts, loading and error states and history link are unchanged, and it appears once.
- **Admin Extra Supplies → Reports › Inventory › Extra Supplies (`?tab=EXTRA_SUPPLIES`).**
  - It renders the existing `ExtraSupplyHistory`: branch/date/item/cashier and free/paid filters, server pagination, full-period totals, issue details and its own CSV.
  - It is read-only, with no card setup controls.
  - Supply cost stays separate from cash expenses.
  - The reports page's own filter and export bar is hidden on this tab, and `exportableReportType` returns null.
  - The standalone sidebar entry is gone. Dashboard, Reports and Inventory Movements links point at the tab. `extraSupplyIssueHref` builds the link for one issue.
- **Admin Attendance → Reports › Operations › Attendance Records (`?tab=ATTENDANCE_RECORDS`).**
  - The former page body moved unchanged to `components/admin/admin-attendance-report.tsx`: branch, supervisor, employee and date filters, "Open now", pagination, totals and details.
  - It is read-only; corrections stay in the Supervisor console. It never had an export.
  - The sidebar entry is gone.
- **Old URLs.** `/admin/extra-supplies` and `/admin/attendance` are Server Components that `redirect()` to the tab, keeping only an explicit allowlist (`lib/admin-report-redirect.ts`):
  - Extra Supplies keeps `branch_id`, `date_from`, `date_to`, `extra_supply_id`, `kind`, `cashier_id` and `issue`.
  - Attendance keeps none, because the view reads no URL params.
  - Arrays, empty values, values over 100 characters and attempts to override `tab` are dropped.
  - The routes stay inside the middleware-guarded `(admin)` group, so there is no permission bypass and no redirect loop.
- **Connection badges** are removed from the Admin, Supervisor and Branch dashboards and the Admin Reports header, and `DashboardConnectionBadge` is deleted. Realtime hooks, socket reconnects, polling and Refresh are untouched, as are POS and Extra Supplies offline, failed-sale and uncertain-outcome warnings.
- **Supervisor and Branch** Extra Supplies setup and issue workflows, and Supervisor attendance and corrections, are unchanged. No API role policy changed.

## 6. Migration, compatibility and rollback

**Migration** `20261121120000_pos_perf_p64_user_account_removal` is additive:
- two nullable columns and an index;
- the CHECK constraint, validated against every existing row.

It changes no existing row and removes no account. Prisma does not model CHECK constraints; drift checks stay empty.

**Rehearsal on populated local data** (`scripts/test-p64-migration-on-populated-data.ts`):
- 2,006 users in every state, plus their assignments, shifts, attendance, refresh tokens and audit rows: all byte-identical after the migration.
- The migration marked no account removed.
- Older-API deactivate, reactivate and status writes still work on non-removed rows.
- The database refuses re-activating a removed row.
- No schema drift.

**Rolling back the API to before P64:**
- Old login, refresh and PIN code checks `is_active`, which stays false for a removed row, so access stays refused.
- Old reactivate and status writes on a removed row **fail at the CHECK constraint** (a 500 there) rather than restoring access.
- Old code would still list removed supervisors as Inactive. It could also re-assign them to a branch, because the old `assignSupervisor` never checked `is_active`. Assignment alone does not give login back.
- Already-issued access tokens are short-lived (15 minutes). Removal also revoked every refresh token.

**Rule after a rollback:** do not remove accounts with old code running, and do not drop the CHECK constraint. A schema rollback would also need the constraint dropped first; avoid it.

**Older web clients:**
- They still call the same endpoints.
- A P47-era dialog, seeing `can_delete: true` for a supervisor with history, would label the action "Delete permanently". The server would still only remove access and keep history.
- Reloading the web app picks up the new dialog.

## 7. Verification

See §7.1 and §7.2, filled in from the actual runs. Local disposable embedded Postgres only, on ports 56510–56517 with task-owned data under `C:\p64a`, and throwaway secrets that were never printed. Never production, `pos_verify` or another session's services.

### 7.1 Automated

| Check | Result |
| --- | --- |
| P64 integration (`p64-account-removal.integration.test.ts`) | Run 1: 1 failed (a test bug: mixed-case fixture email versus login's lowercase lookup). Fixed. **12/12 passed.** |
| Focused API (employees, auth, branches, middleware, socket, staff-pin) | Run 1: setup failed, a port held by my own orphaned Postgres worker (stopped); the wrapper still exited 0, a pre-existing `with-test-postgres` quirk. Run 2: 4 failed, all expected behaviour changes (old P47 assertion, `outcome` field, reset-password mocks); tests updated. **Run 3: 554/554 passed.** |
| Migration rehearsal | **Passed** (§6) |
| Full API | **1 failed, 3,819 passed, 5 skipped.** The failure is `p59-report-coverage` attendance PDF (99 versus 100): its fixture clocks in at `now − 1 h`, so in the first hour after Manila midnight (the run started 12:38 AM) that record falls on the previous day. Pre-existing time dependency, unrelated to P64. Re-run alone at 1:12 AM: **8/8 passed**, confirming the diagnosis. Not fixed here (out of scope). |
| API typecheck / lint | Clean / 0 errors |
| Focused web (45 files) | **311/311 passed** |
| **Full web, one run, default settings** | **1,758 passed, 0 failed**, 186 files, 437 s |
| Web typecheck / lint (26 changed files) | Clean / 0 errors |
| Shared | No shared contract changed; not re-run |

| Production builds (`stack.sh build`: API `tsc`, `next build`, service worker generated) | Pass. `/admin/attendance` and `/admin/extra-supplies` build as redirect routes |

### 7.2 Browser

Driver `tests/e2e/manual/p64/account-and-reports.mjs`, run on the final production builds with the service worker controlling every page. It used a disposable P62-style stack: `stack.sh` with `P62_ROOT=/c/p64b`, ports 56521–56523, database `p62_p64browser`. Viewports are Chromium emulation (desktop 1366×900, tablet 820×1180, phone 390×844), not real devices.

**Run 1: 32/36.** All four failures were driver mistakes, diagnosed before any change:
- The attendance check looked at the report's default "today". The fixture record started 6 h earlier, on the previous Manila day.
- The Branch order check (×3 viewports) searched for leaf elements only, and the KPI title is not a leaf.

**Run 2, driver fixed, same builds: 36/36 passed.** Covered:
- **Admin navigation and redirects:**
  - The sidebar has no Extra Supplies or Attendance entry; Reports is present.
  - The old Extra Supplies URL redirects with only `branch_id`/`date_from`/`date_to`, dropping an injected `evil` param and a `tab` override. The old Attendance URL redirects to `ATTENDANCE_RECORDS`.
  - Neither report has setup, clock-in or correction controls.
  - The Extra Supplies CSV downloads from Reports. The file was opened: its first line is the coverage header, with **0 matching lines** for that branch and November range, so the CSV's row content was not exercised in the browser. Row content is covered by the P61 tests; P64 did not change the export.
- **Delete with history:**
  - The dialog says history is kept and the record is not erased. The button stays disabled until confirmed.
  - After the toast, the account is gone from the supervisor list. The database row is kept (inactive and removed), with no branch access.
- **Existing session:** the removed supervisor's open browser was on `/login` within the polling window, via the socket push. Signing in again is refused.
- **History:**
  - The historical expense still shows the person as Recorded By.
  - The Admin Attendance Records report still names them.
  - The `EMPLOYEE_REMOVED` audit entry is attributed to the Super Admin.
- **Other roles:**
  - A normal supervisor's dashboard has no badge, and Supervisor Attendance loads.
  - A supervisor sent to the old Admin URL lands on `/supervisor/dashboard` (middleware), not the report.
- **Branch dashboard at all three viewports:** no badge, Extra Supplies summary exactly once and after Gross Sales and Recent Transactions, no horizontal scroll.
- **Realtime and offline:** the socket.io connection opens and receives frames. The terminal still shows its offline warning with the network off.

**Limitations:**
- Supervisor and Branch workflows were checked at page level: dashboards, attendance page and the terminal's offline state. No new sale or supply issue was made in this driver; P62/P63 drivers cover those flows and P64 does not touch them.
- The 60-second cross-process token-cache delay (§2) was not measured in the browser. The removal ran inside the API process, so the cache was cleared.
- Hosted/staging checks were not run. No isolated nonproduction environment exists; this is unchanged from P63.

### 7.3 SHAs

- Starting: `27e7114` (`origin/main`, the last reported deployment)
- Tested: the working tree on top of `27e7114` (all runs above). Final SHA: the P64 commit recorded in `CURRENT_HANDOFF.md`.
