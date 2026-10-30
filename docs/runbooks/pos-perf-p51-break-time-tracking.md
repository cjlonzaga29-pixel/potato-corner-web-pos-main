# POS-PERF-P51 — Staff break-time tracking (POS lock + attendance)

Goal: a cashier can start a break without ending their shift, another cashier can use the terminal meanwhile, and the
first cashier resumes with their own PIN. Work and break durations are recorded from server timestamps for the later
payroll task.

Out of scope (unchanged): wages, paid/unpaid break policy, statutory deductions, payroll totals, dashboard redesign,
deployment workflows.

## 1. Audit of what already existed (base `cd0004b`)

| Concern | Existing mechanism (reused, not rebuilt) |
| --- | --- |
| PIN → cashier | `POST /staff-pin/branches/:id/verify-pos` (Branch Account only, rate-limited) resolves a PIN to one staff member and mints a single-use `pos` verification token. `POST /auth/select-employee` consumes it and mints a 15-minute staff JWT. The terminal keeps that token in memory, never in the global auth store. |
| Token refresh | `POST /auth/refresh-employee-session` re-mints without a PIN, but only while the employee has an open attendance record at that branch. |
| Clock in / out | `attendance_records`: one open row per employee, enforced by a per-employee advisory lock (`attendanceOpenSessionLockId`). Clock-in also auto-opens the branch's hidden shift; clock-out auto-closes it. `break_minutes` existed but was only a client-supplied number sent at clock-out (or set by a supervisor correction). |
| Selling gate | `shiftGuard` (checkout, offline batch sync, hold orders, payment/discount proof uploads): the token's user must have an open record at the branch. |
| Lock / Switch Cashier | Terminal-local only: clears the selected employee and token, returns to the PIN screen, refuses with a non-empty cart. Idle lock does the same. Never touches attendance. |
| Restore after refresh | `useTerminalOperator` restores a sessionStorage hint only after re-reading live attendance. |
| Pending sales | Detached sales (localStorage, keyed by idempotency key; retried under the **current** operator's token) and offline queue rows (IndexedDB; synced only under the token of the cashier who rang them, P46R3). The server records the submitting token's user as `cashier_id`. |
| Supervisor views | P47 Attendance Overview (`/attendance/branch/:id/summary`), branch attendance list, admin cross-branch list (P40). Corrections go through `POST /attendance/override` (supervisor/admin, audited, correction row + soft-deleted original). |

## 2. Attendance states and transitions

Attendance state is separate from browser login, socket presence and terminal lock:

| State | Meaning |
| --- | --- |
| **Working** | Open attendance record, no open break. May sell. |
| **On Break** | Open attendance record **and** one open break interval. The shift is still open. Cannot sell. |
| **Clocked Out** | Record closed. |

```
            Clock In                 Start Break (own token)
 Clocked Out ────────► Working ───────────────────────────► On Break
     ▲                  │  ▲                                  │   │
     │    Clock Out     │  └────── Resume Work (own PIN) ─────┘   │
     └──────────────────┘                                         │
     ▲                                                            │
     └──── Clock Out (own PIN, from the locked screen) ───────────┘
           closes the break and the record at the same timestamp
```

Terminal lock is a different axis: Switch Cashier and idle lock only lock (the cashier stays **Working**). Start Break
records the break **and then** locks. A locked terminal can be unlocked by any clocked-in employee of the branch.

## 3. Data model and migration

Migration `20261030170000_pos_perf_p51_attendance_breaks` is additive only: a new enum `AttendanceBreakEndReason`
(`resumed`, `clock_out`) and a new table `attendance_breaks`:

| Column | Notes |
| --- | --- |
| `attendance_record_id` | FK → `attendance_records` (cascade). Breaks belong to one shift record. |
| `started_at`, `ended_at` | Server timestamps. `ended_at` NULL = open. |
| `started_by`, `ended_by` | The authenticated actor's user id (the employee's own session; for a supervisor-initiated clock-out, the supervisor). |
| `end_reason` | `resumed` or `clock_out`. |

Database-enforced guarantees: partial unique index `attendance_breaks_one_open_per_record` (at most one open break
per record), check `ended_at >= started_at`, check "an end time exactly when there is an end reason". No existing
table, column or row is changed; no break rows are created for history.

`attendance_records.break_minutes` keeps its meaning (total break minutes of a closed record). At clock-out:

