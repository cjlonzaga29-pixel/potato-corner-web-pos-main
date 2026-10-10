# POS-PERF-P30R — Targeted Session Security and Real-Browser Verification

## Starting / final state

- Starting local HEAD: `b0f57725a7154f90d77d094712b798d240ff6db5` (origin/main, clean).
- Final local HEAD: see the commit this report ships alongside — one commit ahead of the starting SHA above, which itself was 1 commit ahead of `origin/main` (unchanged by this task; no push performed).
- `DATABASE_URL`/`DIRECT_URL` verified pointing at `127.0.0.1:5432/pos_verify` (the project's existing disposable local Postgres, already running via the pre-existing `potato-corner-pos-postgres-1` Docker container) before any test run. Local Supabase Storage (`supabase start --exclude studio --ignore-health-check`, port 54321) was started for this session and matches the values already configured in `apps/api/.env`. No production connection string was touched.
- API (`apps/api`, port 4000) and web (`apps/web`, port 3000) were run via their normal dev servers (`npm run dev`) against this local stack for the real-browser verification in Part 3.

## Part 1 — Session refresh and locking: trace results

Traced `refreshEmployeeSession` (auth.service.ts), `selectEmployee`, POS PIN verification (`staff-pin.service.ts`), `refreshEmployeeToken` (terminal/page.tsx), idle lock, Switch Cashier, logout, and credential revocation end to end.

**Confirmed correct (no gap found):**
- `refresh-employee-session` never accepts a raw employee id as proof of identity — it only succeeds while that employee currently has an **open AttendanceRecord at the actor's own branch**, i.e., they already passed the PIN gate via `select-employee` and haven't clocked out. It independently re-checks `employee.status === 'active'`, `employee.isActive`, and current branch assignment on every call — staff deactivation or branch-assignment removal is rejected the next time a refresh is attempted (bounded by the access token's own 15-minute TTL in the worst case, same latency as every other revocation path in this codebase — see `changePassword`'s equivalent limitation).
- `select-employee` resolves identity only from a consumed, single-use `pos`-purpose verification token, never from client-supplied `employee_id` — confirmed unchanged from P30.
- Inventory-purpose and POS-purpose verification tokens are hard-rejected by each other's consume path (`VERIFICATION_CONTEXT_MISMATCH`) — re-verified live against the running server in Part 3, test 8 below, not just by re-reading P30's unit tests.
- Idle lock, Switch Cashier, and Clock Out all only ever drop the terminal-local `activeEmployee`/`activeEmployeeToken` state (and the matching `clearTerminalOperator()` sessionStorage hint) — none of them call `clock-out` as a side effect. Attendance and "who is at the terminal" are correctly kept as two independent concepts.
- Checkout, clock-in, and clock-out all derive cashier identity from the request's bearer token server-side (`req.user.user_id` in `transactions.router.ts`), never from any client-supplied field — confirmed by reading every `cashierId:` assignment site.
- Multi-tab behavior is **defined and bounded by `sessionStorage` scoping**: `terminal-operator.store.ts` persists the selected Employee's identity/token to `sessionStorage`, which browsers scope per tab (not shared, unlike `localStorage`, and not copied on a plain new-tab — only on an explicit "duplicate tab"). A second tab opened to `/branch/terminal` under the same Branch Account therefore always starts at "Who's working?" and must independently PIN-verify — it can never silently inherit a different tab's selected Employee. The Branch Account's own refresh-token cookie *is* shared across tabs (standard cookie behavior), so both tabs stay logged in as the same Branch Account; only the POS-local Employee selection is tab-isolated. This is now stated explicitly here since the original P30 report did not call it out as a defined behavior.

**Confirmed defect (fixed — see Part 2):** a stale `refreshEmployeeToken` closure captured by an in-flight mutation before Switch Cashier/idle-lock/logout can, on a late 401 retry, write into the *current* (now different) terminal session's state.

## Part 2 — Defect found and fixed

### The bug

`terminal/page.tsx`'s `refreshEmployeeToken` callback is passed into `useCreateTransaction`/`useUploadPaymentProof`/`useUploadDiscountProof`/`useClockIn`/`useClockOut` as the `refreshOverrideToken` argument `api-client.ts`'s `fetchAuthenticated` invokes on a 401 for an `accessTokenOverride`-scoped request. Each of these hooks' `mutationFn` closes over whichever `refreshEmployeeToken` reference existed on the render that started that specific `mutateAsync()` call — and once that async function body starts running, it keeps that closure for its entire lifetime, including any 401-triggered retry, no matter how many renders (switch cashier, idle lock, logout) happen afterward.

The callback itself, as written in P30, unconditionally wrote into component state on both its success and failure paths:

```ts
const selected = await refreshEmployeeSession(activeEmployee.id); // activeEmployee closed over from the ORIGINAL render
setActiveEmployeeToken(selected.accessToken);   // always runs
...
} catch {
  setActiveEmployee(null);
  setActiveEmployeeToken(null);                 // always runs
  clearTerminalOperator();
}
```

**Concrete failure scenario (matches the task's required test case):** Cashier A submits an order; the response is delayed. A then switches to cashier B via Switch Cashier (never a clock-out — A's attendance stays open). B unlocks with their own PIN and starts selling. If A's abandoned request eventually 401s (its 15-minute-TTL token can genuinely expire on a long enough delay) and the retry fires, the **stale** closure bound to A runs:
- **Success case:** A is still clocked in (plausible — Switch Cashier never clocked her out), so `refreshEmployeeSession('A')` succeeds and returns a fresh token for A. The stale closure then calls `setActiveEmployeeToken(freshTokenForA)` — overwriting B's *currently active* token with A's, while the UI still displays "Current Cashier: B". Every subsequent request B's screen makes (clock-out, next sale) now silently authenticates as A. `useTerminalOperator`'s sync effect then persists this mismatched pair (`activeEmployee.id = B`, `activeEmployeeToken = A's token`) into the sessionStorage-backed terminal-operator store, so the corruption survives a reload too.
- **Failure case:** if A's refresh instead fails (e.g., A has since clocked out for real), the stale closure calls `setActiveEmployee(null)` / `setActiveEmployeeToken(null)` / `clearTerminalOperator()` — force-logging B out of a session B never had anything wrong with, over a failure that was never B's.

This is exactly the "automatic refresh or late refresh response cannot restore cashier access after … Switch Cashier … " requirement, and as written, it was violated.

### The fix

`apps/web/app/(branch)/branch/terminal/page.tsx` — added `activeEmployeeRef`, a ref kept in sync with the live `activeEmployee` value on every render, independent of which render's closure is currently executing. `refreshEmployeeToken` now checks `activeEmployeeRef.current?.id === employeeAtCallTime.id` before either `setActiveEmployeeToken` (success) or `setActiveEmployee(null)/setActiveEmployeeToken(null)/clearTerminalOperator()` (failure). The resolved/failed token is still **returned** either way, so A's own retry still completes correctly on its own terms (attributed to A, as it always was) — only the write into shared terminal component state is gated on "is this still the operator actually at the terminal."

### Regression test

`apps/web/app/(branch)/branch/terminal/page.test.tsx`, new test in the existing "Employee-scoped token silent refresh (Task 209.56C)" describe block: selects cashier Alice, captures the `refreshEmployeeToken` closure bound to her, performs a real Switch-Cashier UI flow to cashier Bob, then invokes the *stale* captured closure (simulating Alice's abandoned request's late 401 retry). Asserts Alice's own retry still legitimately succeeds (`mockRefreshEmployeeSession` resolves, returned token is Alice's new one), while Bob's screen is untouched — still showing "Bob B", `mockUseCreateTransaction` still last called with Bob's token, no bounce to "Who's working?".

