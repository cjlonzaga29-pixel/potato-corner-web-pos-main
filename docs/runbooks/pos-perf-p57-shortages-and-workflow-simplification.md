# POS-PERF-P57 — Recipe-aware stock alerts, simpler payroll, supervisor-created discounts, type-first products

Starting commit: `d9108ce`. Final commit and git status: §12.

**One decision needs an owner or accountant before release: see §5.** Current checkout no longer offers a PWD or Senior Citizen VAT-exempt path.

**The final results are in §10 and §13.** They replace the earlier run described in the first draft of this runbook, which predated the last stock fix.

## 1. Causes and fixes

| Cause | Effect | Fix |
| --- | --- | --- |
| Alerts only asked "is it at zero or at a threshold?" | Raw Fries 12 g against a 20 g recipe, and Chicken Pops 40 g against 70 g, looked healthy while the POS refused them | Alerts now also ask whether the stock covers one serving of a recipe that sells at this branch |
| The dashboard product-size panel was the only place that reason appeared | Two panels told one story, per size instead of per item | Panel removed. The reasons moved to the item's alert details |
| The discount menu opened legacy promotions | Supervisors landed on the wrong screen | "Discounts" opens Discount Types. Legacy promotions stay reachable and are labelled legacy |
| Checkout had built-in PWD and Senior Citizen choices, and a required-choice flag | Options supervisors never created, and a flag that could block a sale | Checkout shows only active Apply-to-POS types for the branch |
| Discount types could only be staff-entered, whole order, one branch at a time | Repeated setup and no voucher amount | Fixed peso mode, product eligibility, several branches in one save |
| Payroll opened on detail | Hard to see what to do next | Branch and cutoff, then employees, then review |
| The product builder opened before any type was chosen | Promotional and seasonal products were easy to misfile | The type is chosen first, in the existing builder |

## 2. Shortage definitions and counts

Rows and alerts use one state order: **Out of stock > Insufficient for a serving > Critical > Low > Healthy**.

| State | Meaning |
| --- | --- |
| Out of stock | Available is zero or less |
| Insufficient for a serving | Available is positive, and less than one serving of a sellable recipe at this branch |
| Critical, Low | Available is at or under a threshold someone configured. No threshold is invented |

- **Source.** `evaluateBranchRecipeShortages` reuses the conversion from `buildBatchConverter`, the same base, flavor-override and option rules as availability, and available = on hand − reserved.
- **Alternatives are not summed.** Each flavor or option is judged by itself. If only Cheese is short and BBQ still sells, Cheese is listed and the size is marked as still selling (`blocks_size: false`).
- **Choices one sale takes together are summed.** Mix & Max slots and required add-ons all come out of one sale, so `required-choice-combinations.ts` tries each whole selection (§2.1).
- **Counts are unique items per branch.** An item short for three sizes counts once. The shown requirement is the largest one, and each affected size is listed.
- **Shown with units:** available, required, deficit, and the affected sizes.
- **Kept separate:** untracked items keep the checkout policy and appear under `setup_issues`, not as shortages. Setup errors stay in product screens. Manually deactivated products are not evaluated.

**API.** `alerts` keeps its P56 meaning for older clients. New additive fields are `recipe_shortages[]` (healthy by threshold but short of a serving), `setup_issues[]`, and `recipe_shortage` on rows and alerts. `choice_kind` can also be `slot` or `combination`. `setup_issues[].inventory_item_id` is null when no item is involved.

**One source for all views.** Dashboard card, dashboard panel, inventory filter (`?status=insufficient`) and transfer needs use the same fields. The recipe check is batched per branch, and a test guards against N+1 reads. Alerts refresh with 30-second polling plus invalidation on recipe changes.

### 2.1 Required choices (final review)

Reproduced against the real routes before any fix. Before the fix, the alert and POS card reported the first five rows wrongly, while the cart check and checkout refused the sale.

