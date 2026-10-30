# POS-PERF-P50 — VAT settings visibility and tax calculation review

Source: October 29 video review ("VAT settings"). Scope: make the VAT setup visible and understandable, expose only
configuration the business can legitimately control, and keep checkout, receipts and reports consistent.

Out of scope (unchanged): payroll, break tracking, promotion fraud-rule tuning, transfer idempotency, unrelated redesigns.

## 1. Audit of the existing calculation (before any change, at `422c9ff`)

### Sources of truth

| Concern | Where it lived | Notes |
| --- | --- | --- |
| VAT rate | Hard-coded `1.12` and `12 / 112` in `transactions.service.ts computeAmounts` **and** a copy in `terminal/page.tsx previewAmounts`. Labels "VAT (12%)" hard-coded in checkout, receipt modal and public receipt. | Not a setting anywhere. A hard-coded rate is not itself a defect: the rate is statutory (§3). |
| VAT registration / tax treatment | Implicit: the app assumes a VAT-registered seller. No setting, no per-branch variation. | See §7 decision D1. |
| Inclusive vs exclusive pricing | Implicit: catalog prices are VAT-inclusive; VAT is extracted (12/112), never added. | Fixed application behavior. |
| Product VAT cap | `product_variants.vatable_cap_amount` (per size). The part of a line above `cap × qty` is non-VATable: not discounted, not taxed, stored in `transactions.vat_exempt_amount`. | Business/product setup ("Tera Mix capped to Mega Mix SRP"). Not a statutory rule we could verify — preserved unchanged (§3). |
| PWD / Senior | `computeAmounts`: VATable ÷ 1.12, rate % off the VAT-exclusive amount, VAT = 0. Rate from `discount_policy` (SystemSetting, default 20%). | Formula locked in `.claude/CLAUDE.md`. |
| Employee | Rate % off the VAT-inclusive VATable amount; VAT = 12/112 of the remainder. Rate from `discount_policy`. | Business choice. |
| P49 promotions | Same non-statutory path as Employee; per-line discount; only with no transaction-level discount; never on VAT-capped sizes; acknowledgement checked (`PROMOTION_CHANGED`). | Unchanged by P50. |
| Discount settings | `GET/PUT /api/settings/discount-policy`, organization-wide, PUT `adminOrSupervisor`, last-write-wins, audited. | Defects D-2, D-3 below. |
| Live checkout | Client sends discount **type** only; server resolves the current rate, recomputes everything, persists `subtotal/discount_amount/vat_amount/vat_exempt_amount/total_amount/discount_rate_used`. `discount_amount` from the client is ignored (typed promotional refused). | Client never supplies VAT, discount or totals. |
| Offline sync | Same `createTransaction` path, rate resolved **at sync time**. | Defect D-4. |
| Refund / void | Status flip on the original row; amounts never recomputed; reports exclude non-completed rows (refunds subtracted from net). | Correct as-is. |
| Receipts | Render stored amounts only (`discount_rate_used` frozen). Label "VAT (12%) ₱0.00" on VAT-exempt sales; no VATable/exempt breakdown. | D-5 (presentation). |
| Reports | Daily sales `vat_total` = Σ stored `vat_amount`. Discount Compliance "VAT Exempt Total" = Σ stored `vat_exempt_amount`. | Defect D-6. |
| Historical snapshots | Every sale stores all amounts and `discount_rate_used`. The VAT rate is not stored, but it is a code constant that has always been 12%. | No migration needed (§5). |

### Proven defects and discrepancies

Each was reproduced locally (unit and/or real-database integration test) before being fixed.

