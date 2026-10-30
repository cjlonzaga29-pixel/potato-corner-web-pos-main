# POS-PERF-P54 — Integrating P52 (payroll) with P53 (discounts + breaks)

Local integration only. Nothing in this branch was merged into `main`, pushed or deployed, and no production
migration, reconciliation SQL or data change was run.

## 1. Branch, worktree and SHAs

| | |
| --- | --- |
| Integration branch | `feat/pos-perf-p54-payroll-discounts-breaks-integration` |
| Worktree | `C:/Users/kaile/Downloads/pc-p54-integration-worktree` |
| Base (P53 tip, verified) | `3a68bca5bfec3e1fedc2a4e88c7db9580c4c03b1` (`feat/pos-perf-p53-discounts-breaks-integration`; contains `089a164` merge, `43b59ee`, `0ea1b19`, `9dab82d`, and the later tablet fix `3a68bca`) |
| Merged in (P52) | `ff41706906454c03287e48093e9db76924b9ddaf` (`feat/pos-perf-p52-payroll`) |
| Common ancestor | `ac0f1b0` (P51) — the merge brings in only `ff41706` |
| `origin/main` (deployed baseline) | `7084291f25c301c5e9b4f28ed529eda88838f550` (local tracking ref; not fetched) |
| Merge commit | `ddb9b80` — parents `3a68bca` + `ff41706` |
| Integration fixes | `41dd52c` (§3) |
| Final SHA | the commit that adds this runbook (reported in the P54 handoff) |

The P51, P52 and P53 branches and their worktrees, local `main` (`ea9f0f4`, 5 ahead of `origin/main`) and the
remote were not modified. `3a68bca` (after the P53 runbook commit `9dab82d`) was inspected before use: it only keeps
an open two-pane checkout two-pane when the viewport shrinks, plus tests and a P53 runbook update.

## 2. Merge and conflict review

No textual conflicts. Only `apps/api/prisma/schema.prisma` was changed on both sides since `ac0f1b0`.

| File | Outcome | Review |
| --- | --- | --- |
| `apps/api/prisma/schema.prisma` | Auto-merged | Merged file = P53's schema + exactly P52's additions (`User.payRates/payrollRunLines/payrollAdjustments`, `Branch.payrollPolicies/payRates/payrollRuns`, `AttendanceRecord.payrollClaims`, 4 enums, 7 models). Every P50R (`PromotionApplicationMode`, `tax_snapshot`, column re-alignment), P51 (`AttendanceBreak`, `AttendanceBreakEndReason`, `AttendanceRecord.breaks`, partial unique index) and P52 field, relation, index and constraint is present. `prisma migrate diff` (migrated DB → schema): empty. |
| `apps/api/src/app.ts`, `lib/pg-lock.ts`, `packages/shared/src/schemas/index.ts`, admin/supervisor `reports/page.tsx` | P52 only | Unchanged on the P53 side; additive (router, two lock helpers, one export, section tabs). |
| Payroll ↔ P50R | Semantic check | Payroll's only P53-side dependency is `settingsService.getRegularShiftMinutes` / branch work hours, unchanged by P50R. P50R renamed one sidebar label; payroll is reached via Reports → Payroll tab. |
| Payroll ↔ P51 | Semantic check | No attendance/break code changed on the P53 side. Found two integration defects (§3). |

## 3. Defects found and fixed (`41dd52c`)

1. **A corrected "forgot to clock out" record lost its recorded breaks (payroll overpaid).**
   `break_minutes` is only written at clock-out. A supervisor correction (`/attendance/override`) of a record that
   was still open copied `original.breakMinutes` = 0, and the correction row has no intervals of its own, so P52 took
   the "no break" path and paid a resumed P51 break as work — with no warning. The correction dialog never sends
   `break_minutes`, so this is the normal correction path. Fix (`attendance.service.ts`): when the correction does
   not set break minutes and the original has recorded intervals, carry their total clipped to the corrected shift
   (an explicit `break_minutes` still wins; records without intervals keep their stored value). Payroll then shows
   the correction as "Legacy break total" + "corrected" for the reviewer, per the P52 rules.
   Tests: `p54-payroll-breaks.integration.test.ts` (real P51 services → real payroll: 9 h shift, 1 h break, corrected
   → 8 h payable) and 3 unit tests in `attendance-breaks.service.test.ts`; both fail without the fix.
