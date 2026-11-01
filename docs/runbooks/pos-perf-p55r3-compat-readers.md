# POS-PERF-P55R3 — compatibility release: read manual-total sales truthfully

Branch `release/pos-perf-p55r3-compat-readers`, one code commit `a414bf1` on the deployed base `042a700`. Release 1
of 2. Release 2 (the P55 manual-total checkout) is `feat/pos-perf-p55-manual-discounts`, which merges this branch;
its full plan is `docs/runbooks/pos-perf-p55-manual-discounts-and-proof.md` §14 on that branch.

## Why it exists

The P55R2 checkout records sales whose VAT is **not calculated** (`calculation_mode = 'manual_total_v1'`; the API
returns `vat_amount: null`). The deployed `042a700` web cannot show them (verified in a browser against the P55 API):

| Reader in 042a700 | Manual-total sale |
| --- | --- |
| Public receipt `/r/<number>` | "Application error" (`formatPeso(null)`) |
| Branch Sales → receipt (POS `ReceiptModal`, also the terminal's View Receipt) | the whole page: "Application error" |
| Reports rows, transaction detail, admin drilldown | VAT "₱0.00" (`Intl` formats null as 0) |
| Reports "VAT Collected" | manual-only period "₱0"; mixed period silently leaves them out |

None of that can be fixed in an already-loaded 042a700 bundle, and the API must not send a false number. So this
release ships the tolerant readers first, while **no manual-total sale can be written** (no build in production writes
one: this release adds no checkout, request field or API change).

## What changes (web + shared response types only)

- Receipts: "VAT not calculated by this checkout" — never a VATable/VAT/exempt breakdown, never "VAT ₱0.00". Legacy
  and PWD/Senior receipts are unchanged. A discount type this build does not know shows as "Discount" (on `/r/`, the
  type name the API froze on the sale).
- Reports / detail / drilldown / Discount Compliance: "Not calculated". "VAT Collected" says "VAT-calculated sales only —
  excludes N manual-total sale(s)", or shows "Not calculated" when no sale in the period calculated VAT; a "Without VAT
  Calculation" card shows those sales and their amount paid. Admin Daily Sales gets "Without VAT Calc." when the API
  reports it. A genuine calculated ₱0 VAT (PWD/Senior) still shows "₱0.00".
- Offline queue: a sale a newer build queued in the same browser (only possible after a web rollback) is forwarded
  with its own `discount_flow` / `manual_discount`, so it syncs in its original mode. Rows this build queues are sent
  byte-for-byte as before.
- Not changed: API source, migrations, `DISCOUNT_TYPE` and every request schema, tax formulas, checkout.

## Deploy

1. Web only (the API build is unchanged; deploying it is unnecessary).
2. Reload terminals and back-office browsers. One **online** reload is enough: the installed service worker serves the
   new build on the next navigation (verified, below). An open page that is never reloaded keeps 042a700.
3. Leave it in place long enough for every device to reload before release 2 rings any manual-total sale.

**Rollback** to `042a700` web is safe **only while no manual-total sale exists**
(`SELECT count(*) FROM transactions WHERE calculation_mode = 'manual_total_v1';` = 0). Afterwards, roll back to this
release, never below it.

## Verification (2026-11-01, local disposable DB, real browser on final builds)

Embedded Postgres 18.4 on `127.0.0.1:46755`, DB `p55b_311013`; API `API_PORT=4755`; webs on 3755/3756/3757/3760;
Chromium (Playwright 1.61.1). Details and the remaining cases are in the P55 runbook §14.

| Check | Result |
| --- | --- |
| type-check + lint (api, shared, web) | 7 / 7 tasks, 0 errors |
| shared 41 / 41 · API receipts/reports/report renderers 93 / 93 | pass |
| web suite | 1551 / 1554 in the full parallel run; the 4 failing files re-run alone: 203 / 203 (3 timeouts under load + one file read mid-edit) |
| Compat web → P55R3 API: receipts, receipt modal, Reports in legacy-only / manual-only / mixed / whole periods, desktop 1440 / tablet 820 / phone 390 | **18 / 18** |
| Compat web → actual 042a700 API: legacy sale | ₱500, VAT ₱53.57, mode NULL — as 042a700 |
| Service worker 042a700 → compat (same origin) | open page not reloaded: still crashes (expected); online navigation / reload: compat; offline reload: the cached 042a700 build |
| Web rollback P55R3 → compat with a queued manual-total sale and a lost sync response | one sale, `manual_total_v1`, ₱750, flow `manual_v1`, cashier unchanged |
