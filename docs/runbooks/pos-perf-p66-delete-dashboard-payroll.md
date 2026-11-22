# POS-PERF-P66: permanent Delete, dashboard panel removal, simpler Supervisor payroll

Owner-requested batch of three items:
- **A.** Remove "Today's Expenses by Type" and "Today's Extra Supplies" from every dashboard.
- **B.** Fix the failing Delete and make it mean what it says: the account is permanently removed.
- **C.** Simplify the Supervisor payroll setup and review flow.

Branch `feat/pos-perf-p66-delete-dashboard-payroll`, cut from `origin/main` at `f9ce9da7` (PR #47, P64, the last **reported** deployment; not independently verified). **Nothing was pushed, deployed or run against production. No production account was looked up, deleted or changed, and the production fixture cleanup was NOT executed.**

## 1. Why Delete failed ("Something went wrong")

Reproduced locally on the unchanged code (`f9ce9da7`) on a disposable database.

- The P47 permanent-delete path first counts "history" with `countHistoryReferences`. That count missed several tables with a foreign key to `users`:
  - expense types, Extra Supplies cards and issues;
  - manual discount types, promotions and product types;
  - discount proofs and the payroll tables.
- A supervisor whose history sits only there is classified as "no history". The `DELETE` is then refused by Postgres with **23001 `restrict_violation`** (`expense_types_created_by_id_fkey` in the reproduction).
- Prisma 5 raises 23001 as `PrismaClientUnknownRequestError`, not `P2003`. The service mapped only `P2003`, so the request ended as a bare 500, which the web shows as "Something went wrong".
- A supervisor with *counted* history (such as audit entries) took the P64 keep-the-row path and did not fail locally. The exact production account was not inspected (no production access), so whether the owner's case was this path cannot be confirmed. The reproduced path is the only one found that produces the screenshot's error.

The fix is the design in §2, not a message change: history no longer blocks a delete, so neither path exists any more. `lib/foreign-key-restriction.ts` now recognises 23001 as well as `P2003`, and is used where a refusal is genuine (branches, §3).

A second hazard found while tracing: 31 of the history references were `ON DELETE SET NULL`. A naive physical delete would have silently erased who voided a sale, who wrote an audit entry, and so on. The design removes that too.

## 2. Physical deletion and historical attribution

**What Delete does now (staff and supervisors):** the `users` row is deleted. With it go:
- email, password hash, TOTP;
- refresh tokens, reset tokens, device PIN credentials;
- the staff PIN (and its one-time verification tokens);
- branch assignments, notification preferences and notifications.

Every past record stays, unchanged, still showing the person's name.

**Attribution record.** The new table `people` (Prisma `Person`) holds:
- one row per account ever created, with the same id;
- first and last name, role, employee code;
- `account_deleted_at` and `account_deleted_by`.

It has no email, password, PIN, session or branch access, and nothing authenticates against it. It is not a disguised login: login, refresh, PIN and password reset all read `users`, which no longer has the row.

- **History references `people`, not `users`.** The 54 history foreign keys were retargeted, covering sales (cashier, void, refund, proof verifier), shifts, attendance, audit, expenses, payroll, catalog provenance and settings. `users.id` itself references `people.id`, so an account can never exist without its record. Only account-owned tables still reference `users`, all `ON DELETE CASCADE`.
- **Triggers** (migration SQL) keep the record in step:
  - **insert:** creates the record. They also generate the id, because Prisma no longer fills its client-side `uuid()` once `id` is a relation field.
  - **rename or role change:** follows to the record.
  - **any users delete:** marks the record deleted.
  - **reuse:** an insert reusing a deleted account's id is refused (`POS_PERF_P66_ACCOUNT_ID_REUSED`).
- **Readers.** Joins (`include: { cashier: … }`) resolve through `Person` unchanged. Live-account fields (status, `isActive`, branch assignments, email) are read through `Person.account`, which is null once deleted:
  - attendance lists show the name with `employee_status: null`;
  - audit shows the actor's name with `email: null` and `account_deleted: true`;
  - dashboard "clocked in" counts treat a missing account as not working.
  - Plain-id name lookups now read `people`: stock movements, fraud alerts, Extra Supplies issues, report recorders/employees and the payroll actor.
- **Access ends at once and for good.**
  - The removed-account marker (P64 `removedAccountRevocationHash`) is written in the same transaction, so already-issued access tokens are refused on every route and on the socket handshake.
  - In-process caches are cleared and the browser gets `EMPLOYEE_SESSION_REVOKED`.
  - A login that races the delete either fails or holds tokens that are already refused (tested).
- **A new account** with the same email gets a new id and none of the old access or history (tested).

**Prerequisites (block, nothing changes, plain instructions):**
- an open shift (close it and count the cash);
- an open clock-in (clock out or correct the record);
- **staff only:** hours recorded at a branch that uses payroll that no finalized payroll run covers. Drafts are built from live accounts, so deleting first would drop those hours. The fix is to finalize payroll for that period first.

Branches left without a supervisor, held orders and pending inventory approvals are reported, not blocking. History never blocks.

**Safeguards kept:**
- Super Admin targets (`PRIVILEGED_ACCOUNT_PROTECTED`), self (`SELF_ACTION_FORBIDDEN`), branch accounts (`BRANCH_ACCOUNT_NOT_DELETABLE`);
- peer supervisors (`TARGET_ROLE_FORBIDDEN`) and other branches (`EMPLOYEE_ACCESS_DENIED`);
- all checked server-side before anything is read for deletion.

**Confirmation, bound server-side:**
- `GET /api/employees/:id/deletion-eligibility` returns `confirmation: { name, version }`, where version is the account's `updated_at`.
- `DELETE /api/employees/:id` requires the body `{ confirm_name, version }` (Zod `deleteEmployeeSchema`).
- The typed name must match, ignoring case and extra spaces (`DELETE_CONFIRMATION_MISMATCH`). The version must match under the row lock (`EMPLOYEE_CHANGED`, 409), so a concurrent edit makes the person look again.
- Cancel sends nothing.

**Repeats, races, lost responses:**
- The transaction's first write takes the row lock and matches the version.
- Two simultaneous deletes give exactly one `deleted` and one `already_deleted` (tested).
- A repeat after a lost response returns `already_deleted` to the actor who deleted it (or any Super Admin) and is audited (`EMPLOYEE_DELETION_REPEATED`). Anyone else gets 404.
- The dialog re-checks with the server after any failed request and reports success if the delete went through. A double click sends one request.
- The interactive transaction allows 30 s (default 5 s), since the prerequisite reads share one pooled connection.
- Failures after the commit (cache, socket) are logged, never turned into a 500.

**Audit:** `EMPLOYEE_DELETED`, by the actor, with name, role, employee code, status and the counts of history kept. Email and phone are deliberately not copied into the audit entry.

**Dialog** (`remove-employee-dialog.tsx`):
- It shows "Permanently delete [name]? This cannot be undone in the application. Past business records will remain, but this account cannot be restored."
- It lists what is removed now and what stays (with counts), and offers Inactive as the undoable alternative.
- It requires the typed name plus an acknowledgment.
- It says nothing about backups.
- On a pre-P66 API it offers no delete.

**Legacy P64 rows** (removed but kept) are hidden from lists. A Super Admin, or the cleanup tool, can now delete them for good the same way (tested).

## 3. Delete-action inventory

| Where (button) | Entity | Server path | Actual behaviour now | Historical dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| Admin › Supervisors; Admin employee detail; Supervisor Employees list/detail ("Delete … permanently") | Staff/supervisor account | `DELETE /api/employees/:id` | Physical delete (§2) | All history kept via `people` | **Done** |
| Admin › Branches › Settings › Permanently Delete Branch | Branch | `GET /api/branches/:id/deletion-eligibility`, then `DELETE /api/branches/:id` with `deleteBranchSchema` | **P67 (§10):** physical delete of the operational branch, its branch login account, everyone's access and its configuration. History stays on `branch_records` with its original name and code. Open work and non-zero stock block. | All history kept | **Done (P67)** |
| Branch › Remove supervisor | Assignment | `DELETE /api/branches/:id/assignments/:userId` | Ends the assignment (`removedAt`); the account stays | none | Labelled honestly ("Remove … from this branch") |
| Admin › Expenses › Delete Expense | Expense | `DELETE /api/expenses/:id` (Super Admin) | **Soft delete** (`deleted_at`); the row is kept | Financial evidence | Wording corrected: "Hides this expense from the expense ledger. The record itself is kept for the audit history…" (was "This cannot be undone"). Physical deletion deliberately not implemented. Not proved that every total excludes soft-deleted rows (only the expense repository and report readers were checked). |
| Expense › Delete receipt | Receipt file | `DELETE /api/expenses/:id/receipt` | Removes the file reference (`updateReceipt`) | none | Unchanged |
| Extra Supplies card › image | Image | `DELETE /api/extra-supplies/:id/image` | Removes the image | none | Unchanged |
| Products › Delete… | Product | `DELETE /api/products/:id` | Hard delete with cascade of its configuration; **refused when sold** ("Change status to Archived instead") | Sales | Unchanged; honest refusal |
| Products › image, Delete Size, option-group unassign, flavor slot / snack option Remove | Product parts | `products.router.ts` deletes | Hard delete of configuration rows; variant delete refuses with dependencies (`VARIANT_HAS_DEPENDENCIES`) | Recipe/BOM | Unchanged |
| Product options › delete group | Option group | `DELETE /api/product-options/:groupId` | Hard delete; refused while used by a recipe or inventory mapping | BOM | Unchanged |
| Recipe/BOM Remove; product–inventory mapping | Mapping | `DELETE /api/product-components/:id`, `/api/product-inventory/:id` | Hard delete of a mapping row | Future deductions only | Unchanged |
| Inventory › Delete conversion | Unit conversion | `DELETE /api/universal-inventory/items/:id/conversions/:cid` | Hard delete | none | Unchanged |
| Settings › branch work hours | Override | `DELETE /api/settings/work-hours/branches/:id` | Clears the override (reason required) | none | Unchanged |
| Security › sessions | Session | `DELETE /api/auth/sessions/:id` | Revokes the refresh token | none | Unchanged |
| POS cart / payment "Remove" | Cart line | client only | Browser state | none | n/a |
| Sales | Transaction | none | No Delete; Void/Refund preserved | Financial evidence | Unchanged by design |

No universal cascade mechanism was added.

## 4. Dashboards (A)

- **Removed:** "Today's Expenses by Type" (with View ledger) and "Today's Extra Supplies" (with View history), from the Admin, Supervisor and Branch dashboards (`app/(admin|supervisor|branch)/*/dashboard/page.tsx`).
  - The panels sat outside any grid, so no gap is left.
  - Their data hooks (`useExpenseSummary`, `useExtraSupplySummary`) live inside the cards. They no longer fire on dashboard mount (tests mock them and assert they are not called).
- **Kept:** the small Today's Expenses KPI and every other card, chart, collection and action. The shared cards stay, because they are still used by `/admin/expenses` and `/admin/reports`.
- **Where the information lives:**
  - expenses: `/admin/expenses` (by-type breakdown), `/supervisor/expenses`, `/branch/expenses`, Admin Reports;
  - Extra Supplies: `/supervisor/extra-supplies` (History), `/admin/reports?tab=EXTRA_SUPPLIES`, `/branch/extra-supplies`.
  - No permission changed.
- P64's behaviour is unchanged: Admin Attendance and Extra Supplies stay under Reports with redirects, the badges stay removed, and realtime, polling and offline warnings still work.

## 5. Supervisor payroll (C)

UX only: no API, calculation, rounding, effective-date or policy change.

- **One entry:**
  - A single "Payroll Settings" button opens Settings as its own view with "Back to payroll". The duplicate tab and tab strip are gone, and `?tab=settings` links still work.
  - The branch name is shown once.
  - The subtitle says this is attendance-based basic pay, with no statutory deductions, contributions or taxes, and no actual payout.
- **Readiness checklist** (`payroll-setup-checklist.tsx`):
  - Rows: branch payroll policy, pay period and cutoff, paid or unpaid breaks, employee hourly rates.
  - Each row has Set up or Edit, opening the existing forms. A "Set rate" button opens the existing rate dialog.
  - Missing rates read "not paid at ₱0".
  - The checklist collapses to one line when ready.
- **Flow:**
  1. Choose pay period: readable dates and a Not started / Draft / Finalized badge, with one main action, "Prepare draft payroll".
  2. Review (`payroll-review-table.tsx`): one employee list (table on desktop, cards on phones) with recorded hours, the rates stored on the run (never today's), basic pay, adjustments and totals.
     - Multiple rates are explained.
     - Time with no rate shows "Needs a rate", not ₱0.00, in basic pay, the row total, the footer totals, the phone cards and the calculation details. Pay that leaves out some unpriced days, and totals over such rows, are marked "Incomplete — needs a rate" (follow-up §7a).
     - Details and "How payroll is worked out" expand.
  3. Finalize: a separate card that opens the existing finalize dialog.
- **Preserved:**
  - draft generation, notes, adjustments, exports, history and revisions;
  - finalized runs read-only;
  - branch isolation: keys include the branch, panels reset on switch, and a run from another branch is refused;
  - selection kept after a failed request.
  - Clock times are now 12-hour, which also fixed a broken break-end display.
- **Admin:** P52 gives Super Admin full payroll rights (not read-only). That behaviour was kept as it was.

## 6. Migration, compatibility, rollback

**Migration** `20261122120000_pos_perf_p66_account_deletion_people`:
- creates and backfills `people` (every account, including P64-removed rows, which are **not** marked deleted);
- adds three triggers;
- drops 59 foreign keys and re-adds 60: 5 account-owned as `CASCADE`, 55 to `people` added `NOT VALID` then validated, so validation does not block writes on the history tables.
- It changes no row in any existing table and deletes no account. **No migration performs account cleanup.**

**Rehearsal** (`scripts/test-p66-migration-on-populated-data.ts`): see §7.

**Rollout order:** migration, then API, then web.
- During the migration-to-API window, the old API keeps working: its creates go through the trigger, and its P64 removal and P47 unused-delete still work (rehearsed).
- An old web against the new API cannot delete: there is no confirmation body, so it gets a 400 and nothing changes. A reload fixes it. The old dialog's wording would describe P47/P64 behaviour until reloaded.

**Rollback floor:**
- Before the first P66 deletion, the API can be rolled back to P64 code safely. The old Prisma client still reads through FKs by value.
- After any account has been physically deleted, rolling the API back below P66 breaks old readers that join a deleted person's history to `users`. For a required relation (cashier on a sale, employee on attendance) Prisma 5 throws "Inconsistent query result" and the page 500s. The rehearsal shows this hazard.
- **So: after the first deletion, P66 is the API rollback floor.** Do not drop `people`, its triggers or the P64 CHECK constraint. A schema rollback would have to restore the old FKs, which is impossible once rows are gone. Treat it as forward-only.

**Old code cannot restore access:** a deleted row does not exist, and the deleted id cannot be re-inserted (trigger).

## 7. Verification

Local disposable embedded Postgres only, with task-owned data under `C:\p66` and throwaway secrets that were never printed. Ports: 56610 to 56640. Never production, `pos_verify` or another session's services.

| Check | Result |
| --- | --- |
| Reproduction, unchanged code `f9ce9da7` | Supervisor with audit history only: P64 removal worked. Supervisor whose only history was an expense type: eligibility said "permanent", then `PrismaClientUnknownRequestError` / Postgres **23001** on `expense_types_created_by_id_fkey`, unmapped, so a 500 |
| P66 integration (`p66-account-deletion.integration.test.ts`, 14 tests) | Run 1 (inside the focused set): setup failed for every file creating users (`people.id` NULL, because Prisma stopped filling `uuid()`). Fixed in the trigger. Run 2: 2 failures, both test bugs (`afterAll` tried to delete immutable sales; finalized payroll fixture violated `payroll_runs_finalized_snapshot`). **Run 3: all passed**, including the reproduced case |
| Focused API (employees, attendance, audit, branches, auth, payroll, reports, fraud, extra-supplies, universal-inventory, products) | Run 3: 3 unit failures, mocks still on `prisma.user.findMany` for name lookups (now `prisma.person`). Updated. Then **1,523 + the fixed files (122/122) passed** |
| Migration rehearsal (2,005 users incl. a P64-removed row, sales, shifts, attendance, expenses, audit) | Run 1: seed SQL bug (`shifts.updated_at` doesn't exist). **Run 2: passed.** 92 pre-existing tables byte-identical; 2,005/2,005 matching attribution records; none marked deleted; all new FKs validated; only account-owned tables reference `users` (all CASCADE); triggers (id generation, rename, delete mark, id-reuse refusal) work; physical delete keeps actor ids (including the former SET NULL `voided_by`), names and amounts; older-API deactivate, P64 removal and P47 delete still work; old-reader hazard shown; **no drift** |
| **Full API, one run** | **1 failed, 3,835 passed, 5 skipped.** The failure is `p62-pdf-isolation` "deadline-aware admission" (1,124 ms against a 1,090 ms wall-clock bound) in a file P66 does not touch (no diff under `lib/reports`). It failed again with 9 other files in parallel, and **passed 23/23 alone**. Load-sensitive timing, pre-existing, not P66. Not re-run until green |
| Edited after the full run started (branch delete mapping, `foreign-key-restriction` + its test) | Branches, employees and helper files re-run: 293 passed (the only failure in that set was the PDF file above) |
| Full web, one run | **1,777 passed, 0 failed** (187 files). Follow-up §7a: **1,780 passed, 0 failed** (187 files) |
| Focused web during work | Dashboards 56/56 (Agent 1); payroll 29/29 (Agent 2); delete dialog 9/9 |
| Shared | 83 passed |
| Typecheck | API, web, shared clean |
| Lint | API 0 errors (409 warnings, existing); web 0 errors (5 warnings, existing) |
| Production builds (`stack.sh build`: API `tsc`, `next build`, service worker generated) | Pass |
| Browser, final builds, service worker active (`tests/e2e/manual/p66/delete-dashboard-payroll.mjs`; stack `C:\p66\stack`, ports 56641–56643, db `p62_p66browser`; Chromium emulation 1366/820/390, not real devices) | Run 1: stopped on a **driver** bug (two "Back to payroll" buttons, strict locator) after 40 passes. **Run 2: 57/57 passed**: Delete dialog wording, typed-name gating (partial name refused, case-insensitive match accepted), account row, sessions and branch access gone, attribution record kept with no credentials, history rows kept; the deleted supervisor's open browser lands on /login and re-login is refused; Admin expense ledger and Attendance Records still name them; all three dashboards without both panels, with the Today's Expenses KPI and without their requests (checked from the network log), at three branch viewports; Admin Reports Extra Supplies; Supervisor Extra Supplies; payroll one Settings entry, basic-pay statement, no horizontal scroll at three viewports, Settings ↔ back; terminal offline warning |
| Not exercised in the browser | Payroll draft generation and finalization at first (no local payroll policy, rates or runs in the stack seed). **Closed by follow-up §7a: 44/44.** Still browser-untested: lost response and concurrency (API integration and dialog tests only); real devices; hosted/staging (none exists) |

**Disposable data and processes.**
- Leftovers, task-owned and safe to delete: `C:\p66` (env with throwaway secrets, logs, stopped stack data) and `C:\Users\kaile\AppData\Local\Temp\pos-test-pg-*` dirs (EBUSY on cleanup).
- The stack services were stopped, plus two orphaned `io_worker` processes proven to be this task's by parent PID.
- **Four more idle `io_worker` orphans** (started 4:01, 4:36, 4:38 and 4:56 AM, no ports) match this task's run times but could not be tied to it with certainty, so they were left running.
- `prisma generate` could not replace the shared query-engine DLL because another session's `dist/server.js` (PID 17220, 2026-11-21 1:04 PM) has it loaded. The DLL is byte-identical (same Prisma 5.22.0); types and `index.js` regenerated normally. Stray `query_engine-windows.dll.node.tmp*` files from failed renames remain in that folder.

### 7a. Follow-up: payroll draft and finalization in the browser

Same branch, after the P66 commit `10658134`. Web-only fixes; no API, schema, migration or calculation change.

**Driver.** `tests/e2e/manual/p66/payroll-flow.mjs`.
- Uses the P62 stack's local-only guards: a fresh stack in `C:\p66pay` (ports 56651–56653, db `p62_p66pay`, throwaway secrets never printed), with production builds and an active service worker.
- Creates its own branch (supervisor assigned), one staff member and two shifts (one with a 30-minute break) in the previous cutoff, all in that local database only.
- Steps:
  1. Missing setup, then Set up (keyboard), then a refused save that keeps the inputs, then save and return.
  2. Draft before any rate, then a failed Prepare (request aborted) that keeps the period.
  3. Rates: ₱80 from the period start (checklist "Set rate"), ₱90 from day 8 and ₱95 today (Settings).
  4. Review: ₱80 and ₱90 lines, never ₱95, total ₱960.00. Details expand.
  5. Cancel writes nothing, then keyboard finalize. The database holds one finalized run, 960.00, with snapshots.
  6. Read-only state. Voiding the ₱90 rate leaves the finalized figures unchanged after a reload.
  7. Switching to another branch shows no stale run, then switching back.
  8. Desktop and tablet show the table, the phone shows cards, with no horizontal scroll.
  9. Admin Reports → Payroll shows the run. No 5xx responses.

**Defects found and fixed.**
1. **The rate dialog stayed open after the last missing rate was saved.**
   - The checklist switches from "items to finish" to the collapsed "ready" view when the rates refetch lands. The dialog was rendered inside each branch, so it remounted.
   - The save's per-call `onSuccess` belonged to the unmounted copy, so the dialog never closed. It showed again empty, although the rate was saved (201).
   - Fix: `payroll-setup-checklist.tsx` renders the dialog once, outside that switch.
   - Regression test in `payroll-flow.test.tsx`. It fails on the committed code ("expected '' to be '80'") and passes with the fix.
2. **Unpriced time could still read as ₱0.00.**
   - P66 showed "Needs a rate" only in the basic-pay cell. The row total, phone card total, footer totals and calculation details still showed ₱0.00.
   - Totals over rows with unpriced days were shown as if complete.
   - Fix: `payroll-review-table.tsx` and `payroll-employee-drilldown.tsx`. With no priced time they show "Needs a rate"; with some priced time they show the amount marked "Incomplete — needs a rate". Footer adjustments (+₱0.00 / −₱0.00) are real zeros and stay.
   - Tests in `payroll-flow.test.tsx`.
3. **A cutoff day outside 1–27 left the form.** The message already promised "(1–27)", but only digits were checked. The server refused it (422), and the only message was the shared payroll error toast.
   - Fix: `payroll-policy-form.tsx` checks the range and shows the message in the form, with the inputs kept.
   - Test in `payroll-components.test.tsx`.

**Runs (none retried blindly; each failure was diagnosed first).**

| Run | Result |
| --- | --- |
| 1 | Driver fixture bug: `attendance_breaks_end_consistent` needs `end_reason`. Its partial staff row and shift were removed from the disposable database |
| 2 (Main Branch) | 23 passed, 3 failed, then stopped. Found defect 2. Finalize was correctly blocked: the P62 perf fixture's cashiers have 120 h with no rate there. One wait-timing driver bug. The process did not exit (contexts left open); the driver now closes them |
| 3 (P62 Branch 2) | 19/20, then stopped. Found defect 1 |
| 4–5 (P62 Branches 3–4) | 27/29 and 27/30. Finalize correctly blocked by the P62 perf fixture's attendance on every P62 branch (another employee, 92 shifts, "30 to check"). The driver now creates its own empty branch |
| 6 | 44/44. The "refused with a message" check had matched Next's empty route announcer, so it was not trusted |
| 7 | Stopped: no in-form message for cutoff 30. Found defect 3 |
| **8, final build** | **44/44** |

**Other checks.** Payroll component tests 28/28. Full web suite 1,780/1,780. Web typecheck clean; web lint 0 errors. API and shared code unchanged since `10658134`, so the full API suite was not rerun.

**Processes.** The stack's web, API and Postgres were stopped, plus one `io_worker` whose parent was this stack's Postgres. Earlier `next start` children on port 56653 were stopped after each rebuild. `C:\p66pay` (env, logs, stopped data, screenshots) is task-owned and safe to delete.

## 8. Test-account cleanup (exact IDs, dry run first). NOT executed

The P64 tool (`scripts/p64-fixture-account-cleanup.ts`, `fixture-account-cleanup.ts`) now follows the P66 lifecycle:
- Planned actions: `permanent_delete`, `already_deleted`, `refused`.
- Staff fixtures, which have no email, are identified by exact id, role and full name.
- P64-removed rows are deleted for good.
- Each execution re-reads the account, binds the delete to its current version and goes through `deleteEmployee` (same authorization, prerequisites and audit).
- It still never matches names or email substrings, refuses Super Admin and Branch accounts and the actor's own account, and needs the dry-run token and a matching database host.
- Locally tested (§7). **The production inventory, dry run and execution were NOT run.** Follow P64 runbook §4 after deploy, with the owner. Provision new smoke accounts before the next smoke run if the old ones are deleted.

## 9. Known limits and follow-ups

- ~~Branch permanent delete erases financial history by cascade.~~ Fixed in P67 (§10). Its own limits are in §10.7.
- Soft-deleted expenses: exclusion from every dashboard and report total was not re-audited.
- Out-of-process deletion (the cleanup CLI) has the P64 cross-process delays: up to 60 s on authenticate-only routes, and an open socket is not cut.
- Payroll: Super Admin payroll is not read-only (P52 design). The checklist's pay-period and break rows open the one policy form.
- Hosted and staging checks were NOT RUN; no isolated environment exists (unchanged).
- Payroll mutation errors from the server still appear only as a toast (shared P52 `usePayrollMutation`); inputs are kept. Only the cutoff range now has an in-form message.
- The P62 perf fixture's attendance (no rates, staff not assigned to every P62 branch) blocks payroll finalization on its branches. Browser payroll checks need their own branch, as `payroll-flow.mjs` does.

## 10. P67: branch Delete keeps business history, plus the PDF test fix

Same branch, on top of `8af206e8`. Local only: nothing pushed until §10.8 says so, nothing deployed, production not accessed.

### 10.1 What the old branch Delete actually did

Traced from the migrations (final constraint state), not from `schema.prisma` alone. `DELETE /api/branches/:id` was a bare `prisma.branch.delete`: no transaction, no lock, no body. It ran after a single open-shift count.

| What happened to the row | Tables |
| --- | --- |
| **Erased** (CASCADE) | `transactions`, plus their items, deduction jobs and projection outbox; `shifts`, plus cash denominations and reviews; `attendance_records`, plus breaks; `expenses`; `inventory_movements`; `inventory_stock_movements`; `inventory_cost_corrections`; `extra_supply_issues`, lines and operations; `ingredients`, which also erased legacy movements through `ingredient_id` |
| **Unlinked** (SET NULL) | `audit_logs.branch_id`. This silently changed rows that are hashed into the audit chain. Also `fraud_alerts`, `catalog_management_assignments`, and `products.exclusive_branch_id`, which orphaned "exclusive" products |
| **Refused** (RESTRICT, now a 409 since P66) | payroll policies, pay rates and runs; manual discount types and proofs; product-type enrolment; attendance with payroll claims |
| **Left behind** | Role `branch` login accounts (their tokens kept working until expiry); staff tokens kept access to the deleted id (staff and branch access trusted the JWT); socket rooms; `id_counters` keyed by branch code. Re-creating a branch with the same code on the same day **continued the old receipt sequence** |

### 10.2 What Delete does now

- **`branch_records`** (Prisma `BranchRecord`) is the immutable historical identity of a branch:
  - one row per branch ever created, with the same id, name, code, address and city;
  - `deleted_at` and `deleted_by`;
  - no status, settings, stock, access or accounts.
- **All 20 history references point at it** with `ON DELETE RESTRICT`: sales, shifts, attendance, expenses, payroll policies, pay rates and runs, discount types and proofs, stock and legacy movements, cost corrections, ingredients, Extra Supplies, audit, fraud, catalog provenance, exclusive products. Their second-level children (items, breaks, reviews, deduction jobs, claims) therefore stay too.
- **Still `CASCADE` with the branches row** (13 references): assignments, staff PIN lookups, product and flavor availability, receipt and payment settings, promotion, expense-type and Extra Supplies enrolment, legacy `product_inventory`, `inventory_stocks` (zero only, see blockers) and finished hold orders. `product_type_branches` changed from RESTRICT to CASCADE, because it is enrolment.
- **`branches.id` references `branch_records.id`.** Triggers in the migration SQL handle the rest:
  - **insert:** create the record, generate the id (Prisma stops filling `uuid()` once `id` is a relation field), and refuse a deleted id (`POS_PERF_P67_BRANCH_ID_REUSED`) or any code already on a record, live or deleted (`POS_PERF_P67_BRANCH_CODE_RETIRED`);
  - **live rename:** follows to the record;
  - **any delete:** marks the record deleted;
  - **after deletion:** the record is frozen, and records are never deleted (`POS_PERF_P67_BRANCH_RECORD_IMMUTABLE`).
- **Live-branch guard.** 18 operational history tables have a trigger on insert, or on a change of `branch_id`. It locks the branches row `FOR KEY SHARE`, exactly like a foreign-key check, and raises `POS_PERF_P67_BRANCH_DELETED` (SQLSTATE P0001) if the row is gone.
  - Not raised as 23503: Prisma reports a trigger-raised 23503 as a generic P2003 without the message, which was found in testing.
  - `app.ts` maps the error to 409 `BRANCH_DELETED` ("Nothing was saved").
  - `audit_logs` and `fraud_alerts` are not guarded: evidence about a deleted branch may still be written, and the deletion's own audit entry names it.
- **Codes are never reused.** Receipt numbers (`<CODE>-<YYYYMMDD>-<seq>`) and the `id_counters` keys carry the code, so retiring it keeps every receipt number pointing at one branch. A manual code that a record holds is refused with 409 `BRANCH_CODE_RETIRED`. An auto-generated code skips one that is held.
- **Access ends at once.**
  - The branch's own role `branch` accounts are deleted in the same transaction, using the P66 lifecycle: the removed-account marker kills their tokens, and attribution stays on `people`.
  - Staff and branch tokens now keep only branch ids that still exist (`getAccessibleBranchIds` → `findExistingBranchIds`, a primary-key lookup per request, like the supervisor query). Socket rooms come from the same function.
  - After commit, sockets leave the branch room and the deleted accounts get `EMPLOYEE_SESSION_REVOKED`.
  - Staff and supervisors keep their own accounts, without this branch.
- **Also removed:** the branch's notifications and cached `report_snapshots`.

### 10.3 Blockers (nothing changes until resolved; history never blocks)

| Code | Condition | Resolve with |
| --- | --- | --- |
| `open_shifts` | `shifts.status = 'active'` | close the shift and count the cash |
| `open_attendance` | clocked in, not deleted | clock out or correct the record |
| `pending_checkouts` | `checkout_attempts.status = 'in_progress'` (including expired leases: their result is uncertain) | finish or resolve it on the terminal |
| `held_orders` | `hold_orders.status = 'held'` and not expired | complete or release them |
| `pending_inventory_jobs` | deduction jobs `pending`/`processing`/`failed`; projection outbox `pending`/`processing`/`deferred`/`stuck`; approvals `PENDING`/`RETURNED` | let them finish, reconcile failed or stuck ones, review approvals |
| `nonzero_stock` | `inventory_stocks` on-hand or reserved ≠ 0 | transfer it out, or record a count of zero |
| `draft_payroll_runs` | `payroll_runs.status = 'draft'` | finalize or discard |
| `unpaid_payroll_hours` | P66's rule per branch: clocked-out hours from the first policy on that no finalized run covers | finalize payroll for those dates |

There are no transfer, reservation or Extra Supplies blockers. Transfers are immediate movement pairs, reservations exist only as `quantity_reserved` (covered by stock), and Extra Supplies operations persist only `committed` or `abandoned`.

### 10.4 Confirmation, races, repeats

- **Eligibility.** `GET /api/branches/:id/deletion-eligibility` (Super Admin) returns the blockers, the retained-history counts, what is removed, and `confirmation { name, code, version, confirmation_token }`.
  - `version` is the branch's `updated_at`.
  - The token is `HMAC(HASH_KEY, actor | branch | version)`, so it binds the actor, the branch and the version.
- **Delete body.** `DELETE /api/branches/:id` requires `{ confirm_name, confirm_code, version, confirmation_token }` (Zod `deleteBranchSchema`). The server checks:
  - the name, ignoring case and extra spaces;
  - the code, exactly;
  - the token, for this actor (`DELETE_CONFIRMATION_INVALID`, 403);
  - the version (`BRANCH_CHANGED`, 409).
- **Older web.** It sends no body and gets 422 with no change.
- **Cancel** sends nothing.
- **One transaction:**
  1. A version-bound `updateMany` takes the row lock.
  2. Blockers and an activity fingerprint (counts of sales, shifts, attendance, stock and legacy movements, expenses, Extra Supplies, checkouts, approvals, payroll runs) are read.
  3. The branch accounts are deleted.
  4. `branch_records.deleted_by` is stamped.
  5. `branches` is deleted. This waits for any write already holding the row `FOR KEY SHARE`.
  6. Blockers and the fingerprint are re-read. Any change rolls everything back: `BRANCH_ACTIVITY_DURING_DELETE`, or `BRANCH_HAS_OPEN_OPERATIONS`.
- **Assumption:** every stock change writes a stock movement (the CR-006 ledger design).
- **Repeats and races:**
  - A repeat after success returns `already_deleted` to a Super Admin (audited as `BRANCH_DELETION_REPEATED`). An unknown id gets 404.
  - Two simultaneous deletes give exactly one `deleted` and one `already_deleted` (tested).
  - The dialog re-checks eligibility after any failed request, and a double click sends one request.
- **Audit:** `BRANCH_DELETED` now carries `branch_id` (it references the record), name, code, address, city, status, the retained-history counts, the removed counts and the deleted branch-account ids.

### 10.5 Migration, compatibility, rollout and rollback floor

**Migration** `20261122130000_pos_perf_p67_branch_deletion_records` (new; no applied migration edited):
- creates and backfills `branch_records`;
- drops 21 foreign keys and adds 22 (the 21 retargeted or changed plus `branches_id_fkey`), `NOT VALID` then validated;
- adds 7 functions and 22 triggers;
- changes no row in any existing table and deletes no branch. **No migration performs branch deletion or account cleanup.**

**Order:** migration, then API, then web.

**Migration → old (P66) API window:**
- *Reads, writes and branch creation keep working.* The old client fills the id itself, and the trigger creates the record.
- *Old Delete no longer erases history.* The database no longer cascades it, whichever API calls it.
- *Old Delete is still unsafe.* It checks only open shifts, cascades non-zero `inventory_stocks` rows, leaves branch accounts behind, and afterwards the old readers 500 on that branch's history: required Prisma relations, "Inconsistent query result" (shown in the rehearsal).
- **Restriction: no branch may be deleted until every API instance runs P67.** This is **documented, not database-enforced.** Enforcing it would mean refusing any unstamped `DELETE FROM branches`, which would also break the ~39 test teardowns that delete fixture branches.
- Render runs one API instance, so the window is the time between the migration and the API swap.

**New API with an old web:** the old dialog sends no body, so delete is impossible (422) until a reload. The old dialog's wording ("destroys all…") is wrong until then.

**Rollback floor:**
- Before the first branch deletion, the API can go back to P66 code.
- **After any branch has been deleted, P67 is the API floor**: old readers join history to `branches`.
- Never drop `branch_records`, its triggers or the retargeted FKs. The schema is forward-only once a branch is gone.
- Old code cannot restore a deleted branch: the id and code are refused.

**Reports after a deletion:** history readers (receipts, transaction export, reports, attendance, expenses, audit) read name and code through the record and keep working. Admin "all branches" summaries keep deleted-branch history, while the live dashboard groups only live branches (P60 test adjusted to state this). Payroll for a deleted branch cannot be created or edited: the guard blocks it, and unpaid hours are a blocker.

### 10.6 PDF test failure (`p62-pdf-isolation`, "deadline-aware admission")

**Cause, proved: (c), a load-sensitive wall-clock bound.**
- The old 1,090 ms limit was the 1 s job plus 90 ms of slack. It included the worker's own 1 s timer and its message back to the main thread, and both stretch under CPU load.
- **Alone:** 15 trials took 1,000–1,051 ms.
- **Under 8 busy processes on 4 cores:** 20/20 trials took 1,092–1,242 ms, every one over the old limit. In all 35 trials the queued job was refused **0 ms** after the long job finished.
- **Not (a), a pool fault:** the outcome was correct every time and the pool ended idle.
- **Not (b), a start-up issue:** the warm-up always finished before t0, with exactly one worker.
- The original test failed 2/2 under load.

**Fix (test-only):**
- `p62-pdf-isolation.test.ts` now asserts:
  - exactly one worker before the window;
  - the long job took at least 950 ms;
  - the long job resolves;
  - the queued job gets `PDF_BUSY` with the deadline message (not queue-full or queue-wait);
  - the refusal comes after the long job and within 50 ms of it (half the 100 ms job, so it still catches "ran it anyway");
  - the pool is idle at the end.
- The other 22 tests, including the `<100 ms` refusals and main-thread responsiveness, are unchanged.
- The timing distribution moved to the opt-in `p62-pdf-admission.bench.test.ts` (`P62_PDF_BENCH=1`, which fails on a wrong outcome, median gap ≥ 20 ms or median long job ≥ 1,250 ms), with helper `p62-pdf-admission.test-helpers.ts`.

**Results:**
- Alone: 5/5 runs, 23/23 each.
- Under load: 5/5 runs, long job 1,070–1,195 ms, refusal gap 0 ms.
- In full API run 1: 23/23 (overrun 1,017 ms, gap 0).
- Logs are in `C:\p67\pdf\`.

### 10.7 Verification

Disposable local embedded Postgres only, on ports 56671–56677, with task-owned files in `C:\p67` (throwaway secrets, never printed in full). Never production, `pos_verify` or another session's services.

| Check | Result |
| --- | --- |
| Dependency audit (Agent 1, read-only, every FK parsed from the final migration state) | §10.1. 33 FKs to `branches`; 20 history references, 13 configuration/access; second-level cascades, non-FK references, token and counter behaviour |
| Focused API, run 1 (branches, branch-access) | **8 failed**: 7 mocks missing the new repository method, 1 real finding (a trigger-raised 23503 reaches Prisma as P2003 without its message, so the API could not recognise it). Fixed: guard raises P0001; mocks updated; the 422 (not 400) for a missing body corrected in the test |
| Focused API, run 2 (+ P60, P66) | **1 failed**: P60's Admin-vs-dashboard expense total. Cause: deleted-branch expenses now stay in the Admin summary (₱246.90 = 2 × P67 fixture). Intended; test now sets deleted-branch expenses aside. Then 248 others passed |
| P67 integration (`p67-branch-deletion.integration.test.ts`) | 14/14 in the full run: eligibility, cancel/mismatch/other admin's token/stale version change nothing; physical delete, branch account gone, staff kept; history counts, amounts, names, codes, receipt lookup; branch-account token refused, staff token loses the branch; writes refused in the DB, audit still allowed; record frozen; repeat `already_deleted`; same-name replacement new id/no access/no history, old code retired; blockers (shift, clock-in, stock, unpaid hours); two simultaneous deletes; delete racing a shift insert and an expense insert |
| Migration rehearsal (`scripts/test-p67-migration-on-populated-data.ts`, 302 branches, 20,001 sales) | Run 1: stopped on the script's own error-text match (the trigger did refuse; Prisma's raw error omits trigger text for 23505). **Run 2: passed**: 93 pre-existing tables byte-identical; 302/302 records, none deleted; all FKs validated; exactly the 20 history tables reference `branch_records` (RESTRICT); only config tables reference `branches` (CASCADE); id generation, rename, delete mark, id/code reuse refused, record frozen and undeletable, deleted-branch write refused, history re-pointing refused, audit allowed; an old-style plain `DELETE` keeps all history; old-reader hazard shown; **no drift**. Migration ~3 s with the CLI start |
| **Full API, run 1** | **75 failed, 3,785 passed, 6 skipped; exit 1.** All 75 were one cause in 9 unit-test files: their `branchesRepository` mock lacked `findExistingBranchIds` (staff/branch access). Mocks fixed; those 9 files 386/386 |
| **Full API, run 2** | **0 failed, 3,860 passed, 6 skipped (229 files); runner exit 0** (recorded in `C:\p67\api-full2.exit`) |
| Shared | 83 passed |
| Typecheck | API, web, shared clean |
| Lint | API 0 errors (26 warnings, none in changed files); web 0 errors (warnings in untouched files) |
| Web, affected | Dialog 7/7; the 13 files touching branches or mocking `use-branches`: 309/309. Full web suite not rerun (no shared UI/navigation change); last full run 1,780/1,780 (§7a) |
| Production builds (`stack.sh build`: API `tsc`, `next build`, service worker generated) | Pass |
| **Browser, final builds, service worker active** (`tests/e2e/manual/p67/branch-delete.mjs`; stack `C:\p67\stack`, ports 56681–56683, db `p62_p67browser`; Chromium 1366 and 390 emulation) | **Run 1: 27/27**: Settings wording; blocked branch shows the open-shift instruction and no delete; dialog names branch and code, irreversible, lists kept history with counts and the removed login account, no horizontal scroll at 390; gating (wrong-case code refused, case-insensitive name + exact code accepted); cancel changes nothing; a double click sends one DELETE; branch row absent, record kept and marked; history counts and sale amount unchanged; branch account deleted, staff kept; list no longer shows it; the branch's open terminal lands on /login and re-login is refused; Admin expenses and Attendance Records still name it. API log: no 5xx |
| Payroll browser and account deletion | Not rerun: no payroll or account-deletion code changed (P66 44/44 and 57/57 evidence stands); P66 integration 15/15 in the full run |
| PDF test | §10.6 |
| Not run | Hosted/staging (none exists); real devices; an actual old API process against the new schema (the rehearsal reproduces its SQL) |

**Disposable data and processes.** `C:\p67` (env with throwaway secrets, logs, stopped stack data, screenshots, scripts) is task-owned and safe to delete. The stack's API, web and Postgres processes were stopped and their PIDs checked. `%TEMP%\pos-test-pg-*` directories left by EBUSY remain. During setup the lead printed part of `C:\p66\env.sh` into its own tool output: a throwaway local JWT key pair generated for that disposable stack, used nowhere else. Treat `C:\p66` as disposable and delete it.

**Not done / limits:**
- The rollout restriction in §10.5 is procedural.
- Offline sales still queued on a device for a deleted branch are refused at sync (`BRANCH_DELETED`) with no recording screen. Sync every terminal before deleting a branch.
- Storage objects (proofs, GCash QR) stay in storage and are still referenced by the retained rows.
- An expired, still-`held` hold order cascades without blocking.
- Real devices and hosted/staging were not tested (none exists).
- The production branch inventory and any production deletion were NOT done.

### 10.8 PR and CI

PR_SECTION