2. **Concurrent payroll reviewers could time out instead of getting 409.**
   `finalize`, `addAdjustment` and `addResolution` hold the branch advisory lock inside a transaction, but
   `computeRun` read regular work hours through the global client — a second pooled connection. With several
   reviewers at once, the waiters each hold a connection, the lock holder cannot get one and fails with Prisma
   `P2024` after the pool timeout. Seen first in the full API run (P52's own concurrent-finalize test, 9-connection
   pool) and reproduced deterministically with `connection_limit=3`. In production the Transaction Pooler URL's
   `connection_limit` makes the pool small, so this is reachable. Fix (`payroll.service.ts`): read regular hours
   before opening the transaction and pass them in; nothing under the lock uses a second connection.
   Test: `payroll-pool.integration.test.ts` (pool capped at 2 for that file: 5 concurrent resolution notes → 1 ok +
   4 `ISSUE_ALREADY_RESOLVED`; 6 concurrent finalizations → 1 ok + 5 `RUN_NOT_DRAFT`); fails without the fix.

No tax, contribution or overtime-pay calculation was added. Payroll still only flags possible overtime/night hours.

## 4. Combined migrations

Pending against `origin/main` — exactly five, in this order; none previously applied migration was edited
(`git diff 7084291 HEAD -- prisma/migrations` shows additions only):

| # | Migration | Source |
| --- | --- | --- |
| 1 | `20261030120000_pos_perf_p49_promotions` | P49 |
| 2 | `20261030120100_pos_perf_p49_classification_backfill` | P49 |
| 3 | `20261030160000_pos_perf_p50r_branch_discounts` | P50R |
| 4 | `20261030170000_pos_perf_p51_attendance_breaks` | P51 |
| 5 | `20261030190000_pos_perf_p52_payroll` | P52 (4 enums, 7 tables, FKs `ON DELETE RESTRICT`; independent of 1–4) |

**Rehearsal** — `apps/api/scripts/test-p54-combined-migrations-on-populated-data.ts` (new; extends the P53 script):
new embedded Postgres on 127.0.0.1:467xx, database `p54_<digits>` (refused otherwise, and refused if
`PRODUCTION_DATABASE_URL_DIRECT` is set), deleted afterwards. All `origin/main` migrations applied from a copy of the
folder, then populated with raw SQL: 20,000 sales (⅓ Employee 15%) with items, 2 branches, organization discount
policy, global work hours 9 h + North override 10 h, seasonal/regular products, 40 stock rows, an active shift, and
attendance (open record, closed shift with legacy `break_minutes` 60, overnight shift, a correction + its soft-deleted
original). Then the five real migrations in one `migrate deploy`. Result **PASS**, exit 0:

- all five recorded as applied; all **69** pre-existing tables byte-identical (row count + content MD5);
- **effective settings identical before and after**, computed by the same application code: organization tax
  configuration, and per branch the effective discount policy, branch tax configuration and regular shift minutes
  (North 600 = override, South 540 = global);
- nothing backfilled: no promotions/discounts on sale lines, no tax snapshots, no break rows, all 7 payroll tables
  empty; P49 classification backfill correct; FK validated; 6 partial unique indexes and 11 payroll CHECKs present;
  `prisma migrate diff` → no drift;
- on the migrated data: the open record reads Working → Start Break → On Break → Resume on the **same** record →
  Clock Out; payroll starts "Not configured"; a draft reads the new P51 interval for that record (intervals, not added
  to `break_minutes`), the legacy 60-minute total once (9 h → 8 h), and the correction (legacy total, flagged
  corrected) with its soft-deleted original excluded; rollback queries detect the open break, the enabled
  cashier-selected discount and 0 finalized payroll runs.

Migration wall time 4.1–5.2 s including Prisma CLI start-up (not a production timing). An earlier run printed PASS
but kept the process alive on an open handle; the script now exits explicitly (the orphaned rehearsal backend from
that run, on its own port, was stopped).

## 5. Release order, compatibility and rollback prerequisites

