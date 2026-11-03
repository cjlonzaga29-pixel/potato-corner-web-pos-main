# POS-PERF-P61: Extra Supplies

Extra Supplies records cups, tissue and bags a cashier gives out beyond what an order already includes, either free or for payment. Each issue deducts existing inventory and is recorded on its own, separate from product sales.

**Status: verified locally only.** Not pushed, merged or deployed.

| | |
| --- | --- |
| Branch | `feat/pos-perf-p61-extra-supplies` |
| Starting SHA | `500e97e` (P60 tip) |
| Tested code SHA | `95c7b5e` |
| Depends on | P60 and P59, both unpushed. Merging P61 brings in both |

**Three findings need a decision before release:** section 10 covers the auth sign-out on reload, the test suite's parallel failures, and the existing PDF blockers.

## 1. Setup

Supervisors create, edit, deactivate and reactivate cards for the branches they manage. Super Admin can read but not write. Cashiers never see setup.

| Field | Rule |
| --- | --- |
| Name | Unique per branch, ignoring case and spacing |
| Picture | Optional. Stored in the existing `product-images` bucket at `extra-supplies/<id>/<uuid>.webp` |
| Inventory item | Must be an existing, tracked item. P61 creates no stock of its own |
| Cashier counts in | Free-text label, such as "cup" or "pack" |
| Stock used per issue, unit | Quantity and unit, converted to the item's base unit. A unit with no conversion is refused |
| Selling price | Empty means the card can only be given free |
| Stated issue cost | Optional. See section 2 |
| Branches, Apply to POS | Only branches the Supervisor manages |

- **Conversion:** the form shows what each issue deducts before saving, for example "Each pack deducts 10 pc of P61 Tissue". The server recalculates it on save.
- **Edits:** version-checked. A stale edit is refused rather than overwriting someone else's change.
- **Deactivating:** removes the card from new entry and keeps its history. A card with history can't be deleted.
- **Pictures:** the new file uploads first and the version is checked, then the old file is removed on a best-effort basis. A failed replacement keeps the old picture.

## 2. Cost source

Each issue line records where its cost came from, and reports keep the sources apart.

| Source | Meaning | On the stock movement? |
| --- | --- | --- |
| `inventory` | Branch stock cost, otherwise the item's cost | Yes |
| `configured` | No inventory cost, so the card's stated cost is used | No, it stays off the ledger |
| `unknown` | Neither exists. Stored as null, never as zero | No |

Reports show calculated cost as the main figure and stated cost beside it, for example "₱20.00 from inventory cost, plus ₱3.50 stated on cards".

## 3. Accounting

**Free issues** deduct stock and collect nothing, and a reason is required. **Paid issues** deduct stock and collect the card's current price, by cash, GCash, Maya or other. Non-cash payments need a proof photo, using the existing payment proof upload.

An issue creates no sale, expense, payroll entry, inventory receipt, discount or VAT.

**Snapshots:** each line stores its name, price, unit and cost at issue time, so later renames and price changes don't alter history.

| Figure | Definition |
| --- | --- |
| Supply collections | Sum of `amount_collected` on paid issues |
| Product sales in the combined total | `total_amount` of completed sales for the same branch, dates and cashier, so net of discounts |
| Combined collections | Product sales + supply collections. Hidden when filtered by supply or free/paid, because product sales can't be split that way |
| Shift expected cash | Opening + cash sales + cash supply collections − refunds |
| Shift `cash_sales_total`, `gross_sales_total` | Unchanged and product-only |
| Shift `total_collections` | Shift gross sales + all supply collections |

**Two "sales" figures can look different.** In the browser run, the dashboard's Gross Sales showed ₱200 while combined collections used ₱190, because a ₱10 discount applied. The first is before discount and the second is money collected.

An order reference is free text and isn't checked against sales.

## 4. Stock and reservations

Each issue revalidates its cards and stock on the server, inside one transaction. Nothing is written if any line fails.

**Lock order:** operation → shift (shared) → cards, sorted → stock, sorted → conditional update `WHERE on_hand - reserved >= quantity`.

- **Reservations:** stock held for other orders can't be issued. The conditional update enforces this, because reservations take no advisory lock.
- **Shared items:** cards drawing on the same item are added together before checking stock.
- **Shift close:** the shift lock is shared here and exclusive for closing and cash refunds, so an issue can't land in a shift mid-close.
- **Limits:** 1,000 per line.
- **Stock movements:** existing `ADJUSTMENT_OUT` with `reference_type = 'extra_supply_issue'`. A new enum value was avoided because an old API's Prisma client fails on unknown values.