**Verified the test actually catches the bug**: reverted just the `page.tsx` fix (keeping the new test), re-ran — the test failed with `expected "employee-b-token-1", got "employee-a-token-2"` (i.e., it detected Bob's session being overwritten with Alice's token), confirming the test is not a false positive. Restored the fix — the same test (and the full 120-test file) passes.

## Part 3 — Real-browser verification

New spec: `tests/e2e/pos-perf-p30r-session-security.spec.ts`, run against the local disposable stack described above (not production accounts/storage/data). All 9 tests passed in a clean run:

1. **Supervisor sees staff PIN status and sets a PIN through the actual UI** — `/supervisor/employees` → row action → `ManageStaffPinDialog` → types+confirms a PIN → PIN status badge flips to "Active". Real UI, real backend, real DB row.
2. **Wrong PIN fails without unlocking POS** — generic "Invalid PIN", terminal stays on the PIN screen, no identity ever resolved/displayed.
3. **Correct PIN identifies the staff member and Clock In opens the terminal** — PIN verified → "Continue as Jenny" → "Clock In to Start Selling" card (real geolocation via Playwright's `context.setGeolocation`) → Clock In → catalog + "Current Cashier: Jenny Santos" strip.
4. **Already-clocked-in staff continues without a duplicate attendance record** — full page reload; operator is restored directly from the live attendance check (Task 209.27), "Who's working?" never flashes; confirmed via a direct API call that exactly one open attendance record exists for Jenny (not two).
5. **Switch Cashier swaps identity without clocking out the prior cashier** — clicked "Switch Cashier"; confirmed via API that Jenny's attendance is *still open* immediately after switching (before Bob even PIN-verifies); Bob PIN-verifies, clocks in independently; confirmed via API again that Jenny is *still* open afterward (one open record each, never merged/clobbered).
6. **Deactivating a PIN rejects a new verification attempt with it** — Supervisor UI "Deactivate PIN" → badge flips to "Inactive" → a fresh `verify-pos` call with the just-deactivated PIN returns `401 INVALID_PIN` (generic — never reveals the PIN used to be valid).
7. **Cross-branch management access is denied** — `branch@potatocorner.test` (scoped to MAIN01 only) gets `401`/`403` attempting `verify-pos` and inventory `verify` against a branch it has no assignment to.
8. **An inventory-purpose verification token cannot unlock POS cashier selection** — a real `verify` (inventory, `WASTE` operation) token, fed into `select-employee`, is rejected with `422 VERIFICATION_CONTEXT_MISMATCH` — re-proves P30's purpose separation against the live running server, not just its own unit tests.
9. **Idle lock requires a PIN to unlock, and never clocks the cashier out** — a genuine, un-mocked wait of `IDLE_LOCK_MS` (5 minutes) + a 20s margin with zero pointer/key events: the terminal reverts to "Who's working?" on its own; confirmed via API that attendance is still open throughout; the idle-locked screen still rejects a wrong PIN the same as the initial screen. This took the real ~5.5 minutes wall-clock — not simulated or faked.

**Employee ↔ User mapping / missing-link state**: re-confirmed (as P30 already established) that there is no separate Employee table — a `staff`-role `User` row *is* the employee record. The "missing-link" state this task asked to test explicitly is therefore: a `staff` user with no `StaffPin` row at all. `verifyPosPin`'s `findActiveBranchLookup` returns nothing for such a user, so any PIN attempt against them falls straight into the same generic `INVALID_PIN` path as a wrong PIN for an existing PIN — **no privileged account is ever silently created**, and no distinct code path exists that could create one. Verified by reading `staff-pin.repository.ts` and `staff-pin.service.ts` — the only way a `StaffPin` row is ever created is `setPin`, which is role-gated (`adminSupervisorOrBranch`) and always requires an explicit PIN input from an authorized actor.

### Cleanup performed between runs

Jenny's (`staff@potatocorner.test`) attendance was clocked out via a direct authenticated API call after each test run that left her clocked in, so the shared disposable DB wasn't left in a state that would desync the next run's assumptions. "Bob Cashier-<random>" test employees created by `beforeAll` are left in place (harmless, disposable local DB — matches this DB's existing accumulation of prior P28/P29 test-run artifacts, which predate this session).

