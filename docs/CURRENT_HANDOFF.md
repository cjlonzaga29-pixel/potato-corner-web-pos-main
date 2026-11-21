# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-22
- **Branch:** `feat/pos-perf-p64-account-removal-and-dashboard-cleanup`, from `origin/main` `27e7114`. It has two commits: P64 `52a9555`, and the P65 follow-up (test determinism and runner exit status) on top. **The branch is pushed and has a PR (see the PR for its number and CI). Nothing merged or deployed; production not accessed.**
- **Reported history, not re-verified here:**
  - `27e7114` is the merge of PR #46 (the ever-published test isolation fix), the last reported deployment.
  - PR #45 (combined P59–P63) was merged before it.
  - This session did not verify production independently.
- **Working tree:** only `.vscode/settings.json` is modified (the owner's personal setting). Never stage it.
- **Local leftovers (task-owned, safe to delete):**
  - `C:\p65`: P65 env, logs, stopped Postgres data, measurement stack and its driver (`C:\p65\lead\measure-revocation.mjs`).
  - `C:\p64a`: P64 test env, logs, stopped Postgres data.
  - `C:\p64b`: P64 browser stack, logs, screenshots, CSV and stopped Postgres data.
  - Older roots: `C:\p64` (P63), `C:\p63`, `C:\p62`, `C:\p59r`, `C:\p59c`.
  - No P64 service is left running.
- **Unidentified, left running:** two orphaned embedded-Postgres `io_worker` processes from 2026-11-22 1:51 AM and 2:12 AM. They hold no port and could not be tied to this task with certainty.
- **Not this session's:** a `stack.sh api` (`dist/server.js`) from 2026-11-21 1:04 PM and older orphaned embedded-Postgres `io_worker` processes from 2026-11-21. They were left untouched.

## Latest: P64 — supervisor removal with history, test-account cleanup, Reports-only Admin views, dashboard cleanup (local)

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