| Case | Before | Now, on every surface |
| --- | --- | --- |
| Two slots need 40 g each, 60 g available | No alert, card In Stock, checkout refused | Blocking alert: 80 g needed, 20 g short. Card Out of Stock |
| 100 g on hand, 30 g reserved, same recipe | No alert | Blocked at 70 g available. Clears when the reservation does |
| Slot recipe in kg, stock in g | No alert | Converted first: 80 g needed, 10 g short |
| Packaging 10 g and slot 40 g from one item, 45 g available | No alert | 50 g needed, 5 g short |
| Flavor and required add-on share an item | No blocking alert | Added together: 60 g needed, 10 g short |
| Two slots, Fries or Alt, Fries 60 g | Correctly quiet | Still no shortage: Fries + Alt fits and sells |
| One option too big, another fits | Not listed | Listed for the slot, `blocks_size: false` |
| "Add-ons" group flagged required, option short | Alert said blocked, checkout sells | Not blocking, matching checkout |
| Slot with no choosable snack and flavor | Not reported | `setup_issues` reason `no_slot_choice`, never a shortage |
| Snack manually disabled | Not a shortage | Still not a shortage |

- **Rules follow checkout.** Every slot needs one snack and flavor even if not flagged required, a slot variant ignores its own flavors, and "Add-ons" groups are never required. A MULTIPLE group's pick count follows `resolveSelectedOptions`.
- **Blocked names what to restock:** the short items of the combination closest to fitting, once per item.
- **Reads stay batched.** Slots add one batched recipe read and required add-ons one mapping read, each plus conversions if needed. Neither grows per item or per slot. Identical choices collapse before the search. Past 5,000 distinct combinations nothing is claimed.
- **POS card.** It now uses the same evaluator for variants with slots or required add-ons, so a blocked Mix & Max is refused on tap with the named shortage. Variants without either keep the existing flavor check. Checkout, stock balances and enablement are unchanged.
- **A recipe unit with no conversion.** Readiness doesn't check conversions, so a sellable recipe like this made the shared batch throw. That failed the branch's alerts and Inventory page (reproduced), and the POS catalog uses the same batch. Now only that recipe is affected: `setup_issues` reason `no_unit_conversion`, or `no_slot_choice` if it was a slot's only choice, and its POS card reads `unknown`, never out of stock. Other products answer normally and checkout still refuses it.

**Threshold-only metrics, now labelled.**

| Metric | Label |
| --- | --- |
| Admin branch page, `lowStockIngredientCount` | "Items At Stock Threshold" |
| Branch dashboard, if the alerts fail to load | Falls back to the same count and says "Items At Stock Threshold", not "Items Needing Stock". While alerts load it shows loading |
| Admin low-stock summary empty state | Says it covers thresholds and zero stock only. This panel isn't currently mounted on the Admin dashboard |

The Admin valuation rollup's `low_stock_count`, `critical_stock_count` and `out_of_stock_count` and the branch comparison's `low_stock_ingredient_count` stay threshold-based. No mounted page presents them as a count of items preventing sales.

**Found, not changed: the cart check is stricter than slot deduction.** The cart check and these alerts count a slot snack's flavor-specific recipe rows. `computeComponentDeductionForSlots` calls `computeBomDeduction` without the flavor, so checkout neither reserves nor deducts those rows for a Mix & Max slot. Reporting follows the cart check, because it gates the POS. Whether flavor ingredients should be deducted for slots is a checkout decision and was left alone.

**Transfer.** Selecting a need prefills the item and destination and explains the suggested quantity. The quantity stays empty until "Use …" is pressed, and stock moves only on the normal submit.

## 3. Payroll

Calculations and safeguards are unchanged. The flow reads Branch → 1. Cutoff → 2. Employees → 3. Review payroll.

- A clear Payroll Settings link, and guidance when the policy is missing ("Nothing is assumed").
- An employee with no rate shows "No rate — add one". No default rate is invented.
- Explanations are collapsed. Exclusions are one tap away and still state that this is not statutory net pay.
- "Review payroll" creates a draft. Finalizing remains a separate human action.

## 4. Discount menu and legacy

- `/supervisor/discounts` is the primary page. Normal workflow no longer shows promotion or VAT-treatment controls.
- Legacy promotions and legacy discount settings remain separate and labelled. Promotions are not disabled and no history is deleted.

## 5. Built-in checkout choices removed: decision needed

- Checkout lists only active Apply-to-POS types for the branch. Nothing is seeded.
- With none: **"No discounts available. Ask your supervisor to add one."** Apply discount is disabled, and No discount still works.
- The required-choice flag no longer blocks checkout. If the list fails, a retry is shown with no fallback.
- A supervisor may name a type "PWD". It remains a plain manual discount. The name never selects a formula, and the editor says so.

