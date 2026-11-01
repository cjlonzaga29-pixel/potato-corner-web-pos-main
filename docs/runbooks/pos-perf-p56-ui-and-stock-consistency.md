# POS-PERF-P56 — Stock consistency, payroll visibility, settings cleanup, flat PIN layout

Status: committed locally on `feat/pos-perf-p56-ui-and-stock-consistency`. Not pushed, not deployed. No migration.
Starting SHA, final SHA and git status are in section 9.

## 1. Reproduced causes

**"POS says Out of Stock, the dashboard says zero alerts, Transfer says No stock needs."**

| Cause | Where | Effect |
| --- | --- | --- |
| Two rules for one question | `classifyStockStatus` returned `healthy` at zero when an item had no thresholds; the POS divides available stock by the recipe quantity directly | POS: Out of Stock. Dashboard, Inventory and Transfer: nothing to report |
| A recipe can need more than an item has | 3 available, recipe needs 10: the POS blocks, while the item is positive and has no thresholds | The item is correctly not "out", so a shortage had no visible home outside the POS |
| POS gave no reason | Card showed only "Out of Stock" | Nobody could tell which ingredient, or whether reservations caused it |
| Other counts used other rules | `countLowStock` used on-hand and ignored tracking. The Admin rollup used on-hand, and treated zero without thresholds as a placeholder | Branch, Admin and Supervisor views could disagree |

Checked and **not** a cause: branch caches. The queries are keyed by branch, and the dashboard and transfer page already
drop responses for another branch. The Inventory page's alert banner lacked that guard; it now has it.

Requested UI changes (not defects): a Payroll entry, Supervisor Cash Management removal, the settings cleanup and the flat
PIN screen.

## 2. Final stock definitions

The rule lives in `apps/api/src/modules/universal-inventory/stock-classification.ts`.

- **Available** = on hand − reserved, floored at 0. This is the figure checkout reserves against.
- **Out of stock**: tracked, active item with available ≤ 0, with or without thresholds.
- **Critical**: available > 0 and at or below the critical threshold.
- **Low**: above critical and at or below the low threshold.
- **Healthy**: everything else. Positive stock without thresholds is healthy; no threshold is invented.
- **Untracked items** are never in dashboards, filters or transfer needs. They still add to inventory value and item count.

API compatibility: `status` and `severity` keep their three values, and no-stock items report `critical`, so older clients
keep working. The web derives "out" from `quantity_available <= 0` (`lib/inventory-stock-status.ts`), which gives three
buckets that never overlap and also works against an older API.

Where the rule is used: Supervisor dashboard cards, Inventory filters (new **Out of stock** filter), Transfer stock needs,
the Admin valuation rollup, branch stats (`lowStockIngredientCount`, relabelled "Items Needing Stock" on the branch
dashboard) and the inventory valuation report row status.

**Product counts and item counts are deliberately separate.** The new dashboard panel "POS product sizes that can't be
sold" reads the POS's own catalog, keyed per branch. One empty item can block many sizes, and a size can be blocked by an
item with some stock left, so the panel and "Inventory item alerts" are not expected to match.

**Reasons shown** (`stock_shortages`, an optional additive catalog field): no stock; fully reserved by pending sales;
"3 available, 10 needed for one"; not assigned to this branch; not tracked but its recipe still needs stock. A setup
problem is labelled "Setup incomplete", separately from "Ingredient shortage". A product a supervisor turned off is not on
the POS, so it is never reported as a shortage.

Not changed: balances, transfers, assignments, product enablement, checkout stock checks, reservations, deductions.

## 3. Payroll routes and permissions

Payroll was not rebuilt.

- Route: `/supervisor/reports/payroll`, now a top-level **Payroll** sidebar item. Reports stays reachable; only one of the
  two items highlights. The Admin route `/admin/reports/payroll` is unchanged.
- **Payroll Settings**: a header button and tab on the page, plus a card on Supervisor Settings that links to
  `?tab=settings`.
- Missing policy: guidance with "Open Payroll Settings". Missing rates: names the current staff with no rate in effect and
  offers "Add rates in Payroll Settings".
- API unchanged: `/api/payroll/*` stays `adminOrSupervisor` with branch scope. A supervisor gets 403 for an unassigned
  branch and a Branch Account gets 403.
- Effective-dated rates, break calculations and finalized history were not touched. No rate or break policy is invented.

## 4. Cash Management access

- Removed from the supervisor sidebar. `/supervisor/cash` and `/supervisor/cash/:shiftId` show a notice with links to
  Reports and the Dashboard, and no longer list or open shifts.
- Dashboard transaction rows and supervisor `cash_variance_flagged` notifications now go to Reports.
- **No API permission changed.** `/api/cash/*` consumers include the terminal's shift lookups, the Admin shift pages and
  the Branch pages, so all remain as they were. No record, table or checkout service was touched.
- **Behaviour to note:** supervisors no longer have a screen for shift or variance review. The screen remains under
  Admin → Shifts, and the endpoints still allow supervisors.

## 5. Settings cleanup; what did not change

- Supervisor Settings order: Discount types, Work Hours, Payroll Settings link, then a collapsed "Statutory & legacy VAT
  settings" section. The Admin Discounts tab (renamed from "VAT & Discounts") has the same structure.
- The VAT card is now "VAT calculation reference" and says ordinary manual sales are subtotal − discount with no VAT
  calculated.
- Work Hours explains that regular attendance hours are not pay, and names the organization default (Super Admin),
  branch overrides and who edits them (assigned supervisors). Admin sees an oversight view.

