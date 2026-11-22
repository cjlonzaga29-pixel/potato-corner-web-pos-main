# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-23
- **Branch:** `feat/pos-perf-p69-pos-product-type-filter`, created from `origin/main` `a5ffefbb` (the PR #49 merge, the last **reported** deployment, not verified here).
  - P69 code `3e21fc8f` (tested), docs `c2db620c`.
  - P69R code `c147ec4f` (tested), docs commit after it.
  - **Pushed (feature branch only) with one PR to `main`. Not merged or deployed. Production not accessed.**
- **Previous branch** `feat/pos-perf-p68-branch-lifecycle-and-staff` (`c988c639`) is fully contained in `origin/main`.
- **Working tree:** only `.vscode/settings.json` is modified (the owner's personal setting). Never stage it.
- **Local leftovers (task-owned, safe to delete):**
  - `C:\p69r` (logs, integration Postgres data `pg-int1`) and `C:\p69rs` (P69R browser stack: env with fresh random keys, never printed; DB `p62_p69r`; profiles; results in `out1`). Its Postgres, API and web (ports 56721–56723) were stopped.
  - `C:\p69` (throwaway test env with fresh random keys, never printed; logs; embedded Postgres data dirs).
  - `C:\p69s` (browser stack: env, Postgres data `p62_p69`, logs, browser profiles, results in `out1`–`out11`). Its Postgres, API and web processes (ports 56691–56693) were stopped.
  - The older `C:\p68`, `C:\p68r`, `C:\p68s`, `C:\p67`, `C:\p66*` folders noted before.
- **Left running, not proven to be this task's:** the idle `io_worker` orphans and the `dist/server.js` (PID 17220) noted before.

## Latest: account deletion and email reuse (branch `feat/account-deletion-email-reuse`)

Details: [`runbooks/account-deletion-email-reuse.md`](runbooks/account-deletion-email-reuse.md).

- **Already correct (traced, now regression-tested):**
  - Every permanent delete path releases the email: supervisor or staff Delete, normal branch Delete and Force Delete.
  - A same-email account (any case) gets a new id and nothing of the old one.
  - Reports keep the original person.
  - Inactive keeps its email.
- **Fixed:** concurrent Create Employee or branch-account email edit with one email returned a 500. It is now 409 `EMAIL_ALREADY_EXISTS`.
- **Dialogs** now say the email can be reused by a fresh account.
- **Tests:** API integration 53/53, web 184/184, browser 11/11, typecheck and lint clean. Local only. Not pushed.
- **Production leftover-account cleanup:** run by the owner with the P68 script (exact ids, dry run first). Account details and evidence are kept outside the repository on purpose.
- **Local leftovers:** `C:\p70` (integration logs, Postgres data) and `C:\p70s` (browser stack, env with random keys, results `out2`). All of its processes are stopped.

## Earlier: P69R — prompt catalog updates and the offline cold reload

Details: P69 runbook §8.

- **Refresh:**
  - After a committed product or product-type write, the API sends a branch-scoped `catalog:changed` (`{ branch_id }` only) to the affected branch rooms, coalesced over 300 ms.
  - The open terminal refetches its authorized catalog (debounced 750 ms, never cancelling a fetch in flight), and once after a socket reconnect.
  - Fallback: every 2 min while realtime is down, otherwise 30 min.
  - **Refresh products** button: one network-confirmed read; keeps the cart.
- **Measured:** about 1.0–1.6 s from commit (1.3–2.2 s from click) for type create, product reassignment and rename, with no reload. A change missed while offline appeared 1.2 s after reconnect. 6 catalog GETs for 3 changes; branch B made 0.
- **Offline cold reload:**
  - The identity is memory-only, so an offline reload leaves the session `unconfirmed`, and pages read that as "No branch assigned".
  - P69 did not touch this path (static diff). No pre-P69 browser build was run.
  - Now the branch shell shows "Can't confirm your sign-in while offline" with Try again and automatic retry, and storage is kept. It continued 1.2 s after reconnect.
  - No branch is assumed from cached data. Selling after an offline *cold* reload still needs an offline-auth design (out of scope).
- **Compatibility:** additive event, **no migration**, any deploy order. Single API instance only for hints (in-memory adapter, as before).

| Check | Result |
| --- | --- |
| API unit (new) | 12/12 |
| API integration on fresh local Postgres (P69R, P69, P58, P58R) | **58/58**, first run |
| Web, new and affected | All pass after 3 test bugs of mine (runbook §8.5) |
| Full web | Run 1: 1,831/1,835 (1 test bug, 3 load timeouts). **Run 2: 1,835/1,835, exit 0** |
| Shared / typecheck / lint / builds | 83/83 / clean / 0 errors / pass |
| Browser (`tests/e2e/manual/p69/realtime.mjs`, SW active) | **22/22**, run 1, incl. sale ₱89.00, stock −1/−2 |
| Not run | Full API suite, real devices, staging, multi-instance API |

**Next (owner):** review the PR. Merge and deploy are separate decisions.

## Earlier: P69 — product type filter and type badges on the POS

Details: [`runbooks/pos-perf-p69-pos-product-type-filter.md`](runbooks/pos-perf-p69-pos-product-type-filter.md).

- **Problem:** Cheese Fries PPO is Promotional in Supervisor Products, but its POS card showed only the size "Regular".
- **Now:**
  - A labelled **Type** row: All Types, Regular, Promotional, Seasonal, then the branch's active custom types, including empty ones with an honest empty state.
  - Kept apart from the **category** row (now "All Categories") and from the **size** line.
  - Each card has a type badge.
  - Type, category and search combine with AND; **Clear filters** resets all three.
- **Rules:**
  - Same as Supervisor Products: a custom assignment is the displayed type, otherwise the classification's built-in. A product appears once.
  - Keys are `builtin:<classification>` and `custom:<id>`.
  - A deactivated type loses its tab. Its products stay sellable and labelled in All Types, and a stale selection resets with a notice.
  - Classification, promotions and product data are unchanged.
- **API:** additive `products[].product_type` and `product_types` on `GET /api/products/catalog`. A type is named only when scoped to that branch. No migration, no checkout change.
- **Refresh:** the existing catalog query at the time (on mount after 60 s, on reconnect, every 30 min). Superseded by P69R above.
- **Offline:** the type list is saved beside each cached catalog row (no Dexie version bump). With an older API or a pre-P69 cache, the filter is hidden and nothing is guessed.

| Check | Result |
| --- | --- |
| API unit / P69 integration | 167/167; **6/6** first run (isolation, same-name types, 403s, rename, reassignment, deactivation, drafts) |
| Affected API (products + product-types) | 387 passed, 2 gated files; `products.integration` with the legacy gate set **22/22**. Full API not run (additive) |
| Web P69 tests | Run 1: 6/8 (2 test bugs). Run 2: 7/8, **real defect** (stale name in the notice after a rename), fixed. Then 8/8, plus a branch-switch test |
| Full web | **1,815/1,815**, exit 0 |
| Shared / typecheck / lint / builds | 83/83 / clean / 0 errors / pass |
| Browser (SW active, emulated desktop/tablet/phone) | 11 runs, every one reported in runbook §6.1. Runs 1–9: driver bugs, one keyboard timing failure, and an emulation limit (SW blocks route rewriting). Run 10: 21/22, offline cold reload. **Run 11: 24/24**, including a local sale (₱89.00, stock −1/−2 exactly) and branch B 403 |
| Not covered | Offline **cold reload** showed "No branch assigned." (session, not P69; not compared with pre-P69). Real devices, staging, a live old API |

**Next (owner):**
- Review the branch. Push, PR, merge and deploy are separate decisions. Any deploy order works (additive, no migration).
- Both optional items (prompt refresh, offline cold reload) were handled in P69R.

## Earlier: P68 follow-up — multi-process Force Delete races, pending approvals, rolling deploy

Details: P68 runbook §6.2 (scenarios and runs) and §6.3 (suites).

- **Two real built API processes (three for the crash case)** against one fresh disposable local Postgres, ordered by database lock barriers, with no sleeps and no debug routes (`apps/api/scripts/p68-process-races.ts`). Both orders of checkout and Force Delete were covered, plus: a checkout claimed before the fence, a claimed deduction worker, paid supply issues, a void after the fence, a lost response with a crash and restart, concurrent repeats, and pending approvals (approve or reject on either side of the fence). Other branches' balances stayed unchanged.
- **Defects found and fixed:**
  - The fence only guarded inserts. A void of a sale with a pending deduction committed after the fence.
  - Approval requests had no live-branch guard: a new count during the fence aborted Force Delete and left a pending request.
  - Concurrent repeats of one operation id got 409 instead of the operation.
  - The approval closure snapshot had no quantities.
- **Fixes:** additive migration `20261123130000_pos_perf_p68_fence_updates_and_approvals` (triggers only), plus a narrow service change and a repository select. Nothing was weakened: no audit, stock or permission check removed.
- **Rolling deploy:**
  - the P68 migrations are additive (diff to the pre-P68 schema shows only P68 additions);
  - no Force Delete until every instance runs P68;
  - after the first Force Delete, the rollback floor is P68.
  - Email reuse gives a new id with no old tokens or history; no account is deleted because a branch is absent (runbook §5).

| Check | Result |
| --- | --- |
| Race harness | Run 1 (repro, fix triggers off): 88/101, reproduced the approval defect, plus harness bugs. Run 2 (repro, S5): finalize lost a deadlock, then recovered. Run 3: 132/133 (baseline, not proven). Run 4: 5/5. Run 5: 133/133. Run 6: 132/133, baseline bug proven (earlier run's leftover jobs) and fixed. **Run 7, final code: 133/133** |
| Focused API | 477/478 (my test bug), then P68 + P67 integration **36/36** |
| Full API | Run 1: **8 failed** (PDF timing, a P58 count, a P59 cascade from one PDF 503 under load); those files alone 66/66. Run 2: **1 failed** (`transactions.integration` concurrent-sales worker batch, cross-file); alone 3 × 16/16. **No fully green full run on the final code**; no failure repeated |
| Migration rehearsal | Run 1: my check had no stock in the seed. **Run 2: passed**, 94 tables byte-identical, no drift |
| Typecheck / lint | Clean / 0 errors |
| Web, browser | Not rerun: no web or UI change (last 1,797/1,797; 26/26 and 27/27 at `8f882aaa`) |
| Not run | A live pre-P68 API process; hosted/staging; real devices; load |

**Next (owner):**
- Review the PR. Merge and deploy are separate decisions. Order: migrations, then API, then web.
- No Force Delete until every API instance runs P68.
- The production leftover-account diagnosis, dry run and repair are **NOT done**. They remain a separate step.

## Earlier: P68 — branch email reuse, Force Delete Branch, branch-scoped staff (local)

Details: [`runbooks/pos-perf-p68-branch-lifecycle-and-staff.md`](runbooks/pos-perf-p68-branch-lifecycle-and-staff.md).

- **A. Email "already exists":**
  - The likely cause is a **leftover branch login from a branch deleted before P67**: the assignment was cascaded, but the `users` row and its email stayed. No screen lists or deletes it.
  - The conflict is now classified and shown beside Username, with values kept: leftover (with its exact id), removed account, or working account.
  - The check is case-insensitive.
  - A same-email race now gets a 409, not a 500, with no partial rows.
  - Reuse after deletion gets a new account id and no old access or history.
  - **Leftover repair:** `apps/api/scripts/p68-leftover-branch-account-repair.ts`. Diagnose, dry run, then execute, exact ids only. **NOT run on production.**
- **B. Force Delete Branch (Super Admin):**
  - Offered from the blocked Delete dialog.
  - One confirmation, bound to the actor, branch, version and exact plan.
  - Fence, then finalize, with a durable, idempotent operation, an abort, and a restart sweeper.
  - Each open item gets an explicit outcome and a read-only closure record:
    - shift `terminated` with no cash count;
    - clock-in administratively terminated with no clock-out;
    - checkouts abandoned and deductions cancelled, only after proving they were not committed or applied;
    - approvals cancelled;
    - stock, holds, draft payroll and unpaid hours recorded, not changed.
  - Reconcile later at **Admin → Branches → Deleted-branch items**.
  - Offline terminal queues are not reachable by the server. Late syncs are refused (`BRANCH_DELETED` is a definitive local refusal) and kept on the device.
- **C. Rows without controls were supervisor accounts.**
  - The supervisor Employees list now shows only the selected branch's staff, with a total, and no flash on a branch switch.
  - Create offers only the supervisor's branches.
  - New staff appear with **No PIN** and **Set PIN**.
  - Server checks are re-verified by tests.
- **Migration** `20261123120000_pos_perf_p68_branch_force_deletion`: additive, no row changed.
  - **No Force Delete until every API instance runs P68.**
  - **Rollback floor: after the first Force Delete, P68** (`ShiftStatus 'terminated'`).
  - Order: migration, API, web.

| Check | Result |
| --- | --- |
| P68 integration | 20/20 (first run) |
| Focused API, run 1 | 2 failed (query-shape assertions changed on purpose), then fixed |
| Full API | Run 1: **1 failed** (same kind, `attendance.repository.test.ts`), 3,879 passed. **Run 2: 0 failed, 3,880 passed, 6 skipped, exit 0** |
| Full web | **1,797/1,797** |
| Migration rehearsal (302 branches, 20,000 sales) | Run 1: seed SQL bug. **Run 2: passed**, 94 tables byte-identical in existing columns, no drift |
| Typecheck / lint | Clean / 0 errors (after fixing 3 non-null assertions in the new test) |
| Builds + browser (SW active, emulated desktop/phone) | Builds pass. P68 driver: run 1 driver bug, run 2 25/26 (driver timing), **run 3 26/26**. P67 regression **27/27** |
| Not run (at that time) | Hosted/staging (none exists); real devices; live old API on the new schema; multi-process checkout-vs-Force-Delete HTTP race and a pending-approval fixture (both since done, see the follow-up above) |

**Next (owner):**
- Review and decide on push/PR. Merge and deploy are separate decisions.
- In production, run the leftover **diagnosis** (read-only) to see who holds the screenshot email. A dry run and execution need your review.
- Decide the Demo same-name supervisor/staff pair. Nothing was changed.

## Earlier: P67 — branch Delete keeps business history; PDF test fixed

Details: [`runbooks/pos-perf-p66-delete-dashboard-payroll.md`](runbooks/pos-perf-p66-delete-dashboard-payroll.md) §10.

- **Before:** branch Delete cascaded sales, shifts, attendance, expenses, stock and Extra Supplies history, and through `ingredients` the legacy movements too. It nulled audit, fraud and catalog links (breaking the audit hash chain), left branch login accounts and staff tokens working, and let a same-code branch continue the old receipt sequence.
- **Now:**
  - The operational branch row, its branch login account(s), everyone's access and its configuration are physically deleted.
  - All history references the new immutable `branch_records` (original name and code).
  - Codes are never reused.
  - Database triggers refuse new operational writes for a deleted branch (409 `BRANCH_DELETED`).
  - Staff and branch tokens lose a deleted branch at once.
- **Blocks** on open shifts, clock-ins, in-progress checkouts, held orders, pending, failed or stuck stock jobs, pending approvals, non-zero stock, draft payroll and unpaid payroll hours. History never blocks.
- **Confirmation** binds the typed name and code, the version and an actor-bound server token. Cancel writes nothing; repeats and lost responses report `already_deleted`.
- **Migration** `20261122130000_pos_perf_p67_branch_deletion_records`: additive, no row changed.
  - **Rollout:** migration, API, web. **No branch delete until every API instance runs P67** (documented, not DB-enforced).
  - **Rollback floor:** after the first branch delete, the API cannot go below P67.
- **PDF test (`p62-pdf-isolation`):** proved to be a load-sensitive wall-clock bound, not a pool or start-up fault (20/20 loaded trials over 1,090 ms, refusal always 0 ms after the long job). Fixed in the test, with an opt-in benchmark.

| Check | Result |
| --- | --- |
| Full API | Run 1: **75 failed** (one cause: 9 unit-test mocks lacked the new access method), 3,785 passed. **Run 2: 0 failed, 3,860 passed, 6 skipped, exit 0** |
| P67 integration | 14/14 (in the full run) |
| Migration rehearsal (302 branches, 20,001 sales) | Run 1: script error-match bug. **Run 2: passed**, 93 tables byte-identical, no drift |
| Shared / typecheck / lint | 83 / clean / 0 errors |
| Web | Dialog 7/7, affected 309/309; full suite not rerun (last 1,780/1,780) |
| Builds + browser (SW active) | Pass; **27/27** (`tests/e2e/manual/p67/branch-delete.mjs`) |
| Not run | Hosted/staging (none exists); real devices; a live old-API process |

**Next (owner):**
- Review the PR. Merge and deploy are separate decisions.
- Do not delete any branch during the rollout window.
- Sync every terminal before deleting a branch, because queued offline sales for it are refused at sync.
- The production fixture inventory (P64 §4 / P66 §8) is still NOT done.

## Earlier: P66 — permanent Delete, dashboard panels removed, simpler Supervisor payroll (local)

Details: [`runbooks/pos-perf-p66-delete-dashboard-payroll.md`](runbooks/pos-perf-p66-delete-dashboard-payroll.md).

- **Delete failure, root cause:** P47's history count missed FK'd tables (expense types and others). Postgres then refused the delete with 23001 `restrict_violation`, which Prisma reports as an *unknown* error, so the request ended as an unmapped 500. Reproduced locally.
- **Delete is now permanent** for staff and supervisors:
  - The `users` row and everything it owned (credentials, sessions, PINs, branch access, notifications) are removed.
  - History references the new non-authenticatable attribution record `people`, so every past record keeps its name and amounts. Existing tokens die through the P64 marker.
  - Blocks only on an open shift, an open clock-in, or (staff) payroll hours no finalized run covers.
  - The typed name and the account version are confirmed server-side. Repeats and lost responses are reported as `already_deleted`.
- **Migration** `20261122120000_pos_perf_p66_account_deletion_people` (additive data; it retargets FKs and adds triggers). Rehearsed: 92 tables byte-identical, no drift. **Rollback floor: once any account is deleted, the API cannot go below P66** (old readers 500 on a deleted person's history). Order: migration, API, web.
- **Delete inventory:** every Delete button is mapped (runbook §3).
  - Expense Delete is a soft delete; its wording is now honest.
  - **Branch delete cascades sales, shifts, attendance, expenses and stock history (pre-existing design). Owner decision needed.** Its `RESTRICT` refusals are now a 409, not a 500.
- **Dashboards:** both panels gone from all three roles; the Today's Expenses KPI stays; their requests no longer fire.
- **Payroll:** one Payroll Settings entry, readiness checklist, then pay period, review and finalize. No calculation change.
- **Follow-up (runbook §7a):** payroll draft → review → finalize is now browser-verified on final builds, **44/44**. That run found and fixed three web-only payroll defects:
  - the rate dialog stayed open after the last missing rate was saved;
  - unpriced time still read ₱0.00 in totals and details, and is now "Needs a rate" or "Incomplete — needs a rate";
  - a cutoff day outside 1–27 had no in-form message.
- **Fixture cleanup** follows the new lifecycle (exact IDs, dry run first). **The production inventory, dry run and execution were NOT done.**

| Check | Result |
| --- | --- |
| P66 integration | 14 tests, all pass (run 3; runs 1–2 found a trigger gap and two test bugs) |
| Migration rehearsal | Passed (run 2; run 1 seed SQL bug) |
| Full API, one run | **1 failed, 3,835 passed, 5 skipped**: `p62-pdf-isolation` timing bound (1,124 vs 1,090 ms) in an untouched file; passes 23/23 alone |
| Full web | **1,777/1,777**; after the follow-up **1,780/1,780** |
| Shared / typecheck / lint | 83 passed / clean / 0 errors |
| Builds + browser (SW active, emulated desktop/tablet/phone) | Run 1 stopped on a driver bug; **run 2: 57/57** |
| Payroll browser (follow-up, `tests/e2e/manual/p66/payroll-flow.mjs`) | Runs 1–7 found driver/fixture issues and the three defects; **run 8 on the final build: 44/44** |
| Not run | Hosted/staging (none exists); real devices; full API suite not rerun after the follow-up (API unchanged) |

**Next (owner):**
- Review and push. A push, PR, merge or deploy needs your separate approval.
- Decide the branch-delete cascade.
- After deploy, run the fixture inventory and dry run (P64 runbook §4, adapted in P66 §8).

## Earlier: P64 — supervisor removal with history, test-account cleanup, Reports-only Admin views, dashboard cleanup (local)

Details: [`runbooks/pos-perf-p64-account-removal-and-dashboard-cleanup.md`](runbooks/pos-perf-p64-account-removal-and-dashboard-cleanup.md).

- **Super Admin Delete of a supervisor with history removes access and keeps the record.**
  - Removed: login, refresh, PIN, existing access tokens (via a removed-account marker in `revoked_tokens`) and branch access. The account leaves operational lists.
  - Kept: history names the person, and nothing is cascaded.
  - It cannot be revived through status, reactivation, edit, reset, assignment or unlock. A CHECK constraint also blocks an older API.
  - An open shift or clock-in blocks the removal, and nothing changes. Branches left without a supervisor are reported as a warning.
- **Additive migration** `20261121120000_pos_perf_p64_user_account_removal`. It changes no row, and was rehearsed on populated local data.
- **E2E/smoke cleanup:** `apps/api/scripts/p64-fixture-account-cleanup.ts` works on an exact-ID manifest. It runs a dry run first and needs a matching database host and confirmation token. It refuses Super Admin and Branch accounts. **The production inventory, dry run and execution have NOT been done.** They need the owner's review (runbook §4).
- **UI:**
  - The Branch Extra Supplies summary is now last on the dashboard.
  - Admin Extra Supplies and Attendance live only under Reports (`?tab=EXTRA_SUPPLIES`, `?tab=ATTENDANCE_RECORDS`). Their old URLs redirect, keeping only allowlisted filters.
  - The dashboard connection badges are gone.

| Check | Result |
| --- | --- |
| P64 integration | 12/12 (after fixing a test-email bug) |
| Focused API | 554/554 (third run; see the runbook for runs 1–2) |
| Full API (P64) | 1 failed / 3,819 passed: `p59-report-coverage` midnight dependency, **fixed in P65** |
| **P65 follow-up** (runbook §8) | Report test pinned to one Manila day (old formula reproduced 99/100 at a 12:38 AM base; fixed 11/11). The runner no longer exits 0 after a failed setup (occupied port: 0 → 1; 19/19 runner tests). Out-of-process removal was measured: refresh is refused at once, branch routes in ~0.15 s, auth-only routes in ≤60 s (13.6 s sample); an **open socket is not cut** |
| Full API (P65, one run) | **1 failed, 3,829 passed, 5 skipped; runner exit 1.** The failure is `p59-export-coverage` Discount PDF `PDF_TIMEOUT` (25 s) under load, in a file this branch doesn't touch. It passed 3/3 alone. Pre-existing and load-sensitive; not re-run |
| Full web | **1,758/1,758** |
| Typecheck / lint | Clean / 0 errors (API and web) |
| Migration rehearsal | Passed: 2,006 users unchanged, no drift |
| Builds + browser (SW active, emulated desktop/tablet/phone) | Run 1: 32/36 (driver bugs). **Run 2: 36/36** |
| Hosted / staging | NOT RUN: no isolated environment (unchanged) |

**Next (owner):**
- Review the PR. Merge and deploy are separate decisions. Order: migrations, then API, then web.
- No account cleanup until every pre-P64 API instance has retired.
- After deploy, run the production fixture inventory and dry run (runbook §4) for review before any execution.
- Provision new smoke accounts before the next smoke run if the old ones are removed.

## Earlier: P63 — VAT retired (owner decision, CR-010), verified locally

Every new sale is subtotal − the supervisor-set discount. The server refuses any VAT-calculated new sale (`VAT_CALCULATION_RETIRED`) after the replay paths. History is stored as-is and never recalculated, and no migration or column drop was made. VAT settings and statutory-rate editors are removed. A type named "PWD" is a manual type. Details: [`runbooks/pos-perf-p63-vat-retired.md`](runbooks/pos-perf-p63-vat-retired.md) §4 has the results.

| Check | Result |
| --- | --- |
| Full API | Run 1: 1 failed (P38R2 publication budget, cross-file FK race, passes alone, untouched since before P59). **Run 2: 0 failed, 3,805 passed** |
| Full web, default settings | **0 failed, 1,721 passed** |
| Shared, typecheck, lint, builds | 83 passed; clean; 0 errors; pass |
| Browser, final builds, service worker active | P62 terminal flows 10/10; P63 driver 10/10 ("PWD"-named type, no VAT on screen, offline sync once, Settings) |
| Hosted / staging | **NOT RUN: no isolated nonproduction environment exists** (see release blockers) |

**Operator prerequisite before production approval:** reload every terminal onto P58 or later, and check that no terminal still has queued offline sales from an older build. Any `VAT_CALCULATION_RETIRED` refusal after release is reconciled by hand against the shift's cash; there is no recording screen, by design.

**Release blockers (unchanged by P63):**
- Hosted checks (P62 §12.8) need an isolated staging environment. None exists: the `staging` GitHub environment has no secrets, there is no `staging` branch, `deploy-staging.yml` has never run, and Vercel previews have no API.
- Client-IP keying behind Vercel (the per-IP limits are shared), the same as `main` today.
- PDF capacity on Render is unmeasured.
- `main` has no branch protection or required checks, and repo auto-merge is disabled.

## Earlier: web test flakes fixed, full web suite green (local only)

Started at `aaae67b`; test-only changes plus docs, committed on top. Two subagents fixed one test file each; the lead reviewed the combined P59–P62 release (P62 runbook §12.9).

| Check | Result |
| --- | --- |
| `login-form` countdown | Cause: the test moved the fake clock before the countdown effect had run (screen rendered outside `act`). Test now waits for "2:05" first. 5/5 runs; reproduced and fixed under injected render delay |
| `daily-sales-drilldown` 18 failures | Cause: a timed-out `await act(async …)` under fake timers left React's act scope open, so no later render in the file committed. Search test made synchronous, real timers restored after each test, cold mount warmed in `beforeAll`. 19/19 × 3; a forced timeout no longer cascades |
| Affected files | 34/34 |
| **Full web, one run, default settings** | **1,725 passed, 0 failed, 184 files, exit 0, 531.75s** (machine not idle: owner's Chrome/VS Code) |
| Web typecheck / lint | Clean / 0 errors (5 warnings, unchanged) |
| API | Unchanged since run 2 at `5952a62` (0 failed); not re-run |
| Builds, browser | Not re-run: no application code changed |

**Remaining release blockers:** owner decisions (PDF capacity §11.2, Extra Supplies rollback §12.7, P59 VAT decisions, P60 type setup) and every hosted check (§12.8, NOT RUN). See §12.9.

## Earlier: P62 readiness batch, verified locally — not release-ready

All local gaps from the previous batch are closed or diagnosed; hosted checks are NOT RUN. See runbook §12.

| Check | Result |
| --- | --- |
| Requests before session restore (browser, 4 accounts, reload + client nav) | Supervisor per reload 16 → 14 requests; 1 tokenless 401 + 1 `daily-sales` 400 → 0. Admin/Branch/staff already 0. The "13 Admin calls" were the driver's own aborted requests |
| Session set (final web build) | 12/12; 12 injected failures counted apart; 0 unexpected |
| Screen totals vs API vs DB (Admin + Supervisor reports, Supervisor + Branch dashboards) | 34/34, discounts non-zero |
| PDF, saturation 4×3 week PDFs | 4/12 before and after; refusals ~25s → 0.8–1.2s. Sheets 120 → 61. Under browser+terminal load: 2/12, 2 admitted renders still hit 25s |
| Terminal under PDF load, SW active | 10/10; one sale/deduction/issue/collection per operation |
| Full API | Run 1: 2 failed (diagnosed, fixed). Run 2 `5952a62`: **0 failed**, 3,845 passed |
| Full web, final `032d07b` | Run 1: **1 failed** (`login-form` countdown, unexplained, untouched area). Run 2: **18 failed** in `daily-sales-drilldown` (5s timeout under load, passes alone). **No fully green web run on final code** |
| Shared, typecheck, lint, builds | 83 passed; clean; 0 errors; pass |

**Release blockers (at that time):** hosted checks (§12.8, NOT RUN); PDF capacity (§11.2); Extra Supplies rollback acceptance (§12.7); unexplained failures (P57 hook, P58 race, refresh 500s; `login-form` and `daily-sales-drilldown` since fixed, see Latest).

**Next:** owner decisions; with authorization, the hosted checklist in §12.8.

## Earlier: P61, verified locally

Supervisors set up Extra Supplies cards on existing inventory items. Cashiers give them free or for payment from a terminal tab, with exactly-once retries. History, reports and Inventory Movements read the same records. One additive migration; no reversal exists. See [`runbooks/pos-perf-p61-extra-supplies.md`](runbooks/pos-perf-p61-extra-supplies.md).

| Check on `95c7b5e`, disposable local databases, sequential | Result |
| --- | --- |
| Full API suite, default parallel | **1 failed** (`flavors`), 3,775 passed, 5 skipped |
| Full API suite, one file at a time | 3,776 passed, 5 skipped, 0 failed |
| Full web suite, 5s timeout | **2 failed** (timeouts: `admin/attendance`, `dialog-host`), 1,688 passed |
| Full web suite, 20s timeout | 1,690 passed, 0 failed |
| Shared suite | 83 passed |
| Typecheck, lint, production builds | Clean; 0 errors; pass |
| Migration rehearsal, 20,000 sales | Pass; 87 tables byte-identical, no drift |
| Browser, final builds, service worker active | 73 / 73, after 14 earlier runs; four found real bugs (runbook §8) |
| Real devices, camera, hosted Storage, realtime, a real old API, rollback | **Not tested** |

**Rollout:** migration, API, then web. **Rollback:** code only, and an open shift would lose cash supply collections from expected cash (runbook §7).

**New findings, not fixed (runbook §10):** a reload during a slow token refresh can sign a user out; the API suite fails intermittently in parallel, cause not proved; the global rate limit is shared per IP.

**Next:** performance diagnosis across Admin, Supervisor and Branch, including PDF rendering isolation, before combined release.

## Earlier: P60, verified locally

Supervisors create expense types for their branches and sort expenses into filtered views over one ledger. Existing expenses stay legacy: no backfill, seeds or guessing. Two additive migrations. Dashboards and Admin Reports get a type breakdown that drills into the ledger, and exports are server-made. It also fixes expense route bugs that predate P60, including a cross-branch read through `branch_id`. See [`runbooks/pos-perf-p60-expense-types.md`](runbooks/pos-perf-p60-expense-types.md).

| Check, on disposable local databases, sequential | Result |
| --- | --- |
| Full API suite, real Postgres, final code | 3,733 passed, 5 skipped, 0 failed. **The first run, before the final code, had 1 failed test and 1 failed suite; the cause was not proved (runbook §6)** |
| Shared suite | 83 passed |
| Full web suite | 1,670 passed, 0 failed |
| Typecheck, production builds | Clean; pass |
| Lint | 0 errors |
| Migration rehearsal, 20,000 expenses | Pass; 85 tables byte-identical, no drift |
| Browser, final builds, service worker active | 86 / 86 on a complete run, plus 11 / 11 for checks it read too early. Earlier runs in runbook §6, one of which found a real stale-rows bug |
| Real devices, camera, printing, offline, hosted Storage, realtime, mixed old/new versions | **Not tested** |

**Rollout:** migrations, API, then web. **Rollback:** code only; never drop the schema. Supervisors must create types before branch accounts can save expenses in the new web (runbook §5, §8).

## Earlier: P59, verified locally

Visible VAT removed, saved discount names shown everywhere, Discount Report with proof over required sales only, DSR wording,
and "Managed by Super Admin" removed. Presentation only, with no migration. See
[`runbooks/pos-perf-p59-reports-and-ui-cleanup.md`](runbooks/pos-perf-p59-reports-and-ui-cleanup.md).

**Owner decisions to confirm before release** (runbook, top section): receipts without VAT lines, exports without VAT columns, and no VAT registration screen.

**Readiness follow-up, also local only:** report limits now label partial results, the Admin drill-down pages through the server, and the real terminal was verified with the service worker active. It found and fixed a reload-recovery bug that could charge a sale twice. See runbook §10.

**PDF cap and report coverage, also local only:** Supervisor and Branch record-level PDFs stop at 100 rows and CSVs at 10,000, labelled inside the file when cut short. Every Supervisor tab now pages through the server, and its cards read full-period aggregates. See runbook §11.

## Read next

0. For P62: its runbook §1 for the auth protocol, §3 for PDF bounds, §7 for test results, §9 for what's missing. For P61: its runbook §5 for recovery, §7 for rollback, §10 for release blockers. For P60: its runbook §1 for scope rules, §5 for compatibility, §8 for rollout. The rest of this list is P59.
1. The P59 runbook's owner decisions, §11 for the latest work and its rollout order, §10 for the follow-up, then §8 for limits
2. `packages/shared/src/discounts/discount-display.ts` for the name, identity and proof rules
3. [`PROJECT_MAP.md`](PROJECT_MAP.md), "Manual discounts and proof uploads" and "Dashboards, reports and stock alerts"

## P59 verification evidence

On a new disposable database, sequential. The full API run is at `3172435`; `0d86464` changes web tests only. Everything else is at `0d86464`.

| Check | Result |
| --- | --- |
| Full API suite, real Postgres | 3,700 passed, 5 skipped (opt-in measurement), 0 failed |
| Shared suite | 73 passed |
| Full web suite | 1,655 passed, 0 failed |
| Typecheck, production builds | Clean; pass |
| Lint | 0 errors |
| Browser, final builds, service worker active | 44 / 44, on a complete re-run; the first run was 43 / 44 (runbook §11) |
| Generated CSV and PDF files | Read; PDF text extracted, appearance not inspected |

**Blocking, on one laptop, 100-row Discount PDF against idle:** PDF 1.65s to 2.38s. Worst `/health` 1.35s to 1.79s (idle 6ms). Checkout 1.42s to 2.04s (idle median 128ms). Each sale and deduction happened exactly once.

Earlier: on a disposable local database, at `e6a4d1a`, run sequentially.

| Check | Result |
| --- | --- |
| Full API suite | 3,666 passed, 5 skipped, 0 failed |
| Shared suite | 73 passed |
| Full web suite | 1,633 passed, 0 failed |
| Typecheck, lint, production builds | Clean; 0 lint errors |
| Browser, final builds, service worker blocked | 87 / 87 |
| Generated CSV and PDF files | Opened and read |

On a new disposable database and real local Storage, at `61b4df1`, run sequentially.

| Check | Result |
|---|---|
| Terminal browser run, final builds, service worker active | 95 / 95, on a complete run from fresh data |
| Earlier complete run, `050056d` | 86 / 90. It found the double-charge bug |
| Shared suite | 73 passed |
| API report and discount integration tests | 344 passed. **Full API suite not re-run; last full run `e6a4d1a`** |
| Full web suite | 1,644 passed, 0 failed |
| Typecheck, production builds | Clean; pass |
| Lint | 0 errors |
| Real devices, physical camera (gallery upload used), printing, offline sales in this run, hosted Storage, mixed old/new versions | **Not tested** |

Earlier failures are recorded in runbook §7 and §10.

## Known blockers and notes

- **Still open from P59, not fixed by P60:** PDF blocking and the uncapped routes (both below) and the owner decisions (P59 section) block release.
- **Found in P60, not changed:** see runbook §7.
- Production was not accessed, and local Git says nothing about what is deployed.
- **P62:** PDF rendering runs in a bounded worker with a 25s interactive deadline (P62 runbook §3). Hosted timing not measured. Capacity is an owner decision (§11).
- **Test environment (P62):** fixed in `db80eb0`; `with-test-postgres.ts` now exits nonzero on any failure.
- **Unresolved: the Transaction PDF route is uncapped.** `GET /api/transactions/export/pdf`, behind the Daily Sales drill-down, took 9.6s and stalled `/health` for 8.4s at about 267 rows, and allows 2,000. Admin's synchronous PDFs also stay uncapped below 2,000 rows. Decide before release. See runbook §11.
- **Owner to note:** a branch with more than 100 sales a week gets a partial PDF on the default 7-day range. CSV stays complete up to 10,000 rows.
- **Deploy order:** API before web, or the new Void/Refund tab lists every sale during the overlap. See runbook §11.
- **Ship soon:** the double-charge fix (`61b4df1`). The bug predates P59, so a deployed build probably has it. Not checked.
- **One unexplained stop:** a PIN step stalled once in the 86/90 run and did not recur. Cause not established.
- **Found, not changed:** the service worker can't install while logged out (`/apple-touch-icon.png` redirects). See runbook §10.
- **Cleanup:** `C:\p59r` and `C:\p59c` (browser profiles from these local runs) are still there; a safety check blocked removing them. Safe to delete by hand.
- **Next batches:** Extra Supplies setup, terminal, and inventory and history integration, then performance and PDF isolation last, before release. The Discount Report aggregate's cost belongs in the performance review (runbook §8).
- **Test setup:** the API environment needs a base64 `ENCRYPTION_KEY` and `TEST_REDIS_URL` set, or tests fail or skip. Set every value explicitly. Docker Desktop was off and had to be started for the disposable database.
- **Browser setup:** keep Chromium profile paths short on Windows; a long one breaks `CacheStorage`. Ports 55158 to 55557 are reserved here. With only local Storage running, `supabase status` omits the keys.
- **Found, not changed:** staff get 403 from Export on `/branch/reports`, which isn't in their sidebar.

## Actions

**Permitted:** read code; run local tests against disposable databases; update this handoff and the affected map entries.

**Needs separate authorization:** pushes, PRs, merges, deployment, production access, stashes, removing worktrees, migrations outside a verified local database.

Record the code SHA that was actually observed or tested, never a guess at a future docs commit.