**Owner or accountant decision.** RA 9994 and RA 10754 treat PWD and Senior Citizen sales as VAT-exempt, and `.claude/CLAUDE.md` records that formula as a critical rule. This task removes that path from current checkout as instructed, and nothing here claims a verified statutory calculation. Decide whether statutory sales may be run this way before release.

**Preserved.** The API still accepts legacy statutory payloads and queued sales. Historical VAT, receipts and statutory reports are unchanged.

**Boundary.** Current checkout computes amount to pay as subtotal minus the entered or fixed discount. It does not calculate VAT on those sales. That is an accounting-policy choice the owner asked for, not a verified statutory calculation, and this project makes no claim of legal compliance. Tax redesign is out of scope.

## 6. Amount and proof rules

| Field | Rule |
| --- | --- |
| Amount mode | A. Staff enters at checkout. B. Fixed peso. Existing types stay staff-entered |
| Fixed | Order-level, never per unit, capped at the eligible subtotal, with the cap shown. No automatic percent |
| Selection | Always explicit. A fixed type is never applied by itself |

**Server validation.** The server checks type, version, branch, eligibility and mode, and computes fixed amounts itself in centavos.

| Code | When |
| --- | --- |
| `MANUAL_DISCOUNT_TYPE_CHANGED` (409) | The type's version moved since the cashier saw it |
| `MANUAL_DISCOUNT_AMOUNT_MODE_CHANGED` (409) | The payload's mode differs from the type's |
| `MANUAL_DISCOUNT_FIXED_AMOUNT_MISMATCH` (409) | The acknowledged amount differs from the server's capped amount |
| `MANUAL_DISCOUNT_NO_ELIGIBLE_ITEMS` (422) | No line is eligible |
| `MANUAL_DISCOUNT_EXCEEDS_SUBTOTAL` | A manual amount exceeds the eligible subtotal |
| `MANUAL_DISCOUNT_PRODUCT_INVALID` (422) | The product list is not valid for the branch |

**Config changes never silently change a charge.** The POS list does not poll during checkout. A stale Charge gets a 409 and writes nothing; the terminal then refetches, shows the new total, and blocks Charge until "Confirm new total".

**Snapshot.** Version 2 with additive fields: `amount_mode`, `fixed_amount`, `capped_to_eligible`, `product_scope`, `eligible_product_ids`, `order_subtotal`.

**Proof.** Take Photo or Upload from Gallery, uploaded before Charge, bound to cashier, branch and shift, one sale only. Upload failure keeps the form and offers retry. Historical proofs are untouched.

## 7. Eligibility and Select all

- Branch and product pickers show a count and a partial state, and offer Clear.
- **"All products" scope** includes future products. **"Only the products I choose"** is an explicit stored list. Select all during a search covers only the shown results, and the UI says so.
- The server authorizes each branch and product, and stores eligibility in `manual_discount_type_products`.
- A mixed cart caps at the eligible lines' totals (a line's add-ons count with it), shows the eligible amount when different, and is never automatic.
- **PATCH.** With `branch_ids`, the save applies to rows at branches the supervisor manages, adds rows, and deactivates dropped ones in one transaction. Without it (older web), only that row changes. A row retired by moving a single-branch type keeps `group_id` null; retired rows cannot be edited, and the branch can be re-added later.

## 8. Product types

Create Product asks Regular, Promotional or Seasonal first, then opens the existing builder (`?type=`), with an unknown value falling back to Regular. The list gains a Type column and filter. Active, Drafts and Inactive stay separate. Classification alone neither discounts nor publishes, and choosing a type writes nothing.

## 9. Migration and rollout

Migration: `20261102120000_pos_perf_p57_discount_amount_modes`. Additive only: four columns on `manual_discount_types` with constant defaults, CHECK constraints, a group index, and one new join table. `transactions` is not touched. No applied migration was edited.

**Rehearsal** (`apps/api/scripts/test-p57-migration-on-populated-data.ts`, disposable local database): 20,000 sales, all existing columns byte-identical, CHECKs refuse bad values, an older-API insert gets defaults, no drift. That rehearsal ran on the earlier commit. The migration has not changed, and the final stock fix adds none.

**Order: migrate → API → web.**

Real-browser results are in §13.