**Order:** migrations 1–5 → API → web (unchanged from P50R/P51/P52). Old API + new schema is safe; new API + old
schema is not supported. The P54 fixes are code-only (no migration).

| Combination | Behaviour |
| --- | --- |
| New schema, old API | Old API ignores `attendance_breaks`, `application_mode`, `tax_snapshot` and the payroll tables. Safe. |
| New API, old web | Payroll endpoints unused; break/discount behaviour as P53 documents. Safe. |
| New web, old API | Payroll pages show "Could not load…"; P50R/P51 behaviour per P53 runbook. |

**Rollback prerequisites** (run read-only first, resolve before an older API serves traffic):

| Check | Why | Action |
| --- | --- | --- |
| `SELECT count(*) FROM attendance_breaks WHERE ended_at IS NULL` | A pre-P51 API treats an on-break employee as Working. | Resume or clock out each one first. |
| `SELECT count(*) FROM promotions WHERE application_mode = 'cashier_selected' AND is_enabled` | A pre-P50R API applies cashier-selected discounts automatically. | Disable them first. |
| Branch overrides (`system_settings` keys `discount_policy:branch:*`) | Ignored by a pre-P50R API (`TAX_SETTINGS_CHANGED` refusals). | Decide the organization rate; reconcile refused offline sales (P50 §6). |
| `SELECT status, count(*) FROM payroll_runs GROUP BY status` | **P52 compatibility:** rolling the API back past P52 leaves payroll data intact but unreachable; dropping the payroll schema deletes it. | API/web rollback: no action needed. Schema removal: export every finalized/superseded run (CSV/PDF) first; drop only the 7 payroll tables and 4 enums. |
| Corrections made after this release on records with breaks | Rolling back past `41dd52c` only affects **new** corrections (they would again carry 0 break minutes for open records). | Re-check break minutes on corrections made during the rollback window before finalizing payroll. |
| Concurrent payroll reviewers | Rolling back past `41dd52c` reintroduces `P2024` timeouts under concurrent finalize/notes. | Ask reviewers to finalize one at a time until re-deployed. |

## 6. Verification