## Part 4 — Validation and honest results

- **`apps/api`**: `tsc --noEmit` clean. `eslint` clean (0 errors; 296 pre-existing `no-console` warnings in files this task never touched). Production build (`tsc -p tsconfig.json`) clean.
  - Full `vitest run`: **149 files passed / 1 file failed**, **2763 tests passed / 1 test failed** (222 skipped), of 164 files / 2986 tests total.
    - The one failure: `src/modules/universal-inventory/universal-inventory.http-concurrency.integration.test.ts` — `concurrent identical direct-write adjustments under the same Idempotency-Key change InventoryStock exactly once and create exactly one movement`, which asserted `successes.length >= 1` and got `0` (all 6 concurrent HTTP requests in that one test returned non-2xx).
    - **This file is unrelated to any P30R change** (P30R touched only `auth`/`terminal`/`staff-pin` test-adjacent files; this is a pre-existing `universal-inventory` concurrency test, untouched by this task).
    - Re-ran this exact file in isolation: **5/5 passed**, including the specific test that failed under the full run, with the expected idempotency-mutex behavior visible in the Prisma query log (a `unique constraint failed` on `(idempotency_key, actor_user_id)` for the losing concurrent callers, which the code's own catch branch correctly turns into a cache-lookup-and-replay instead of a raw error).
    - Per this task's own instruction not to call something "resource contention" from a bare retry alone: the isolated pass is paired with a structural argument, not just a second roll of the dice — a real logic defect in this mutex would be expected to produce *some* successes with a wrong total count (e.g., two stock mutations instead of one), not a uniform *zero* successes across all six concurrent callers. A uniform total failure across every concurrent caller is the signature of an external resource failing closed (e.g., Postgres connection-pool pressure from 164 test files' worth of concurrent `PrismaClient` instances, each opening their own pool, all running in the same `vitest` process at once) — not of the idempotency logic itself misbehaving. Not re-asserted as fully proven without a connection-pool metric capture, which wasn't gathered this session; flagging as the leading hypothesis with the supporting isolation-run evidence, not a closed case.
  - **Reported separately, as instructed**: the full run is 1 failed / 149 passed; the isolated confirmation is 5/5 passed. Both numbers are given — neither is presented as the whole story alone.