| Combination | Behavior |
| --- | --- |
| Old web, new API | Supported. Fixed and product-limited types are not offered. Staff-entered, proof, statutory and queued sales work. An old edit changes one row and keeps its mode, scope and eligibility |
| New web, old API | Supported for selling once the rollback step below has run. **Not for configuring types:** the old API requires `branch_id`, so the save is refused with 422, nothing is written, and the form stays open. The message is raw (`branch_id: Invalid input…`). The Type filter shows all products |
| Queued sales | Sync once in both directions, keeping cashier, total and offline flag. Manual discounts stay online-only |
| Fixed type, old client | Not listed. A payload naming one without `amount_mode` is refused with `MANUAL_DISCOUNT_AMOUNT_MODE_CHANGED`, never converted |
| Config changed while on screen | A stale version or changed amount is refused and writes nothing. An old terminal keeps the cart and asks the cashier to review |

**Reload.** An open terminal keeps its loaded discount list until it refetches, and old web has no way to learn a type changed until Charge is refused. That refusal is safe, so no forced reload is needed for correctness. Reload open terminals after the web deploy so cashiers get the new checkout.

**API rollback prerequisite.** An older API offers fixed and product-limited types as staff-entered, whole-order types, and does not enforce eligibility. Verified: without this step, a limited type gave ₱10 off a product it does not cover. Take them off the POS first (review, then run on the verified target):

```sql
UPDATE manual_discount_types
SET apply_to_pos = false, version = version + 1
WHERE is_active AND apply_to_pos AND (amount_mode = 'fixed' OR product_scope = 'selected');
```

**A terminal open across that rollback.** A fixed type already selected on a new terminal is sent with its shown amount, and the old API records it as a manual discount. Verified: ₱20 shown, ₱20 charged, cashier and key kept. The charge is right, but the old API applies no cap or eligibility check. Reload terminals as part of the rollback.

Web rollback alone is safe. The migration can stay in place, because an older API ignores the new columns. Do not drop them after sales have snapshots referring to fixed types.

## 10. Verification

Everything below ran on the final code: a new local Postgres cluster on its own port, an isolated local Supabase Storage project, new keys, production builds. Shared services were left alone. No production access.

| Suite | Result |
| --- | --- |
| API, serial | 3503 passed, 0 failed, 104 skipped (8 files gated on environment or database conditions) |
| Web | 1604 / 1604 |
| Shared | 54 / 54 |
| Lint and type-check | 7 / 7 tasks, 0 errors. Warnings are `no-console` and one `<img>` |
| Builds: shared, API, web | 3 / 3 |
| Migration rehearsal | Not rerun: no migration changed (§9) |

**Final-build browser sweep: 162 / 162, from a freshly migrated and seeded database.**

| Section | Result | Covers |
| --- | --- | --- |
| Stock | 23 / 23 | 12 g / 40 g and 40 g / 70 g, unique counts, card = panel = filter = transfer needs, flavors not summed, keyboard details, transfer never moves stock, refresh, branch isolation, forged branch id |
| No types | 7 / 7 | exact message, Apply disabled, no built-in or percent labels, undiscounted sale, failed list with working Retry and no fallback |
| Payroll | 11 / 11 | missing policy guidance, settings button, flow order, no invented rate, draft only, no auto-finalize |
| Discount admin | 15 / 15 | menu, legacy labels, Select all states, search-scoped selection, persisted eligibility, statutory-looking name stays manual, forged branch and product |
| Terminal | 33 / 33 | manual, fixed, cap, tampered amount, mixed cart, no eligible item, proof failure and retry on real Storage, cashier and shift binding, private bucket, reuse refused, idempotent replay, fresh-sale reset, cashier switch, stale type refused then confirmed, branch move |
| Products | 7 / 7 | Type column and filter, tabs, type-first creation, nothing written by choosing |
| Mix & Max | 15 / 15 | dashboard, Inventory, Transfer and POS agree; blocked card refused; impossible combination refused; valid combination sold and deducted; reservation blocks and clears |
| Late lint fix | 3 / 3 | see below |
| Layouts | 48 / 48 | light and dark at desktop, tablet and phone, keyboard Apply discount at checkout |

**The late lint fix.** It is in `updateManualDiscountTypeSchema`: "Nothing to change" is now decided by looking for any field other than `expected_version` that isn't undefined. It runs on every discount-type PATCH, so it does affect runtime validation. Behavior is the same: an empty update is refused and changes nothing, a one-field update works, and a field set to `false` counts as a change. Checked on the final build, as were the supervisor edits in the sections above.

