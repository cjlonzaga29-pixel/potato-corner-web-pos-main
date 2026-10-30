# POS-PERF-P53 — Integrating P50R (branch discounts) and P51 (break time)

Local integration only: nothing in this branch was merged into `main`, pushed or deployed, and no production
migration or reconciliation SQL was run.

## 1. Branch, worktree and SHAs

| | |
| --- | --- |
| Integration branch | `feat/pos-perf-p53-discounts-breaks-integration` |
| Worktree | `C:/Users/kaile/Downloads/pc-p53-integration-worktree` |
| Base (committed `main`, P50R) | `ea9f0f405be239ec7a47ca4fb4f40c6abfce29c4` (parent `cd0004b`, P50) |
| Merged in (P51) | `ac0f1b07f8418d8121e1ed0c691c441da5046dc2` (`feat/pos-perf-p51-break-time-tracking`, forked from `cd0004b`) |
| `origin/main` (deployed baseline) | `7084291f25c301c5e9b4f28ed529eda88838f550` (an ancestor of `main`) |
| Merge commit | `089a164` — parents `ea9f0f4` + `ac0f1b0` |
| Integration fixes | `43b59ee` (discount decision reset on operator change), `0ea1b19` (re-read discounts on operator change) |
| Final SHA | the commit that adds this runbook (see `git log -1` on the branch; reported in the P53 handoff) |

The P51 branch, the P52 branch and both of their worktrees were not modified, rebased or merged.

## 2. Conflicts and resolutions

P51 forked from P50 (`cd0004b`), so the merge combines P51 with P50R only.