- **`apps/web`**: `tsc --noEmit` clean. `eslint` clean (0 errors; 1 pre-existing `@next/next/no-img-element` warning in an untouched file). Production `next build` clean — all routes compiled, including `/branch/terminal` and `/supervisor/employees`.
  - Full `vitest run`: **133/133 files passed, 1168/1168 tests passed.** No failures, no flakes, this run.
- **`packages/shared`**: `tsc` build clean.
- **E2E (`tests/e2e/pos-perf-p30r-session-security.spec.ts`)**: 9/9 passed against the real local stack (API+web dev servers, local Postgres, local Supabase Storage/Auth). Not authored-only — executed, with failures debugged and fixed along the way (see "issues found and fixed while writing this suite" below) rather than adjusted to force a pass.
- **Unit regression test** (`terminal/page.test.tsx`): verified it fails without the fix and passes with it (see Part 2).

### Issues found and fixed while writing the verification suite itself (test-infrastructure only, not product defects)

These were artifacts of the verification work, not findings about the product, and are recorded for anyone re-running this suite later:
- `/api/attendance?employee_id=...` is not a real route — the correct path is `/api/attendance/employee/:employeeId`. Fixed in the spec.
- `getByRole('row', { name: /Jenny Santos/ })` matched two elements (the app's DataTable renders both a desktop and a mobile layout in the DOM simultaneously, one hidden via CSS, both still queryable) — scoped with `.first()`.
- The shared PIN-verify rate limiter (`staffPinVerifyOverallLimiter`/`staffPinVerifyFailureLimiter`, keyed per `(branchId, actor)`) got exhausted by this session's own repeated manual re-runs during debugging, not by the suite's own normal single pass — test 8 now uses a different actor (`adminAccessToken` instead of `branchAccessToken`) for its one inventory-verify call specifically to avoid colliding with the budget tests 2/3/5/6/7 already spent in the same actor+branch bucket within one 5-minute window. `consumePosVerification` only checks the token's branch, never which actor minted it, so this doesn't weaken what's being proven.
- First attempts hit Next.js dev-mode cold-compile latency (each route takes 5–30s to compile on its first hit) exceeding `global-setup.ts`'s 30s `waitForURL` — resolved by letting each route compile once before the timed run; not a defect, just a dev-server characteristic.

## Part 5 — Migration compatibility and populated-upgrade evidence

No schema migration was created or needed by this task — P30R is a client-side logic fix plus tests/docs only. The local shadow DB (`pos_verify`) used throughout this session already carries P30's additive migration (`20261010090805_add_staff_pin_pos_purpose_p30`) and months of accumulated prior test-run data (80 users, 20+ branches, multiple historical attendance records including a stale open one from 2026-10-07 that had to be manually clocked out before this session's own tests could run cleanly) — `prisma migrate status` reports "Database schema is up to date" against it. This stands as the populated-upgrade evidence for this task: every scenario above ran correctly against a long-lived, heavily-used shadow database, not a pristine one.

