# POS-PERF-P59: reports and UI cleanup

Removes visible VAT, shows the discount name saved on each sale, turns Discount Compliance into the Discount Report, adopts
familiar Daily Sales Report (DSR) wording, and removes one line of employee-list text.

**This changes presentation only.** Stored sales, totals, calculation modes, refunds and tax formulas are unchanged, and there is no migration.

| | |
|---|---|
| Started from | `origin/main` `6931b10`. PR #44 is not included |
| Tested code | `e6a4d1a`, on `c341814`. Readiness follow-up (§10): `61b4df1`, on `050056d` |
| Production | Not accessed. Nothing pushed, merged or deployed |

## Decisions the owner should confirm

> **Resolved 2026-11-21 (CR-010, P63):** the owner removed VAT as an active feature, which settles items 1–3 below as intended. The VAT-registration write endpoint is now removed too. See [`pos-perf-p63-vat-retired.md`](pos-perf-p63-vat-retired.md).

These follow the P59 instructions, but they have consequences outside the code:

1. **Receipts no longer show VAT lines.** That includes historical VAT-registered and PWD/Senior VAT-exempt sales. Please confirm this suits the business's receipt obligations with whoever handles BIR compliance. Git revert restores the lines, and the figures are still stored and returned by the API.
2. **Normal exports no longer have VAT columns.** Anyone who needs historical VAT totals now has to get them from the API or the database.
3. **Super Admins can no longer see or record a branch's VAT registration.** The screen is gone. The API endpoint and stored records remain.

## 1. Causes

| Symptom | Cause | Fix |
|---|---|---|
| A type named PWD read "Manual" | Each surface ran `humanize(discount_type)` on the stored code `manual`, ignoring the name in `manual_discount_snapshot`. The Transactions PDF did too, and the shift view and detail dialog printed the raw code | One rule, `discountDisplayName` |
| Proof rate looked wrong | Every PWD/Senior sale counted as requiring proof, though the server has never enforced that for them (`transactions.service.ts`). Custom types were left out entirely. It also read only the newest 100 sales | Counted from each sale's saved evidence, across the whole range |
| Export could disagree with the screen | The Supervisor export took the newest `limit` sales, then filtered to discounted ones | Filtered in the query |
| Detail table could miss discounted sales | It filtered the newest 100 completed sales in the browser | Its own server-paginated query |

## 2. Discount name rule

`packages/shared/src/discounts/discount-display.ts`, used by every surface:

| Saved on the sale | Shows |
|---|---|
| `manual` with a snapshot name | That name, for example `PWD`. Rename or deactivation doesn't change it |
| `manual` with no readable name | `Unspecified discount`. Nothing is guessed from the proof, the amount or the current type list |
| `pwd`, `senior_citizen`, `employee`, `manager_override`, `promotional` | `PWD`, `Senior Citizen`, and so on. Historical labels only, not checkout choices |
| A code this build doesn't know | `Unspecified discount`, never the raw code |

**Receipts** use `discountReceiptLabel`: `PWD discount`, or `PWD Discount (20%)` with the rate frozen on a built-in type. With no readable name they show plain `Discount`.

**Amount mode** (staff-entered or fixed) is not part of the name.

**Identity is not the name.** `discountIdentityKey` gives `manual:<type id>` or `type:<code>`, and sales are grouped and filtered by that:

- Each branch has its own type row, so a `PWD` at two branches stays two identities, even when created in one action.
- A type deactivated and recreated under the same name is also two identities.
- A renamed type stays one row. It shows the newest saved name, plus "Also saved as:" for older names in the period. Each sale keeps its own name.

**No backfill.** Manual sales have always saved a snapshot, so genuinely nameless sales should be rare. Their type's current name is deliberately not used, because it could be wrong for that sale. Nothing was repaired.

## 3. Proof rule

`discountProofRequirement` reads only what the sale saved. Today's type settings never change the answer.

| Sale | Requirement | In the completion denominator |
|---|---|---|
| Manual, snapshot `require_proof: true` | Required | Yes |
| Manual, snapshot `require_proof: false` | Not required, even with a photo attached | No |
| Manual with no snapshot | Unknown | No |
| Older-checkout PWD / Senior Citizen | Unknown: that checkout accepted proof but never enforced it | No |
| Employee, promotional, manager override | Not required: these never had proof capture | No |