| # | Defect | Reproduction | Fix |
| --- | --- | --- | --- |
| D-1 | Two copies of the VAT/discount formula (server `computeAmounts`, client `previewAmounts`). Identical today, but nothing stopped drift. | Code read; 20,000-cart differential test shows they agree now. | One pure `computeSaleTax` in `@potato-corner/shared`, used by both. Verified byte-for-byte equal to the old server formula on 20,000 random carts. |
| D-2 | Any supervisor could change the **statutory** PWD/Senior percentage organization-wide (e.g. to 10%) or turn it off; checkout then charged that. | Old service test `updateDiscountPolicy({ pwd: { percentage: 10 } })` succeeded for admin and supervisor. | Server refuses any change to PWD/Senior rate or enabled state for every role (`STATUTORY_DISCOUNT_LOCKED`, 422, nothing written or audited). Re-sending the stored value is accepted (old editors send every row); the only accepted change is back to 20%/enabled. |
| D-3 | Discount settings were last-write-wins: a stale editor silently overwrote a newer save. | Two saves from the same loaded version both succeeded. | Optional `expectedUpdatedAt`; when sent, a compare-and-set write (`updateMany … where updatedAt = expected`, or `create` when the editor loaded "never saved") refuses a stale or racing save with `SETTINGS_CHANGED` (409, current values in `details`). Real-DB test: two concurrent saves → exactly one wins, one audited. |
| D-4 | A rate change between the cashier seeing a total and the server committing silently charged a different total: live (cart open while a supervisor saves) and offline (sale paid at 20%, synced after a change to 10% → recorded at 10%, not what was collected). | Integration test: Employee 20% cart, rate set to 10%, sale committed at 10% with no notice. | Client sends `tax_basis { vat_rate, discount_rate }` (rates only, never amounts). Server compares after computing and **before writing**; mismatch → `TAX_SETTINGS_CHANGED` (409) with the amounts that would be charged now. Live: cart kept, settings re-read, new total shown for confirmation, no Retry. Offline: definitive visible rejection, never repriced, never dropped. Absent basis (old client / pre-P50 queue) → old behavior. |
| D-5 | Receipts and checkout showed "VAT (12%) ₱0.00" for a VAT-exempt PWD/Senior sale and never showed VATable / VAT-exempt amounts. | Receipt modal test fixture (Senior sale). | Receipt breakdown derived only from stored amounts (`describeStoredSaleTax`): VATable sales (net of VAT), VAT, non-VATable cap part; PWD/Senior → "VAT-exempt sale" = stored total. Checkout shows "VAT-exempt (PWD/Senior) — no VAT". |
| D-6 | Discount Compliance "VAT Exempt Total" for PWD/Senior rows summed `vat_exempt_amount` (only the VAT-cap overflow, usually ₱0), so a fully VAT-exempt PWD sale reported ₱0 exempt. | Repository test with a PWD group. | New additive `total_vat_exempt_sales` = Σ stored `total_amount` of PWD/Senior sales (0 for other types). Existing column kept, relabelled "Non-VATable Amount (VAT cap)". |

Not defects (kept): the hard-coded 12% rate; VAT-inclusive pricing; the VAT-cap rule; P49 restrictions (no promotion
with PWD/Senior/Employee, none offline, none on capped sizes); void/refund behavior; rounding (`Math.round(x·100)/100`
at the same points as before).

## 2. What changed

- `packages/shared/src/tax/sale-tax.ts` — `VAT_RATE_PERCENT = 12`, `STATUTORY_DISCOUNT_PERCENT = 20`,
  `PRICES_INCLUDE_VAT`, `computeSaleTax` (moved unchanged), `discountRateFor`, `describeStoredSaleTax`.
- API: `computeAmounts` delegates to `computeSaleTax`; `assertTaxBasisUnchanged` before any write (live + sync);
  `GET /api/settings/tax` (read-only, all roles, no write route); discount-policy statutory lock + compare-and-set;
  public receipt adds `vat_exempt_amount`; Discount Compliance adds `total_vat_exempt_sales`.
- Web: terminal preview uses `computeSaleTax` and sends `tax_basis`; `TAX_SETTINGS_CHANGED` notice (review-only, no
  Retry, Charge blocked while settings reload, VAT-rate build mismatch tells the cashier to reload); Settings →
  "VAT & Tax" read-only section with a worked ₱112 example computed by `computeSaleTax`; Discount Settings shows
  PWD/Senior read-only, edits Employee only, sends `expectedUpdatedAt`, explains a conflict, offers "Restore 20%"
  only when legacy data is off-statute; receipts use `ReceiptTaxLines`; offline Pending tab explains a tax-settings
  refusal; admin reports show VAT-exempt sales.
- No database migration.

## 3. Tax rules — official sources

| Rule | Status | Source |
| --- | --- | --- |
| VAT is 12% of the gross selling price | Statutory | NIRC §106 as amended by RA 10963 (TRAIN): <https://www.lawphil.net/statutes/repacts/ra2017/ra_10963_2017.html>; original RA 9337: <https://lawphil.net/statutes/repacts/ra2005/ra_9337_2005.html> |
| Senior Citizen: 20% discount and VAT exemption on restaurant food/consumables, for the senior's exclusive use | Statutory | RA 9994 §4(a), item (7): <https://lawphil.net/statutes/repacts/ra2010/ra_9994_2010.html>; BIR RR 7-2010: <https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/10/55830> |
| PWD: "at least twenty percent (20%) discount and exemption from VAT" incl. restaurants; not combinable with other discount programs | Statutory | RA 10754 §1 (amending RA 7277 §32): <https://lawphil.net/statutes/repacts/ra2016/ra_10754_2016.html>, <https://www.officialgazette.gov.ph/2016/03/23/republic-act-no-10754/> |
| Senior on a promoted item: promotional discount **or** the senior discount, whichever is higher | Statutory (RA 9994 §4(a)) | Same as above. The app makes the cashier choose one (P49); it does not auto-pick the higher. Decision D4. |
| Prices are VAT-inclusive | Application behavior | — |
| VAT cap per product size | Business/product setup | No statutory source found; preserved, not re-derived. Decision D3. |
| Employee discount rate, promotions | Business choice | — |

