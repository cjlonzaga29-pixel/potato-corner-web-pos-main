# POS-PERF-P55 — Manual peso discounts, supervisor discount types, preserved proof photos

Owner-approved UX: a supervisor enables discount types for a branch; the cashier picks a type, enters a **peso**
amount, adds a proof photo when the type requires one, reviews the total and charges. This replaces automatic
discounts in the new checkout flow. Local work only — nothing pushed, deployed or run against production.

## 1. Audit of the starting implementation (`042a700`, before any edit)

| Area | Found | Consequence for P55 |
| --- | --- | --- |
| Transaction-level discounts | `transactions.discount_type` is a free `String` column. Values in use: `pwd`, `senior_citizen`, `employee`, `promotional` (P49/P50R product promotions); `manager_override` and a cashier-typed `promotional` amount are refused (`DISCOUNT_TYPE_NOT_SUPPORTED`). `discount_amount` from the client is ignored. One discount per sale. | A new value `manual`. A client may send it only together with `manual_discount` and `discount_flow` (it is the API-rollback fence, §6); the amount is always the server's own check of the cashier's entry. |
| Rates | `discount_policy` (organization) + `discount_policy:branch:<id>` (P50R override) system settings: Employee %, PWD % (≥20), Senior (=20), `requireDiscountChoice`. Resolved per sale branch at checkout. | Kept unchanged for statutory and for older clients. Not used for manual discounts. |
| Promotions | `promotions` (P49) with `application_mode` `automatic` (applied by the server to eligible Promotional/Seasonal lines) or `cashier_selected` (P50R). Rate/fixed per unit, product + branch scoped, schedules. Acknowledged per line (`items[].promotion`), refused on mismatch (`PROMOTION_CHANGED`). | Meaning does not fit a name-only, amount-free, order-level type → a separate table. Promotions stay intact for older clients; the new flow never applies them. |
| VAT | `computeSaleTax` (`@potato-corner/shared`), server-authoritative. PWD/Senior: VAT-exempt formula locked in `.claude/CLAUDE.md`. Every other discount (Employee, promotions): taken off the VAT-inclusive VATable amount, VAT = 12/112 of the remainder. VAT-capped sizes: the part above the cap is non-VATable, never discounted or taxed. `tax_basis` acknowledgement → `TAX_SETTINGS_CHANGED`. `transactions.tax_snapshot` (P50R) frozen per sale. | A manual peso discount uses the **existing** commercial path (same as Employee/promotions). No new tax rule, no exemption. |
| Proof | `POST /api/transactions/discount-proof` (multer 5 MB, JPEG/PNG/WebP, sharp → WebP, private `discount-proofs` bucket, key `<branch>/<shift>/<uploader>-<ms>-<name>.webp`, audited `DISCOUNT_PROOF_UPLOADED`). Checkout accepts `discount_proof_key` (any string!) for PWD/Senior only, optional. Viewing: `GET /:id/discount-proof` (signed 60 min) / `?download` (5 min), branch-scoped. `ImageUpload` offers Take Photo (in-page `getUserMedia`) and Upload from Gallery, keeps the file and offers Retry on upload failure. | **Defect:** a forged `discount_proof_key` naming another branch's object would be attached to the forger's sale and then viewable through it. Fixed for every new sale (§4). Manual proofs are referenced by a server-issued upload id, never a key. |
| Checkout / idempotency | `idempotency_key` + `checkout_attempts` fencing (claim → commit in the sale's own `$transaction`), lost-response resolve/abandon endpoints, replay compares branch/shift/cashier/method/items only. | Replay must also refuse a same-key request that names a different manual discount. Proof consumption happens inside the sale's `$transaction`. |
| Offline | Dexie queue → `POST /sync-offline` → the same `createTransaction`. Offline sales are cash only, never carry proof, never apply promotions; `tax_basis` mismatch is a visible rejection. | Manual discounts are online-only (config + proof can't be confirmed offline). A queued sale claiming one is refused visibly. |
| Receipts / reports | Receipts render stored amounts only; reports group by `discount_type`; Discount Compliance shows PWD/Senior rows and proof existence (never keys). Void/refund flip status, amounts never recomputed. | `manual` becomes its own group; manual sale rows carry a type snapshot. |
| Legacy UI | Supervisor Settings → "Discounts & VAT by branch" (PWD %, Employee %, "Cashier must choose a discount"); Promotions page; terminal picker with statutory, Employee and cashier-selected promotions. | New UI: Discount types manager replaces the Employee rate and required-decision controls; statutory PWD control kept. |

## 2. Transition design (decided before implementation)

- **Explicit payload version.** The new terminal sends `discount_flow: "manual_v1"`. Only then does the server apply
  the P55 rules. A request without it is a legacy client and gets exactly the pre-P55 behavior (including P49
  automatic promotions, P50R cashier-selected promotions and the Employee rate). No legacy field changes meaning.
- **New flow rules (server-enforced):** an explicit `discount_choice` is required; automatic and cashier-selected
  promotions are never applied (a line claiming one is refused); the Employee rate type is not offered; the only
  discounts are one manual peso discount **or** the statutory PWD/Senior discount (unchanged formula), never both.
- **New records, not reinterpreted ones.** New table `manual_discount_types` (branch-scoped), new table
  `discount_proof_uploads` (server registry of every discount-proof upload), and two nullable columns on
  `transactions` (`manual_discount_type_id`, `manual_discount_snapshot`). Legacy rows keep NULL. The existing
  `discount_proof_*` columns are reused for the manual proof because their meaning ("discount compliance evidence
  photo, storage key only") is the same.
- **Rollback fence.** A manual-discount sale also sends `discount_type: "manual"`. A pre-P55 API rejects that unknown
  enum value (`VALIDATION_ERROR`, nothing written) instead of stripping the unknown `manual_discount` key and charging
  the full price. The new API accepts `"manual"` only together with `manual_discount` and the flow flag.

## 3. Final checkout and supervisor flow

**Supervisor — Settings → Discount types** (`components/settings/manual-discount-types-section.tsx`): branch picker
(only branches they supervise), list of types with *On POS / Not on POS*, *Proof photo required*, "Used in N sales";
**New discount type** / **Edit** dialog with exactly three fields — Name, *Apply to POS*, *Require proof photo* — and
**Deactivate** (confirmation; deactivated types stay listed under "Deactivated (n) — kept for N past sales"). There is
no rate, amount, schedule or product field. Turning a required proof **off** needs an explicit confirmation checkbox
and is audited, so a proof-required type never silently becomes proof-optional. Statutory names (PWD, Senior, SC,
OSCA, disability…) are refused in the dialog and by the API (`STATUTORY_DISCOUNT_NAME_RESERVED`). Names are unique per
branch among active types, case-insensitive. The service check is the friendly fast path; the partial unique index
`manual_discount_types_branch_active_name_key` (`branch_id, lower(name) WHERE is_active`, migration `20261101120200`)
decides under concurrency, and its violation is reported as the same `409 MANUAL_DISCOUNT_TYPE_NAME_TAKEN` (§12.5).

The old "Discounts & VAT by branch" card is now "Statutory discounts & VAT by branch" on the supervisor page: PWD and
Senior rows only. The Employee rate and "Cashier must choose a discount" controls are hidden there, and their stored
values are re-sent unchanged on save. Super Admin sees discount types read-only (Settings → VAT & Discounts). The
admin's organization Employee-rate form is unchanged because older terminals still use it during the overlap. The
Promotions page carries a cutover notice.

API (`discounts` module): `GET /api/discounts/manual-types?branch_id=&include_inactive=` (admin, supervisor);
`GET /api/discounts/manual-types/pos` (all roles; staff and Branch Account always get their own branch, a query id is
ignored); `POST /manual-types`; `PATCH /manual-types/:id` (`expected_version`, compare-and-set →
`409 MANUAL_DISCOUNT_TYPE_CONFLICT` with the current row); `POST /manual-types/:id/deactivate`. Writes are
supervisor-only, re-checked against **live** assignments (never the JWT claim) and the type's **stored** branch; an
inactive branch gets 422. Audit: `MANUAL_DISCOUNT_TYPE_CREATED / _UPDATED / _DEACTIVATED` with before/after settings.
There is no delete route.

**Cashier — Checkout** (`components/pos/manual-discount-fields.tsx`):

1. **No discount** | **Apply discount**. A sale starts on *No discount*. At a branch whose existing P50R "Cashier must
   choose" switch is on, nothing is preselected and Charge waits for a choice.
2. *Apply discount* → **Discount type**: the branch's active Apply-to-POS types ("Enter amount in pesos"), plus the
   **Statutory · VAT-exempt** group (PWD, Senior Citizen — unchanged formula, ID number, optional ID photo).
3. Manual type → **Discount amount (₱)**: pesos off the whole order, at most 2 decimals, more than ₱0, at most the
   order's VATable amount. `10%`, `0`, `5.555`, negatives and over-subtotal amounts show a reason and keep Charge
   disabled. No percent is ever interpreted.
4. Type requires proof → **Discount Proof Photo** card with **Take Photo** and **Upload from Gallery** (the existing
   `ImageUpload`). Charge stays disabled until the upload has finished. A failed upload shows Retry Upload and keeps
   the file, cart, amount and selections.
5. Summary: **Subtotal ₱500.00 · Employee discount −₱50.00 · Amount to pay ₱450.00**. The Charge button and the
   order-review panel ("Amount to pay") show the same total.
6. Cart changed after the amount was entered → "The order changed: subtotal is now … (was …). Amount to pay is now …"
   with **Confirm new total**; Charge is blocked until it is confirmed.
7. Product cards and cart lines no longer show promotions; every line is charged its regular price (Regular,
   Promotional and Seasonal classification is unchanged).
8. The decision belongs to the sale and the cashier: it is cleared after every sale and at every operator change
   (Switch Cashier, break, idle lock, clock out — the existing `resetPaymentFields` points), and the branch's types
   are re-read when the operator changes.

## 4. Server validation (`transactions.service.ts`)

`discount_flow: "manual_v1"` (`assertManualFlowShape`, before any lookup): an explicit `discount_choice` is required
for live sales; only `pwd`, `senior_citizen` or `manual` are accepted; `employee`, a typed `promotional`,
`selected_discount` and any line that claims a promotion are refused; manual + statutory → `DISCOUNT_NOT_COMBINABLE`;
"Apply discount" without a discount, or "No discount" with one → `DISCOUNT_CHOICE_CONFLICT`. Promotions are never
applied (`applyLinePromotions` is skipped).

`manual_discount` (`resolveManualDiscount`, the server's own reads):

- the type exists, belongs to the **sale's** branch, is active and Apply-to-POS (`409 MANUAL_DISCOUNT_TYPE_UNAVAILABLE`),
  and is at the version the screen showed (`409 MANUAL_DISCOUNT_TYPE_CHANGED`);
- the amount is finite, > 0, ≤ 2 decimals, ≤ ₱999,999.99 (schema), and ≤ the VATable subtotal the server prices
  itself (`422 MANUAL_DISCOUNT_EXCEEDS_SUBTOTAL`, compared in centavos);
- the optional `expected_total_amount` acknowledgement must equal the server's total (`409
  MANUAL_DISCOUNT_TOTAL_CHANGED`, e.g. after a price change);
- a required proof needs a `proof_upload_id` that exists in the registry, was uploaded by **this cashier** for **this
  branch and shift**, and is not attached to any sale (`MANUAL_DISCOUNT_PROOF_REQUIRED / _INVALID / _ALREADY_USED`).

Client totals, labels, keys, URLs and eligibility claims are never read. Money uses centavo comparisons and the shared
`round2`, like the rest of checkout.

Inside the sale's `$transaction`, after the insert and stock reservation, the proof row is claimed with
`UPDATE … WHERE id = ? AND transaction_id IS NULL`. 0 rows → the whole sale rolls back (a concurrent sale got it).
Unchanged: the idempotent fast-path replay (before any of this), attempt fencing, stock reservation and async
deduction, cashier attribution (`cashier_id` = the token's user). A same-key replay now also requires the same manual
type and amount (`IDEMPOTENCY_KEY_REUSE` otherwise), so a retry can never apply a different or second discount.

Stored per sale: `discount_type = 'manual'`, `discount_amount`, `discount_rate_used = NULL`, `manual_discount_type_id`,
`manual_discount_snapshot` `{version, source: 'manual', discount_type_id, name, require_proof, type_version, amount,
eligible_subtotal, proof_upload_id, entered_by_id}`, the proof in the existing `discount_proof_key/type/uploaded_at`
(from the registry), and `tax_snapshot` gains `discount_flow`, `discount_source` (`manual | statutory | rate |
promotion | null`) and `manual_discount_type_id`. Everything is written once at insert (the immutability guard blocks
later changes). Receipts (POS modal, public `/r/<number>`) label it "<type name> discount" from the snapshot; reports
group it as its own `manual` discount type, separate from `promotional`, `employee`, `pwd` and `senior_citizen`.

## 5. Manual versus statutory / tax behavior

- A manual peso discount is treated exactly like the existing commercial discounts (Employee %, promotions): it comes
  off the VAT-inclusive VATable amount and VAT is the 12/112 share of what remains (`computeManualDiscountSaleTax`,
  the same arithmetic as `computeSaleTax`'s non-statutory branch; unit-tested equal to an Employee discount of the
  same peso size). ₱500 − ₱50 → ₱450, VAT ₱48.21. **VAT is not removed or zeroed, and no tax snapshot is deleted.**
  Receipt printing does not affect the tax computation.
- The non-VATable part above a size's VAT cap is never discounted (same as Employee); the maximum manual amount is the
  VATable amount, and the message says so when it differs from the subtotal.
- PWD and Senior keep their statutory formula, rates, ID requirement and VAT exemption (RA 10754 / RA 9994; sources in
  P50 §3 and §11.4). They are offered under "Statutory · VAT-exempt", cannot be created as manual types and cannot be
  combined with a manual discount. No legal or tax rule was changed in P55, so no new rule needed source
  verification; I did not re-check those sources for amendments in this session.
- **Outstanding decision (not invented here):** the owner's target "subtotal → manual discount → amount to pay" for
  *every* discount — including PWD/Senior entered as a peso amount — needs an owner/accountant decision on (a) how a
  peso PWD/Senior amount relates to the statutory 20% and VAT exemption, and (b) whether any manual commercial
  discount should ever be VAT-exempt. Until then, statutory discounts stay on the statutory path and that combination
  is blocked.

## 6. Proof security and permissions

- Upload: the existing route (multer 5 MB, JPEG/PNG/WebP, sharp → WebP, branch guard, shift guard, private
  `discount-proofs` bucket). It now also writes a `discount_proof_uploads` row and returns its id next to the key
  (older clients ignore the id).
- A manual discount never accepts a key at checkout — only the registry id, bound to cashier/branch/shift, single use.
- **Defect fixed for every sale (legacy too):** a statutory `discount_proof_key` must start with the sale's own branch
  id (`422 DISCOUNT_PROOF_INVALID`). **Superseded in the release pass (§12.3):** the prefix check alone still accepted
  a made-up `<branch>/…` key, another cashier's key, an already-attached key and `<branch>/../<other branch>/…`. An
  attached statutory key must now be a registered upload by this cashier for this branch and shift that no sale uses
  (`422 DISCOUNT_PROOF_INVALID` / `409 DISCOUNT_PROOF_ALREADY_USED`), consumed inside the sale's `$transaction` like
  a manual proof. Real uploads through the upload route (old clients included) are registered and still work.
- Viewing and downloading are unchanged (`GET /:id/discount-proof[?download]`, authenticated, branch-scoped, signed
  URLs on demand, never stored). Responses expose only `has_discount_proof`, type and time — never the key (the
  integration test asserts the key is absent from the checkout response). No new log line contains a key, URL or
  image. The existing upload audit row records the key and now the upload id (internal audit chain, as before).
- Historical proofs are untouched (nothing moved, re-keyed or registered; the rehearsal checks 1,667 historical keys).
- An uploaded but unused photo stays in the bucket (pre-existing v1 debt: no sweep job).

## 7. Legacy, offline and deploy compatibility

| Combination | Behavior |
| --- | --- |
| Old web → new API | No `discount_flow` → exactly the pre-P55 behavior (automatic and cashier-selected promotions, Employee rate, P50R required choice). A proof key must now be own-branch, which real uploads always are. |
| New web → new API | P55 flow. |
| New web → old API (API rollback) | **Executed in the release pass (§12.2).** `GET /manual-types/pos` 404 → only statutory discounts offered, with "Manual discounts aren't available on this server yet" (no futile Retry). A manual sale already on screen sends `discount_type: "manual"` → old API `VALIDATION_ERROR`, nothing written; the terminal shows "This server does not support manual discounts yet…" (review-only). No-discount sales send `promotion: null` per line; with an active automatic promotion the old API answers `PROMOTION_CHANGED` (visible, nothing charged — but such products cannot be sold until the promotion is disabled or the web is rolled back too). A required-proof upload answered by an old API has no upload id → the terminal refuses to attach it (the object stays in the bucket, unattached). |
| Queued offline sales | Synced as before; original payload, cashier and idempotency identity untouched; never repriced. New-flow offline sales carry only `discount_flow` + `discount_choice`. A queued sale claiming a manual discount (the terminal never queues one) gets a definitive visible rejection `MANUAL_DISCOUNT_OFFLINE_UNSUPPORTED` ("not recorded … amount collected was not changed"); other rows sync. |
| Offline terminal | Apply discount offers only the statutory discounts ("discount types need a connection"). A manual type chosen before going offline blocks Charge with a reason; the cart is kept. |
| Lost responses | Unchanged resolve-before-remint gate. Every P55 refusal code is on the definite-no-commit allowlist and is review-only in the error popup (no Retry). |

**Promotion cutover (explicit, never automatic).** Read-only inventory to run before go-live:

```sql
SELECT p.application_mode, count(DISTINCT p.id) AS enabled, count(DISTINCT pb.branch_id) AS branches,
       count(DISTINCT pp.product_id) AS products
FROM promotions p
LEFT JOIN promotion_branches pb ON pb.promotion_id = p.id
LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
WHERE p.is_enabled GROUP BY p.application_mode;
```

Locally: `prisma/seed.ts` creates no promotions; the rehearsal ran the query on seeded data (1 automatic, 1
cashier-selected, both left untouched). Production was not read. Steps: (1) migrate; (2) API live — old web keeps
working and promotions still apply on old terminals; (3) supervisors create their branch discount types; (4) promote
the web and reload every terminal (PWA); (5) once no old build is in use, supervisors **disable** (not delete) the
automatic and cashier-selected promotions. Rates are never converted into peso amounts.

## 8. Migrations and rollback

`20261101120000_pos_perf_p55_manual_discounts`: tables `manual_discount_types` and `discount_proof_uploads` (unique
`storage_key`, unique `transaction_id`); two nullable columns on `transactions` (no default, metadata-only); FK
`transactions.manual_discount_type_id` added `NOT VALID`. `20261101120100_pos_perf_p55_validate_fks`: `VALIDATE
CONSTRAINT` (SHARE UPDATE EXCLUSIVE, does not block inserts). No backfill, no index on `transactions`.
`20261101120200_pos_perf_p55_manual_discount_type_unique_name` (release pass): partial unique index on
`manual_discount_types (branch_id, lower(name)) WHERE is_active` — see §12.5 for its duplicate pre-check.

Rollback: old API + new schema is supported (keep migrate-before-API). Before rolling the API back, check
`SELECT count(*) FROM manual_discount_types WHERE is_active AND apply_to_pos` (tell cashiers manual discounts stop)
and `SELECT count(*) FROM transactions WHERE discount_type = 'manual'` (an old API shows them with their stored
amounts; nothing recomputes). Do not roll the schema back while manual sales exist — that would drop their snapshots;
export them first.

## 9. Verification

Environment: every database was new, local, disposable and owned by this session — embedded Postgres clusters on
127.0.0.1 with data directories in this session's scratch folder: `pos_test` on 46555–46558 (API tests), `p55_<digits>`
on 468xx (rehearsal, refused by the script otherwise), `p55b_1101` on 46565 (browser; the fixture refuses anything but
`127.0.0.1` + `p55b_<digits>`). `PRODUCTION_DATABASE_URL_DIRECT` was unset and the worktree's `apps/api/.env` (a copy of
`.env.example`, git-ignored) had its DB URLs pointed at `127.0.0.1:1` so nothing could reach a shared local 5432.
Throwaway `ENCRYPTION_KEY`/`HASH_KEY` were generated (same as CI). Ports: API 4555, web 3555. Production,
`pos_verify`, the other local Postgres container (`potato-corner-pos-postgres-1`) and other sessions' worktrees,
processes and databases were not touched. No smoke accounts were provisioned and no terminal queues were cleared.

**Real local Storage.** Docker Desktop was not running; I started it, which also restarted this repository's existing
local Supabase stack (`supabase_*_potato-corner-web-pos-main`). Only its **Storage** service was used, through the API,
with objects under the disposable branch's new UUID prefix; the two objects created were deleted afterwards (0 left
under that prefix). Docker Desktop and that stack were left running — stop them if they should not be.

| Check | Result |
| --- | --- |
| P55 API integration (`p55-manual-discounts.integration.test.ts`, real Express + Postgres, in-memory Storage mock) | 9 / 9 (final code, together with `transactions.service.test.ts`: 279 / 279) |
| API full suite, serial (`--no-file-parallelism`), real Postgres — final code | 210 files passed / 1 skipped; **3,549 tests passed / 5 skipped / 0 failed** |
| Earlier full API run (before two test-only fixes; kept for honesty) | 3,540 passed / 9 failed, all in my own tests: 7 in the P55 integration file (its helper predated the `discount_type: "manual"` fence) and 2 in `transactions.service.test.ts` (repository mock lacked `createDiscountProofUpload`). Production code did not change between the two runs. |
| Shared package (`manual-discount.schema.test.ts` + existing) | 6 files, 48 / 48 |
| Web, affected suites (terminal page, `components`, `lib`, `hooks`) | 132 files, 1,237 / 1,237 |
| Web full suite (final code) | **170 files, 1,571 / 1,571**. An earlier full run had 1 failure (admin Settings page test lacked a mock for the new section); mock added, re-run clean. |
| `turbo run type-check lint --force` | **7 / 7 tasks, 0 errors**. Warnings: API 358 = P54's 343 + 15 `no-console` in the two new scripts (rehearsal, browser fixture; same convention as P53/P54 scripts); web 1 pre-existing `<img>`. Web re-checked after the last test edit: 3 / 3, 0 errors. |
| API `tsc` build, web `next build` | pass |
| Populated migration rehearsal (`scripts/test-p55-migration-on-populated-data.ts`, 20,000 sales) | **PASS** (below) |
| Real browser (Chromium 1.61.1, built web + built API, real local Storage) | **25 / 25** (below) |

Integration coverage: supervisor create/edit/deactivate; other-branch supervisor, a forged JWT branch claim (token says
branch A, live assignment only B), staff, Branch Account and super_admin all refused writes; reserved statutory names;
duplicate names; stale save 409 with nothing written; audit before/after; POS list own-branch, active + Apply-to-POS
only, staff query id ignored; no discount; ₱500 − ₱50 = ₱450, VAT ₱48.21, change ₱550, snapshot + tax snapshot,
`discount_rate_used` NULL, cashier kept, stock reserved 2 × 100 g; PWD in the new flow ₱357.14 / VAT ₱0; PWD + manual,
Employee, typed promotional, missing/conflicting choice, `discount_type: "manual"` without a discount — all refused with
no sale written; amounts `0`, `-5`, `10.005`, `"50"`, `1e12` refused, ₱500.01 over the subtotal refused with the
eligible amount, a changed total refused (409 with the new amounts), forged `discount_amount`/`total_amount` ignored, the
full subtotal → ₱0; proof required / random id / Ben using Ana's proof / another branch's proof refused, wrong file type
refused by the route, cross-branch upload refused by the branch guard, a failed (cash-short) sale leaves the proof
unattached and the replacement sale uses it, the proof is consumed once and its key never appears in the response, a
second use refused, supervisor of the branch can view it and another branch's supervisor cannot, a forged legacy
statutory key refused; same-key retry returns the same sale with the amount once, a different amount or no discount
under the same key refused, lost-response resolve returns the committed sale, one row per key; a legacy client still
gets the automatic promotion (₱100 → ₱90) while the new flow refuses a promotion claim and never applies one (lines
have no promotion, classification unchanged), `manual_discount` without the flow flag refused; an edited type refused
(409 changed), the earlier sale and the public receipt keep the old name, a deactivated or other-branch type refused,
`sale_count` shown; offline sync refuses a queued manual discount per row with a message while a no-discount row syncs;
Discount Compliance has a separate `manual` row whose count/total equal the stored sales (VAT-exempt sales 0), `pwd` and
`promotional` rows remain separate, subtotal − discount = total for every manual sale, and a refund keeps amount,
type and snapshot.

Rehearsal (pre-state = every migration before P55; 20,000 sales — ⅓ Employee, ⅙ PWD with 1,667 proof keys, ⅙
promotional with line snapshots; enabled automatic + cashier-selected promotions; organization Employee 15% and a North
override 10% with the required choice; then the two P55 migrations): both recorded applied; all 80 pre-existing tables'
pre-existing columns byte-identical; effective discount policy identical at both branches; no sale gains a manual
discount; no type invented from rates/promotions; no proof registered or moved; 1,667 historical keys intact; FK
validated; **no schema drift**; promotion inventory query returns 1 automatic + 1 cashier-selected (left enabled);
a supervisor creates a type on the migrated data and the POS list is branch-scoped; rollback checks read 1 active type /
0 manual sales. Migration wall time 3.9 s including Prisma CLI start-up (not a production timing).

Browser (desktop 1440 × 900 unless noted; Chromium with a fake camera device):

| # | Checked | Result |
| --- | --- | --- |
| S1–S2 | Supervisor Settings shows Discount types and "Statutory discounts & VAT by branch"; no Employee-rate or required-choice control | pass |
| S3–S5 | Keyboard only: "PWD" refused in the dialog (Create disabled); "Employee" created with Enter; "Loyalty card" with proof required toggled with Space | pass |
| S6 | Deactivate → listed under "Deactivated (1)" | pass |
| S7 | Turning a required proof off: Save disabled and the prompt shown until the confirmation box is ticked; cancelled → still required in the DB | pass |
| S8 | Second tab saved after a newer save → refused with the explanation; the DB version only moved for the real saves | pass |
| S9 | Promotions page cutover notice | pass |
| C1 | Starts on "No discount"; ₱70 sale | pass |
| C2 | "10%", "0", "350.01" refused with Charge disabled; ₱350 − Employee ₱50: summary "Subtotal ₱350.00 / Employee discount −₱50.00 / Amount to pay ₱300.00", Charge ₱300.00 | pass |
| C3 | Cart changed after entering the amount → changed-total notice mentioning ₱385.00, Charge blocked; Confirm new total → Charge ₱335.00 | pass |
| C4 | Server committed, response dropped (request forwarded, connection reset) → Retry → completed; DB: exactly one ₱335 sale | pass |
| C5 | Proof-required type: Take Photo + Upload from Gallery offered, Charge disabled; gallery upload failed (network) → Retry Upload shown, amount kept, Charge still disabled; retry → attached → charged ₱120 | pass |
| C6 | Take Photo through the in-page camera (fake device) → Capture → Confirm → attached → charged | pass |
| C7 | Next sale starts on "No discount", no amount field | pass |
| C8 | Offline: Apply discount offers PWD/Senior only, no manual type | pass |
| D | Tablet 1024 × 768 (touch) and phone 390 × 844 (iPhone 13 profile, stepped checkout): ₱105 − ₱15 = ₱90 completed, no horizontal page scroll | pass |

Database and Storage after the browser run: 6 sales (1 no-discount, 5 manual), 6 distinct idempotency keys, one cashier;
VAT on every manual sale = 12/112 of the amount to pay (e.g. ₱335 → ₱35.89); no line discounts or promotions; 2 proof
uploads, both consumed and each linked to its own sale; 25 units sold, 25 deducted, 0 reserved; audit rows 3 created /
2 updated / 1 deactivated. Both proof objects were in the private bucket under the branch prefix; the supervisor's
signed view returned 200 `image/webp`; unauthenticated view 401; the public object URL refused; transaction lists show
`has_discount_proof` only (no key or URL); the public receipt shows "manual / Employee / ₱15.00 / VAT ₱9.64 / ₱90.00".

Issues found during verification and fixed: the terminal did not send `discount_type: "manual"` (caught by a web test
after I added the rollback fence); product cards still advertised catalog promotions the new checkout no longer applies
(now hidden). Script-only issues (login selector, a `device_id` the login API requires, the 10-logins-per-15-minutes
limiter returning 429 for the phone run — the API was restarted to reset it, a closing-dialog race in S7) were fixed in
the scratch scripts, not the app; the browser script itself is a session scratch file and is not committed.

**Not verified (first pass):** cashier switching / break handoff in a real browser, the old web build against this API,
and a new-web → old-API run. **All three were executed in the release pass — see §12.** Still not verified: real iOS
Safari / Android Chrome devices or an installed PWA (emulation only).

## 10. Unresolved business decisions

1. **Statutory discounts as peso amounts** (§5): whether PWD/Senior should ever be entered as a peso amount, and how
   that maps to the statutory 20% and the VAT exemption. Owner + accountant. Until decided: statutory path, combination
   blocked.
2. **VAT on manual discounts**: P55 keeps them taxable (the existing commercial treatment). Any exemption needs an
   accountant decision; the app does not infer one.
3. **Proof for non-required types**: the POS shows the proof card only when the type requires it. Decide whether
   cashiers should be able to attach an optional photo.
4. **Default "No discount"**: a sale starts on "No discount" except where the P50R required-choice switch is on. Decide
   whether every branch should require an explicit tap (one more tap per sale).
5. **Promotion retirement date** (§7 step 5) and who disables them.
6. **Discount Compliance detail**: manual sales appear as their own `manual` row; a per-type (name) breakdown is not
   built.
7. Carried over, unchanged: P50 D1 (VAT registration), D3 (VAT cap basis), D4 (Senior/PWD vs promotion), D6 (BIR
   receipt compliance).

Known limitations: the legacy picker code path is still in `PaymentFooter` (used only when `manualDiscount` is absent;
no current caller) — remove once old clients are retired; unused proof uploads are not swept (including a photo an old
API stored for a manual discount it could not attach). Manual-type name uniqueness is now a DB constraint (§12.5).

## 11. State

| | |
| --- | --- |
| Repository | `C:/Users/kaile/Downloads/potato-corner-web-pos-main` (origin `cjlonzaga29-pixel/potato-corner-web-pos-main`); not the `-1` clone |
| Starting SHA | `042a700b9da51bd41f1dc244f209055c16fdb1e7` (= reported deployed SHA = `origin/main`), `main` clean at start |
| Worktree / branch | `C:/Users/kaile/Downloads/pc-p55-manual-discounts-worktree`, `feat/pos-perf-p55-manual-discounts` (created from `042a700`; the main checkout and the P51–P54 worktrees were not modified) |
| Final SHA | first pass `ab35dd1`; release pass: the local commit on top of it that updates this runbook (reported in the handoff) |
| Git status after commit | clean worktree; branch 2 commits ahead of `origin/main`. Not pushed, not merged, not deployed, no production access |

## 12. Release-readiness verification (release pass, 2026-11-01)

Started from `ab35dd1` (parent `042a700`), clean tree. One session, no subagents. The statutory PWD/Senior formula,
VAT rules and historical tax/proof data were not changed. No smoke accounts were provisioned, no terminal queue was
cleared, no promotion was disabled except in a disposable local database, and nothing touched production.

### 12.1 Environment

- A new embedded Postgres 18 cluster on `127.0.0.1:46575` (data directory in this session's scratch folder), databases
  `p55c_1101` (direct-API probes), `p55c_1102` (browser), `p55o_1101` (old-API compatibility), `p55t_1101` (API test
  suites). Every `prisma migrate` command used and printed `127.0.0.1:46575/<db>`; `PRODUCTION_DATABASE_URL_DIRECT` was
  unset. Seeded with `prisma/seed.ts`, `seed-pos-demo-inventory.ts` and `scripts/p55-browser-fixtures.ts`, which now
  also (opt-in: `P55_FIXTURE_PASSWORD` + `P55_PIN_ANA/BEN/CARL`) creates PIN cashiers Ana and Ben at MAIN01, a second
  branch `P55S01` with its own Branch Account, supervisor and cashier Carl, and open attendance for each. The random
  PINs and password lived in a scratch file only.
- Real local Supabase **Storage** (the repository's already-running local stack; only Storage was used). Every object
  this pass created was under a disposable branch UUID; all were deleted at the end (53 deleted, 0 left).
- Final builds: API `tsc` (`dist/`), web `next build`, served with `next start`. P55 web on `127.0.0.1:3575`, the
  042a700 web on `3576`, the API on `API_PORT=4575` (both webs proxy `/api` to it). The **actual 042a700 API and web**
  were built from a detached scratch worktree at `042a700` (`pnpm install --frozen-lockfile`, its own Prisma client).
- Chromium (Playwright 1.61.1), desktop 1440 × 900, fake camera device. The API was restarted between runs to reset
  the in-memory select-employee limiter (429 after ~10 selections in 15 minutes).

### 12.2 Results

| Run | Result |
| --- | --- |
| Cashier switching / break isolation, real browser, final builds (S1–S7) | **21 / 21** |
| Direct API: proof reuse across cashier, branch, shift and sale + idempotent replay (final API) | **25 / 25** (on `ab35dd1`: 4 legacy-key checks failed, §12.3) |
| New web (P55) → actual 042a700 API (A–G) | **9 / 9** (before §12.4 the two wording checks failed) |
| Old web (042a700) → P55 API (O1–O5) | **5 / 5** |
| Legacy calculations: identical payloads through the 042a700 API and the P55 API (none / PWD / Senior / Employee, ₱70) | **byte-identical**: ₱70 VAT 7.50; PWD ₱50 VAT 0; Senior ₱50 VAT 0; Employee 20% ₱56 VAT 6.00 |
| Concurrent discount-type names (8 creates incl. case/whitespace variants; 2 concurrent renames) | before: **8 active duplicates; 2 after the rename race**. After the constraint: 1 created + 7 × 409; rename 1 ok + 1 × 409 |
| API suites, real Postgres, serial: transactions, reports, discounts, receipts | **21 files, 683 / 683** |
| API affected suites incl. the new tests (P55 integration, transactions.service, discounts) | **309 / 309** |
| Web affected suites (terminal page, components/pos, lib, hooks) | 664 tests: **663 passed, 1 failed** — `use-cart-stock-validation` "times out a check that never answers" (timing under parallel load; file not touched by P55; **21 / 21 when run alone, twice**) |
| Shared package | 48 / 48 |
| `turbo type-check lint --force` (api, shared, web) | 0 errors; API 358 warnings (same as the first pass) |
| New migration on a DB that already held active duplicates | fails `P3018 … is duplicated` as designed; after deactivating the extras: applied, `migrate diff --exit-code`: **no drift** |

**Cashier switching (S1–S7), Branch Account terminal, cashiers Ana and Ben, types "Loyalty card" (proof required)
and "Staff meal".** S1: Ana picks Loyalty card, enters ₱20 and cash ₱100 → Charge disabled with "Take or upload the
discount proof photo before charging."; gallery upload → attached, Charge ₱50.00 enabled, the registry row is Ana's and
unattached. S2: Ana empties the cart (Switch Cashier refuses a non-empty cart) → Switch Cashier → Ben. S3: Ben sees
"No discount", no amount field, Charge ₱70.00; Apply discount → no type preselected; Loyalty card → empty amount,
Upload offered, Charge disabled with the proof reason even after amount + cash — Ana's photo is never offered; Ben's
no-discount sale is Ben's, with no discount and no proof; Ana's upload is still unattached. S4: back to Ana — "No
discount", no amount, the earlier photo not re-offered. S5: Ana charges ₱20 with a new photo; the server commits and the
response is dropped → Retry / Edit Cart → Retry resolves the same sale: one sale, Ana, ₱20 once, the proof consumed by
it, one attempt row. S6: Ana charges Staff meal ₱15 with the response held, taps Next Customer while it is saving
(detached to Pending), starts another sale with Staff meal ₱12, empties the cart and taps **Start Break**; Ben signs in
and taps Retry on "Pending (1)" → still one sale, **cashier Ana**, snapshot `name: Staff meal`, `entered_by_id` Ana,
₱55 — resolution never re-posts as Ben. Ben's next sale shows "No discount" with no amount (Ana's ₱12 not carried) and
is recorded as Ben. S7: Ana → **Resume Work** → "No discount", Staff meal amount empty; Staff meal ₱10 → ₱60, VAT ₱6.43
(= 12/112), cashier Ana; the break is closed on her same open attendance record. Browser DB afterwards (all
iterations): 37 sales / 37 distinct idempotency keys; 22 uploads, 10 consumed, **0 consumed by a cashier other than the
uploader**; 20 manual sales, **0 with VAT ≠ 12/112 of the amount paid**; Ben: 13 sales, all without a discount.

**Direct API (Branch Account → PIN → employee tokens; Carl at South).** Cashier B naming A's manual upload id → 422
`MANUAL_DISCOUNT_PROOF_INVALID`; another branch's id → 422; a random id → 422; a storage key instead of the id → 422
`VALIDATION_ERROR`; A's own id → 201 (the key never appears in the response); the same idempotency key again → the same
sale, nothing written; a new key reusing the consumed id → 409 `MANUAL_DISCOUNT_PROOF_ALREADY_USED`; three concurrent
sales on one fresh id → exactly one 201 and two 409, one sale and one consumed proof added; a photo uploaded before the
branch's shift was closed, used in the next shift → 422. Legacy statutory key (the old-web path): A's own fresh key →
201; a same-key replay after it is consumed → the same sale; the key on a second sale → 409
`DISCOUNT_PROOF_ALREADY_USED`; B with A's key → 422; made-up `<branch>/made-up/…` → 422; another branch's key → 422;
`<branch>/../<other>/x.webp` → 422; A afterwards still uses her own key → 201. Every refusal: no sale, no committed
attempt, no deduction job, no reservation, no proof attachment (a refused checkout leaves only its `failed` fencing
row in `checkout_attempts`, by design).

**New web → actual 042a700 API** (`p55o_1101`, migrated with every migration = the API-rollback case). A: the P55 API
loads the types; Staff meal ₱10 on screen (Charge ₱60.00). B: the API is swapped to 042a700 (same port and DB; the
session stays valid) → Charge → old API `422 VALIDATION_ERROR` (the rollback fence), **nothing written**; the dialog
says "Manual discounts not available yet — not charged / This server does not support manual discounts yet…", no
Retry; Review → cart, type and ₱10 kept. C: Loyalty card + gallery upload → the old API stores the photo but returns
no upload id → "cannot attach a proof photo to a manual discount" with Retry Upload, Charge disabled, nothing attached.
D: "No discount" → ₱70.00, VAT ₱7.50, Ana — recorded correctly. E: after a reload only PWD / Senior are offered, with
"Manual discounts aren't available on this server yet. Use “No discount” or a statutory discount." F: PWD on ₱35 →
₱25.00, VAT ₱0. G: with an enabled automatic promotion on the product, a no-discount sale → `PROMOTION_CHANGED`
("was no promotion, now ₱5.00 off"), nothing written — never silently repriced.

**Old web (042a700) → P55 API.** O1: PWD with ID number and a real gallery upload → ₱25.00, VAT ₱0, proof attached; its
registry row is Ana's and consumed by that sale. O2: Senior ₱70 → ₱50, VAT ₱0. O3: Employee 20% → ₱56, VAT ₱6.00. O4: no
discount ₱70, VAT ₱7.50. O5: all recorded as legacy (`tax_snapshot.discount_flow` null, no manual type).

### 12.3 Defect fixed: legacy statutory proof keys (security)

Demonstrated on `ab35dd1` (all 201): an own-branch-prefixed made-up key, cashier B attaching A's key, an
already-attached key on a second sale, and `<branch>/../<other branch>/…`. Fix (`resolveStatutoryProof` in
`transactions.service.ts`, `findDiscountProofUploadByStorageKey` in the repository): a PWD/Senior key that will be
attached must be a `discount_proof_uploads` row with the sale's branch, shift and cashier and no transaction
(`422 DISCOUNT_PROOF_INVALID`, `409 DISCOUNT_PROOF_ALREADY_USED`). The row is claimed inside the sale's `$transaction`
exactly like a manual proof (0 rows → the sale rolls back), and the stored proof type and time now come from the
registry. The idempotent fast-path replay still runs first, so a valid retry is unaffected. Web: both codes are on the
definite-no-commit list, review-only, and clear the ID photo so the cashier retakes it. Cutover consequence: a photo
uploaded through a **pre-P55** API is not registered, so a PWD/Senior sale started before the API cutover and charged
after it is refused once ("Take or upload the photo again") — a retake, never a wrong charge.

### 12.4 Defects fixed: new web against an old API (usability, no data risk)

1. The rollback fence's refusal showed the raw schema text (`discount_type: Invalid option: expected one of
   "pwd"|…`) with a Retry that can never succeed. `VALIDATION_ERROR` on a payload with `discount_type: "manual"` now
   shows `MANUAL_DISCOUNT_UNSUPPORTED_BY_SERVER` ("Manual discounts not available yet — not charged"), review-only.
2. A missing types route (`404 NOT_FOUND`) showed "Couldn't load … Retry". It is now `ManualDiscountsUnsupportedError`
   (not retried) → "Manual discounts aren't available on this server yet. Use “No discount” or a statutory discount."

### 12.5 Settings integrity: discount-type names

Uniqueness per branch among active types, case-insensitive, is the intended invariant (service check, its 409 code,
§3). It was proven broken under real concurrency (8 concurrent creates → 8 active rows; 2 concurrent renames → 2).
Migration `20261101120200_pos_perf_p55_manual_discount_type_unique_name` adds `CREATE UNIQUE INDEX
manual_discount_types_branch_active_name_key ON manual_discount_types (branch_id, LOWER(name)) WHERE is_active`. It is
raw SQL like `inventory_items_sku_ci_key` (the Prisma DSL has no partial or expression index; documented on the model).
Branch scope is kept (the same name at another branch: 201), a deactivated name is reusable (201), and names are stored
trimmed by Zod, so `lower(name)` matches the service's case-insensitive compare. `discounts.service.ts` maps P2002 on
create and rename to `409 MANUAL_DISCOUNT_TYPE_NAME_TAKEN`. The table is new in P55 (never in production) and small,
so a plain build is fine. The migration **fails on a database that already holds active duplicates**, which is only
possible where `ab35dd1` ran. Pre-check: `SELECT branch_id, lower(name), count(*) FROM manual_discount_types WHERE
is_active GROUP BY 1, 2 HAVING count(*) > 1;` — a supervisor deactivates the extras first. Wildcard characters are not
an issue (`W_1` and `WX1` are both allowed).

### 12.6 Cutover

**Order (unchanged, now verified):** (1) **migrate** — three P55 migrations, all additive; the old API runs on the new
schema (every old-API run in §12.2 was on it). (2) **API** — old webs keep working (O1–O5): legacy discounts, rates,
the P50R choice and promotions are unchanged; real old-client proof uploads work. (3) Supervisors create the branch
discount types. (4) **Web**. (5) **Every terminal must reload** (close and reopen the POS / PWA, or reload the tab): the
service worker keeps serving the old build until it updates, and an old build never offers manual discounts. Promoting
the web does **not** retire old clients by itself — a terminal that is not reloaded keeps the old checkout (legacy
discounts, Employee rate, promotions) against the new API, which stays supported.

**Old-client and offline sales that remain valid after the API cutover.** Online old-web sales: all legacy discounts
(none, PWD, Senior, Employee, cashier-selected and automatic promotions) exactly as before. A PWD/Senior proof is
accepted when it was uploaded through the new API by the same cashier in the same shift; a photo uploaded through the
old API just before the cutover must be retaken once. Queued offline sales (old or new web) sync as before: they never
carry a proof and never apply promotions (a queued line claiming one is refused, `PROMOTION_OFFLINE_UNSUPPORTED`, as
before P55). An offline Employee-rate sale is accepted while its `tax_basis` matches the current rate (otherwise
`TAX_SETTINGS_CHANGED`, visible). A queued manual discount is refused visibly (`MANUAL_DISCOUNT_OFFLINE_UNSUPPORTED`; the
P55 terminal never queues one).

**When legacy promotions can be disabled:** only after every terminal runs the P55 build. Check per branch that no
recent online sale has `tax_snapshot->>'discount_flow' IS NULL`. Disabling (not deleting) does **not** change
queued-sale acceptance, because offline sales never use promotions. An online old-web sale whose line still
acknowledges a promotion gets `PROMOTION_CHANGED` and is re-priced on review (visible, nothing charged). Keep the
organization Employee rate unchanged until old terminals and their queues are gone (old offline Employee sales are
checked against it). The read-only inventory query in §7 was **not** run against production.

**API rollback prerequisites (manual-discount sales and bound proofs).** Keep the schema: never roll the migrations back
while `discount_type = 'manual'` sales or consumed `discount_proof_uploads` rows exist — the snapshot, type FK and proof
binding live there; export first if it is ever needed. Before rolling the API back: (a) tell cashiers that manual
discounts stop — the P55 web then refuses them visibly and offers statutory or no discount (verified); (b) **disable the
automatic promotions or roll the web back too** — the P55 web always acknowledges "no promotion", so a 042a700 API
refuses every sale of a product with an enabled automatic promotion (`PROMOTION_CHANGED`, verified in G — safe, but
those products cannot be sold); (c) expect required-proof manual types to be unusable (no upload id), and PWD/Senior
photos to be accepted by prefix only again (the pre-P55 weakness returns while the old API runs); (d) stored manual
sales stay readable with their stored amounts (nothing recomputes). Rolling forward again needs no data repair; photos
uploaded through the old API in the meantime are not registered (retake).

### 12.7 Distinctions

- **Manual custom discounts:** supervisor-named per branch, a peso amount per sale, an optional required proof bound to
  cashier/branch/shift and single use; taxable commercial treatment (VAT = 12/112 of the amount paid); online only.
- **Statutory PWD / Senior:** unchanged formula, rates, ID requirement and VAT exemption (verified identical through
  the old and new API); offered under "Statutory · VAT-exempt"; never combinable with a manual discount; the proof photo
  is now bound like a manual proof.
- **Backend VAT:** unchanged. Server-authoritative `computeSaleTax`; manual discounts use its existing commercial
  arithmetic; no exemption can be created from a discount type.
- **Verified vs unverified compatibility:** verified in a real browser on final builds — P55 web ↔ P55 API, P55 web →
  042a700 API, 042a700 web → P55 API, and legacy calculations old vs new. Not verified: real devices and installed-PWA
  update behavior (emulation only), the production promotion inventory, and production data shapes.

### 12.8 Owner decisions and release actions

The owner/accountant decisions in §10 are unchanged: statutory discounts as pesos, VAT on manual discounts, optional
proof, default "No discount", the promotion retirement date, and a per-type report. Release actions:

1. Run the duplicate-name pre-check (§12.5) on any database where `ab35dd1` was applied.
2. Migrate → API → web.
3. Reload every terminal.
4. Supervisors create the discount types.
5. Watch for online `discount_flow IS NULL` sales before disabling promotions.
6. Keep the Employee rate until old queues drain.
7. A rollback follows §12.6.

**Release blockers:** none found in code. Open before go-live: the real-device / installed-PWA reload check, and the
owner's promotion-retirement decision (not a code change).