- **Proof Completion** = required sales with proof ÷ required sales.
- With no required sales it reads **N/A**, not 100%.
- Unknown sales are stated separately ("N sales with no saved requirement not counted"), never as missing.

**Numbers will move.** Periods dominated by older PWD/Senior sales now read N/A instead of a percentage. That is the intended correction.

Camera and gallery upload, proof binding, one-sale use and access checks are unchanged.

## 4. Changed surfaces

**VAT removed from view:**

- Daily Sales cards and columns, Sold Product Transactions, transaction detail, Admin Daily Sales and Discount tables
- Internal and public receipts, the checkout total, Transactions PDF, and report CSV/PDF columns
- Promotion price preview and its VAT notice
- Settings: `TaxSettingsSection` and `BranchVatRegistration` are deleted; the VAT columns and wording in the legacy statutory section are gone

**Kept in Settings:** the discount types link, and the collapsed legacy statutory rates, because terminals on older POS versions still depend on them.

**Discount Report:**

- The tab and report are renamed. PDF title and download name become `Discount Report` and `DiscountReport_*`.
- `DISCOUNT_COMPLIANCE`, `/api/reports/discount-compliance`, the `discount-compliance` tab id and the `discount_compliance_flagged` notification keep their identifiers.
- Fixed PWD and Senior cards are gone. Total Discounted Transactions and Total Discount Amount stay.
- New: type breakdown, type filter, proof summary, and Proof Requirement in the drill-down and export. Filter choices come only from sales in the range, so deactivated types appear and no default types are added.
- The filter applies to the KPIs, breakdown, detail table, Admin export and Supervisor export. A choice that drops out when the branch or dates change falls back to all types.
- Admin's report category is still named "Compliance", as it also holds Void / Refund.

**Employees:** "Managed by Super Admin" is gone. Those rows still offer no actions, and the server still refuses them.

**Staff (found in browser testing):** staff can open `/branch/reports`, but the report API refuses them. They saw a false `0` and `₱0` beside an error, so they now get only the sales list. A failed summary reads "Unavailable" for every role. No access changed.

## 5. DSR wording

| Before | After | Where |
|---|---|---|
| Daily Sales | Daily Sales Report (DSR) | Report tabs, PDF title |
| Opening Stock | Beginning Stock (Beg.) | Inventory Summary, exports. It really is the day's start: on-hand minus today's movements |
| Consumed Today / This Month | Stock Used Today / This Month (Sales) | Same, plus inventory list and dashboard panel |
| Consumption Summary / Inventory Consumption | Stock Used Summary / Stock Used (Sales) | Tab, dashboard panel, exports |
| Receiving, Stock In (report KPI) | Deliveries / Received | Movement label and report KPIs that count `RECEIVING` |
| Staff Clocked In, Clocked In Now | Crew on Duty | Dashboards, Attendance Summary. These count open attendance records |
| Clock In / Clock Out (report columns) | Time In / Time Out | Attendance reports and export |

"(Sales)" stays in the stock labels because those figures count `SALE` movements only, not spoilage or adjustments.

**Deliberately unchanged:**

- **Remaining** is not "Ending Stock": it is live on-hand, not an end-of-day figure. No screen had a real closing-stock figure.
- **Stock In** stays as the action on its form and in stock history.
- **Clock In / Clock Out** stay as actions, and "Still clocked in" as a status.
- **Total Sales** stays; it isn't Cash on Hand. **Opening Cash** isn't stock.
- **Total Staff Today** keeps its existing label and count.
- **Currently Clocked In, Staff Timed In** and the branch table's **Clocked In** are status labels on other screens, unchanged.
- **Pull Out, Yield and Cash Breakdown** were not added: no such data exists.
- **CSV `movement_type`** still prints raw codes such as `RECEIVING`, as before.

## 6. Compatibility

**Stored data and API fields stay.** `vat_amount`, `vat_exempt_amount`, `calculation_mode`, `vat_total`, `tax_not_calculated_*`, `total_vat_exempt_*`, `tax_calculation`, raw `discount_type` and the tax settings endpoints are all still returned. New fields and filters (`discount_key`, `discount_name`, `proof_*`, `discounted_only`) are additive.

**Behaviour changes for API readers:**