Changed in P50 on the strength of these sources: only the *configurability* of the PWD/Senior rate (locked at the
statutory 20%). No formula, rate, exemption rule, stacking order or cap behavior was changed. Search verification was
done on 2026-10-30 against lawphil/Official Gazette/BIR/SC e-Library; amendments after those texts were not
exhaustively checked — re-verify before changing any value.

## 4. Editable vs read-only

| Setting | Who can change | Where | Server enforcement |
| --- | --- | --- | --- |
| VAT rate (12%) | Nobody (code release) | Settings → VAT & Tax (read-only) | No write route (`GET /api/settings/tax` only) |
| VAT-inclusive pricing | Nobody (code release) | read-only | — |
| PWD / Senior 20%, VAT-exempt, enabled | Nobody; only "restore to 20%" if legacy data differs | read-only rows | `STATUTORY_DISCOUNT_LOCKED` for every role |
| Employee % / enabled | Super Admin, Supervisor (unchanged from Task 209.xx), organization-wide | Discount Settings | `adminOrSupervisor`; staff/branch 403; stale save 409 |
| Product promotions | Supervisors of the branch (P49, unchanged) | Promotions page | P49 rules |
| VAT cap | Product setup (unchanged) | Product editor | unchanged |

Every successful discount-policy change writes `DISCOUNT_POLICY_UPDATED` to the audit chain (before/after). Refused
saves write nothing.

Maintenance gate: `/api/settings/*` is **not** covered by the write gate (`middleware/write-gate.ts` patterns cover
transactions, inventory and catalog only). P50 does not rely on it: stale and racing saves are refused by the
compare-and-set, and a rate change during a deploy is caught at checkout by `tax_basis`.

## 5. Historical sales

- Every sale already stores `subtotal`, `discount_amount`, `vat_amount`, `vat_exempt_amount`, `total_amount` and
  `discount_rate_used`. Receipts and reports read only these. Verified: a settings change leaves receipts, transaction
  rows, daily sales and Discount Compliance identical; void/refund afterwards keeps the original amounts.
- The new receipt breakdown and `total_vat_exempt_sales` are derived from those stored amounts only — nothing is
  backfilled or recomputed from current settings.
- The VAT rate is not stored per sale. That is safe only while it is a constant: **if the VAT rate ever becomes
  changeable, add a `vat_rate` snapshot column first (additive, legacy rows = 12) and label receipts from it.**

## 6. Offline, compatibility and rollout

Offline:
- A sale queued with `tax_basis` that no longer matches is refused at sync (`TAX_SETTINGS_CHANGED`) through the P46R3
  visible-rejection path: shown as "Not accepted" with what it was rung at vs now, never resent on its own, never
  repriced, kept on the device. Other sales in the batch sync normally. An already-committed sale still replays.
- Sales queued before P50 (no `tax_basis`) sync exactly as before (current rate).
- **Operator reconciliation:** for a refused offline sale, the supervisor records the cash collected (ID, time, amount
  shown on the Pending tab) through the usual cash-variance process. Do not change the Employee rate back and forth to
  force it through. Only the Employee rate can change now, so this needs an Employee-discount sale rung offline while
  the rate is changed.

| Combination | Behavior |
| --- | --- |
| Old web → new API | No `tax_basis` → no check (pre-P50 behavior). Old Discount Settings form sends every row with stored values → accepted; it can still change Employee (last write wins, no stale token) but can no longer change PWD/Senior (422 with message). |
| New web → old API (rollback) | Old API strips `tax_basis` and `expectedUpdatedAt` (Zod object strips unknown keys); checkout as before. `GET /settings/tax` 404 → UI says the server does not report it and shows this build's values. Receipts without `vat_exempt_amount` show only the VAT line. Report column shows "—". |
| New web, new API | Full behavior. |
| Old queued offline sales | No `tax_basis` → synced as before. |