**A known quirk:** Inventory Movements labels these "Extra Supply Issue", but the Reports inventory CSV still shows the movement type as `ADJUSTMENT_OUT`, with "Extra supply issue ES-…" in its notes.

## 5. Exactly-once and recovery

The browser creates an operation ID and saves it before sending. The server binds that ID to the branch, cashier and content.

| Situation | Result |
| --- | --- |
| Same ID, same content | Returns the original issue |
| Same ID, different content, cashier or branch | Refused |
| Double click | One request, one issue |
| Reply lost after the server posted | The draft stays locked. The cashier sees "We don't know yet" with Try again, Check again and Cancel |
| Reload or reconnect while unresolved | The terminal returns to the Extra Supplies tab and checks the outcome |
| Cancel | Fences the ID as `abandoned`, so a delayed original can't post. If it already posted, the cashier sees that issue instead |
| Server refusal on the first attempt | Frees the ID and keeps the draft |
| Any other error | Keeps the ID. **Fails closed** |

Only a fixed list of codes frees an ID (`PROVES_NOTHING_POSTED` in `use-extra-supplies.ts`). A lost connection, an unreadable reply or a code added later all keep it, because a new ID after a posted issue would deduct stock twice. **This list exists because the first version got it wrong:** see section 8, runs 3 and 4.

**Offline:** Extra Supplies is online only. Confirm is disabled, the draft is kept, and nothing enters the ordinary sales queue.

**Drafts:** kept separately from the product cart in local storage, per branch and cashier. The next cashier sees none of the previous cashier's selection or cash, and the draft returns on Resume Work.

### Reversal

**There is no reversal or void. A posted issue can't be changed.** Corrections use the existing authorized paths:

- **Stock:** an audited Supervisor inventory adjustment.
- **Money:** a shift variance explanation or the existing cash process.

## 6. History and reports

Branch, Supervisor and Super Admin views read the same records, and the browser run confirmed identical figures for identical filters.

- **Filters:** branch, dates, item, free/paid and cashier, with server pagination.
- **Totals:** calculated over the full period, not the current page.
- **Drill-through:** an Inventory Movements row opens its issue, and an issue lists its movements.
- **CSV:** capped at 10,000 lines. The first line states coverage and the total collected for all matching rows. Formula-like values are escaped. Times are in UTC.
- **PDF:** none added.

Summary cards appear on the Branch, Supervisor and Admin dashboards and on Admin Reports.

## 7. Migration and compatibility

`20261105120000_pos_perf_p61_extra_supplies` is additive: five new tables and one enum. It adds no columns to existing tables.

**Rollout:** migration, then API, then web. Each needs its own authorization. No hosted Storage change is needed, because it uses an existing bucket. P59 and P60 rollout notes also apply.

**Rollback:** code only. Roll back web, then API. **Do not drop the tables or edit migration history.**

| Combination | Expected | Evidence |
| --- | --- | --- |
| New web, old API | Explains that the feature isn't available, keeps the draft, writes nothing | Unit test only |
| Old API, new schema | Reads movements as ordinary adjustments | Reasoned from the schema. **No real old process was run** |
| After rollback | Issue rows stay. Old EOD and report code ignores them, so **shift expected cash would no longer include cash supply collections** | Reasoned, not tested |

**Decide before any rollback after real use:** closed shifts keep their saved figures, but a shift open during the rollback would show cash variance equal to its cash supply collections.

## 8. Verification

Everything ran on disposable local Postgres in Docker (`p61_test`, `p61_browser`) and local Supabase Storage, on separate ports, with throwaway secrets. Nothing touched production or `pos_verify`.

### Final results on `95c7b5e`, sequential

| Check | Result |
| --- | --- |
| Full API suite, default parallel | **1 failed**, 3,775 passed, 5 skipped |
| Full API suite, one file at a time | 3,776 passed, 5 skipped, 0 failed |
| Full web suite, default 5s timeout | **2 failed**, 1,688 passed |
| Full web suite, 20s timeout | 1,690 passed, 0 failed |
| Shared suite | 83 passed |
| Typecheck, API and web | Clean |
| Lint, API, web and shared | 0 errors |
| Production builds, API and web | Pass |
| Migration rehearsal | Pass: 20,000 sales, all 87 existing tables byte-identical, no drift |
| Browser, production builds, service worker active | **73 / 73** |

The two passing reruns used a different configuration, so **they don't erase the failures above**. Section 10 covers what they suggest.

### Browser coverage