- `/api/reports/discount-compliance` returns one `manual` row per type instead of one for all manual sales. Summing them gives the same totals.
- It now reads each discounted sale, because the name and requirement live in the JSON snapshot. See the limits in §8.

**Exports change for every date range,** including past periods. Stored amounts don't. Removed columns: VAT, Tax Calculation, Sales / Amount Paid Without VAT Calculation, VAT-Exempt Sales, Non-VATable Amount. Anything parsing exports by header must also expect the new Time In, Stock Used, Discount Report and proof columns, plus the `DiscountReport_*` and `StockUsedSummary_*` file names.

**Reworded messages:** cashier-facing refusals no longer mention VAT, but codes and behaviour are unchanged (`TAX_SETTINGS_CHANGED`, `CALCULATION_MODE_REQUIRED`). Internal VAT messages remain on the tax profile endpoint, which no screen calls now.

## 7. Verification

Everything ran on a disposable local Docker `postgres:16` on `127.0.0.1:55959` (`p59_disposable`, `p59_browser`), API on 4159, web on 3159, with generated throwaway secrets and a local stand-in for Supabase Storage. All of it has been removed.

**Final run on `e6a4d1a`, sequential, freshly migrated database:**

| Check | Result |
|---|---|
| Full API suite, serial | 3,666 passed, 5 skipped, 0 failed (217 files passed, 1 skipped) |
| Shared suite | 73 passed |
| Full web suite | 1,633 passed, 0 failed (177 files) |
| Typecheck: shared, API, web | Clean |
| Lint: API, web | 0 errors. 397 API warnings, 1 web warning (not from P59) |
| Production builds: shared, API, web | Pass |
| Browser, final production builds | 87 / 87, no rate-limited requests |

The API total includes `p59-discount-report.integration.test.ts`, which covers all nine requested scenarios end to end.

**Files opened, not just mocked:**

- Discount Report CSV and PDF (Supervisor and Admin), including a filtered export
- Daily Sales CSV and PDF, Transactions PDF
- Stock Used Summary, Attendance Summary and Inventory Summary CSVs

On the same data the on-screen ₱184.29 matched the export.

**Browser coverage:** Admin, Supervisor, staff and Branch account screens; desktop, then tablet and phone for the Discount Report; proof viewing; filtering; rename and deactivate; same-named types at two branches; public receipts.

**Failures along the way, in order:**

- **First web run:** 49 failed. 48 were tests pinned to old labels or VAT behaviour, since updated. One was a timeout in `use-cart-stock-validation`, a file P59 didn't touch. It passed in the two full runs after that. Load is the likely cause, not proven.
- **First full API run, `c341814`:** 1 failed. A P55 test assumed one `manual` report row. This was the intended change, so the test now checks totals across rows, and the whole suite was re-run.
- **Browser passes:** 0/1, 1/2, 5/8 twice, 40/51, 48/51, then 87/87 on `c341814` plus the driver changes, then 87/87 on `e6a4d1a`. The earlier failures were my driver: selectors, branch choice, timing and uppercase headers. The 40/51 pass also hit the real 100-requests-a-minute limiter, so the driver now paces itself; the limiter was never bypassed.
- **Real defect caught by reading a screenshot after a green run:** the staff false ₱0 in §4. The first 87/87 didn't assert it. It was fixed in `e6a4d1a` and the driver now checks it.

## 8. Limits and gaps

**Not tested:**

- Real phones or tablets (Chromium viewport emulation only); printing (`window.print`)
- Offline flows. The worker-active terminal run is in §10
- New web with an older API, or old web with the new API. During that overlap, the old web shows several "Manual" rows, and the new web shows `Unspecified discount` for manual rows with no filter effect, until both are updated
- PDF exports from the staff and Branch account roles
- Production data volume

**Known limits:**

- **Report cost:** the aggregate loads each discounted sale's snapshot, and `eligible_product_ids` can make those large. It should be fine for a branch and a normal date range, but it wasn't measured. Worth reviewing in the performance batch.
- **Export ceiling:** Supervisor and Branch record-level exports hold the newest 10,000 rows (CSV) or 100 (PDF), and say so when they stop short. See §11, which replaces the 2,000-row PDF limit in §10.
- **Breakdown** reads up to 100 summary rows per request, so totals undercount beyond that. The screens now say so. See §10.
- **Limiter:** the Reports page adds one request on load and one on the Discount tab, against the existing 100 a minute per IP.

