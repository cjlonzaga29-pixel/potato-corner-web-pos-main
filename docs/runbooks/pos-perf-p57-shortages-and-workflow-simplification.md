# POS-PERF-P57 — Recipe-aware stock alerts, simpler payroll, supervisor-created discounts, type-first products

Starting commit: `d9108ce`. Final commit and git status: §12.

**One decision needs an owner or accountant before release: see §5.** Current checkout no longer offers a PWD or Senior Citizen VAT-exempt path.

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
- **Counts are unique items per branch.** An item short for three sizes counts once. The shown requirement is the largest one, and each affected size is listed.
- **Shown with units:** available, required, deficit, and the affected sizes.
- **Kept separate:** untracked items keep the checkout policy and appear under `setup_issues`, not as shortages. Setup errors stay in product screens. Manually deactivated products are not evaluated.

**API.** `alerts` keeps its P56 meaning for older clients. New additive fields are `recipe_shortages[]` (healthy by threshold but short of a serving), `setup_issues[]`, and `recipe_shortage` on rows and alerts.

**One source for all views.** Dashboard card, dashboard panel, inventory filter (`?status=insufficient`) and transfer needs use the same fields. The recipe check is batched per branch, and a test guards against N+1 reads. Alerts refresh with 30-second polling plus invalidation on recipe changes.

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

**Rehearsal** (`apps/api/scripts/test-p57-migration-on-populated-data.ts`, disposable local database): 20,000 sales, all existing columns byte-identical, CHECKs refuse bad values, an older-API insert gets defaults, no drift.

**Order: migrate → API → web.**

| Combination | Behavior |
| --- | --- |
| Old web, new API | Without the capability parameter the POS list returns only staff-entered, whole-order types. Old edits change one row. Old checkout payloads omit `amount_mode` and are accepted |
| New web, old API | Web treats a missing `amount_mode` as staff-entered and whole order. Selected-product and fixed saves are ignored by the old API, and the Type filter shows all products. **Unsupported for configuring new types: deploy the API first** |
| Queued sales | Current and legacy queued payloads still sync, including legacy statutory ones |
| Fixed type, old offline client | Not listed to clients without the capability, so they cannot select it. A payload naming one without `amount_mode` is read as staff-entered and refused with `MANUAL_DISCOUNT_AMOUNT_MODE_CHANGED`, never converted |
| Config changed while queued or on screen | A stale version or changed amount is refused, never recalculated silently |

**API rollback.** An older API would offer fixed and product-limited types as staff-entered and whole order. First take them off the POS (review, then run on the verified target):

```sql
UPDATE manual_discount_types
SET apply_to_pos = false, version = version + 1
WHERE is_active AND apply_to_pos AND (amount_mode = 'fixed' OR product_scope = 'selected');
```

Web rollback alone is safe. The migration can stay in place, because an older API ignores the new columns. Do not drop them after sales have snapshots referring to fixed types.

## 10. Verification

Disposable local Postgres (new `p57_test`, `p57_browser`, `p57_rehearsal` databases), real local Supabase Storage, final production builds, separate ports. No production access.

| Suite | Result |
| --- | --- |
| API, serial | 3481 passed, 0 failed, 104 skipped (8 files gated on environment or database conditions) |
| Web | 1603 / 1603 |
| Shared | 54 / 54 |
| Type-check and lint | 7 / 7 tasks, 0 errors. Warnings are `no-console` and one `<img>` |
| Builds: shared, API, web | 3 / 3 |
| Migration rehearsal | Pass (§9) |

Final-build browser sections, 141 checks:

| Section | Result | Covers |
| --- | --- | --- |
| No types | 7 / 7 | exact message, Apply disabled, no built-in or percent labels, undiscounted sale, failed list with working Retry and no fallback |
| Stock | 23 / 23 | 12 g / 40 g and 40 g / 70 g, unique counts, card = panel = filter = transfer needs, flavors not summed, keyboard details, transfer never moves stock, refresh after a stock change, branch isolation, forged branch id |
| Payroll | 11 / 11 | missing policy guidance, settings link, flow order, no invented rate, draft only, no auto-finalize |
| Discount admin | 15 / 15 | menu, legacy labels, Select all states, search-scoped selection, persisted eligibility, statutory-looking name stays manual, forged branch and product |
| Terminal | 30 / 30 | manual, fixed, cap, tampered amount, mixed cart, no eligible item, proof failure and retry on real Storage, cashier and shift binding, private bucket, reuse refused, idempotent replay, fresh-sale reset, cashier switch, stale type refused then confirmed |
| Products | 7 / 7 | Type column and filter, tabs, type-first creation, nothing written by choosing |
| Layouts | 48 / 48 | light and dark at desktop, tablet and phone, keyboard Apply discount at checkout |

**Test-aid notes.**

- Browser fixtures are in `apps/api/scripts/p57-browser-fixtures.ts`; it refuses anything except a local `p57_browser` database. The driver itself was session scratch and is not committed.
- Failures during driver bring-up were driver faults (selectors, a corrupt test image, a too-strict assertion on retired rows) and the local rate limiter. No app code changed because of them.
- The layout sweep ran through a scratch proxy that varied the forwarded IP (§11).
- After the browser runs, one lint fix changed how `updateManualDiscountTypeSchema` detects an empty update, with the same behavior. Shared tests, the discount and P55/P57 integration tests, type-check and builds were rerun. The browser sections were not.

## 11. Remaining limits

- **Old and new build combinations** were verified at API contract level only. Real old-build browser runs were not possible without a new worktree.
- **Real camera** capture was not exercised. Gallery upload was, on real local Storage.
- **Admin rollups and `lowStockIngredientCount`** stay threshold-based, so "Low Stock Items" can differ from "Inventory Alerts" by design.
- **Mix & Max slot snack variants** are evaluated only through their own catalog rows, not per slot.
- **Terminal statutory plumbing** (`discountType` and ID fields in `PaymentFooter`) is inert and left in place. Tech debt.
- **Existing behavior found, not changed:**
  - `apiLimiter` allows 100 requests per 15 minutes and is keyed by IP, because it runs before auth. About 13 supervisor page loads exhausted it locally, and a branch behind one IP shares that budget. The layout sweep used a scratch proxy to get past this. Worth reviewing.
  - A corrupt image sent to `POST /api/transactions/discount-proof` returns 500 rather than a clean validation error. The form is kept and retry works.
  - The local `backgroundCompletionMs` log reads about −8 hours, so it looks like a timezone mismatch in that metric. Not confirmed on deployed infrastructure.

## 12. Final state

- Starting commit: `d9108ce` (`origin/main`).
- Branch: `feat/pos-perf-p57-shortages-and-workflow`, local only. Not pushed, merged or deployed.
- Code commit: `f3377a2`. This runbook is the commit directly after it.
- Git status after both commits: only `.vscode/settings.json` modified, which is unrelated and was left unstaged.
- Local test resources: proof objects deleted from local Storage, and the local services used for this run stopped.