Rollout: validation → approval → staged web build → (no migrations) → API live → web promotion. No DB step, no backfill.

Operator prerequisites before API go-live:
1. Read the current `discount_policy` (Settings → VAT & Discounts). If PWD or Senior is not 20%/enabled, decide with
   the owner and press "Restore 20%" after the web is promoted (until then checkout keeps using the stored value, as
   it does today). The VAT & Tax section shows a red warning while this is the case.
2. Brief supervisors: PWD/Senior are now read-only; a cashier may see "Discount or VAT settings changed — not
   recorded" if the Employee rate is changed while a cart is open.

## 7. Decisions needed from the business

- **D1 — VAT registration.** The app assumes every branch is a VAT-registered seller. If any branch/franchisee is
  non-VAT (percentage-tax) registered, receipts and VAT amounts for that branch are wrong; this needs a per-branch tax
  status and a different calculation — not built.
- **D2 — PWD rate above 20%.** RA 10754 says "at least 20%". If the business wants to give PWD more than 20%, that is a
  new decision (and who may set it); P50 locks it at 20%.
- **D3 — VAT cap rule.** Confirm with the accountant the basis for treating the price above `vatable_cap_amount` as
  non-VATable. P50 preserves it and labels it "Non-VATable amount".
- **D4 — Senior/PWD on a promoted item.** RA 9994 gives the senior the higher of the promotion or the statutory
  discount; the POS makes the cashier pick one. Decide whether to auto-select the higher.
- **D5 — Employee discount authority.** Any supervisor can still change the organization-wide Employee rate (Task
  209.xx). Decide whether that should be Super Admin only or per branch.
- **D6 — Receipt compliance.** The in-app receipt now shows VATable / VAT / VAT-exempt amounts, but whether it meets
  BIR invoice requirements (TIN, OSCA/PWD ID and signature lines, etc.) was not assessed.

## 8. Verification

All runs used a new disposable LOCAL Postgres database (`127.0.0.1:5432`, name `p50_10301251`), created for this
session and refused by a guard unless every URL was local **and** the database name matched `p50_<digits>`
(`local-db-guard` + name check). Throwaway secrets; separate ports (API 4550, web 3550). Production, `pos_verify` and
other sessions' databases were never touched; no smoke accounts were provisioned; no terminal queues were cleared.
The database was seeded with the repo's local seed (`prisma/seed.ts`, `ALLOW_DATABASE_SEED=true`) plus two test
products (₱112, and ₱300 with a ₱250 VAT cap).

| Check | Result |
| --- | --- |
| API unit + integration (full suite, isolated final run) | 192 files passed / 8 skipped; 3,285 tests passed / 104 skipped |
| P50 integration (`p50-tax.integration.test.ts`, real Postgres) | 10 / 10 |
| Shared package (incl. 20,000-cart differential test vs the pre-P50 formula) | 41 / 41 |
| Web unit (full suite) | 164 files, 1,504 / 1,504 |
| `turbo run type-check lint --force` | 7 / 7 tasks, 0 errors (pre-existing warnings only: 308 `no-console` in API scripts, 1 `<img>` in web) |
| API `tsc` build, web `next build` | pass (web built against the final code; see note below) |
| Live HTTP checks against the built API | 22 / 22 |
| Real browser, Chromium, final web build | 26 / 26 (desktop 1440×900, tablet 820×1180, phone 390×844, keyboard) |
| Migration rehearsal | not applicable — P50 adds no migration |

Integration coverage (real Postgres): stored amounts equal `computeSaleTax` for ordinary, PWD, Senior, Employee and
VAT-capped carts at quantities 1–7 with centavo prices; promotional sale (₱45 × 3, ₱5.50 off) and promotion+Employee
refused; PWD sale reserves exactly recipe × quantity (400 g for 4); forged `discount_amount` ignored; forged VAT rate,
forged discount rate and a missing discount rate refused with no transaction, job or available-stock change; rate
changed with a cart open → refusal carries the new amounts, recharge with the new basis commits at 10% with the rate
frozen; old client without basis charged at the current rate; offline batch: committed sale replays, stale sale
refused with a message naming both rates, unaffected and pre-P50 sales sync; receipts, rows, daily sales and Discount
Compliance identical after a settings change, then void/refund keep the original amounts; PWD exempt sales = stored
PWD totals; statutory rows locked for admin and supervisor with nothing written or audited; two concurrent saves from
one version → exactly one wins and is audited, the stale one gets 409.

