# POS-PERF-P52 — Attendance-based payroll settings and payroll reports

Goal: supervisors configure employee hourly rates and a branch payroll policy, review attendance-based payroll for
their branches, finalize an immutable record, and export it.

**This is basic time-based payroll.** It is not a claim of complete Philippine payroll compliance. The result is
labelled **"Calculated total (before statutory items)"** everywhere — never "net pay".

<!-- DESIGN-START (written before implementation; kept as the authoritative rules) -->

## 1. Audit of what already existed (base `ac0f1b0`, P51)

| Concern | Existing support | P52 decision |
| --- | --- | --- |
| Employee pay rate | **None.** `users` has no rate/wage column; no rate table. | New effective-dated `employee_pay_rates` (per employee **and branch**). No backfill. |
| Work hours | Global `work_hours_policy` + per-branch override (`settingsService.getRegularShiftMinutes`, default 8 h) — used only to compute `attendance_records.overtime_minutes`. | Reused **only to flag** possible overtime for review. Never used to cap or pay overtime. |
| Attendance | `attendance_records`: server `clock_in_server_time` / `clock_out_server_time`, `branch_id`, `break_minutes`, `actual_work_minutes`. Corrections (`POST /attendance/override`) create a new row (`original_record_id` set, `corrected_by`, `correction_reason`) and soft-delete the original (`deleted_at`). | Payroll reads non-deleted records only, from server timestamps. The stored `actual_work_minutes` / `overtime_minutes` are **not** used (they are minute-rounded and policy-free). |
| Breaks (P51) | `attendance_breaks` intervals with server timestamps, at most one open per record. At clock-out, a record with intervals stores `break_minutes = Σ intervals`. A correction row has **no** intervals of its own and carries `break_minutes` over. | See §3.3: intervals are authoritative when present; otherwise `break_minutes` is the legacy fallback. Never both. |
| Branch scope | `branchGuard` / `hasBranchAccess`: super_admin = all; supervisor = **current** active assignments to active branches, read fresh from the DB (never the JWT claim); branch/staff = their one branch. `user_branch_assignments` keeps `assigned_at` / `removed_at` history. | Payroll routes are `super_admin` + `supervisor` only, behind `branchGuard`. Employee history uses assignment history (§5). |
| Reports | Sales/ops reports (`/api/reports`), CSV with formula-injection escaping (`lib/reports/csv.ts`), PDF via `@react-pdf/renderer` (`lib/reports/pdf.ts`). | Payroll gets its own export (different shape), reusing the escaping rule (extended to tab/CR) and the PDF column-layout helper. |
| Audit | Hash-chained `audit_logs`; transactional `audit_outbox.enqueue(tx, …)`. | Every payroll write enqueues its audit intent **inside** its transaction. |
| Locks | `pg_advisory_xact_lock` via `lib/pg-lock.ts` helpers. | New `payrollBranchLockId(branchId)` and `payrollRateLockId(employeeId, branchId)`. |
| Holidays / rest days / night differential / statutory contributions / tax | None in the system. | Not calculated (§7). |

## 2. Settings and their defaults

There are **no silent defaults**. A branch without a saved payroll policy shows "Not configured" and payroll for it
cannot be finalized; an employee without a rate for a worked day shows "No rate" and blocks finalization.

### 2.1 Branch payroll policy (versioned, append-only)

| Field | Values | Notes |
| --- | --- | --- |
| Business timezone | any IANA zone accepted by the server's `Intl` (UI suggests `Asia/Manila`, never saves it implicitly) | Decides business dates, period boundaries, rate-effective boundaries and the night-hours flag. |
| Pay period | `semi_monthly` or `monthly` | |
| First cutoff day (semi-monthly only) | 1–27 | Periods: day 1 → cutoff, cutoff+1 → last day of month. E.g. 15 → 1–15 and 16–end. |
| Break treatment | `paid`, `unpaid`, `paid_up_to_limit` | Required; no default. |
| Paid break limit (minutes per shift) | 0–720, required for `paid_up_to_limit` | First N minutes of break per shift are paid, the rest unpaid. |