- record **with** intervals → `break_minutes` = Σ intervals (rounded to the minute), `actual_work_minutes` =
  elapsed − break, overtime as before. A client-sent `break_minutes` is ignored.
- record **without** intervals (every pre-P51 record, or a legacy client) → unchanged pre-P51 arithmetic.

## 4. API

| Endpoint | Who | Behaviour |
| --- | --- | --- |
| `POST /api/attendance/break/start` `{branch_id}` | staff token only (`staffOnly`), active employee, `branchGuard` | Acts on the token's own user — there is no `employee_id`; an injected one is ignored. 201 with the record (`attendance_state: on_break`). 409 `ALREADY_ON_BREAK` (details: existing break), 409 `NOT_CLOCKED_IN`. |
| `POST /api/attendance/break/end` `{branch_id}` | same | Closes the open break (`resumed`). 200 (`working`). 409 `NOT_ON_BREAK`, 409 `NOT_CLOCKED_IN`. |
| `POST /api/attendance/clock-out` | unchanged roles | Now under the per-employee lock; an open break is closed at the **same** timestamp (`clock_out`) in the same transaction. A second concurrent clock-out gets 404 instead of overwriting the first. |
| `GET /api/attendance/...` (employee, branch, admin lists) | unchanged | Each record now also carries `attendance_state`, `current_break_started_at`, `breaks[]`, `elapsed_break_seconds`, `elapsed_work_seconds` (server-computed; an open record counts up to "now"). |
| `GET /api/attendance/branch/:id/summary` | unchanged (supervisor/admin, `branchGuard`) | `clocked_in` still lists everyone with an open record (so it keeps matching the Staff Clocked In KPI); each row now has `attendance_state` / `break_started_at`, plus `on_break_count`. |
| `POST /api/staff-pin/branches/:id/verify-pos` | unchanged | Adds `attendance_state` and `break_started_at`. `is_clocked_in` stays `true` on break. |
| `POST /api/auth/select-employee` | unchanged | New optional `allow_on_break`. Without it, an employee on break gets 409 `EMPLOYEE_ON_BREAK`. |
| `POST /api/auth/refresh-employee-session` | unchanged | 409 `EMPLOYEE_ON_BREAK` while on break (no silent re-mint). |
| `shiftGuard` | — | 403 `ON_BREAK` for an on-break employee: checkout, offline batch sync, hold orders, payment/discount proof uploads. |

Events: `attendance:break_started`, `attendance:break_ended` (branch room and super admin). A clock-out that closes a
break emits `attendance:clocked_out` only. Audit actions: `ATTENDANCE_BREAK_STARTED`, `ATTENDANCE_BREAK_ENDED`.

## 5. Authorization, timestamps and retry rules

- **Only the employee's own PIN can end their break.** Resume Work is only offered after `verify-pos` resolves the
  entered PIN to that employee; `select-employee` mints *their* token; `/break/end` acts only on the token's user.
  Another employee's PIN resolves to that other employee, which is a normal handoff ("Continue as …").
- **A cashier on break cannot sell**, whatever the client: `shiftGuard` checks the open break on every request, so a
  token minted before the break (still inside its 15-minute TTL), a stale tab or a direct API call all get
  `ON_BREAK`. `refresh-employee-session` refuses too.
- **Timestamps** are the API server's clock only. A new break never starts before the previous one ended or before
  clock-in, and an end never precedes its start (guards against clock differences between API instances). Device
  time is never used. Durations are differences of absolute instants, so overnight shifts and breaks across Manila
  midnight need no special handling. The Manila business timezone only decides "which business day" in summaries.
- **Repeats and concurrency:** every write (start, end, clock-out) takes the per-employee advisory lock and re-reads
  inside the transaction. A repeated Start Break gets `ALREADY_ON_BREAK`, a repeated Resume gets `NOT_ON_BREAK`;
  neither writes anything. The partial unique index is the second line of defence.
- **Lost responses:** the terminal never retries blindly. Any non-success (no connection, lost response, server
  error, `ALREADY_ON_BREAK`/`NOT_ON_BREAK`) is settled by reading the employee's current attendance state:
  Start Break is treated as started only if the server says `on_break`; Resume only if it says `working`.
  Otherwise the UI says the action was **not** confirmed.
- **Offline:** Start Break, Resume Work and Clock Out-from-break all require the server. Offline, the terminal says so
  and sends nothing; no timestamp is invented or queued.

## 6. Terminal behaviour (web)