| File | Outcome | Resolution |
| --- | --- | --- |
| `apps/web/app/(branch)/branch/terminal/page.test.tsx` | Textual conflict | Both sides appended an independent `describe` block at end of file (P50R custom discounts / required choice; P51 break time). Both kept intact, P50R first; no assertion changed. |
| `apps/api/prisma/schema.prisma` | Auto-merged | Additive: P51's `AttendanceBreak` model, `AttendanceBreakEndReason` enum and `AttendanceRecord.breaks` relation on top of P50R's `PromotionApplicationMode` / `tax_snapshot` and P50R's column re-alignment. `prisma migrate diff` (migrated DB → schema) is empty. |
| `apps/web/app/(branch)/branch/terminal/page.tsx` | Auto-merged | Reviewed by hand: P50R's discount picker / required decision / changed-total flow and P51's Start Break / Resume / lock screen touch different regions. Two semantic interactions found and fixed (§3). |
| `packages/shared/src/types/index.ts` | Auto-merged | Additive (P51 attendance-state types next to P50R's settings types). |

Server interaction reviewed (no change needed):

- `shiftGuard` (P51) refuses an on-break token with 403 `ON_BREAK` before any write on checkout, offline batch sync,
  hold orders and proof uploads. The checkout-recovery endpoints — `GET /transactions/by-idempotency-key/:key` and
  `POST …/abandon` — are **not** behind `shiftGuard`, so a sale the server already committed stays recoverable while its
  cashier is on break (the terminal resolves with the Branch Account session token).
- The web client treats `ON_BREAK` as *not* a definite no-commit code, so a refused retry is resolved before a
  replacement key is minted — conservative, never a duplicate.
- A whole-batch `ON_BREAK` on offline sync marks rows retryable (`lastError`), never `rejection`; rows are only ever sent
  under their original cashier's token (`isOfflineSaleEligible`), so queued sales wait for that cashier.
- P50R tax snapshots, branch overrides and `TAX_SETTINGS_CHANGED` refusals are unaffected by breaks: the rate is resolved
  per request at checkout.

## 3. Integration fixes

1. **Discount decision carried to the next cashier** (`43b59ee`). Payment fields (including P50R's
   `discountChoiceMade`, the chosen discount type and custom discount) were reset only after a completed/abandoned
   sale, not when a cart was cleared by hand. After Start Break, Switch Cashier / idle lock or Clock Out, the next
   cashier inherited "No applicable discount" (or a discount) and was never asked — defeating the required decision.
   Fix: `resetPaymentFields()` at each operator-release point (the cart is already empty there). Regression test in the
   P51 block of `page.test.tsx`; verified to fail without the fix.
2. **Stale rates after a break** (`0ea1b19`). The discount policy query has no refresh interval, so a supervisor change
   made while the terminal was locked was not shown to the next cashier (or to the same cashier after Resume Work)
   until checkout refused the total. Fix: refetch when the operator changes (not on mount, which already fetches).
   Found in the real-browser run (Ben saw Employee 10% after the supervisor set 15% during Ana's break); after the fix
   the picker showed 15%.

## 4. Combined migrations

Pending against `origin/main` (inventory of the actual folder, in order — exactly these four):

| # | Migration | Kind |
| --- | --- | --- |
| 1 | `20261030120000_pos_perf_p49_promotions` | enums, `products.classification` (default), `transaction_items` discount/promotion columns (defaults/nullable), promotion tables, FK `NOT VALID` |
| 2 | `20261030120100_pos_perf_p49_classification_backfill` | `is_seasonal → 'seasonal'` backfill; `VALIDATE CONSTRAINT` (depends on 1) |
| 3 | `20261030160000_pos_perf_p50r_branch_discounts` | `PromotionApplicationMode` enum, `promotions.application_mode` default `'automatic'` (depends on 1's `promotions`), nullable `transactions.tax_snapshot` |
| 4 | `20261030170000_pos_perf_p51_attendance_breaks` | `AttendanceBreakEndReason` enum, `attendance_breaks` table, partial unique index, check constraints, FK to `attendance_records` (independent of 1–3) |

P50R's branch discount overrides and VAT registration are `system_settings` rows — no migration.

**Rehearsal** — `apps/api/scripts/test-p53-combined-migrations-on-populated-data.ts` (new): disposable embedded
Postgres on 127.0.0.1 (name `p53_<digits>`, refused otherwise); every `origin/main` migration applied, then populated
with raw SQL under that schema: 20,000 sales (⅓ Employee 15%) with items, 2 branches, a supervisor-saved organization
discount policy, seasonal + regular products, 20 items × 2 branches of stock, an active shift, and attendance (open
record, closed day shift with legacy `break_minutes` 60, overnight shift with OT, a correction and its soft-deleted
original). Then the four real migrations in one `migrate deploy`. Result **PASS**:

- all four recorded as applied; all **69** pre-existing tables: pre-existing columns byte-identical (row count + MD5);
- seasonal product → `seasonal`, other → `regular`; no sale line gains a discount/promotion; no sale gains a
  `tax_snapshot`; no break rows invented; FK validated; partial unique index present; schema drift: none;
- effective discount policy at both branches = organization Employee 15% / PWD 20% / Senior 20%, no required choice;
- the pre-existing open record reads `working`; Start Break on it → On Break; Resume closes it on the **same** record.

Migration wall time 4.3 s including Prisma CLI start-up (DDL time not isolated; not a production timing).

### Rollback prerequisites (before rolling the API back past P50R / P51)

Run read-only checks first; resolve anything they return before the old API serves traffic.

| Check | Why | Action |
| --- | --- | --- |
| `SELECT count(*) FROM attendance_breaks WHERE ended_at IS NULL` | A pre-P51 API ignores open breaks: an on-break employee would be treated as Working and could sell. | Each employee resumes (Resume Work) or is clocked out (closes the break at the clock-out time) first. |
| `SELECT count(*) FROM promotions WHERE application_mode = 'cashier_selected' AND is_enabled` | A pre-P50R API does not know `application_mode` and would apply cashier-selected discounts **automatically**. | Disable every cashier-selected discount first (P50 runbook §11). |
| Branch overrides (`system_settings` keys `discount_policy:branch:*`) | A pre-P50R API ignores them; terminals showing a branch rate get `TAX_SETTINGS_CHANGED` (refused, not repriced). | Decide whether to restore the organization rate expected at those branches; queued offline sales at a changed rate will be refused (reconcile cash per P50 §6). |

The rehearsal script asserts both detection queries find the expected rows. The schema itself is additive; rolling
back the API does not require rolling back migrations (old API + new schema is supported; new API + old schema is
not — keep migrate-before-API).

## 5. Verification

Environment: all databases new, local, disposable, owned by this session, refused by a guard unless every URL was
`127.0.0.1` on port 45000–49999 with name `pos_test`, `p53_<digits>` or `p51_53<digits>`, with
`PRODUCTION_DATABASE_URL_DIRECT` unset. Throwaway secrets generated for the session. Ports: API 4553, web 3553,
Postgres 46541 (API suite) / 46551 (browser) / random (rehearsal). Production, `pos_verify` and other sessions'
databases, processes and builds were not touched. No smoke accounts were provisioned and no queues were cleared.
The browser database was named `p51_5310302200` only because P51's fixture script accepts only `p51_<digits>`; it
was a new cluster in this session's scratch directory.

### Final integrated code (HEAD after `0ea1b19`; API code unchanged since the API run)

| Check | Result |
| --- | --- |
| API full suite, serial (`--no-file-parallelism`), real Postgres | 196 files passed / 8 skipped; 3,344 tests passed / 104 skipped; **0 failed** |
| P53 combined integration (`p53-discounts-breaks.integration.test.ts`, real Express + Postgres) | pass (in the run above) |
| Web full suite | 166 files, **1,546 / 1,546** |
| `turbo run type-check lint --force` | 7 / 7 tasks, **0 errors** (warnings: §5.3) |
| API `tsc` build, web `next build` | pass (web rebuilt after `0ea1b19`; browser run on that build) |
| Populated migration rehearsal | PASS (§4) |
| Real browser (Chromium, built web + built API, desktop 1440×900) | **15 / 15** |

P53 integration test (one end-to-end scenario through HTTP): sale while Working → Start Break → stale token new sale
403 `ON_BREAK` and offline batch 403 `ON_BREAK`, nothing written, stock unchanged → same-key retry of the committed
sale 403 (no duplicate), Branch Account resolve → `committed`, same id → abandon of a committed key reports the sale →
the refused key is fenced (`abandoned`) → supervisor sets Employee rate + required decision during the break → Ben:
no decision → `DISCOUNT_CHOICE_REQUIRED`, `none_applicable` → 201 as Ben → Ben resubmitting Ana's key never creates a
second sale or reassigns it → supervisor summary Ana `on_break`, Ben `working`, `on_break_count` 1 → other-branch
supervisor summary/settings 403, staff settings 403, Branch Account Start Break 403, other-branch Resume 403, Ben's
Resume acts on Ben (`NOT_ON_BREAK`) and Ana's break stays open, supervisor VAT registration 403 → Ana resumes on the
same record → her lost-response retry replays the original sale → the fenced key can never commit → pre-break rate
`TAX_SETTINGS_CHANGED` with nothing written; new rate 201, `discount_rate_source: branch` → queued offline sale synced
under Ana → per-row `TAX_SETTINGS_CHANGED` with a message.

Browser (B1–B15): Branch Account → Ana PIN → selling screen; required decision disables Charge; "No applicable
discount" sells; rate changed mid-checkout → "Discount or VAT settings changed — not recorded" → Review updated prices →
"Total is now ₱31.50 (was ₱28.00)…" → charged ₱31.50; cart cleared by hand → Start Break → locked, shift open; rate
changed during the break; Ben asked for his own decision and offered the new 15%; Ben sells; supervisor dashboard shows
"On break since …"; Ana PIN → Resume Work → decides again → sells at 15%; offline sale at 15%, rate changed to 12%,
reconnect → Pending row "Not accepted — Discount or VAT settings changed — not recorded … rung with 15% … now uses
12%", attributed to Ana. Database afterwards (cumulative over the iterated runs): 0 duplicate idempotency keys, 0
rejected offline sales recorded, all 3 breaks on Ana's single open record (`resumed`), sales attributed Ana 12 / Ben 2.

### 5.2 Earlier evidence (not final code — kept for honesty)

- First full API run: 5 failures in PWD/Senior tests (`p49-promotions`, `p50r-branch-discounts`, `p50-tax`) caused by
  this session's throwaway `ENCRYPTION_KEY` being hex instead of base64 32 bytes (encryption of the ID reference). Not a
  code defect; fixed the env and the rerun above passed with no code change to those areas.
- A terminal-page run while the API suite was running had 3 timing-sensitive failures (P41 stock-check fail-open, P19
  detached-sale backlog, P49 offline promotion) at 5–9 s; none reproduced in the two clean full web runs. No timeouts
  were raised.
- Browser iterations failed on script selectors (dropdown vs buttons, "Next Customer", dialog close, dashboard URL,
  Pending tab) before 15/15; one iteration exposed the stale-rate issue fixed in `0ea1b19`. Only the final run on the
  final build is counted above.

### 5.3 Typecheck / lint

`turbo run type-check lint --force` on the code before `0ea1b19`: 7/7 tasks, 0 errors (API 330 warnings = 317 after
P50R + 13 `no-console` in the new rehearsal script, same convention as the other scripts; web 1 pre-existing). Final
run after `0ea1b19`: 7/7 tasks, 0 errors, same warning counts.

### Limitations

- Browser coverage is desktop Chromium only (no tablet/phone/keyboard-only pass this time; P50R and P51 each ran those
  separately on their own code).
- The supervisor attendance UI was checked on the dashboard overview; the full attendance page was not re-walked.
- Offline sales were exercised via Playwright's offline mode, not a real device / service worker restart.
- No tax/BIR compliance is claimed beyond what the tests assert (VAT-inclusive pricing at 12%, PWD/Senior exempt
  formula as already implemented in P50/P50R).

## 6. P52 handoff (payroll — separate session)

Inspected read-only: `feat/pos-perf-p52-payroll` / `C:/Users/kaile/Downloads/pc-p52-payroll-worktree` is still at
`ac0f1b0` (P51) with **uncommitted** work (schema, `app.ts`, `pg-lock.ts`, shared schema index, reports pages, a new
payroll module and migration `20261030190000_pos_perf_p52_payroll`). Not integrated here.

- Committed integration base available for P52: `feat/pos-perf-p53-discounts-breaks-integration` at the final SHA of
  this branch. P52 should commit on its own branch, then merge this branch (or rebase only if its owner chooses — this
  session did not touch it).
- Likely overlaps when P52 meets this base: `apps/api/prisma/schema.prisma` (P50R re-aligned the `User` and `Branch`
  model blocks where P52 adds relation fields — expect textual conflicts there; `AttendanceRecord` is shared with P51
  but P52 already sits on P51), `apps/web/app/(supervisor)/supervisor/reports/page.tsx` and
  `apps/web/app/(admin)/admin/reports/page.tsx` (not changed by P50R; low risk), and the migration order
  (P52's `20261030190000` sorts after all four here — fine).
- Payroll should read `attendance_breaks` intervals where present and `break_minutes` otherwise (P51 runbook), and must
  not count an open break as worked time.

## 7. Owner decisions before release

1. Release order and window: migrations 1–4 before the API (old API + new schema is safe; the reverse is not).
2. Whether to release P50R and P51 together (this branch) or separately; the rollback checks in §4 apply either way.
3. Who may enable cashier-selected discounts and the required discount decision per branch at pilot, and the policy for
   reconciling refused offline sales (P50 §6).
4. Break policy expectations (paid/unpaid, maximum length) — P51 records intervals only; payroll (P52) decides use.
5. Whether a tablet/phone browser pass is required on this combined build before pilot.