Each save creates version N+1 (the previous versions stay readable). Saves carry `expected_version`; a mismatch is a
409 `STALE_POLICY` — a stale form can never overwrite a newer policy. A draft is always calculated with the **current**
policy; finalization snapshots the policy version used.

### 2.2 Hourly rates (effective-dated, append-only)

- One row = (employee, branch, effective-from business date, hourly rate in pesos, 2 decimals, > 0, reason, actor).
- The rate for a business date D is the non-voided row with the latest `effective_from ≤ D`.
- Adding a rate dated today/in the future never changes earlier earnings; finalized payroll keeps its own snapshot.
- A mistaken row is **voided** (reason + actor), never edited or deleted. At most one non-voided row per
  (employee, branch, effective date) — enforced by a partial unique index.
- Writes carry `expected_latest_rate_id` (the newest row the editor saw); mismatch → 409 `STALE_RATES`.
- Per-minute rate is display-only (`hourly ÷ 60`, 4 decimals). The hourly rate is the single source of truth.
- Rates are **per branch**: time worked at branch A is paid with A's rate for that employee. A transfer to B does not
  carry A's rate; B's supervisor sets B's rate.

## 3. Time and break calculation

### 3.1 Which attendance belongs to a pay period

- Records at the selected branch, `deleted_at IS NULL`, employee role `staff`.
- A shift belongs to the period containing the **business date of its clock-in** (in the branch policy's timezone).
  An overnight shift that starts on the 15th and ends on the 16th belongs entirely to the 1–15 period. Each record is
  therefore in exactly one period — it can never be paid twice across adjacent periods.
- Non-staff attendance at the branch (e.g. a supervisor) is excluded and counted in an info note.

### 3.2 Payable time for one shift

```
shift span        = clock_out − clock_in                        (server timestamps, exact milliseconds)
recorded breaks   = intervals (§3.3) or legacy total
unpaid break time = per break treatment:
                    paid              → 0
                    unpaid            → all recorded break time
                    paid_up_to_limit  → max(0, total break − limit); the paid part is the chronologically first N minutes
payable time      = shift span − unpaid break time
```

- No clock-out is ever invented; an open record is an issue and contributes nothing.
- No cap to scheduled hours, no lateness penalty, no rounding of times. Durations use exact milliseconds.

### 3.3 Breaks: intervals vs legacy `break_minutes` (never both)

| Record has `attendance_breaks` rows? | Break source | `break_minutes` |
| --- | --- | --- |
| Yes (P51 records) | The intervals. Each must be closed and inside the shift; overlapping or out-of-shift intervals are issues. | Ignored (it is derived from the same intervals). |
| No (pre-P51 records, supervisor corrections, legacy clients) | **Legacy fallback:** `break_minutes` as an unpositioned total. Shown as "Legacy break total (no recorded times)" with a warning. | Used. |

A legacy total has no position in time, so when a shift is split at a rate boundary, its unpaid portion is taken from
the **earliest** segment(s) of the shift first (documented, shown in the drilldown).

### 3.4 Rates across a shift

Each payable stretch is split at rate-effective boundaries (start of the effective business date in the policy
timezone), and each piece is paid at the rate in effect at its own business date. A shift crossing midnight into a
day with a new rate is therefore paid partly at each rate.

### 3.5 Money

- Amount of a piece = hourly rate × payable milliseconds ÷ 3,600,000, computed exactly with integer arithmetic
  (centavos × milliseconds — no floating point).
- Exact amounts are summed per (employee, rate) and each sum is rounded **once**, half-up, to the centavo.
  Basic pay = Σ of those rounded rate lines, so the rate breakdown always adds up to basic pay exactly.
- Adjustments are exact 2-decimal amounts. Calculated total = basic pay + earnings adjustments − deductions.

### 3.6 Issues

| Issue | Severity | Blocks finalization? |
| --- | --- | --- |
| Payroll policy not configured | blocking | yes |
| No rate for a worked day | blocking | yes |
| Open attendance (no clock-out) | blocking | yes |
| Open break on the record | blocking | yes |
| Invalid interval (clock-out before clock-in; break outside the shift; overlapping breaks; legacy break longer than the shift) | blocking | yes |
| Overlapping attendance (same employee, any branch — other branches are not named) | blocking | yes |
| Calculated total below zero | blocking | yes |
| Possible overtime (payable time on a business date above the branch's regular hours) | special pay | yes, until a reviewer records a resolution note |
| Night hours (payable time between 22:00 and 06:00 business time) | special pay | yes, until a reviewer records a resolution note |
| Legacy break total used | warning | no — covered by the scope acknowledgement |
| Shift not covered by a recorded branch assignment | warning | no — covered by the scope acknowledgement |
| Supervisor-corrected record | info | no |

Resolving a special-pay issue only records the reviewer's note ("handled by allowance adjustment", "not overtime —
approved schedule", …). It never changes attendance and never computes a premium.

## 4. Draft → review → finalize → export

1. Select branch + period → **Generate draft** (one open draft per branch and period).
2. A draft is recalculated live on every view from current attendance, rates, policy, adjustments and resolutions.
   It shows "Draft — calculated <time>" and a fingerprint (SHA-256 of the full calculation).
3. Reviewer adds adjustments / resolution notes.
4. **Finalize** sends the fingerprint the reviewer saw plus an explicit scope acknowledgement. Under a per-branch
   advisory lock and in one transaction the server recalculates; if the fingerprint differs → 409 `STALE_PREVIEW`
   (nothing written). Blocking issues → 409. Overlapping finalized period at the branch → 409. Otherwise it writes
   the immutable lines, rate/policy snapshots, attendance claims and reviewer, atomically.
5. **Finalized ≠ Paid.** "Mark as paid" only records who/when/reference. No money moves.
6. Corrections: **Revise** a finalized run → a new draft (adjustments copied, marked as copied). Finalizing the revision
   marks the original `superseded` (kept, readable) in the same transaction. Nothing is deleted or overwritten.

### 4.1 Calculation examples (Asia/Manila, semi-monthly cutoff 15, breaks unpaid)

Ana's rates at North: ₱80.00/h from 2026-01-01, ₱90.00/h from 2026-10-20.

| Shift (business date) | Recorded | Break source | Payable | Pieces |
| --- | --- | --- | --- | --- |
| 16 Oct 08:00–17:00 | interval 12:00–13:00; `break_minutes` = 60 (same break) | intervals | 8 h | 8 h @ 80 = 640.00 |
| 17 Oct 08:00–17:00 | `break_minutes` = 60, no intervals | legacy total (warning) | 8 h | 8 h @ 80 = 640.00 |
| 19 Oct 22:00 → 20 Oct 06:30 | interval 02:00–02:30 | intervals | 8 h | 19 Oct 2 h @ 80 = 160.00; 20 Oct 6 h @ 90 = 540.00 (night-hours flag) |
| 22 Oct 08:00–16:30 (supervisor correction; original soft-deleted) | `break_minutes` = 30 | legacy total | 8 h | 8 h @ 90 = 720.00 |

Basic pay = 640 + 640 + 160 + 540 + 720 = **2700.00**, shown as two rate lines: 18 h @ 80 = 1440.00 and
14 h @ 90 = 1260.00. The 16 Oct break is subtracted once, never twice.

- *Paid up to a limit (15 min)*: 16 Oct pays 15 of the 60 break minutes → payable 8 h 15 min.
- *Rounding*: Ben, 7 h 59 m at ₱75.55 → 75.55 × 479 ÷ 60 = 603.1408… → **603.14** (rounded once per employee and rate).
- *Overnight at a cutoff*: Ben 15 Oct 22:00 → 16 Oct 06:00 belongs entirely to 1–15 Oct (clock-in date).
- *Transfer*: Dana worked North on 16 and 18 Oct (4 h each), moved to South on 20 Oct, worked South on 21 Oct.
  North's 16–31 Oct payroll has only the two North shifts (8 h @ North's ₱70 = 560.00); South's has only the 21 Oct
  shift at South's rate.

<!-- DESIGN-END -->

## 5. Roles and branch permissions

| Role | Payroll access |
| --- | --- |
| **Super Admin** | Every branch: settings, rates, drafts, adjustments, resolutions, finalize, revise, mark paid, export. Chooses the branch on `/admin/reports/payroll`. |
| **Supervisor** | Only branches with a **current** active assignment (`user_branch_assignments.removed_at IS NULL`, branch active), read from the database on every request — never the JWT's `branch_ids`. Removing the assignment removes access immediately, including to that branch's finalized history. |
| **Branch Account, staff** | None. Every `/api/payroll/*` route is `adminOrSupervisor` → 403. The web routes live under `/supervisor` and `/admin`. |

Enforcement is server-side, in two layers: `authenticate → adminOrSupervisor → requirePasswordChange → branchGuard` on
every route (all routes are `/api/payroll/branches/:branchId/...`), then the service re-checks branch access itself.
Every submitted id is resolved against the URL branch: a run, rate or adjustment from another branch is **404** (never
confirmed to exist); a rate for an employee never assigned to the branch is **404 `EMPLOYEE_NOT_IN_BRANCH`**; an
adjustment for an employee without attendance in the run is **404 `EMPLOYEE_NOT_IN_RUN`**. Actor ids always come from
the verified token; body `branch_id`s are ignored.

**Historical branch access vs current assignment (transfers).**

- Attendance is attributed by `attendance_records.branch_id` (where the shift was recorded), which is reliable. Branch
  A's payroll contains only shifts recorded at A; B's only shifts at B. After a transfer A → B, B's supervisor never
  sees the employee's A time, rates or payroll, and vice versa.
- Rates are per (employee, branch). The rates screen lists **Current staff** and **Former staff of this branch**
  (assignment history at this branch only), so A's supervisor can still set A's rate for the employee's past A shifts.
- A shift recorded at a branch where no assignment covered its clock-in is included (the record says where it
  happened) but flagged **"No recorded branch assignment covers this shift"** for the reviewer, instead of guessing.
- Overlap detection looks at the employee's records at **all** branches, but the issue never names the other branch.

**Stale overwrites.** Policy saves carry `expected_version` (409 `STALE_POLICY`); rate add/void carry
`expected_latest_rate_id` under a per-(employee, branch) advisory lock (409 `STALE_RATES`); one live rate per date is
also a partial unique index (409 `RATE_DATE_TAKEN`). Configuration writes are audited through the transactional audit
outbox (`PAYROLL_POLICY_SAVED`, `PAYROLL_RATE_ADDED`, `PAYROLL_RATE_VOIDED`), and the tables keep full history
(policy versions; voided rate rows).

## 6. Manual adjustments

- **Earnings:** Allowance, Bonus, Other earning. **Deductions:** Documented deduction only, and it **requires a
  documentation reference** (e.g. "Signed authorization #12") — enforced by Zod, the service and a CHECK constraint.
  The screen says it records a deduction; it does not decide that one is permitted.
- Every adjustment has kind, category, positive amount (2 decimals), reason, the actor's id and name, timestamp.
- Adjustments are added only to drafts and never edited; a mistake is **voided** with a reason (kept, shown struck out).
- Adjustments never change attendance. Attendance corrections use the existing audited `/attendance/override`.
- A total below zero blocks finalization (`NEGATIVE_TOTAL`).

## 7. Not calculated (excluded) in this version

Shown on the payroll page, in the finalize acknowledgement, in every CSV and on every PDF:

- SSS, PhilHealth and Pag-IBIG contributions
- Withholding tax
- Overtime premium
- Holiday and rest-day premium
- Night-shift differential
- 13th-month pay and leave conversion

What the system **can** identify blocks finalization until a reviewer records a resolution note: possible overtime
(payable time on a business date above the branch's configured regular hours) and night hours (22:00–06:00 business
time). Holidays and rest days are unknown to the system, so they are covered only by the explicit scope
acknowledgement required to finalize. The result is labelled **"Calculated total (before statutory items)"**, never
"net pay".

## 8. Finalization, corrections and payment

| Step | Rule |
| --- | --- |
| Generate draft | One open draft per branch+period (partial unique index); generating again opens the same draft. Refused without a policy, for dates that are not a policy period, or when a finalized run overlaps. |
| Review | Recalculated on every view. Fingerprint = SHA-256 of the canonical calculation (policy, period, regular hours, every employee line incl. shifts/segments/adjustments, issues incl. resolutions, totals). |
| Finalize | `POST …/finalize {expected_fingerprint, acknowledge_scope: true}`. Under `payrollBranchLockId(branch)`, in one transaction: re-read run (must be draft) → recalculate → fingerprint must match (else 409 `STALE_PREVIEW`, nothing written) → nothing blocking (else 409 `BLOCKING_ISSUES`) → no other finalized run overlapping (else 409 `PERIOD_ALREADY_FINALIZED`) → write lines (full per-employee detail JSON), attendance claims, policy/rate/issue snapshots, totals, reviewer, acknowledgement time → conditional `UPDATE … WHERE status = 'draft'`. |
| Concurrency | The advisory lock serializes finalizations; the loser re-reads and gets 409 `RUN_NOT_DRAFT`. Backstops: one finalized run per branch+period and one live claim per attendance record (partial unique indexes → 409 `ATTENDANCE_ALREADY_PAID`). |
| After finalization | Reads return the stored snapshot (`basis: finalized_snapshot`), never recalculated. If attendance for the branch/period is later corrected or added, the run shows **"Attendance changed after finalization"**; the figures do not move. |
| Correction | **Revise** (reason required) → new draft, `revision_number + 1`, live adjustments copied ("Copied from previous version"), each employee shows the previously finalized total. Finalizing the revision, in the same transaction, marks the original `superseded` (kept, readable, linked), releases its claims and claims the revision's records. Nothing is deleted. A superseded run cannot be revised or paid. |
| Paid | **Mark as paid** (optional reference) only on a finalized run; records who/when. Finalized ≠ Paid. A revision starts unpaid even if the original was paid; it shows the previous total so the difference can be settled outside the system. No money is moved; there is no payout integration. |
| Discard | Drafts only, reason required; kept as `discarded`. |

## 9. Export

`GET /api/payroll/branches/:branchId/runs/:runId/export?format=csv|pdf[&employee_id=]` — same permissions as viewing
the run. Both formats are rendered from the exact `PayrollRunDetail` the page shows; for a finalized run that is the
stored snapshot. Drafts say **DRAFT — NOT FINALIZED** in the first CSV row and in a status column on every summary row,
in a PDF banner and on every PDF page header/footer, and the filename ends `_DRAFT`. CSV: UTF-8 with BOM; summary,
daily detail, adjustments and issues tables; free text starting with `= + - @`, tab or CR is prefixed with `'`;
amounts are plain decimals. PDF: A4 landscape, repeating table headers, long names wrap (zero-width break points for
long unbroken tokens), "Page X of Y". Only name and employee code are included — no government IDs, PINs, contact
details or other employee data. Each export is audited (`PAYROLL_EXPORTED`, best-effort).

## 10. Schema, migration, compatibility and rollback

Migration `20261030190000_pos_perf_p52_payroll` sorts after P50R `20261030160000_…` and P51 `20261030170000_…` and
touches neither's tables. Purely additive: 4 enums, 7 tables, foreign keys `ON DELETE RESTRICT`.

| Table | Purpose |
| --- | --- |
| `payroll_policies` | Versioned branch policy (append-only). |
| `employee_pay_rates` | Effective-dated hourly rate per employee and branch; voided, never deleted. |
| `payroll_runs` | Draft/finalized/superseded/discarded runs with snapshots, totals, reviewer, paid marking. |
| `payroll_run_lines` | Immutable per-employee results written at finalization (full detail JSON). |
| `payroll_adjustments` | Labelled earnings / documented deductions. |
| `payroll_issue_resolutions` | Reviewer notes for special-pay issues. |
| `payroll_attendance_claims` | Which finalized run paid which attendance record. |

Database guarantees: CHECKs for policy shape, positive rates/amounts, void consistency, documented deductions, period
order, finalized-snapshot completeness and paid-only-after-finalized; partial unique indexes
`employee_pay_rates_one_active_per_date`, `payroll_runs_one_draft_per_period`, `payroll_runs_one_finalized_per_period`,
`payroll_runs_one_open_revision`, `payroll_attendance_claims_one_active_per_record`. Existing tables, columns and rows
are untouched and **nothing is backfilled** (no rates, policies or runs): every branch starts "Not configured" and
every employee "No rate". Attendance, breaks, sales, stock and audit history are only read.

Deployment order (unchanged): migration → API → web.

| Combination | Behaviour |
| --- | --- |
| New schema, old API | Old API never reads the new tables. Safe. |
| New API, old web (API-first window) | Payroll endpoints exist but nothing links to them; no existing response changed. Safe. |
| New web, old API | `/reports/payroll` pages load but `/api/payroll/*` is 404 → "Could not load…" alerts. Existing reports pages only gained the section tab strip. |
| New API, old schema | **Not supported** (payroll routes would fail). Keep migrate-before-API. |
| Rollback of API/web | Safe at any time; payroll data stays in its own tables. |
| Rollback of the schema | Only to remove payroll entirely: drop the 7 tables and 4 enums (nothing else references them). This **deletes payroll records** — export finalized runs first. Never needed for an API/web rollback. |

No existing endpoint, response shape, JWT claim or attendance behaviour changed. P51 break behaviour is untouched
(payroll only reads `attendance_breaks`).

## 11. Verification

**Environment.** A new embedded Postgres cluster (binaries from the repo's `embedded-postgres` dev dependency) with its
own data directory in the session scratch area, on `127.0.0.1:45652`, throwaway role and secrets. Three disposable
databases, all guarded (scripts refuse anything not `127.0.0.1` + `p52_<digits>`): `p52_10302006` (migration
rehearsal), `p52_10302005` (test suites), `p52_10302007` (live HTTP + browser). Built API on port 4652, built web
(`next build` in this worktree's own `.next`) on port 3652. Production, `pos_verify` and other sessions' databases
were never touched. Another session's embedded Postgres (port 45620) and its processes were left alone; Docker/WSL was
not used or restarted. No accounts were provisioned outside the disposable databases; no terminal queues were cleared.
Fixtures: repo seed + `seed-pos-demo-inventory` + `scripts/p52-payroll-fixtures.ts` (two branches, supervisors scoped
to one branch each, branch accounts, staff incl. a North → South transfer on 20 Oct, a very long name, a
formula-like name, P51 interval breaks, legacy break totals, an overnight shift across a rate change, an overnight
shift on the cutoff day, a supervisor correction) + `seed-discount-audit-fixtures` (sales) on the rehearsal database.

| Check | Result |
| --- | --- |
| Migration rehearsal on populated data (`p52_10302006`) | Base (P51) migrations deployed, then populated: 15 users, 14 branch assignments, 15 attendance rows (incl. 2 P51 break intervals, a correction + soft-deleted original), 9 sales / 9 items, stock, PINs, audit logs. Row count **and** content MD5 of all 74 tables before vs after `migrate deploy` of the P52 migration: **73 identical**, only `_prisma_migrations` changed; 7 new tables, all empty (no backfill). `prisma migrate diff` (DB → `schema.prisma`) empty. All 5 partial unique indexes and 11 CHECK constraints present. |
| API full suite, serial, real Postgres (`p52_10302005`) — run 1 | 198 files passed / 8 skipped; 3,419 tests passed / 104 skipped, **0 failed**. The 8 skipped files need `TEST_REDIS_URL` (Redis was removed in Phase 21) — pre-existing. Included: P51 `attendance-breaks.integration` 10/10, P50 tax, checkout worker. |
| API full suite — run 2 (final code) | 198 files passed, 8 skipped (TEST_REDIS_URL); 3420 tests passed, 104 skipped, 0 failed; exit 0 (635 s) |
| Payroll unit (`payroll-calc.test.ts`) | 18/18 |
| Payroll real-Postgres integration (`payroll.integration.test.ts`) | 11/11 |
| Payroll router (`payroll.router.test.ts`) | 55/55 |
| Payroll export (`payroll-export.test.ts`) | 4/4 (the 32-employee multi-page PDF took ~18 s on the loaded machine) |
| Web full suite — run 1 | 167/168 files, 1,540/1,541 tests: **1 failure** in `components/branch-ops/inventory-adjust-form.test.tsx` (not touched by P52; "Unable to find … Uploaded"), while an API build ran in parallel. Passed alone (2/2). |
| Web full suite — run 2 (machine otherwise idle) | 168/168 files, 1,541/1,541 tests |
| `turbo run type-check lint` | 7/7 tasks, 0 errors (308 pre-existing API `no-console` warnings, 1 pre-existing web `<img>` warning) |
| API `tsc` build, web `next build` | pass |
| Live HTTP against the built API (`p52_10302007`) | 47/49 on the first run. Both failures were wrong assertions in the check script, re-checked against the same live data with corrected assertions: **2/2 pass** — (a) the overnight 19→20 Oct shift is 2 h @ 80 + 6 h @ 90, but the 20 Oct part is two stretches around the 02:00–02:30 unpaid break, not one; (b) the "no government IDs" regex had matched the CSV's own "Not included: SSS, PhilHealth…" exclusion line. |
| Real browser (Chromium, built web + built API) | All 18 steps passed, **in segments**: the first full run failed every step on a script login selector ("Sign in" matched "Sign in with PIN"); the second run passed 8/18 and the rest were fixed in the script (resolve special-pay before finalizing; wait for the run view, not the period badge; terminal Clock In card before/after the PIN; on-screen keypad) and re-run step groups against the evolving data. One re-run of the phone step hit the API's 100 req/min limiter after rapid scripted runs ("Too many requests") and passed after the window. |

Live HTTP checks (all pass as above): Branch Account 403 on settings and export; no token 401; supervisor South 403
on North settings, North 403 on South rates; unconfigured branch → `policy: null`, `configured: false`, draft
refused `POLICY_MISSING`; policy v1, stale save 409 `STALE_POLICY`, missing break treatment 422; North rates list Dana
as *former*, South as *current* and never lists Ana; nobody starts with a rate; rate for a South-only employee at
North 404; zero rate 422; stale rate write 409 `STALE_RATES`; draft 201 then same draft 200; non-policy period 422;
16 Oct interval break used once (8 h); 17 Oct legacy total (8 h) + warning; 22 Oct correction used, original excluded;
Ana basic pay 2700.00; Dana at North only her two pre-transfer shifts (560.00); night-hours and possible-overtime
flagged; finalize with blockers 409, old fingerprint 409 `STALE_PREVIEW`, no acknowledgement 422; supervisor South
cannot read/export a North run; Super Admin can; draft CSV labelled DRAFT; 15 Oct overnight wholly in 1–15 Oct; after
resolution notes **5 concurrent finalizations → 200, 409, 409, 409, 409**; same period cannot be drafted again;
finalized CSV TOTAL = stored record (1244.40); formula-like name neutralised; finalized PDF `_FINAL.pdf`; mark paid
keeps status finalized, twice 409, draft 409; finalized payroll unchanged after a rate and a policy change; rate voided
and kept.

Browser steps (built web; desktop 1440×900 unless noted):

- **S1** Supervisor South: Reports → *Payroll* tab → "Payroll is not configured for this branch".
- **S2** Pay settings: "Not configured", no radio pre-selected; timezone, semi-monthly cutoff 15, paid-up-to-15-min saved → "Version 1".
- **S3** Rates for Carl (current) and Dana (current after transfer) through the dialog, per-minute preview shown.
- **S4** Generate draft 16–31 Oct: "Draft — not finalized", legacy-break warnings, Dana shows only her South shift.
- **S5** Allowance ₱150.25; a deduction is not submittable until a documentation reference is entered.
- **S6** Special-pay note recorded; Finalize disabled until the acknowledgement is ticked; then "Finalized", "Not marked paid".
- **S7** Downloaded CSV and PDF: CSV TOTAL equals the API's stored totals (1344.94); `_FINAL.csv` / `_FINAL.pdf`; `%PDF-`.
- **S8** Mark as paid with a reference → "Paid" while still "Finalized".
- **S9** Attendance correction via the existing override → "Attendance changed after finalization" → Revise → "Revision 2", "Previously finalized total", "Copied from previous version" → finalize; original is `superseded` and keeps its paid marking.
- **T1** P51 on the North terminal: PIN → Clock In → selling → Start Break → "Locked for a break".
- **T2** Supervisor North opens a revision of the finalized 16–31 Oct run: Ana's open shift is blocking ("Still clocked in…"), Finalize disabled.
- **T3** P51: Ana's own PIN → Resume Work → Clock Out.
- **T4** The revision draft now shows Ana's 30 Oct shift closed.
- **T5** Special-pay notes; finalize dialog open; meanwhile an admin adds Ana's rate effective 30 Oct (changes her pay) → Finalize → "The figures changed after you opened this payroll…" → re-acknowledge → finalized.
- **R1** Tablet 820×1180: run + drilldown for the longest name, no horizontal overflow.
- **R2** Phone 390×844, keyboard only: Payroll tab link (Enter) → Period select → 1–15 Oct option → Open payroll → Details for Ben → rate breakdown, "Paid" → Pay settings tab → Hourly rates; no horizontal overflow.
- **A1** Super Admin: Reports → Payroll, pick South, open "revision 2".
- **X1** Branch Account opening `/supervisor/reports/payroll` is sent to `/login` and never sees the page.

Issues found and fixed during verification:

- Finalized runs would have flagged pre-existing non-staff attendance as "changed after finalization"; now only rows
  written after finalization count (new integration test).
- A literal BOM / zero-width space in source failed lint (`no-irregular-whitespace`); replaced with escapes.
- Router-test mock typing (tsc), an `act()` wrap in a web test, and two of my own wrong expected values (603.08 →
  603.14; 2620 → 2700) — the code was right in both.

Not verified / limitations:

- A real device/PWA. The browser checks ran in headless Chromium.
- Non-Latin-1 names in the PDF: the standard Helvetica font has no glyphs for them (CSV is fine).
- DST zones: business-date conversion handles offset changes, but only Asia/Manila and a New York midnight unit case
  were exercised; the night window is computed as local midnight + hours.
- PDF rendering time grows with employee count (~18 s for 32 employees × 6 shifts on this loaded machine).
- A first-time stale-preview attempt in the browser used a rate change that did not affect anyone's pay, so the
  finalize correctly succeeded; the repeated check used a pay-affecting change (T5).

## 12. Integration notes

- Base: `ac0f1b07f8418d8121e1ed0c691c441da5046dc2` (P51, `feat/pos-perf-p51-break-time-tracking`). Branch
  `feat/pos-perf-p52-payroll`, worktree `C:/Users/kaile/Downloads/pc-p52-payroll-worktree`. Final SHA: the commit that
  adds this file. Not merged, pushed or deployed.
- `main` has since moved to `ea9f0f4` (P50R, committed by the other session); P51 is **not** on `main`. Integrate P51
  first, then P52.
- Files overlapping other work (file-name comparison only):
  - **P50R (`ea9f0f4`)**: `apps/api/prisma/schema.prisma` only — both append models/relations; expect a mechanical
    merge. Migration ids do not collide (`…160000` P50R, `…170000` P51, `…190000` P52).
  - **P51 (`ac0f1b0`)**: `apps/api/prisma/schema.prisma` (P52 adds `payrollClaims` to `AttendanceRecord`).
  - Shared-but-additive files: `apps/api/src/app.ts` (one router), `apps/api/src/lib/pg-lock.ts` (two helpers),
    `packages/shared/src/schemas/index.ts` (one export), `apps/web/app/(admin)/admin/reports/page.tsx` and
    `apps/web/app/(supervisor)/supervisor/reports/page.tsx` (section tab strip).
- Deployment workflows were not modified.