**Existing, not changed:**

- Staff get 403 from Export on `/branch/reports`. That route isn't in their sidebar.
- The Branch account is sent away from `/branch/reports`. It uses sales, receipts and the dashboard, and the export API works for it with the customer ID removed.
- Shift Summary keeps its `PWD/SC Txns` column and count.
- `omitWhenEmpty` and `partialCoverageHeader` remain in the export code with no column using them.

## 9. Rollout and rollback

**Rollout:**

- No migration or data step. The API and web can deploy in either order, with the overlap behaviour in §8.
- Tell anyone who uses exports about the column and file name changes first.
- After deploying, sell one discount with a custom type at one branch, then check its report row, receipt and CSV.

**Rollback:** revert `c341814` and `e6a4d1a` (plus the docs commit). Nothing stored changed, so no data step is needed, and all VAT screens return.

The browser fixture is `apps/api/scripts/p59-browser-fixtures.ts`. The driver was session scratch and is not committed.

## 10. Readiness follow-up: limits and the real terminal

Starting SHA `5cce460`. Code tested in the browser `61b4df1`, on `050056d`. Everything here is local. **Production was not accessed, and nothing here says what is deployed.**

### Limit behaviour

| Surface | Limit | Complete | Cut short |
|---|---|---|---|
| Supervisor and Branch CSV | Newest 10,000 | File unchanged, byte for byte | First line `PARTIAL EXPORT: ...`, file name ends `_PARTIAL.csv` |
| Supervisor and Branch PDF | Newest 2,000 | Header line `Coverage: all N matching discounted sales`, with their total | Boxed notice on page 1, `PARTIAL EXPORT` in every footer, file name ends `_PARTIAL.pdf` |
| Discount Report screens | 100 summary rows per request | `Totals cover all N matching discounted sales.` | `Partial totals` alert, using the API's own total |
| Supervisor and Branch screen, before export | Same as the files | Nothing | `Exports will be partial`, naming the formats, once the sales exceed a limit |
| Admin drill-down | None now | Pages through the server. The pager shows the true total | Not applicable |
| Supervisor detail table | None | Already paged through the server | Not applicable |

- **Detection:** the export asks for one row past the limit, so a file holding exactly the limit reads as complete. No count query was added.
- **Totals:** a partial file's total is labelled `for these exported rows only`, with the date span they cover, and points to the screen for all matching sales. The screen totals come from the aggregate, which covers every match.
- **Download message:** a partial file also gets a warning toast, but the label inside the file is what lasts.
- **Audit:** `REPORT_EXPORTED` for this export now records `partial`.
- **Admin's exports** list summary rows, so these row limits don't apply to them.

A partial CSV's first line is not the header row, so a tool importing it blindly would misread it. That is deliberate: such a file should not pass as complete.

### Two defects this found

**1. Reload recovery could charge a sale twice. Fixed in `61b4df1`.** After a lost reply and a reload, the terminal correctly showed `Sale completed` but left the sold items in the cart, which `sessionStorage` had restored. Next Customer or Escape closed the dialog with those items ready to charge. Charging them minted a new key. Reproduced in the browser on the build before the fix: a second real sale and a second stock deduction (sales 2007 to 2008, stock 915 to 900). Both recovery paths now clear the cart, as `handleCharge`'s own resolve already did. An attempt that never committed keeps its cart.

This code predates P59, so any deployed build with this recovery path and the persisted cart probably has it. That was not checked against production.

**2. Large PDFs froze the API. Reduced, not eliminated.** P59 raised this PDF from 100 to 2,000 rows, and rendering blocks the event loop. With one `Page` element it took about 52s for 500 rows and 154s for 1,000, and 2,000 did not finish in the 190s left. Above 100 rows, `generatePdf` now splits rows across `Page` elements. Reports of 100 rows or fewer keep their exact layout. This applies to every report's PDF above 100 rows, and a group boundary can leave a part-empty sheet. No row is lost: a real 2,000-row file held all 2,000 on 251 sheets.

**Still open:** in the browser run, a 2,000-row PDF took 25.1s, and the worst `/health` response during it took 17.4s. Every branch's checkout would wait about that long. Measured on one laptop, not on the hosted API.