**Test-aid notes.**

- `apps/api/scripts/p57-browser-fixtures.ts` refuses anything except a local `p57_browser` database. The driver and service runner were session scratch and are not committed.
- All browser traffic went through a scratch proxy that varied the forwarded IP, because of the local rate limiter (§11), and echoed the caller's origin so old and new web could share an API. That CORS change exists only in the proxy, so cross-origin behavior between builds wasn't tested.
- Failures during bring-up were driver faults: section order, a hard-coded Storage port, a missing photo Confirm step, selectors for the non-dialog slot prompt, CPU contention with a concurrent build. One assertion was wrong: it expected a moved type's retired row to share a group id, which §7 says it does not. No app code changed because of these.

## 11. Remaining limits

- **Real camera** capture was not exercised, as no camera device was available. Gallery upload was, on real local Storage. It does not prove physical-camera behavior.
- **Accounting decision** on statutory sales is open (§5).
- **Readiness and conversions.** A recipe with no unit conversion still counts as ready, and is only refused at checkout. It is now reported as setup, but readiness itself wasn't changed.
- **Slot prompt accessibility.** The Mix & Max prompt is a plain overlay, not a dialog. Existing behavior, not changed.
- **Terminal statutory plumbing** (`discountType` and ID fields in `PaymentFooter`) is inert and left in place. Tech debt.
- **Existing behavior found, not changed:**
  - Slot flavor rows are counted by the cart check but not deducted at checkout (§2.1).
  - `apiLimiter` allows 100 requests per 15 minutes and is keyed by IP, because it runs before auth. About 13 supervisor page loads exhausted it locally, and a branch behind one IP shares that budget. Worth reviewing.
  - A corrupt image sent to `POST /api/transactions/discount-proof` returns 500 rather than a clean validation error. The form is kept and retry works.
  - The local `backgroundCompletionMs` log reads about −8 hours, so it looks like a timezone mismatch in that metric. Not confirmed on deployed infrastructure.

## 12. Final state

- Starting commit: `d9108ce` (`origin/main`).
- Branch: `feat/pos-perf-p57-shortages-and-workflow`, pushed with a PR to `main`. Not merged or deployed.
- Commits on top of the start: `f3377a2` (code), `e8dad84` (runbook), then the final stock-coverage commit.
- `.vscode/settings.json` is unrelated, stays modified and was never staged.

## 13. Old and new build compatibility

Real browsers against real builds. `d9108ce` came from a clean `git archive` export in a temporary directory, with its own install and builds, and no secrets or `node_modules` copied in. Both API versions used one migrated local database, and only one API ran at a time once the old API started.

**Old web → new API: 18 / 18.**

| Scenario | Result |
| --- | --- |
| Terminal and discount list | Loads. Staff-entered types and built-in PWD and Senior entries offered. Fixed and limited types not offered |
| Manual ₱12.50 on ₱100 | ₱87.50. Payload has no `amount_mode`, server records manual. Cashier and idempotency key kept |
| Proof on real Storage | ₱95. Upload bound to the sale and the cashier |
| Statutory PWD on ₱100 | ₱71.43, VAT ₱0, unchanged |
| Type changed to fixed while selected | Refused by name, no sale written, cart kept, payload unchanged |
| Queued no-discount sale | Nothing sent offline. Syncs once, with cashier, total and offline flag |
| Payload naming a fixed type, old shape (**API-level check**) | 409, nothing written |
| Old supervisor rename of a limited type | That row only. Scope, eligibility and other types unchanged |

**New web → old API: 15 / 15.**

| Scenario | Result |
| --- | --- |
| Open terminal, fixed type, API replaced underneath | ₱20 shown, ₱20 charged, stored as manual. Cashier and key kept |
| Rollback step **not** run | Fixed and limited types offered. Limited type gave ₱10 off an ineligible product. **This is the reason the step is required** |
| Rollback step run, terminal reloaded | Both gone. Staff-entered types remain, and no built-in statutory entries |
| Manual and proof sales | Correct totals, on real Storage |
| Queued no-discount sale | Syncs once, with cashier, total and offline flag |
| Saving a discount type on screen | 422, nothing written, form stays open, raw message |
| Fixed save through the API | 422, nothing stored |

**Not covered.** Sales queued by one build and synced after that browser was upgraded to the other, and a real deployed cutover. Queued payload shapes are covered by the integration tests only.
