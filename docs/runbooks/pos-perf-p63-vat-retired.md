# POS-PERF-P63: VAT retired

The owner decided (2026-11-21) to remove VAT as an active feature permanently, not just hide its labels. The decision record is [CR-010](../decisions/CR-010-vat-retired.md). P63 rides on the same branch as P59–P62 and ships with them.

## 1. What changed

**New sales (server-enforced).** `assertVatCalculationRetired` in `transactions.service.ts` is the first check after the two replay paths (idempotency key, offline device identity). A new sale must be the manual-flow manual total (`discount_flow: manual_v1`, `calculation_mode: manual_total_v1`), and it must not claim the statutory `pwd`/`senior_citizen` type. Anything else is refused with `VAT_CALCULATION_RETIRED` (422), with nothing written. That covers an older POS's checkout (no flow, numeric `tax_basis`), the old statutory formula, Employee rate and promotion pricing. It is never recalculated.

Every accepted sale is `computeManualTotal`: subtotal − the discount, VAT 0 placeholders and a v2 snapshot. The following were deleted as dead code:
- `computeAmounts`, `assertTaxBasisUnchanged`, `assertCalculationMode`
- `applyLinePromotions`, `resolveSelectedDiscountLines`
- the statutory and Employee rate checks.

**Discount types are unchanged.** A supervisor-created type named "PWD" is an ordinary manual or fixed peso discount. Its eligibility, amount limit, proof requirement, cashier/branch/shift proof binding and single use all apply as before.

**Settings:**
- `PUT /api/settings/tax/branches/:id` (VAT registration) and `updateBranchTaxProfile` are removed.
- The Admin organization-rate editor (`DiscountSettingsSection`), the Legacy discount settings panel and its VAT preview table are deleted.
- The Supervisor statutory-rate panel is deleted.
- The branch form keeps only "Cashier must choose a discount" (Super Admin). On save it re-sends the stored rate overrides unchanged.
- `GET /api/settings/tax` and the discount-policy GET stay, read-only, for older terminals.

**Terminal.** The statutory preview (`previewAmounts`/`computeSaleTax`) and the numeric `tax_basis` are removed. Every charge sends `{calculation_mode: manual_total_v1, vat_rate: null}`. `VAT_CALCULATION_RETIRED` is final in three places: checkout recovery ("definitely not charged"), the sale status modal (no Retry) and the offline queue (a definitive refusal, kept and never resent automatically).

**No migration, no schema change.** The `vat_amount`, `vat_exempt_amount`, `tax_snapshot`, `calculation_mode` and `vatable_cap_amount` columns all stay.

## 2. History

- **Stored amounts are never rewritten or recalculated.** CR-004's immutability guard already refuses any change to a sale's amounts. Tests that need a VAT-era row use a test-only fixture client (`src/test-utils/historical-vat-sale.ts`).
- **Replay.** A legacy client retrying its own recorded sale (same idempotency key, or same device and offline number) gets the stored sale back. `idempotencyReplayMatches` still treats a missing mode as legacy.
- **Refund and void** change the status only.
- **Readers.** Receipt detail, the Discount Report and daily-sales `vat_total` read stored values.

## 3. Old clients and offline queues

| Client / payload | Before P63 | Now |
| --- | --- | --- |
| P55R2–P62 web (production today), any sale | manual total | unchanged: accepted |
| Pre-P55 web, live sale (no flow, numeric basis) | VAT-calculated | refused `VAT_CALCULATION_RETIRED`, "Reload the POS" |
| P55–P55R1 web, statutory PWD/Senior | statutory formula | refused |
| Queued offline sale from a pre-P55R2 build | VAT-calculated on sync | refused per row, nothing written, rest of batch syncs |
| Retry of an already-recorded VAT-era sale | replay | replay, stored amounts |

**Which terminals could still create VAT sales?** Only a device still running a pre-P55R2 web bundle. Production's web is P58, whose checkout has always sent the manual total (verified: `main`'s terminal never sets a statutory type). The server change closes the path regardless.

