# POS-PERF-P49 — Promotional/seasonal products and product-scoped discounts

Source: October 29 video review. Supervisors classify products as Regular, Promotional or Seasonal, and configure
promotional discounts for those products at branches they manage. Checkout applies the discount server-side and stores it
with the sale.

## 1. Audit (before implementation)

| Area | Found | Consequence for P49 |
| --- | --- | --- |
| Product classification | `products.is_seasonal` + `seasonal_start_date/end_date` (CR-001). Informational only: no POS, catalog, checkout or report logic reads it. The builder always sends `is_seasonal: false`; only the admin read-only views show a Seasonal badge. No "promotional" product concept. | Add one `classification` enum. Keep `is_seasonal` as a mirror for old readers. |
| Variants vs classification | Sizes are `product_variants` rows (`base_price`, optional `vatable_cap_amount`). | Classification is per product; a discount applies to each size's own price. Variants are never duplicated to change classification. |
| Publication | `products.status` (draft/active/…) + `branch_product_availability.is_available`, P39R2 `ever_published`. | Untouched. Classification is a separate column and never changes status or availability. |
| Shared-product authority | `hasActiveCatalogAuthorityForProduct` (P36R4): full coverage of every configured branch, otherwise fork a branch copy. `PATCH /products/:id` already enforces it. | Classification goes through `PATCH /products/:id`, so it inherits full-coverage authority and the existing fork flow. |
| Discounts module | `apps/api/src/modules/discounts/` is an empty scaffold. | Promotions live here. |
| Transaction discounts | One discount per transaction (architecture §Discounts). PWD/Senior (VAT-exempt formula), Employee (% off the VATable subtotal, VAT extracted 12/112 from the remainder). `promotional` exists as a type, but checkout rejects it with `DISCOUNT_TYPE_NOT_SUPPORTED` (the POS sent a cashier-typed amount, which must never be trusted). | Product promotions use the existing non-statutory path (same as Employee). They never combine with PWD/Senior/Employee. The cashier-typed amount stays rejected. |
| Line snapshot | `transaction_items` stores frozen names/unit price/`line_total` (gross, before discount). Reports use `subtotal`/`line_total` as **gross** and `transactions.discount_amount` as the discount. | Keep `line_total` gross. Add line `discount_amount` + promotion id/snapshot. Put the summed promotion discount in `transactions.discount_amount` with `discount_type = 'promotional'`, so every gross/discount/net report reconciles without changes. |
| Immutability | `prisma-immutability.ts` blocks updates to `TransactionItem` and money fields of `Transaction`. | New columns are written once, at insert. Editing a promotion later cannot rewrite history. |
| POS catalog | `GET /products/catalog` (TanStack + service-worker NetworkFirst cache; P46R3 `fresh=` confirmed read). | Add an optional `promotion` per variant (additive; old clients ignore it). |
| Offline | Queue → `POST /transactions/sync-offline` → the same `createTransaction` path. Old queued payloads have no promotion fields. Request schemas strip unknown keys. | Offline sales never carry a promotion (see §6). |
| Timezone | `lib/manila-time.ts` (`manilaDateKey`), Asia/Manila business day. | Promotion dates are Manila calendar dates, inclusive. |
| Fraud | `rule-discount-abuse` counts any completed sale with a non-null `discount_type` (Decision #3). | Unchanged. A promotional sale counts like any discounted sale. See §8, item 1. |

## 2. Classification versus publication

- `products.classification`: `regular` | `promotional` | `seasonal`. Default `regular`.
- Migration backfill: `seasonal` where `is_seasonal = true`, otherwise `regular`. Prices, status, availability and versions
  are not touched.
- `is_seasonal` is kept equal to `classification = 'seasonal'` on every write, so older readers stay correct. Legacy
  `is_seasonal` input still works: `true` → seasonal; `false` on a seasonal product → regular.
- The seasonal window (`seasonal_start_date/end_date`) remains optional informational metadata. Before P49 a seasonal
  product *required* both dates. That requirement is relaxed, so a product can be classified Seasonal from the builder
  or Edit popup without inventing dates. Both-or-neither and end ≥ start still apply.
- Classification alone never changes a price and never applies a discount.
- Classification is independent of status. Draft/Active/Inactive tabs, Add to POS, deactivate and archive behave exactly
  as before.
- Authority: the same as any product field (`PATCH /products/:id`, supervisor only, full coverage). A supervisor who
  covers only some branches of a shared product gets `PRODUCT_UPDATE_FORBIDDEN` and must use the existing branch-copy
  (fork) flow; the copy inherits the classification.

## 3. Promotion (discount) rules

Schema (additive):

- `promotions`: name, `discount_kind` (`percentage` | `fixed_amount`), `discount_value`, `is_enabled`, optional
  `starts_on`/`ends_on` (Manila calendar dates, inclusive), `version`, creator/updater, timestamps.
- `promotion_products`, `promotion_branches`: explicit selections (composite primary keys).
- `transaction_items`: `discount_amount` (default 0), `promotion_id` (nullable), `promotion_snapshot` (JSON, nullable).

Eligibility (validated on save **and** at checkout):

- A product must be classified Promotional or Seasonal. Regular products cannot be selected.
- A product must not be archived or discontinued.
- A product with any size that has a `vatable_cap_amount` (e.g. Tera Mix) is refused. How a discount splits between the
  capped VATable portion and the non-VATable remainder is not defined anywhere, and P49 does not define VAT rules.
- Each selected product must be configured (have a `branch_product_availability` row) at one or more selected
  branches. The promotion applies only where the product is actually sold.
- Branches: explicitly selected, active, and all within the actor's **live** branch authority
  (`findAllActiveBranchIds`, read from the DB on every request, never the JWT).

Calculation (one pure function shared by the catalog and checkout):

- The discounted price is the **size's base price only**. Flavor premiums and add-on options are never discounted.
  The editor says so.
- Percentage: `unit discount = round2(base price × percent ÷ 100)`, 0 < percent ≤ 100.
- Fixed amount: **per eligible unit**, `unit discount = min(amount, base price)`. Example: ₱10 off a ₱39 Regular → ₱29;
  ₱50 off a ₱39 Regular → ₱0 (capped), never negative. It is never a whole-cart discount.
- `line discount = unit discount × quantity` (rounding happens once per unit, so quantity never introduces drift).
- Money uses the existing `round2` (cents, half-up as `Math.round`).

Schedule: active when enabled and the Manila calendar date of "now" is ≥ `starts_on` (if set) and ≤ `ends_on` (if set).
Both ends are inclusive whole Manila days (00:00–23:59:59.999 +08:00).

Overlap: when several active promotions cover the same product at the same branch, the unit gets **exactly one**: the
largest unit discount for that size. Ties go to the earliest-created promotion, then the lowest id. No stacking. The
editor shows overlapping promotions for the selected products and states this rule.

Combination with transaction discounts (architecture §Discounts, "only one per transaction"; PWD/Senior take precedence
over promotional):

- When PWD, Senior Citizen or Employee is selected, product promotions are **not applied** to that sale. The POS shows
  regular prices plus the selected discount and explains why. The server refuses a sale that claims a promotion together
  with one of those discounts (`PROMOTION_NOT_COMBINABLE`, nothing charged).
- The VAT path for a promotional sale is the existing non-statutory path (identical to Employee): the discount reduces
  the VAT-inclusive VATable amount and VAT is extracted at 12/112. No new VAT rule.
- `transactions.discount_type = 'promotional'`, `discount_amount` = Σ line discounts, `discount_rate_used = NULL` (rates
  differ per line; the per-line snapshot holds them).
- The old cashier-typed whole-cart "Promotional" amount stays refused by the API and is removed from the POS discount
  menu.

Permissions:

| Action | Super admin | Supervisor | Branch / staff |
| --- | --- | --- | --- |
| Set product classification | No (catalog writes are supervisor-only since P35) | Yes, with full-coverage authority | No |
| List promotions | All (read-only) | Promotions touching any of their live branches | No |
| Create / edit / enable / disable | No | Only when **every** branch of the promotion is in their live authority (a promotion that also covers another supervisor's branch is read-only to them, with an explanation) | No |
| Apply at checkout | Server only | Server only | Server only |

Every change writes an audit log entry and bumps `version`.

## 4. Checkout, receipts, history

- New per-item request field `promotion`: `{ promotion_id, unit_discount }` or `null`. It is the cashier's
  *acknowledgement* of what the screen showed, never a price. The server recomputes from current configuration, bound to
  the sale's actual branch and the line's actual product/size.
- If the acknowledgement differs from the server's answer (promotion expired, disabled, edited, newly started, overlap
  changed, forged amount, unselected branch, ineligible product), the sale is refused with `409 PROMOTION_CHANGED`
  (definite no-commit). The details list each line's expected versus current discount. The POS keeps the cart, refreshes
  the catalog, shows the change and requires a fresh Charge. Nothing is silently repriced.
- An item **without** the field (an older web build) gets no promotion. It is charged exactly what that client displayed.
- Stored per line: gross `unit_price_snapshot`/`line_total` (unchanged meaning), `discount_amount`, `promotion_id`,
  `promotion_snapshot` `{ promotion_id, name, discount_kind, discount_value, version, base_price, unit_discount, quantity }`.
- The transaction stores the existing `subtotal` (gross), `discount_amount`, `discount_type`, `vat_amount` and
  `total_amount`. Receipts (POS modal, public `/r/[txn]`) show each discounted line with the promotion name and amount.
- Idempotency, attempt fencing, stock reservation, async inventory deduction and cashier attribution are untouched:
  promotion resolution runs before the write transaction, together with the other catalog reads. Inventory arithmetic
  does not depend on price.

## 5. Rollout compatibility

Pipeline: validation → approval → staged web build → migrations → API live → web promotion.

| Combination | Behavior |
| --- | --- |
| New DB, old API | Additive columns with defaults; old API never reads them. Sales write `discount_amount` 0 and NULL promotion fields. |
| Old web → new API | Old web never sends `promotion`, so no promotion is applied and the old POS charge matches its display. Old web cannot create promotions (no editor), so none exist until the new web is live. The old "Promotional" menu entry stays refused, as before. |
| New web → old API (rollback) | The new POS reads promotions only from the catalog's `promotion` field. The old API does not send it, so no promotions show and items are sent with `promotion: null`; the old API strips the unknown key. The editor page reports that the API does not support promotions (404). |
| Old queued offline sales | No `promotion` field → no promotion, same as before. |

## 6. Offline

Promotions cannot be validated offline: the device cannot know whether a promotion was edited, disabled or expired by
the time the queue syncs, and repricing a queued sale would charge something other than what the customer paid.
Therefore:

- While offline, the POS shows regular prices, labels promoted items "Promo unavailable offline", and queues items with
  `promotion: null`.
- The sync path never applies promotions. A queued item claiming one is refused (`PROMOTION_OFFLINE_UNSUPPORTED`) through
  the P46R3 visible-rejection path; it is never dropped or repriced.

## 7. Verification

All runs used disposable LOCAL Postgres databases (`127.0.0.1:5432`, names `p49_<digits>` / `p49m_<digits>`), guarded
by `local-db-guard` and a name check, with throwaway secrets and separate ports (API 4499, web 3499). Production,
`pos_verify` and other sessions' databases were never touched; no smoke accounts were provisioned and no terminal queues
were cleared.

| Check | Result |
| --- | --- |
| API unit + integration (full suite) | 191 files passed / 8 skipped; 3,258 tests passed / 104 skipped |
| P49 API suites (`promotion-pricing`, `p49-promotions.integration`) | 28 / 28 |
| Shared package | 30 / 30 |
| Web unit (full suite) | 161 files, 1,485 / 1,485 |
| `turbo run type-check lint` | 7 / 7 tasks, 0 errors (pre-existing warnings only) |
| API `tsc` build, web `next build` | pass |
| Live HTTP checks against the built API | 32 / 32 |
| Real browser (Chromium, desktop 1440×900, tablet 820×1180, phone 390×844, keyboard) | 41 / 41 checks on the final build (A–E and phone in one run; tablet in the preceding run on the same build — a repeat was blocked only by the login rate limit, 10 logins / 15 min) |

Integration coverage: branch authority (unmanaged/inactive branch refused, live re-check on write and enable),
eligibility (Regular, archived/discontinued and VAT-capped products refused with reasons), shared product promoted at a
managed branch without changing its global configuration, super_admin read-only, checkout breakdown and persisted
snapshot, inventory deduction unchanged, forged / unshown / unselected-branch claims refused with per-line details,
PWD + promotion refused, offline sync refused visibly while other queued sales sync, overlap resolution, per-unit
rounding, schedule windows in Manila time, history unchanged after an edit, idempotent replay, reclassification, and
report reconciliation (`net = gross − discount`; Σ line totals = gross).

Live HTTP highlights: forged discount → 409 `PROMOTION_CHANGED`; 3 × ₱39 with ₱10 off → subtotal ₱117, discount ₱30,
total ₱87, VAT ₱9.32; same idempotency key replays the same sale; legacy client (no `promotion` field) charged ₱39;
stale editor save → 409 `PROMOTION_CONFLICT`; staff posting another branch's id → 403 (branch guard); partial-coverage
supervisor cannot reclassify a shared product (403) but can promote it at a managed branch.

Browser scenarios: (A) editor by keyboard — Fixed amount by arrow keys, branch ticked with Space, foreign branch not
offered, Regular product disabled with reason, preview ₱39 − ₱20 = ₱19 and ₱99 − ₱20 = ₱79, cap explained, overlap
explained; (B) Edit popup shows Classification, saving Promotional leaves status and prices unchanged, builder defaults
to Regular; (C) terminal card chip, cart line names the promotion, Charge ₱38.00 for 2 × ₱19, success popup
"Promotions −₱40.00", receipt promotion line, exactly one sale stored as gross ₱78 / discount ₱40 / total ₱38;
(D) promotion disabled mid-checkout → refusal explains the change, no Retry, nothing charged, cart kept and repriced to
₱39 with a notice, then charged once; (E) "Promotional" not in the typed-discount menu, PWD line explains promotions are
not combined and uses the PWD formula on the regular price (₱27.86), offline hides the chip and shows regular price;
(F) tablet and phone: no horizontal overflow on the terminal or promotions page, editor fits the screen.

Issue found and fixed during browser verification: the "New promotion"/"Edit" buttons could open the editor before the
branch list loaded, which showed "You have no active branch assignment." and skipped the single-branch preselect. They
are now disabled until branches load.

Migration rehearsal (populated pre-P49 database: 300 products — every third seasonal with a window — 600 variants,
2,000 sales × 2 lines, stock):

- Checksums of products, variants, availability, transactions, transaction items and stock: **identical** before and
  after `prisma migrate deploy`.
- Classification after backfill: regular 200, seasonal 100; rows where `is_seasonal` disagrees with classification: 0.
- Transaction items with a discount or promotion: 0. FK `transaction_items_promotion_id_fkey` validated.
- Second `migrate deploy`: no pending migrations; re-running the backfill statement changes nothing.
- Deploy wall time 4.8 s including Prisma CLI start-up. The FK is created `NOT VALID` and validated separately, so the
  `transaction_items` lock is short; no index is built on the large table.
- A product created by an old API between migration and API cut-over gets `classification = regular` even if
  `is_seasonal = true`; re-run the backfill `UPDATE` from the second migration after the API is live to reconcile.

## 8. Known limitations

- Fraud rule "discount abuse" counts any non-null `discount_type`, so promotional sales now count toward it. Left
  unchanged (out of scope); tune the threshold or exclude `promotional` in a follow-up if it becomes noisy.
- Promotions are not available offline (by design, §6).
- Products with a VAT-capped size cannot be promoted (refused with a reason) to avoid redesigning VAT.
- Super admins can read promotions (read-only) but there is no admin promotions page; writes are supervisor-only.
- PWD/Senior and other typed discounts do not combine with promotions; the POS shows regular prices for the
  statutory formula.

## 9. State

- Starting SHA: `b8c922c` (P48), on `0357ce0` (P47), on `origin/main` `7084291`. Working tree clean at start.
- Final SHA: the local commit that adds this runbook (`feat(pos-perf-p49): …`), directly on `b8c922c`.
- Git status after commit: clean, `main` 3 commits ahead of `origin/main` (P47, P48, P49). Not pushed, not deployed.
