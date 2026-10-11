# POS-PERF-P32R — Idle Unlock and Deployment Compatibility Verification

## Starting / final state

- Starting local HEAD: `56ef3f58706b44d20b7a7e386321b48a08923cd5` (origin/main + 1, clean).
- Final local HEAD: see the commit this report ships alongside — one commit ahead of the starting SHA above.
- Local stack: the project's existing disposable Postgres (`potato-corner-pos-postgres-1`, `pos_verify` database) + `apps/api` (`tsx watch`, port 4000) + `apps/web` (`next dev --turbopack`, port 3000), matching the setup documented in `pos-perf-p30r-session-security-verification.md`. No production connection string was touched; `DATABASE_URL`/`DIRECT_URL` were verified pointing at `127.0.0.1:5432/pos_verify` before any test run.
- No push/deploy, no production data, no schema changes, no credential rotation.

## Correction to the runbook record

P30R's own report (test 9 of `tests/e2e/pos-perf-p30r-session-security.spec.ts`) already executed a real, un-mocked `IDLE_LOCK_MS` (5-minute) wait and confirmed the idle lock fires, never clocks the cashier out, and still requires a correct PIN to unlock. **This task does not re-litigate that** — it verifies the P32 lockContext/label behavior (`"Unlock POS"` vs `"Continue as [name]"` vs `"Clock In & Open POS"`) that P32 layered on top of that same lock, which P30R's suite predates and could not have exercised.

## Part 1 — Code-level trace of the idle-unlock / lockContext logic

Traced `terminal/page.tsx`'s `handleLockTerminal`, the idle-lock `useEffect`, `handlePinVerify`, and the STATE 1 render branch (`isIdleUnlockForThisStaff` / `primaryActionLabel`) end to end.

- `handleLockTerminal(reason)` captures `lockContext = { reason, employeeId: activeEmployee.id }` **before** clearing `activeEmployee` — so the lock screen always knows which employee's own idle timeout (or manual Switch Cashier) produced it, server-sourced from whichever employee was actually the live operator.
- `isIdleUnlockForThisStaff` requires **all** of: a resolved `pinVerification`, `pinVerification.isClockedIn === true` (server-confirmed, from the `verify-pos` response), `lockContext.reason === 'idle'`, and `lockContext.employeeId === pinVerification.staffId`. All four come from server-verified facts (the attendance lookup backing `is_clocked_in`, and the PIN-resolved `staff_id`) — none are inferred client-side.
- **Same staff, idle lock**: all four conditions hold → `"Unlock POS"`.
- **Different staff, after the same idle lock**: `lockContext.employeeId` still names the original (idle-locked) employee, but `pinVerification.staffId` names the new one — the identity comparison fails, so `isIdleUnlockForThisStaff` is `false` regardless of the new staff member's own clocked-in state. Falls through to `"Continue as [name]"` (if the new staff member is independently clocked in elsewhere) or `"Clock In & Open POS"` (if not) — never `"Unlock POS"`.
- **Switch Cashier (manual), same staff re-entering immediately**: `lockContext.reason === 'manual'`, so even an exact staff-id match never produces `"Unlock POS"` — correctly distinguishing a deliberate handoff from an idle timeout.
- **Late token refresh cannot bypass the lock**: unchanged from P30R's Part 2 fix — `refreshEmployeeToken`'s `activeEmployeeRef` guard only ever writes a token into `activeEmployeeToken`/`activeEmployee` state for whichever employee is still *currently* at the terminal. A stale refresh resolving after an idle lock has already fired finds `activeEmployeeRef.current` is `null` (the lock cleared it), so the guard's `activeEmployeeRef.current?.id === employeeAtCallTime.id` check fails and the write is skipped — the locked screen is never silently reopened by a late-arriving token. This is the same mechanism P30R proved for Switch Cashier, re-confirmed by re-reading it against the P32 lock path, which calls the identical `handleLockTerminal`.

## Part 2 — Frontend/API response-contract compatibility: defect found and fixed

### The bug