## Part 6 — Staff onboarding before rollout

No new onboarding step is introduced by this fix — it is purely a client-side defensive fix with no API/schema/UX change. Existing P30 onboarding requirements (documented in `pos-perf-p30-supervisor-pin-pos-clockin.md`) are unchanged: supervisors/branch accounts need to set each staff member's Inventory/POS PIN once before that staff member can use the PIN-gated terminal.

## Part 7 — Deployment ordering, stale frontend handling, safe rollback

- **Deployment ordering**: web-only change (`apps/web/app/(branch)/branch/terminal/page.tsx`) — no API contract changed, so there is no ordering constraint with the API deploy. Deploy independently of the API.
- **Stale frontend handling**: a stale (pre-fix) frontend bundle still has the race described in Part 2, but it is not a *regression* introduced by a mismatched deploy — it's the exact same pre-existing behavior that bundle already had in production before this fix. No new incompatibility is introduced between an old frontend and a new backend, or vice versa, since no backend contract changed.
- **Safe rollback**: rolling back `apps/web` to the prior commit (before this fix) restores the pre-fix behavior described in Part 2 — not a new regression, the same latent issue P30 already shipped with. Safe to roll back if needed; nothing else depends on this change.

## Part 8 — Remaining concrete blockers

- None introduced by this task. The one pre-existing, unrelated-to-P30R integration test flake (Part 4) is a candidate for a separate follow-up investigating Postgres connection-pool sizing under full-parallel `vitest run`, not a blocker for this fix.
- Idle-lock duration (5 minutes, `IDLE_LOCK_MS`) remains a hardcoded constant, not a per-branch setting — unchanged scope from P30, still a known limitation, not addressed by this task.

## Files changed

```
apps/web/app/(branch)/branch/terminal/page.tsx        (fix: stale-closure guard on refreshEmployeeToken)
apps/web/app/(branch)/branch/terminal/page.test.tsx    (new regression test)
tests/e2e/pos-perf-p30r-session-security.spec.ts       (new, real-browser verification suite)
docs/runbooks/pos-perf-p30r-session-security-verification.md   (new, this file)
```