### Terminal run

Final production builds of `61b4df1`, fresh database, API on 4161 behind a local proxy on 4160, web on 3160, real local Supabase Storage (`storage-api` through the local gateway). **95 / 95.**

| Area | Result |
|---|---|
| Service worker | Active and controlling every terminal session and the Supervisor report page, including after reload. Chromium, not a real device |
| No-discount sale | Cart, payment, Charge, receipt. One sale, one deduction |
| PWD sale | Type created on the Supervisor screen. Choose, enter ₱30, upload, Charge. Subtotal 200 - 30 = total 170; tendered 200, change 30. Cashier is Ana, not the branch account |
| Saved name | PWD on the receipt, public receipt, Discount Report, transaction details, CSV, PDF and Admin drill-down |
| Rename, then deactivate | PWD unchanged on the report row, receipt, CSV and stored sale. The terminal stops offering the type |
| Proof | A real object in local Storage, on the correct sale. The Supervisor saw the 640x480 image through a signed URL. Admin 200, another branch's supervisor 403 |
| Lost reply, Retry | Server committed, client saw a failure. Retry resolved to the same sale, once |
| Lost reply, reload, Next Customer | Recovered as completed, cart empty, one sale |
| Lost reply, reload, Escape | Cart empty, Checkout disabled, one sale |
| Request never arrived, Retry | Exactly one sale |
| Ledger | 6 sales, stock 1000 - 5 - 10 - 5 - 15 - 10 - 20 = 935, one SALE movement per sale, none pending |
| Queued rows | Read only, nothing cleared: `offlineTransactions` 0 |
| Large data, 2,002 sales | Screen warned for PDF only. CSV complete with 2,002 rows. PDF labelled partial with exactly 2,000 rows, opened and read. Admin pager showed 2002 rows and reached page 2 |

Lost replies were real network cuts: a one-shot proxy in front of the API either forwarded the sale and cut the reply, or cut the request first. The proof was a **gallery upload, not a physical camera**.

**Boundary tests:** `p59-export-coverage.integration.test.ts` runs real Express and Postgres at 9,999, 10,000 and 10,001 CSV rows and 1,999, 2,000 and 2,001 PDF rows, with a type filter, an out-of-range date and other types, and compares the rows with the aggregate.

**Checks at `61b4df1`, sequential:**

| Check | Result |
|---|---|
| Shared suite | 73 passed |
| API: all report tests plus the P55 and P57 discount integration tests, serial | 344 passed. **The full API suite was not re-run.** The last full run is `e6a4d1a` (§7) |
| Full web suite | 1,644 passed, 0 failed (178 files) |
| Typecheck: shared, API, web | Clean |
| Lint | 0 errors. One new web warning was closed with a commented exception after the browser run; that commit changes no behaviour |
| Production builds: shared, API, web | Pass |

**Failures along the way, in order:**

- **New coverage test:** 4 failed because the new test file didn't clean up between tests.
- **First boundary run:** the PDF test timed out at 300s, which exposed defect 2.
- **Page-count assertion:** expected 5 sheets, got 9. Discount Report rows wrap to about 8 a sheet, so the group size became 24.
- **Driver setup:** a long profile path broke `CacheStorage`, a short one fixed it. Several selector and timing mistakes followed, and the first checks read stock before deduction had finished.
- **First complete run, `050056d`: 86 / 90.** It found defect 1. One failure was a label mistake in the driver and one read the pager while loading.
- **Not explained:** that run's `renameDeactivate` phase stopped once at the PIN step, waiting for `Continue as`. It did not recur in a direct probe or in the final run, and the cause was not established.

### Found, not changed

- **The worker can't install while logged out.** `/apple-touch-icon.png` is precached, but the middleware redirects it to login, so install fails on the login page. It installs on the next page load after signing in, and it was active within 10s. A terminal that has signed in is fine. Fix is one matcher entry, in a separate batch.
- **Other Supervisor tabs still stop at 100 without saying so.** Daily Sales, Sold Products, Void/Refund, Inventory Movement and Attendance, including Daily Sales KPIs and its export. `reports-view.tsx` documents this ceiling, but users can't see it. The same is true of the customer IDs read by the Daily Sales drill-down. **Fixed in §11.**