Unchanged: manual-total math, statutory formulas, `computeSaleTax`, historical reports, proof requirements and binding,
promotions, stored tax and discount data. Legacy controls are collapsed, not removed or disabled.

## 6. Flat PIN terminal

Removed the enclosing card, border, shadow, panel background, divider, icon tile and status badge. Only the keypad's own
keys keep outlines. Keypad, limits, verification, clock-in/out, break/resume, Switch Cashier and locking are unchanged.

## 7. Verification

Environment: a new embedded PostgreSQL 18.1 cluster on `127.0.0.1:46656`, data in this session's scratchpad, databases
`p56_test` (suites) and `p56_browser` (browser). Every `prisma migrate deploy` printed its `127.0.0.1:46656` target.
`PRODUCTION_DATABASE_URL_DIRECT` was unset. Throwaway `ENCRYPTION_KEY` and `HASH_KEY`. Ports: API 4656, web 3656, storage
stand-in 54656. Production, `pos_verify`, Docker containers and other sessions' databases were not touched.

Final results are in section 9.

**Browser, final builds (`next build` / `tsc`), Chromium:**

| Section | Result | Covers |
| --- | --- | --- |
| Stock | 23 / 23 | zero and positive without thresholds; reserved; untracked; disabled; unassigned; card = filter = transfer needs; branch switch both ways, including mid-refetch; 403 on an unassigned branch |
| Payroll | 8 / 8 | sidebar, deep link, missing policy and rate guidance, no invented rate, 403 scope |
| Cash and Branch Account | 8 / 8 | no menu item, notice on both routes, endpoint unchanged, Admin and Branch routes intact, Branch Account refused by payroll |
| Settings | 9 / 9 | order, collapsed legacy, keyboard opening, Work Hours wording, Admin oversight |
| PIN layout | 10 / 10 | light and dark at desktop, tablet, tablet landscape, phone 360×640, short 740×360: flat, keys ≥ 48 px, Continue reachable, no sideways scroll, title contrast 17.6:1 |
| Checkout, proof, break | 19 / 19 | keyboard PIN, wrong-PIN error, POS reasons, ₱35 cash sale, proof-required ₱70 − ₱10 = ₱60, Start Break, Resume, Switch Cashier, stock 1000 → 997 |

These sections were run in two passes. The first combined run scored 36 / 42, then 53 / 58 after fixes. Failures were
traced to: the driver's extra API logins invalidating sessions; the login and general rate limiters when all scenarios ran
from one IP (429s); a selector that exists only in unit-test mocks; a discount type created on the wrong branch; and one
real issue, the `?tab=settings` read, moved to after mount to avoid a hydration mismatch. Stock, Cash and PIN were then run
separately, restarting the API between them to clear its in-memory limiter, which was itself left unchanged. Payroll
(except its Branch Account check, moved into Cash), Settings and Checkout passed in the 53 / 58 run on the same build.

## 8. Limitations and open decisions

- **Untracked recipe items:** checkout reserves every recipe line regardless of `trackInventory`, and a missing stock row
  counts as insufficient. An untracked item with no balance therefore still blocks the sale. Checkout was to be preserved,
  so the POS keeps blocking and names the reason, and dashboards do not flag the item. If untracked items should sell
  freely, that is a checkout change needing its own decision.
- **Supervisor shift review** now has no screen; see section 4.
- **Notifications:** `notifyIfLowStock` still skips items without a low threshold, so a no-threshold item reaching zero
  shows on dashboards (polling every 30 s) but sends no notification. Left as is to avoid new alerts at every branch.
- **Storage:** browser proof uploads used an in-memory stand-in, not real Supabase Storage. The proof pipeline was not
  changed.
- **Clock-in:** the browser fixture opens attendance directly, so GPS clock-in was covered by existing tests, not here.
- **Realtime:** the dashboard showed "Reconnecting" in this local setup, so socket pushes were not exercised in the
  browser. Polling supplied the data.
- **Scratch deletion during the session:** at about 22:10 something outside this work deleted files under the Temp folder,
  including this session's scratch files, the first disposable cluster and an older session's files. The cause was not
  identified. The first API run was discarded and everything was rebuilt on a new cluster.
- `apps/api/scripts/p56-browser-fixtures.ts` refuses anything but `127.0.0.1` + `p56_browser`.

## 9. Results and SHAs

Final full runs, on the final code, one at a time:

| Check | Result |
| --- | --- |
| API full suite, serial, real Postgres | **211 files passed / 1 skipped; 3,565 passed / 5 skipped / 0 failed** |
| Web full suite | **175 files; 1,598 / 1,598** |
| `turbo type-check lint --force` | **7 / 7 tasks, 0 errors** (API 383 `no-console`-style warnings, the repo's script convention) |
| Builds | shared `tsc`, API `tsc`, web `next build`: pass |

Earlier failed full runs, all fixed before the runs above: API 2 failed / 3,563 passed (assertions of the old stock rule);
web 24 failed / 1,573 passed (dashboard test missing the new catalog hook mock, a renamed tab, reworded text). One earlier
API run was discarded because its log and database were deleted mid-run (section 8).

- Starting SHA: `ed941e9` (last reported deployed commit). Local `main` was at `042a700`, 15 commits behind, and was left
  as it was.
- Branch: `feat/pos-perf-p56-ui-and-stock-consistency`. Code commit: `c284aa3`. This runbook is the commit after it.
- Git status after committing: only `.vscode/settings.json` modified (`python.terminal.useEnvFile`, changed outside this
  task at 22:10:35; deliberately not staged or reverted).
- Not pushed, not deployed; no production access, migration, account provisioning or queue clearing.