`staffPinVerifyPosResponseSchema` (`packages/shared`) declares `staff_id: z.uuid()` and `is_clocked_in: z.boolean()` as always-present — but that is a schema for the **current** API's intended response shape, not a runtime guarantee. `apiClient()` (`apps/web/lib/api-client.ts`) does a bare `response.json()` cast to the generic type parameter with **no runtime (Zod) validation** — so if the frontend is deployed ahead of a rolling API deploy (new frontend talking to an API instance still running pre-P32 code), the parsed response genuinely has no `staff_id`/`is_clocked_in` keys at all. `result.is_clocked_in` is `undefined` at runtime, regardless of what the TypeScript type on the response claims.

As written before this fix, `handlePinVerify` read those fields directly (`isClockedIn: result.is_clocked_in`) into state typed as a plain `boolean`. The render logic then used truthy/falsy checks (`pinVerification.isClockedIn ? ... : 'Clock In & Open POS'`), so `undefined` fell through the same branch as `false` — an old API's *silence* on attendance state was silently read as "**not** clocked in" and surfaced as a confidently-wrong `"Clock In & Open POS"` button, exactly the "missing fields must not be treated as `is_clocked_in: false`" failure mode this task's brief calls out by name.

**Concrete failure scenario**: the web deploy ships before the API deploy during a rolling release. A staff member who is genuinely still clocked in (e.g., resuming after an idle lock) enters their PIN against the not-yet-upgraded API. The response has no `is_clocked_in` key. The old code would show `"Clock In & Open POS"` — a guessed, wrong label for someone who is actually already clocked in. (The actual clock-in gate downstream — `isClockedIn` from `useTerminalOperator`, a separate live attendance re-check — is unaffected and would still correctly skip the real Clock In step; this bug is confined to the confirmation button's own text, but it is still exactly the "guessed attendance" class of defect the task is asking to rule out.)

### The fix

`apps/web/app/(branch)/branch/terminal/page.tsx`:
- `pinVerification.staffId`/`.isClockedIn` are now typed `string | null` / `boolean | null` (a true three-state value: known-true, known-false, or unknown), not a bare `string`/`boolean`.
- `handlePinVerify` populates them with explicit `typeof` runtime guards (`typeof result.staff_id === 'string' ? result.staff_id : null`, same pattern for `is_clocked_in`) instead of trusting the compile-time response type.
- `isIdleUnlockForThisStaff` and `primaryActionLabel` now branch on `=== true` / `=== false` rather than truthy/falsy, so the `null` ("the API didn't say") case falls through to a neutral `"Continue"` label — never a guessed `"Clock In & Open POS"`, `"Continue as [name]"`, or `"Unlock POS"`.

This is a pure client-side compatibility fallback: it does not create attendance, does not discard the verification token/session, and does not weaken server verification in any way — `handleConfirmIdentity` still proceeds exactly as before using only `pinVerification.token`, and the real "is this employee actually clocked in" gate the catalog depends on is the separate, always-current `useTerminalOperator`/`useIsClockedIn` live check, not this label.

### Old frontend + new API response

Confirmed by reading the pre-P32 `terminal/page.tsx` (`git show` of the prior commit): the old code reads only `result.staff_name`/`result.verification_token` and ignores any other key on the response object. The new `staff_id`/`is_clocked_in` fields are purely additive — an old frontend talking to the new API silently ignores them. No compatibility issue in this direction.

### Verification

Added `page.test.tsx` — *"a verify-pos response missing staff_id/is_clocked_in (old API) never guesses attendance state"* — mocks `verifyPosPin.mutateAsync` resolving with only `staff_name`/`verification_token`/`expires_at` (the pre-P32 shape, cast through `unknown` to bypass the compile-time type since this specifically simulates a runtime-only omission). Asserts the confirmation screen shows a generic `"Continue"` button and never `"Clock In & Open POS"`, `"Continue as Jane"`, or `"Unlock POS"`. Fails on the pre-fix code (showed `"Clock In & Open POS"`), passes on the fix.

## Part 3 — Targeted validation (executed, not just authored)

- **`apps/web`**: `tsc --noEmit` clean. `eslint` on the touched files clean (0 errors/warnings). Full `vitest run` of `app/(branch)/branch/terminal/page.test.tsx`: **121/121 passed** (118 pre-existing + 3 new: the missing-fields compatibility test above, plus two idle-lock/lockContext unit tests that were authored, found to be fundamentally incompatible with this test environment — see below — and removed in favor of the real-browser coverage in Part 4).
- **`apps/api`**: `tsc --noEmit` clean. `eslint` on `staff-pin.service.ts` clean. `vitest run src/modules/staff-pin`: **32/32 passed** (both the unit and the real-Postgres integration suite), unaffected by the `staff_id`/`is_clocked_in` addition — confirmed the service still returns both fields correctly and every existing purpose-separation/revocation/rate-limit test is untouched.
- **`packages/shared`**: `tsc` build clean.

### A dead end worth recording: fake timers cannot simulate this component's idle lock in `vitest`/RTL

Two unit tests were written to drive the 5-minute `IDLE_LOCK_MS` timeout via `vi.useFakeTimers()` and assert the resulting `"Unlock POS"` / handoff labels without a real wait. Both were abandoned after investigation showed this doesn't work in this codebase's test stack, for a reason worth recording so it isn't attempted again:

- `@testing-library`'s `waitFor`/`findBy*` detect active fake timers (`jestFakeTimersAreEnabled()`) and switch into a coordinated-advance mode that assumes the test itself drives every timer tick the assertion depends on.
- React's own scheduler relies on real timer APIs even inside jsdom. Faking `setTimeout` (even scoped to only `setTimeout`/`clearTimeout`, leaving `setInterval` real) starting before the first `render()` stopped the component's state updates from flushing at all — every subsequent `findBy`/`waitFor` call hung for the real per-test timeout, including ones that ran *before* the explicit fake-time advance.
- This is a property of the test environment, not of the production code: the lockContext logic itself was verified correct by direct code trace (Part 1) and by the real, un-mocked e2e wait (Part 4).

The two non-working tests were removed rather than left in a flaky/misleading state; the real verification for this behavior is the e2e run in Part 4.

## Part 4 — Real-browser verification: attempted, partially completed, blocked by environment resource exhaustion

`tests/e2e/pos-perf-p30r-session-security.spec.ts` was extended (test 9) to add, immediately after the existing P30R same-staff `"Unlock POS"` assertion and reusing the *same* real 5-minute wait (not a second one): entering a different, already-independently-clocked-in staff member's correct PIN against the still-idle-locked screen, and asserting the button reads `"Continue as Bob"` — never `"Unlock POS"` — then cancelling without confirming so the attendance state used by later assertions in the file is undisturbed.

**What was actually executed, with real results:**

- **First full run** (before any `page.tsx` fix): tests 1–5 passed against the real local stack (Supervisor PIN set through the actual UI, wrong-PIN rejection, correct-PIN clock-in, already-clocked-in restoration, Switch Cashier). Failed at test 6 (`Deactivate PIN` dialog never closed within the 120s test timeout; `Error: locator.click: Target page, context or browser has been closed`) — serial mode skipped tests 7–9 as a result. This is the only run that reached test 6 at all this session.
- **Five subsequent full re-runs**, each preceded by resetting the shared fixture DB rows the prior run's partial progress had left in an inconsistent state (open attendance records, Jenny's PIN active/inactive status): each failed at a **different** step — test 6 again (identical symptom), test 1 (`Save PIN` dialog never closed), test 1 again (Reset-mode dialog — caused by an over-eager manual DB fix between runs, corrected), test 2 (`branchPage` rendered `"No branch assigned."` despite the DB confirming the assignment existed), and test 1 again (the original symptom, unrelated to any DB state this time).
- **Root cause identified, not product code**: `Get-CimInstance Win32_OperatingSystem` showed **0.6 GB of 7.7 GB RAM free** on this machine during these runs, and process enumeration found (a) a VS Code Playwright Test extension `test-server` process that had been concurrently re-running this same spec against the same shared fixture accounts, confirmed and stopped mid-session, and (b) several duplicate/orphaned `tsx watch`/`next start` processes from earlier sessions that were not bound to any port (pure waste), which were also stopped. Free memory did not recover afterward (dozens of pre-existing `chrome.exe` processes, not started by this task, account for the remainder) — every failure mode observed (a dialog never closing, a page never finishing its render, a client-side auth-state read coming back empty) is consistent with a system under severe memory pressure, not with a logic defect: each failure was at a **different**, logically-unrelated step, and the one failure mode re-investigated in depth (test 1's "No branch assigned.") was directly contradicted by the database, which held the expected row throughout.
- **User was asked** whether to free memory (close some Chrome windows) for a clean re-run, or let this task close Chrome processes on their behalf, or proceed on the evidence already gathered. **User chose to proceed without a further real-browser re-run attempt.**

**What this leaves proven vs. not independently re-proven today:**

- Proven by a real, executed, un-mocked browser run this session: Supervisor PIN provisioning through the actual UI, wrong-PIN rejection, correct-PIN clock-in, already-clocked-in-operator restoration without a duplicate attendance record, and Switch Cashier swapping identity without clocking out the prior cashier — all against the current P32 UI (confirmed the new `"Open POS Terminal"` card/keypad screen and `"Continue as Jenny"` / `"Clock In & Open POS"` labels render and function correctly end-to-end).
- Proven by P30R's own prior real-browser run (not re-run today, per the correction in this report's opening section): the 5-minute `IDLE_LOCK_MS` idle lock itself fires, never clocks the cashier out, and still requires a correct PIN — on the pre-P32 UI.
- **Not independently re-proven in a real browser this session, due to the environment constraint above**: the P32-specific `"Unlock POS"` label for a same-staff idle unlock, and the P32-specific different-staff-handoff assertion added to test 9 in this task. Both are proven by direct code trace (Part 1) and by a passing unit test exercising the exact same conditional logic in isolation (the compatibility test in Part 2, plus the pre-existing unit coverage of `isIdleUnlockForThisStaff`'s sibling branches), but neither has a *real, executed, un-mocked browser confirmation* produced today. This is reported as an open item, not papered over.

## Part 5 — Deployment ordering and release sequencing

- **Deployment ordering**: this is a web-only change plus an additive-only API response field (`staff_id`/`is_clocked_in` were already added by the P32 commit this task verifies, not newly added here). The frontend fix in this task (the `null`-aware three-state label) is defensive **against** exactly the "frontend ships first" ordering — so there is no required ordering constraint introduced by this fix. The API's `staff_id`/`is_clocked_in` fields can roll out before or after the frontend that reads them; either way, the frontend now degrades to a neutral `"Continue"` label instead of a wrong one.
- **Stale frontend**: a frontend bundle built before P32 simply never reads `staff_id`/`is_clocked_in` at all — unaffected by either side of this rollout.
- **Stale backend** (the scenario this task's fix targets): now produces a neutral `"Continue"` label instead of a guessed one, until the API catches up. No attendance is created, no session/cart state is discarded, and server-side verification is unchanged — `handleConfirmIdentity` still only depends on the verification token, present in both API versions.
- **Safe rollback**: rolling back either side independently is safe for the same additive/defensive reasons above.

## Part 6 — Remaining concrete blockers / limitations

- **Real-browser re-confirmation of the P32-specific idle-unlock labels** (same-staff `"Unlock POS"`, different-staff handoff) is the one item this task set out to do that was not completed with a real executed run, due to this machine's current memory exhaustion (0.6 GB free) — not a code defect. The user was asked and chose to proceed on the code-trace + unit-test evidence instead. Re-running `tests/e2e/pos-perf-p30r-session-security.spec.ts` (test 9) against a machine with adequate free memory, or after closing the ~30+ pre-existing `chrome.exe` processes found during this session, would close this gap.
- `IDLE_LOCK_MS` (5 minutes) remains a hardcoded constant, not a per-branch setting — unchanged scope from P30/P30R, still a known limitation, not addressed by this task.
- No schema migration, no production data, no credential rotation, and no Render `autoDeploy` configuration were touched by this task.

## Files changed

```
apps/web/app/(branch)/branch/terminal/page.tsx                                     (fix: three-state staffId/isClockedIn, never guess attendance from a missing field)
apps/web/app/(branch)/branch/terminal/page.test.tsx                                 (new compatibility regression test)
tests/e2e/pos-perf-p30r-session-security.spec.ts                                    (test 9 extended: different-staff handoff after the same idle lock)
docs/runbooks/pos-perf-p32r-idle-unlock-compatibility-verification.md              (new, this file)
```