### Still not tested

Real phones or tablets, a physical camera, printing, offline sales in this run, hosted Supabase Storage, mixed old and new versions, production data volume and the hosted API's PDF timing.

The fixture is `apps/api/scripts/p59r-browser-fixtures.ts`. The driver and proxy were session scratch and are not committed.

## 11. PDF cap and report coverage

Starting SHA `c198137`. Code tested `0d86464`. Everything here is local. **Production was not accessed, and nothing here says what is deployed.**

### What each report does now

Supervisor and Branch only. Tables page 25 rows at a time through the server. Cards read `GET /api/reports/period-summary`, database aggregates over every matching record.

| Tab | Before | Screen now | CSV (newest 10,000) | PDF (newest 100) |
|---|---|---|---|---|
| Daily Sales | Rows and cards stopped at 100; file stopped at 100, unlabelled | All rows reachable, full-period cards | Yes, labelled if cut short | Yes, labelled if cut short |
| Sold Product Transactions | Filtered only the newest 100. File ignored the product filter and held completed sales only | Filters run on the server | Same filters, every status unless one is chosen, a Status column, own file name | Same, and its own title |
| Void/Refund | 100 voided plus 100 refunded, summed; same in the file | One newest-first list, full-period cards | Yes, labelled | Yes, voided and refunded totals kept apart |
| Discount Report | PDF 2,000 | Unchanged apart from the limit shown | Yes, labelled | Yes, labelled |
| Inventory Movement | Rows and cards stopped at 100. File complete up to 1,999 PDF rows, then a job that silently wrote one page | All rows reachable, full-period cards | Yes, labelled | Yes, labelled |
| Stock Used Summary | Summed from the newest 100 movements, so screen and file disagreed | Reads the same aggregate as its file | Complete: one row per ingredient | Complete |
| Attendance Summary | Rows and cards stopped at 100 | All rows reachable, full-period cards. `Total Staff Today` is now `Attendance Records`, because it counts the period | Yes, labelled | Yes, labelled |

- **Detection:** one row past the limit is fetched, so exactly 100 or 10,000 reads as complete. A request's own `limit` no longer matters to these exports.
- **In the file:** a partial CSV's first line, and a partial PDF's boxed notice and every footer, say `PARTIAL EXPORT`, and the file name ends `_PARTIAL`. Totals inside say `for these exported rows only`. A complete CSV is unchanged. A complete PDF gets a one-line coverage note; its layout is unchanged.
- **On screen:** each tab says what its totals cover and warns before an export would be partial, using the same limits.
- **Order:** newest first, with `id` as tie-break, on the exports and the tables, so equal timestamps can't repeat or vanish between pages.
- **Failure:** a card whose aggregate fails, or that staff can't read, says `Unavailable`, never 0.
- **Also fixed:** Daily Sales customer IDs are read for exactly the page shown. The transaction dialog looks up the cashier's session directly. Attendance now uses Manila day boundaries, like its export. An async export job now gets every row, not the request's page size.
- **A direct request can't bypass this:** Supervisor and Branch requests for those reports, Shift Summary and Cash Reconciliation always take the bounded path.

**Everyday effect, owner to note:** the default range is 7 days, so a branch with more than 100 sales a week gets a partial PDF by default. CSV stays complete up to 10,000 rows.

### Measured blocking

Final built API (`NODE_ENV=production`) on this laptop, local Postgres in Docker, no proxy in the path. Independent connections. Every PDF below hit the 100-row limit.

| Request | Idle baseline | During a 100-row Discount PDF (5 runs) |
|---|---|---|
| Discount PDF itself | n/a | 1.65s to 2.38s |
| `GET /health`, worst | 6ms (median 3ms) | **1.35s to 1.79s** |
| Authenticated transaction list, worst | 49ms (median 32ms) | **1.01s to 1.64s** |
| Real checkout, overlapping the PDF | median 128ms, worst 191ms | **1.42s to 2.04s**, all 201 |