- **Supervisor setup:** real image upload and replacement, a failed replacement, conversion preview, an invalid unit, a duplicate name, deactivating.
- **Issues:** free, paid cash and paid GCash with real proof upload, each checked against the database.
- **Failure paths:** double click, lost reply with reload, lost request with same-ID retry, cancel fencing, offline, stale configuration, insufficient stock, cashier switching.
- **Reports:** history, drill-through, Inventory Movements, Supervisor and Admin dashboards, Branch view, another Supervisor's scope, and a real CSV file opened and parsed.
- **Regression:** no-discount and custom-discount product checkout, with recipe packaging deducted once by the sale.
- **Layouts:** 1366×900, 768×1024 and 390×844 in **Playwright viewport emulation, not real devices**. Screenshots were reviewed, not only the scroll checks.

The rate limit was respected by pausing the driver, not bypassed. The driver itself isn't committed; `apps/api/scripts/p61-browser-fixtures.ts` is.

### Failed attempts

| Attempt | Result | Cause | Kind |
| --- | --- | --- | --- |
| Web build 1 | Failed | `NODE_ENV=development` during `next build` | Environment |
| Browser run 1 | No browser opened | Fixture ID file truncated by my script | Harness |
| Run 2 | 24 passed, stopped | Driver skipped the upload's Confirm | Harness |
| **Runs 3, 4** | **28 passed, stopped** | **Real bug: a lost reply released the ID, so a second click could issue stock twice** | **Product, fixed** |
| **Run 5** | **37 passed, stopped** | **Reconnecting returned to Products, leaving an unresolved issue unseen** | **Product, fixed** |
| Run 6 | 48 passed, stopped | Driver's discount SQL was wrong | Harness |
| **Run 7** | **1 failed early, stopped** | **Unit field cleared when units loaded late** | **Product, fixed** |
| Run 8 | 42 passed, stopped | Ben's break left over from an earlier run | Harness |
| Run 9 | 1 passed, stopped | Session lost on reload during a slow refresh (section 10) | Existing behaviour |
| Run 10 | 54 passed, stopped | Supervisor on the wrong branch | Harness |
| **Run 11** | **22 passed, stopped** | **API rate limit hit. A 429 was reported as "unknown outcome"** | **Product, fixed; driver paced** |
| Run 12 | 55 passed, stopped | Wrong selector for the branch switcher | Harness |
| Run 13 | 64 passed, 1 failed, stopped | Dialog read too early; terminal idle-locked | Harness |
| Run 14 | 71 / 71 | Before the final code | Superseded |
| Web suite 1 | 46 failed | 45 from a missing card mock in page tests, 1 timeout in `reports-view` | Test |
| API suite 1 | 29 failed | 27 from missing cash mocks, plus `flavors` and `p50-tax` | Test and flaky |
| API suite, without the P61 test file | 2 failed | `p60-expense-types`, `flavors`; `p58-product-types` also reported | Flaky, diagnostic |

The unit tests passed through runs 3 and 4 because they mocked a thrown error, while the real `apiClient` returns one. Tests now cover the returned form.

## 9. Not tested

- Real phones, tablets or printers, and a physical camera. The camera path wasn't used; proof went through file selection
- Hosted Supabase Storage
- A real old API process, or mixed old and new versions
- A rollback after real use
- Realtime updates between open screens
- Production data volume and concurrency on the terminal. The integration suite covers concurrency on a local database
- Receipt printing: issues don't print receipts

## 10. Before release

**New findings from this work, not fixed because they are out of scope:**

- **A reload during a slow token refresh can sign a user out.** In run 9, the browser aborted a refresh and the API logged "Refresh token reuse detected", then refused further refreshes. It happened with a 4.4s refresh on a loaded laptop. How often this could occur in production isn't known.
- **The API suite fails intermittently in parallel.** Failures moved between `flavors`, `p50-tax`, `p58` and `p60` across runs, including with the P61 test file excluded, and the one-file-at-a-time run passed. That points to test files interfering through the shared database, not to P61 itself, but **the exact cause isn't proved**. CI may see the same failures.
- **The web suite can time out under load.** Different tests failed each time at 5s, and none failed at 20s.
- **The global rate limit counts per IP.** `apiLimiter` allows 100 requests a minute and runs before authentication. Several terminals behind one branch connection would share that allowance. Busy dashboards used much of it in the browser runs.

**Still open from P59 and P60:**

- **PDF rendering blocks the API thread.** A 100-row PDF stalled checkout for about 2s on a laptop.
- **The Transaction PDF route and Admin's synchronous PDFs are uncapped** below 2,000 rows.
- **P59 owner decisions:** receipts without VAT lines, exports without VAT columns, and no VAT registration screen.
- **P60:** Supervisors must create expense types before branch accounts can save expenses in the new web.

P61 adds no PDF route.

**Next:** performance diagnosis across Admin, Supervisor and Branch, including PDF rendering isolation, before combined release.