Live HTTP (built API): `GET /settings/tax` 200 for staff/supervisor/admin; `PUT /settings/tax` 404 (no route); staff
`PUT discount-policy` 403; statutory changes 422 for supervisor and admin; Employee save 200, stale save 409 with
current values; old-web style save (every row, no token) 200; ₱112 → VAT ₱12; PWD ₱112 → ₱80, VAT ₱0; 2 × ₱300
capped Senior → non-VATable ₱100, total ₱457.14; forged `discount_amount`/`total_amount`/`vat_amount` ignored (₱112
charged); forged VAT basis 409; old client Employee 20% → ₱89.60; rate 20→15% with cart open → 409 with ₱95.20, then
201 at ₱95.20 with 15% frozen; offline batch → stale sale `TAX_SETTINGS_CHANGED`, other sale synced; public receipt
byte-identical after a settings change; public receipt carries `vat_exempt_amount`.

Browser (final build):
- A (supervisor, desktop + keyboard): VAT & Tax read-only rows and ₱112 worked example (₱112/₱12 VAT; PWD ₱80, no VAT);
  PWD/Senior rows have no inputs or switches; Employee changed to 10% and saved using only the keyboard; example
  updates to ₱100.80; a second editor opened earlier is refused, told why, and reloaded to the newer 12%.
- B (staff): Employee 10% cart shows Charge ₱100.80; rate changed to 15% → "Discount or VAT settings changed — not
  recorded", no Retry; "Review updated prices" → "Total is now ₱95.20 (was ₱100.80)", picker reads Employee (15%);
  charge succeeds. Database: exactly one sale, ₱95.20 at 15%; no ₱100.80 sale.
- C: PWD checkout shows "VAT-exempt (PWD/Senior) — no VAT", Charge ₱80.00; receipt shows "VAT-exempt sale
  (PWD/Senior) ₱80.00". Database: ₱80.00, VAT ₱0, rate 20%.
- D: admin Settings → "VAT & Discounts" shows the read-only section.
- E: public receipt `/r/<number>` text identical before/after a settings change; shows VATable sales and VAT (12%).
- F: tablet and phone — no horizontal overflow on Settings or the terminal.
- G (offline): sale rung offline at Employee 20% queued with `tax_basis {12, 20}` and ₱89.60; rate changed to 10%;
  on reconnect it stays on the device, unsynced, with `TAX_SETTINGS_CHANGED` and the message naming both rates; the
  Pending tab shows "Not accepted" with supervisor guidance. Nothing was written to the database.

Issues found during verification and fixed:
- Settings sections rendered fallback values (VAT & Tax) or an empty card (Discount Settings) while their queries
  were idle before a session token existed. Both now show a loading state (tests added); web rebuilt and all browser
  checks re-run on that build.
- The refusal notice now also shows the server's total if the refreshed screen still disagrees with it (e.g. a stale
  catalog price), instead of letting the cashier confirm the wrong number.
- Offline refusal wording: "not charged" was wrong for a sale already paid offline; the server message and Pending
  guidance now say it was not recorded and the amount was not changed.

Notes on the runs: an earlier full API run failed only because I edited `transactions.service.ts` while it was
running; another had three product suites time out in hooks because I ran the web suite at the same time (they pass
alone). The final runs above were isolated. One P50 assertion was tightened after a full run showed another suite's
job runner completing earlier deductions mid-test: the "no trace" check now compares available stock
(on hand − reserved), which a refused sale would change and a completed deduction does not.

## 9. Known limitations

- `tax_basis` covers rates only. A catalog **price** change between ringing and committing is still charged at the
  server price (pre-existing; out of scope). The refusal notice shows a server/screen mismatch only when a tax
  refusal happens.
- A refused offline sale can be retried from the Pending tab, but it is refused again unless the rate matches; it
  needs manual reconciliation (§6).
- The Employee rate is still organization-wide and editable by any supervisor (D5).
- No VAT-rate snapshot column; required before the rate can ever become configurable (§5).
- In-app receipts are not assessed against BIR invoice requirements (D6).
- Web build note: the browser runs started a server whose process outlived its task and briefly served a replaced
  `.next`; it was killed and all browser checks were re-run on a clean start of the final build.

## 10. State

- Starting SHA: `422c9ff` (P49), on `b8c922c` (P48) and `0357ce0` (P47), on `origin/main` `7084291`. Working tree
  clean at start.
- Final SHA: the local commit that adds this runbook (`feat(pos-perf-p50): …`), directly on `422c9ff`.
- Git status after commit: clean, `main` 4 commits ahead of `origin/main` (P47, P48, P49, P50). Not pushed, not
  deployed, no production access.
