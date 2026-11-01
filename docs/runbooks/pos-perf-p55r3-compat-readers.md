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

## What this release cannot do

It cannot create a manual-total sale. There is no manual-total checkout UI, no new request field, no API change and no
migration in this branch: `calculation_mode` does not exist in its Prisma schema, so neither its API nor its web can
write one. The only manual-total data it can meet is data written by release 2 (or forwarded from a release-2 offline
queue after a web rollback, below), which it reads and forwards without re-pricing.

## Deploy

1. **No API behavior or schema changes**, but this is not a web-only deploy. A merge to `main` runs
   `deploy-production.yml` as usual: after the `validate` gate and owner approval it stages the web on Vercel, runs
   `prisma migrate deploy` (no new migrations here, so nothing is applied), redeploys the Render API at this SHA (same
   API source as `042a700`) and promotes the web. Both platforms are redeployed; only the web's behavior changes.
2. Reload terminals and back-office browsers. One **online** reload is enough: the installed service worker serves the
   new build on the next navigation (verified, below). An open page that is never reloaded keeps 042a700.
3. Leave it in place long enough for every device to reload, and confirm per terminal (open the POS, check that a
   receipt renders), before release 2 is authorized.

**Rollback** to `042a700` web is safe **only while no manual-total sale exists**. Before this release, production
does not have `transactions.calculation_mode` (it arrives with release 2's migration
`20261101130000_pos_perf_p55r2_calculation_mode`), so check that the column exists first and count only if it does:

```sql
-- 1. Does the column exist?
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'calculation_mode'
) AS has_calculation_mode;
-- 2. Only if step 1 is true:
SELECT count(*) FROM transactions WHERE calculation_mode = 'manual_total_v1';
```

Column absent → no manual-total sale can exist; rollback to `042a700` is safe. Column present and count = 0 → safe.
Count > 0 → roll back to this release, never below it. (Not run against production in this pass.)

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
| Web rollback P55R3 → compat with a queued manual-total sale and a lost sync response — first run | B0–B3 pass. **B4 automated result: FAIL**: the harness looked the cashier up by name and matched the seed's other "Ana". The stored row was inspected by hand at the time; that is not a substitute for the assertion and is not counted as a pass |
| Same scenario, rerun once (harness `v-sw-b.mjs`: cashier by fixture `employee_id = 'P55-ANA'`, sale by this run's `device_id` + offline number, since a fresh browser context reuses `OFFLINE-0001` the same day) | B0 pass; B1 pass (queued `manual_v1` / `manual_total_v1`, cashier = fixture P55-ANA). **Then the run aborted**: the reconnect `page.reload` returned `net::ERR_ABORTED` while the intercepted sync request was in flight (the reload/worker race already noted as a harness issue in P55 §14.6). **B2–B4 were not evaluated. This scenario has no passing automated result.** Not rerun again |

Unit coverage for the same invariants (`sync-queue.test.ts`): a newer-build row is forwarded with its own
`discount_flow` / `manual_discount` / `tax_basis` and its unchanged `offline_provisional_number` (the offline idempotency
key with the device id); it is sent only under the token of the cashier who rang it; this build's own rows carry
neither field.

### After the PR edits (2026-11-01)

Affected web files, run together: `sync-queue`, `receipt-tax-lines`, `utils`, `kpi-card`, `reports-view` — **68 / 68**.
Added: a calculated ₱0 VAT (PWD/Senior, `legacy_vat_v1`) is not shown as "not calculated"; `formatVatAmount(0)` is
"₱0.00" and `null` is "Not calculated"; forwarded rows keep their offline number and original cashier. The full suite
was not repeated locally; PR CI is the complete isolated run.

## Known limits

- **Old cached clients.** A 042a700 page already open and never reloaded keeps its code, and a 042a700 build loaded
  offline from the service-worker cache stays 042a700 until the device is online and navigates once. Either one
  crashes on a manual-total receipt and shows "₱0.00" or a silent VAT total in Reports. Deploying code cannot fix
  that, which is why release 1 must reach and be reloaded on every device before release 2 rings a manual-total sale.
- The web-rollback queue scenario has no passing browser result (above). Its forwarding logic is covered by unit tests.
- Desktop Chromium only; real iOS/Android devices and installed PWAs were not tested. Production data shapes were not
  read.
- PR CI passing means the branch validated. It does not mean production is updated: that needs the merge, the
  `deploy-production.yml` approval and the device reloads above.