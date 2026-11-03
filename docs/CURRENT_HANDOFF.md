# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-03
- **Branch:** `feat/pos-perf-p61-extra-supplies`, from the P60 tip `500e97e`. Local only: not pushed, no PR.
- **Ancestry:** P61 depends on unpushed P60 and P59 (`feat/pos-perf-p59-reports-and-ui-cleanup`), which came from `origin/main` `6931b10`. Merging P61 brings in both.
- **Tested code:** P61 `95c7b5e`. Later commits are docs only. P60's tested code was `6694e05`.
- **PR #44** (`fix/pos-perf-p58-ever-published-test-isolation`, `7f7cf35`) is separate and not included. This handoff doesn't record its status or P58's deployment state, so check GitHub.
- **Working tree after the docs commit:** only `.vscode/settings.json` should remain modified. It is unrelated; never stage it.
- **Other worktrees:** six older P51–P55R3 worktrees, marked `prunable`. Nothing here authorizes removing them.

## Task status: P61, verified locally

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

0. For P61: its runbook §5 for recovery, §7 for rollback, §10 for release blockers. For P60: its runbook §1 for scope rules, §5 for compatibility, §8 for rollout. The rest of this list is P59.
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
- No failing checks. Production was not accessed, and local Git says nothing about what is deployed.
- **Unresolved: PDF rendering still blocks the API.** A 100-row PDF stalls every branch's checkout for up to about 2s here, down from 17.4s. Accept that, or move rendering off the request thread in the performance batch. Hosted timing wasn't measured.
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