Environment: everything new, local and disposable, owned by this session. One embedded Postgres cluster
(repo's `embedded-postgres` binaries) in the session scratch directory on `127.0.0.1:46641` with databases
`p54_10311002` (API suite) and `p52_5410311003` (browser; named so P52's fixture guard accepts it), plus the
rehearsal's own throwaway cluster. An env guard refused any `DATABASE_URL`/`DIRECT_URL`/`TEST_DATABASE_URL` that was
not `127.0.0.1:466xx` with those names, and refused a set `PRODUCTION_DATABASE_URL_DIRECT`. Throwaway secrets and
fixture password/PINs were generated for the session and never printed. API 4654, web 3654. Other sessions' processes
and databases (e.g. 45620, 45112, 3652, 4709) were not touched.

| Check | Result |
| --- | --- |
| Populated migration rehearsal (§4) | PASS |
| API full suite, serial (`--no-file-parallelism`), real Postgres, `TEST_DATABASE_URL` set | **202 files passed / 8 skipped; 3,441 tests passed / 104 skipped; 0 failed** (exit 0, 447 s) |
| Web full suite (machine otherwise idle) | **169 / 169 files, 1,564 / 1,564 tests** |
| `turbo run type-check lint --force` | **7 / 7 tasks, 0 errors**. Warnings: API 343 = P53's 330 + 13 `no-console` in the new rehearsal script (same convention as P53's); web 1 pre-existing `<img>`. |
| API `tsc` build, web `next build` | pass (`/supervisor/reports/payroll`, `/admin/reports/payroll` built) |
| Browser acceptance, final build, one complete pass | **21 / 21** (§6.2) |

**Skips (exact).** 7 files / 99 tests gated on `TEST_DATABASE_URL && TEST_REDIS_URL` (`auth`, `branches`, `cash`,
`employees`, `flavors`, `inventory`, `products` `*.integration.test.ts`): their bodies are placeholder stubs
(`expect(true).toBe(true)`, TODO `beforeAll`) and nothing in the codebase uses Redis since Phase 21, so a disposable
Redis would only make vacuous assertions pass — not run. 1 file / 5 tests `products.publication-budget.measure.test.ts`:
an opt-in benchmark (`PUBLICATION_BUDGET_MEASURE=1`), not a correctness test.

**Earlier evidence (not final — kept for honesty).** The first full API run had `TEST_DATABASE_URL` unset by this
session's env file, so 20 files were skipped (incl. P49/P50/P50R/checkout-worker suites), and it failed P52's
"concurrent finalizations" test with `P2024` → defect 2. A first typecheck failed on a mock type in a new unit test
(fixed in the test).

**`inventory-adjust-form.test.tsx`** (P52's earlier failure, "Unable to find … Uploaded"): did not recur (2/2, 1.8 s
in the full run). The test waits for the evidence upload with Testing Library's default 1 s `waitFor`; P52's failure
happened while an API build ran in parallel, which fits a load-sensitive timing margin, not a product defect. No
timeout or retry was added.

### 6.1 Combined behaviour covered by automated tests

`p54-payroll-breaks.integration.test.ts` (real P51 services under a faked clock → real payroll):

- two resumed breaks (30 + 15 min), a break across midnight on an overnight shift, and a break closed by clock-out
  (`end_reason clock_out`): unpaid → 8 h 15 / 7 h 30 / 4 h (₱1,975.00); paid → ₱2,200.00; paid-up-to-15 min →
  ₱2,050.00; intervals used once (no legacy warning); overnight shift on its clock-in date; night hours flagged;
- open + on-break attendance → `OPEN_ATTENDANCE` blocking (pays nothing), missing rate → `RATE_MISSING`, legacy
  total → warning, finalize → `BLOCKING_ISSUES`; correcting an on-break record → `BREAK_IN_PROGRESS`;
- corrections keep recorded break time (defect 1);
- stale JWT branch claim → `BRANCH_ACCESS_DENIED` for settings/run/policy/rate; other-branch run id → `RUN_NOT_FOUND`;
  Branch Account and staff → `INSUFFICIENT_PERMISSIONS`;
- finalized run keeps policy `unpaid` and ₱800.00 after policy → paid and a back-dated rate; CSV TOTAL = ₱800.00 and
  every exclusion (incl. withholding tax, overtime premium) is listed.

P53's own regression tests (discount decision reset `43b59ee`, rate refresh `0ea1b19`, two-pane checkout `3a68bca`,
on-break blocking, submitted-checkout recovery and original-cashier offline ownership in
`p53-discounts-breaks.integration.test.ts`, `page.test.tsx`, `checkout-workspace.test.tsx`) all pass unchanged.

### 6.2 Browser acceptance (final build)

Chromium (Playwright 1.61.1), built web + built API, fresh browser database, run in four segments back to back
(`2026-10-31`, ~02:00–03:00 Manila). The scenario script is a session scratch file (not committed).

| # | Step | Result |
| --- | --- | --- |
| D1 | Desktop 1440×900. Supervisor North: Reports → Payroll tab → "Payroll is not configured for this branch" | pass |
| D2 | Pay settings: no radio pre-selected; Asia/Manila, semi-monthly cutoff 15, breaks unpaid → "Version 1" | pass |
| D3 | Ana's rate ₱100 via the dialog (verified via API); other North staff ₱80 via API | pass |
| D4 | Supervisor: North requires a discount decision, Employee 15% (P50R) | pass |
| D5 | Terminal: Ana PIN → Clock In (geolocation) → Charge disabled until a decision → "No applicable discount" → cash sale | pass |
| D6 | Start Break → "Locked for a break — shift still open"; Ana's pre-break token → 403 `ON_BREAK` | pass |
| D7 | Payroll draft 16–31 Oct: Ana's open shift blocking ("Still clocked in"), Finalize disabled | pass |
| D8 | Supervisor changes Employee to 12% during the break → Ben asked for his own decision, picker shows Employee 12% (P53 fixes) → sells → Clock Out | pass |
| D9 | Ana PIN → "Resume Work" (same shift) → Clock Out | pass |
| D10 | Draft: Ana's terminal shift closed, one recorded interval, payable = span − break (unpaid); drilldown opens | pass |
| D11 | South supervisor → North settings/run/policy 403, North run via South URL 404; Branch Account 403; no token 401; North policy unchanged; Branch Account never sees the payroll page | pass |
| D12 | Policy v2 (paid breaks) raises basic pay; special-pay notes recorded; Finalize disabled until the scope acknowledgement (lists exclusions) → "Finalized", "Not marked paid" | pass |
| D13 | Export CSV/PDF from the UI: `_FINAL.csv` TOTAL = stored total = API export; every exclusion listed; `_FINAL.pdf` with `%PDF-` | pass |
| D14 | Back-dated ₱150 rate after finalization → finalized figures unchanged | pass |
| T1–T3 | Tablet landscape 1024×768, touch: finalized run + drilldown + Pay settings with no horizontal overflow; Ana PIN on touch keypad → Clock In → Start Break (≥44 px) → locked → Resume Work → Clock Out; "Attendance changed after finalization" shown, figures unchanged | 3/3 |
| P1–P3 | Phone 390×844 (iPhone 13 profile), same as T1–T3 | 3/3 |
| K1 | Keyboard only (desktop): Payroll tab link → Period select → run → Tab to "Details for Ana Reyes" → drilldown receives focus → Pay settings tab via arrow key | 1/1 |

