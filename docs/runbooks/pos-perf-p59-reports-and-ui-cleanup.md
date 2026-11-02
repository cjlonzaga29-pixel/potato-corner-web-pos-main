# POS-PERF-P59: reports and UI cleanup

Removes visible VAT, shows the discount name saved on each sale, turns Discount Compliance into the Discount Report, adopts
familiar Daily Sales Report (DSR) wording, and removes one line of employee-list text.

**This changes presentation only.** Stored sales, totals, calculation modes, refunds and tax formulas are unchanged, and there is no migration.

| | |
|---|---|
| Started from | `origin/main` `6931b10`. PR #44 is not included |
| Tested code | `e6a4d1a`, on `c341814` |
| Production | Not accessed. Nothing pushed, merged or deployed |

## Decisions the owner should confirm

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
- Service worker active, and offline flows: browser runs blocked the worker
- Sales rung through the terminal screen. Browser-run sales went through the real checkout API, and the terminal's own component tests pass
- New web with an older API, or old web with the new API. During that overlap, the old web shows several "Manual" rows, and the new web shows `Unspecified discount` for manual rows with no filter effect, until both are updated
- PDF exports from the staff and Branch account roles
- Production data volume

**Known limits:**

- **Report cost:** the aggregate loads each discounted sale's snapshot, and `eligible_product_ids` can make those large. It should be fine for a branch and a normal date range, but it wasn't measured. Worth reviewing in the performance batch.
- **Export ceiling:** the Supervisor Discount Report export stops at 10,000 rows (CSV) or 2,000 (PDF) without saying so. This replaces a silent cap of the newest 100 sales.
- **Admin drill-down** still shows at most 100 sales, as before.
- **Breakdown** reads up to 100 type rows per request, so KPIs would undercount beyond 100 types in a range.
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