**Refused queued sales are kept, and no recording path exists.** A refused queued sale stays in that terminal's queue (P46R3 rejection state, never deleted). Its message says the amount collected was not changed and that a supervisor must reconcile that cash by hand. No screen exists to record it as a sale. That is deliberate: recording it would mean choosing a formula for money already collected.

**Operator prerequisite before production approval:**
1. Reload every branch terminal onto a current build, i.e. P58 or later.
2. Confirm no terminal holds queued offline sales from an older build. Check the terminal's offline sales list.
3. Any refused sale that appears after release is reconciled by hand against the shift's cash.

## 4. Verification (local only, code commit `8e0fe4b`)

All runs used fresh embedded Postgres instances on 127.0.0.1 with placeholder keys. Never production, `pos_verify` or another session's services. Runs were sequential.

| Check | Result |
| --- | --- |
| Affected API files, first run after the change | 251 failed / 377 passed: tests pinned to the VAT checkout (expected); converted or removed |
| Affected API files, final | 683 passed, 0 failed (`p55` 10/10 including the P63 history test) |
| Service unit file | 272 passed |
| **Full API run 1** | **1 failed**, 3,804 passed. `products.publication-budget` P38R2: FK violation on `branch_product_availability` when another file's branch vanished mid-transaction. Passes alone (4/4); file and code unchanged since before P59. Cross-file isolation, not P63 |
| **Full API run 2** | **0 failed, 3,805 passed, 5 skipped; exit 0** |
| **Full web, default settings** | **0 failed, 1,721 passed, 183 files; exit 0** |
| Shared | 83 passed; typecheck clean |
| Typecheck API / web | Clean |
| Lint | API 0 errors (409 warnings, unchanged); web 0 errors, 5 warnings (unchanged) |
| Production builds | API `tsc` and web `next build`: pass |
| Browser, final builds, service worker active: P62 terminal flows | 10/10: no discount, custom discount, free and paid supplies, lost reply and reload, one transaction and deduction per sale |
| Browser: `vat-retired.mjs` | 10/10: a "PWD"-named type charged 101 − 15 = 86 as `manual_total_v1` with VAT 0; checkout text has no VAT; an offline sale reached the server only after reconnect, exactly once, as a manual total; Admin and Supervisor Settings have no VAT, statutory or rate editors; the discount-decision switch remains |
| Old/new combination | P58 web (production) → new API: the checkout and offline payload builders on `origin/main` send `discount_flow: manual_v1` and the `manual_total_v1` basis, which the new API accepts. Refused shapes are proven against real Express in `p55`/`p53`/`p57`. **No P58 browser build was run against the new API** (that needs a second checkout of `main`) |
| Real devices, camera, printing, hosted Storage | **Not tested** |

## 5. Rollout and rollback

- **Rollout** is the combined P59–P62 order: migrations (P60, P61; P63 adds none), then API, then web. The new API accepts the P58 web's sales, so there is no gap.
- **Rollback.** Revert the P63 commits. The old VAT paths come back, and no data step is needed: P63 wrote nothing new. The P61 restriction still applies to any API rollback below P61.

## 6. Known limits (not blocking)

- Dead branches remain in the terminal: the `pwd`/`senior_citizen` UI paths, the preview-rate labels, and the legacy picker in `payment-footer.tsx`. They are unreachable because the terminal always passes the manual-discount state.
- The API still accepts `vatable_cap_amount` on product edits, and the promotion editor's VAT-cap gate still exists. Neither affects a sale. Promotions are not applied by any checkout.
- `PUT /api/settings/discount-policy` still stores PWD/Senior/Employee rates. No screen sends them and no new sale reads them.
- `discountIdReference` is still encrypted and stored if a client sends one. The current terminal never does.
- The shared `computeSaleTax` and its tests remain, for describing history.