**Rate limits.** Production limits were not changed (login 10/15 min per IP+device, select-employee 10/15 min,
general 100/min per IP). Each role logged in once per database and its browser session was reused across segments;
the API was restarted between segments (fresh in-memory counters, same configuration). No limiter response
occurred in the counted pass. The API ran with `NODE_ENV=development` only so session cookies work over plain-HTTP
localhost (`secure` is production-only); limiter configuration does not depend on `NODE_ENV`.

**Emulation, not devices.** Tablet/phone are Chromium device emulation with touch input. No physical device, iOS
Safari, Android Chrome, installed PWA, real on-screen keyboard or service-worker restart was used. Offline sale
ownership and submitted-checkout recovery were verified by the automated P53 suites, not re-walked in this browser
pass. PWD/Senior proof upload was not exercised (storage stubbed locally).

**Iterations before the counted pass** (script selectors: period label, "Finalize…", run button, drilldown heading,
"Details for …" accessible name; stale saved browser session after refresh-token rotation — correctly refused by the
API; one fixed-UUID requirement for `device_id`). Each iteration used a freshly recreated database. Only the final
complete pass is counted.

**Observed, pre-existing, not changed — Clock In flicker after Resume Work.** After an operator switch the terminal
can render the "Clock In" card for one attendance fetch (<~200 ms) before showing the selling screen. Seen after 2 of
3 Resume Work actions in the counted pass (and in iterations). Cause: `useAttendanceByEmployee` uses
`placeholderData: keepPreviousData` (since P40, already on `origin/main`), so the new operator's status is briefly the
previous operator's record. The server still enforces clock-in and break state; tapping "Clock In" in that window
would get `ALREADY_CLOCKED_IN`. Suggested fix: ignore placeholder data for the operator status read (or drop
`keepPreviousData` for that hook). Not fixed here (not introduced by P50R–P54).

## 7. Owner decisions and limitations

1. Release P49 + P50R + P51 + P52 + P54 fixes together in the order of §5, or stage them; the rollback checks apply
   either way.
2. Break policy per branch (paid / unpaid / paid up to N minutes) and who may configure payroll — no defaults.
3. Keep P51 and the defect-1 fix together: P51 is not on `origin/main`, so no production correction can have lost
   break time yet. If P51 is ever released without `41dd52c`, review corrections made meanwhile before finalizing
   payroll (read-only: corrections whose original has `attendance_breaks` rows and `break_minutes = 0`).
4. Whether the pre-existing Clock In flicker (§6.2) must be fixed before pilot.
5. Real-device pass (pilot tablet, real keyboard, installed PWA, offline + service-worker restart) and the sub-48 px
   controls noted in the P53 runbook — still open.
6. Payroll remains basic time-based pay: no SSS/PhilHealth/Pag-IBIG, withholding tax, overtime/holiday/night premiums,
   13th-month or leave conversion. Non-Latin-1 names are not rendered in the PDF (P52 limitation).