- **Start Break** (cashier strip, next to Switch Cashier and Clock Out; Branch Account terminals). Refused with a
  non-empty cart, a sale on screen or in flight, or offline. On server confirmation the terminal locks ("Locked for a
  break — shift still open"); on failure the cashier stays on the selling screen with "Break not started".
- **Locked screen:** a PIN belonging to someone on break shows "On break since h:mm · shift still open" with
  **Resume Work** and **Clock Out (end shift)**. Resume Work: select-employee (`allow_on_break`) → `/break/end` →
  only then does the employee become the operator (same record, same shift, no second clock-in). If the end cannot be
  confirmed, the minted token is dropped and the terminal stays locked.
- **Switch Cashier** and idle lock: unchanged — lock only, never a break, never a clock-out.
- **Refresh / another device:** a persisted operator who is on break is never restored; if the server reports the
  active operator on break (started elsewhere), the terminal locks.
- **States shown:** selling screen badge "Working"; locked-screen status "Working" / "On Break since …" / "Not
  clocked in yet"; supervisor overview tiles "Clocked in now" / "On break" / "Clocked out today" with an "On break
  since …" badge per row; branch and admin attendance tables show "On Break since …" in the Clock Out column and the
  live break total in the Break column.

### Pending and queued sales — supported rule

- A break never discards or reassigns anything: the cart must be empty to start one; detached and offline-queued
  sales stay on the device with their original cashier and idempotency/offline identities.
- **Offline queue:** rows sync only under the token of the cashier who rang them (P46R3). While that cashier is on
  break the server refuses the batch with `ON_BREAK` and the rows stay queued (retryable, not rejected); they sync once
  that cashier resumes. An older queued sale is therefore *not* treated as a new sale while on break — it simply waits.
  If the cashier clocks out instead, their queued rows wait for their next shift (same as clocking out before P51).
- **Detached sales:** new entries record the submitting cashier. Recheck (read-only) stays open to anyone; a Retry that
  would resubmit the payload is refused for a different cashier ("Only the cashier who rang this order can retry
  it"), because the server would otherwise record the retrying cashier. Entries written before P51 have no recorded
  cashier and keep the old behaviour.

## 7. Corrections

No new correction endpoint. The existing audited `POST /attendance/override` (supervisor/admin) still corrects
`break_minutes` and times on a closed record; the intervals stay on the original (soft-deleted) row as history.
Correcting a record whose break is still open is refused (`BREAK_IN_PROGRESS`): end the break (Resume Work) or clock
the employee out first — a supervisor/branch clock-out of an on-break employee closes the break at the same timestamp.
For payroll: a corrected record has no intervals of its own; use its `break_minutes`.

## 8. Compatibility and deployment

Deployment order is unchanged: migration → API → web. The migration is additive and safe to run before the new API.

| Combination | Behaviour |
| --- | --- |
| New API, old web (API-first window) | Old terminals have no Start Break, so nobody can be on break unless a new terminal started it. Extra response fields are ignored. Old clock-out with `break_minutes` → honoured for records without intervals. **An old terminal trying to unlock an employee who is on break** gets `EMPLOYEE_ON_BREAK` ("Ana is on break. Resume work on a terminal with the latest POS update.") instead of a selling screen; even a forced token cannot sell (`ON_BREAK`). Old terminals cannot clock out an on-break employee via the PIN screen; a new terminal, or a supervisor clock-out, can. |
| New web, old API (rollback) | `verify-pos` has no `attendance_state` → the locked screen behaves as before (no Resume Work). Start Break → 404 → "The server did not confirm the break, so it has NOT started"; the terminal stays unlocked. `allow_on_break` is stripped by the old API. |
| Old API, new schema | The old API never reads `attendance_breaks`; fine. |
| New API, old schema | **Not supported** — the API reads `attendance_breaks`. Keep migrate-before-API. |
| Rollback after breaks were recorded | An old API ignores open breaks: an on-break employee would be treated as working. Before rolling the API back, end open breaks (`SELECT … FROM attendance_breaks WHERE ended_at IS NULL`). |

## 9. Verification

Databases: two new, uniquely named, guarded **local** databases, refused unless every URL was `127.0.0.1` **and** the
name matched `p51_<digits>`. (1) `p51_10301700` on the local Docker Postgres (`127.0.0.1:5432`, own role
`p51_break_user`), used for the migration rehearsal and the first integration runs. (2) `p51_10301800` on an
embedded Postgres (`127.0.0.1:55951`, own data dir), used for everything after Docker Desktop's engine began returning
HTTP 500 mid-session; Docker was not restarted because the other session shares it. Throwaway secrets. Ports: API
4551, web 3551. Production, `pos_verify` and other sessions' databases were never touched; no smoke accounts were
provisioned; no terminal queues were cleared. Fixtures: repo seed + `seed-pos-demo-inventory` +
`scripts/p51-break-fixtures.ts` (2 branches, branch accounts, a supervisor scoped to North only, staff Ana/Ben at
North and Carl at South with PINs, attendance history); `seed-discount-audit-fixtures` for sales history in (1).

| Check | Result |
| --- | --- |
| Migration rehearsal on populated data (DB 1) | Base migrations deployed, then populated: 5 attendance rows (closed day shift with legacy 60 break minutes, closed overnight shift, open shift, a correction plus its soft-deleted original), 1 active shift, 9 sales/9 items, stock. Row count **and** content MD5 of all 72 tables taken before and after `migrate deploy` of the P51 migration → **identical**; the only difference is the new empty `attendance_breaks`. `prisma migrate diff` (local DB → `schema.prisma`) → empty. Partial unique index and both check constraints present. |
| API full suite (serial) | 183 files passed / 19 skipped; 3,157 tests passed / 279 skipped, 0 failed |
| API `TEST_DATABASE_URL`-gated suites (checkout worker, transactions, option requirements, builder recipe match, P49 promotions, P50 tax) against DB 2 | 6 files, 85 / 85 |
| P51 integration (`attendance-breaks.integration.test.ts`, real Postgres) | 10 / 10 |
| P51 unit (`attendance-breaks.service.test.ts`, router, auth, shiftGuard) | all pass (included above) |
| Web full suite | 165 files, 1,526 / 1,526 (after one test-isolation fix, below) |
| `turbo run type-check lint --force` | 7 / 7 tasks, 0 errors (308 pre-existing `no-console` warnings in API scripts, same as P50) |
| API `tsc` build, web `next build` | pass |
| Live HTTP against the built API | 38 / 38 |
| Real browser (Chromium, built web) | 14 / 14 (desktop 1440×900, tablet 820×1180, phone 390×844, keyboard-only) |

Integration coverage (real Postgres): 10 concurrent Start Break → exactly 1 interval, 9 × `ALREADY_ON_BREAK`; a second
open break inserted directly → refused by the partial unique index; an interval ending before it starts, or an end
without a reason → refused by the checks; 10 concurrent Resume → ended exactly once, 9 × `NOT_ON_BREAK`, same record,
no new clock-in; three start/resume cycles → ordered, non-overlapping; clock-out during a break → break `clock_out` at
exactly the clock-out timestamp; Start Break racing Clock Out (5 rounds) → never an open break on a closed record; two
concurrent clock-outs → one succeeds, the other 404 (no overwrite); `shiftGuard` → `ON_BREAK`, then allowed after
Resume; Start Break at another branch refused; branch summaries isolated per branch.

Unit coverage adds: server-side accounting (open / on-break / closed / overnight with a break across Manila midnight /
legacy `break_minutes` fallback), the not-before-previous-break timestamp guard, a client `break_minutes` ignored when
intervals exist, overnight clock-out minutes (9 h − 45 min → 495 worked, 15 OT at 8 h), correction refused with an open
break, summary on-break marking, `select-employee` / `refresh-employee-session` gates, the break routes refusing
branch/supervisor/admin tokens, another branch and a missing `branch_id`, and ignoring an injected `employee_id`. Web:
break lib (lost response settled by a state read, never a second POST; failure never reported as success; old API),
operator hook (an on-break operator is never restored, and locks if found on break), terminal page (confirm-then-lock,
failure keeps the selling screen, cart/offline refusals, Resume recorded before becoming operator, unconfirmed Resume
keeps the lock and drops the token, another PIN = normal handoff, Switch Cashier never starts a break), overview panel.

Live HTTP (built API, DB 2): verify-pos states (`clocked_out` → `on_break` with `break_started_at`); clock-in; sale
while Working 201; Start Break 201 on the same record, repeat 409, 6 concurrent 409, still one interval; stale token
checkout 403 `ON_BREAK`; offline batch sync 403 `ON_BREAK`; refresh-employee-session 409 `EMPLOYEE_ON_BREAK`; old-web
select-employee 409 `EMPLOYEE_ON_BREAK` with "Ana is on break. Resume work on a terminal with the latest POS update.";
Ben's PIN → Ben; Ben clocks in and sells 201 while Ana is on break; Ben's token on `/break/end` → 409 (acts on Ben) and
Ana's break untouched; Branch Account token → 403; Ben's token with a forged `employee_id` = Ana starts **Ben's** break;
another branch → 403; supervisor summary Ana `on_break`, Ben `working`, `on_break_count` 1; supervisor reading South →
403; South branch account reading a North employee → 403; `allow_on_break` token minted but still 403 `ON_BREAK` for
checkout before Resume; Resume 200 on the same record; retried Resume 409 and the state read shows one `resumed` interval
and no second clock-in; separate work/break seconds; Ana sells again 201; clock-out during a second break → that break
`clock_out` with `ended_at` = `clock_out_server_time`, a client `break_minutes: 999` ignored; repeat clock-out 404;
Start Break after clock-out 409; sales attributed to Ana and Ben respectively.

Browser (built web): D1 desktop Ana PIN → Clock In → "Working" + Start Break; D2 Start Break with an item in the cart →
"Finish or clear the current cart before starting a break.", cart kept, still selling; D3 Start Break → "Locked for a
break — shift still open"; D4 refresh while on break → PIN screen, not her selling screen; D5 Ben's PIN → Continue as
Ben (no Resume Work offered) → selling; S1 supervisor dashboard → "On break since …" and On break tile 1; T1 tablet
(another device) Ana's PIN → "On break since … · shift still open", Resume Work, Clock Out (end shift), no horizontal
overflow; T2 Resume Work → selling as Ana, no Clock In prompt; T3 tablet refresh → still Ana, Working; P1 second break;
P2 phone, keyboard only (type PIN + Enter, Tab to Clock Out (end shift), Enter) → "break and shift ended", no overflow;
P3 Ana's PIN → "Not clocked in yet"; S2 supervisor → On break 0, Ana under Clocked out today; D6 desktop still selling
as Ben throughout.

Issues found during verification:
- `records.map(toResponse)` would have passed the array index as "now" — caught by `tsc`, fixed before any run.
- The terminal page used `useQueryClient()` directly, which breaks the page tests' "mock every query hook" rule; moved
  into `useAttendanceCache()` in `use-attendance.ts`.
- Test isolation: the P51 cart test asserted `clearCart` was never called while earlier tests' calls were still recorded;
  the describe block now clears that mock.
- Environment, not code: Prisma needed `sslmode=disable` against the Docker Postgres; under 100% host CPU (shared
  machine) connections timed out at Prisma's default 5 s, and Docker Desktop's engine later returned HTTP 500 — hence
  the move to an embedded Postgres. Some timing-only failures under that load: one existing terminal test
  (`bounded backlog`, passes in 9.8 s with a longer timeout) and browser D2's first attempt (45 s wait timed out;
  passed on re-run). The full web run used `--testTimeout=30000`.

Not verified: a real device/PWA; Socket.io-driven live refresh of the supervisor panel (it was checked by reload, and
it also polls every 60 s); the old web build itself against the new API — old-client behaviour was exercised by sending
exactly what the old client sends (no `allow_on_break`, `break_minutes` at clock-out) and by the unit tests for missing
response fields.

## 10. Integration notes

- Base: `cd0004b1a722e8042482cbe22e66c91ae1bd6bde` (`feat(pos-perf-p50)`), branch `feat/pos-perf-p51-break-time-tracking`,
  worktree `C:/Users/kaile/Downloads/pc-p51-break-worktree`. Final SHA: see the commit that adds this file.
- Likely overlap with the P50R session's uncommitted work (read-only comparison of file lists, no content read):
  `apps/api/prisma/schema.prisma` (both append models — expect a trivial merge), `apps/web/app/(branch)/branch/terminal/page.tsx`
  and `page.test.tsx` (P51 touches the PIN/lock/cashier-strip areas and adds one describe block at the end),
  `packages/shared/src/types/index.ts` (both append exports). P50R also adds migration `20261030160000_…`; P51's
  `20261030170000_…` sorts after it, and neither touches the other's tables. P50R edits `transactions.router.ts`; P51
  edits only `transactions.router.test.ts` (mock of the attendance repository).
- Payroll (next task) should read `attendance_breaks` intervals for records that have them and `break_minutes` for
  records that don't (pre-P51 history, corrections), and decide paid/unpaid policy there.
