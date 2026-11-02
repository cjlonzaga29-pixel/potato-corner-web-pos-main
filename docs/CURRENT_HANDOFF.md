# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-03
- **Branch:** `feat/pos-perf-p59-reports-and-ui-cleanup`, from `origin/main` `6931b10`. Local only: not pushed, no PR.
- **Tested code:** `61b4df1`, on `050056d`, for the readiness follow-up. The original P59 run was on `e6a4d1a`. Later commits add one lint comment and docs only.
- **PR #44** (`fix/pos-perf-p58-ever-published-test-isolation`, `7f7cf35`) is separate and not included. This handoff doesn't record its status or P58's deployment state, so check GitHub.
- **Working tree after the docs commit:** only `.vscode/settings.json` should remain modified. It is unrelated; never stage it.
- **Other worktrees:** six older P51–P55R3 worktrees, marked `prunable`. Nothing here authorizes removing them.

## Task status: P59, verified locally

Visible VAT removed, saved discount names shown everywhere, Discount Report with proof over required sales only, DSR wording,
and "Managed by Super Admin" removed. Presentation only, with no migration. See
[`runbooks/pos-perf-p59-reports-and-ui-cleanup.md`](runbooks/pos-perf-p59-reports-and-ui-cleanup.md).

**Owner decisions to confirm before release** (runbook, top section): receipts without VAT lines, exports without VAT columns, and no VAT registration screen.

**Readiness follow-up, also local only:** report limits now label partial results, the Admin drill-down pages through the server, and the real terminal was verified with the service worker active. It found and fixed a reload-recovery bug that could charge a sale twice. See runbook §10.

## Read next

1. The runbook's owner decisions, §10 for the follow-up, then §8 for limits and §9 for rollout
2. `packages/shared/src/discounts/discount-display.ts` for the name, identity and proof rules
3. [`PROJECT_MAP.md`](PROJECT_MAP.md), "Manual discounts and proof uploads" and "Dashboards, reports and stock alerts"

## Verification evidence

On a disposable local database, at `e6a4d1a`, run sequentially.

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

- No code blockers. Production was not accessed, and local Git says nothing about what is deployed.
- **Owner decision before release:** a 2,000-row Discount Report PDF stalled other API requests for up to 17.4s on a laptop, and checkout would wait too. Accept that, or lower the PDF limit. Moving rendering off the request thread belongs in the performance batch.
- **Ship soon:** the double-charge fix (`61b4df1`). The bug predates P59, so a deployed build probably has it. Not checked.
- **One unexplained stop:** a PIN step stalled once in the 86/90 run and did not recur. Cause not established.
- **Found, not changed:** the service worker can't install while logged out (`/apple-touch-icon.png` redirects), and other Supervisor report tabs still stop at 100 rows without saying so. See runbook §10.
- **Cleanup:** `C:\p59r` (115 MB of browser profiles) is still there; a safety check blocked removing it. Safe to delete by hand.
- **Next batches:** Expense Types, then Extra Supplies, then performance last. The Discount Report aggregate's cost belongs in the performance review (runbook §8).
- **Test setup:** the API environment needs a base64 `ENCRYPTION_KEY` and `TEST_REDIS_URL` set, or tests fail or skip. Set every value explicitly. Docker Desktop was off and had to be started for the disposable database.
- **Browser setup:** keep Chromium profile paths short on Windows; a long one breaks `CacheStorage`. Ports 55158 to 55557 are reserved here. With only local Storage running, `supabase status` omits the keys.
- **Found, not changed:** staff get 403 from Export on `/branch/reports`, which isn't in their sidebar.

## Actions

**Permitted:** read code; run local tests against disposable databases; update this handoff and the affected map entries.

**Needs separate authorization:** pushes, PRs, merges, deployment, production access, stashes, removing worktrees, migrations outside a verified local database.

Record the code SHA that was actually observed or tested, never a guess at a future docs commit.