- **Ledger:** 10 sales (5 idle, 5 during a PDF), stock down 50 at 5 a sale, 10 SALE movements, and exactly one per sale for the 5 sales made during a PDF.
- **Other tabs at 100 rows:** Daily Sales PDF 0.95s, worst `/health` 0.73s. Inventory Movement PDF 1.66s, worst `/health` 1.28s.
- **Compared with §10:** the worst stall fell from 17.4s to about 1.8s. **This is reduced, not resolved.** Each PDF still stalls every branch's checkout for up to about 2s here, and several at once would add up. Hosted API timing was not measured.

### Terminal recovery

Final builds, fresh database, API behind a one-shot proxy that really cut the reply, service worker active and controlling. Both paths passed:

| Path | Result |
|---|---|
| Lost reply, reload, Next Customer | `Sale completed`, Checkout disabled with an empty cart, one sale, stock down once |
| Lost reply, reload, Escape | Same |

### Checks at the tested code, sequential

| Check | SHA | Result |
|---|---|---|
| Full API suite, real Postgres, serial | `3172435`; `0d86464` changes web tests only | 3,700 passed, 5 skipped, 0 failed |
| Full web suite | `0d86464` | 1,655 passed, 0 failed (178 files) |
| Shared suite | `0d86464` | 73 passed |
| Typecheck, production builds | `0d86464` | Clean; pass |
| Lint | `0d86464` | 0 errors; warnings only (API 397, web 1) |
| Browser, final builds | `0d86464` | **44 / 44**, on a complete re-run |
| Generated files | `0d86464` | All 5 tabs' CSVs and 6 PDFs read. Each PDF holds exactly 100 rows, with `PARTIAL EXPORT` in every footer and no VAT |

The 5 skipped tests are the opt-in `PUBLICATION_BUDGET_MEASURE` measurement, not missing setup. `p59-report-coverage.integration.test.ts` reads real downloaded CSV and PDF bytes at 99, 100 and 101 rows, with another branch's rows present and that branch's supervisor refused.

PDFs were read by extracting their text, because no PDF renderer was installed. Page appearance wasn't inspected. The screens were checked in screenshots.

**Failures along the way, in order:**

- **First full API run:** 3,699 passed, 1 failed. A test pinned the old attendance sort. Fixed in `3172435`, then the whole suite was re-run.
- **First full web run:** 1,620 passed, 35 failed, all in `supervisor/reports/page.test.tsx`, whose mock lacked the new hooks. After that, 5 asserted the old row-summed cards and were rewritten in `0d86464`, then the whole suite was re-run.
- **First browser run:** 43 / 44. Attendance reached page 2, but copied fixture rows looked identical. With distinct times, and the API confirming no shared records across pages, the full re-run was 44 / 44.
- **Driver setup:** a missing `device_id` on login and a wrong table name. Development mode logs every query, so the API was restarted in production mode before anything was measured.

### Found, not changed

- **The older Transaction PDF route is still uncapped.** `GET /api/transactions/export/pdf`, behind the Daily Sales drill-down, allows 2,000 rows on one `Page`. **At about 267 rows it took 9.6s and stalled `/health` for 8.4s**, far worse than the capped exports. One unrepeated measurement, on sales mostly without item rows, so a real file may be slower.
- **Admin's exports are not capped.** They stay complete and synchronous below 2,000 PDF rows, so a large Admin Inventory Movement or Void/Refund PDF can stall the API as it did before. Above that they use a job that renders in the same process. Not measured.
- **Admin Audit Log export** counts through a paged query, so it can stop at the request's limit. Admin-only and not a Supervisor tab.
- **Stock Used Summary** loads the period's sale movements on the server. It now runs only while that tab is open, and belongs in the performance batch.
- The Sold tab's product menu lists at most 500 names. Void/Refund PDFs are titled `Void Refund Report`.

### Rollout

**Deploy the API before the web.** An older API ignores `status_group`, so the new Void/Refund tab would list every sale until the API is updated, and `period-summary` would fail, showing `Unavailable`. An older web on the new API keeps its capped screens, and its PDFs become labelled at 100 rows. No migration or data step.

Rollback: revert `fd623d3`, `9e13f15`, `3172435` and `0d86464`, web first. That restores the 2,000-row PDF and its stall.

### Still not tested

Real phones or tablets, printing, hosted API timing, production data volume, mixed old and new versions, PDF exports from the staff and Branch roles in a browser, and the `Request never arrived` path, which §10 covers at `61b4df1`.

The driver, proxy and fixtures were session scratch and are not committed.
