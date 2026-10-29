# POS-PERF-P46 — POS keypad and product customization usability

First batch from the owner's video review. Starting HEAD: `b2910f1` (`main`, equal to `origin/main` after `git fetch`,
clean tree). Web-only change: no migration, schema, API, Render, Vercel or production change. Not pushed or deployed.
Payroll, breaks, VAT, discounts, dashboards, employee deletion and inventory transfers were not touched.

## 1. What changed

| Area | Before | After |
| --- | --- | --- |
| PIN screen (`terminal/page.tsx`, `pin-keypad.tsx`) | Small boxed card (`max-w-sm`), 56 px round keys | Two-pane terminal panel from `md` (status left, keypad right), one compact column on a phone. Keys are full-width grid cells, `clamp(52px, 9dvh, 80px)` tall. Status panel shows branch, **Terminal Locked**, offline badge/message, and the employee state (`Not identified yet` → `PIN verified · Clocked in / Not clocked in yet`); the verified name is shown once, large, beside the confirm button. |
| Customization dialog (`add-ons-dialog.tsx`, `customization-dialog-layout.ts`) | `max-w-[720px]`, whole dialog scrolled, sticky header/footer inside it | Full screen on a phone; from `sm` `min(94vw, 960px)` wide, `min(90dvh, 880px)` tall. Header (product, size chip, Close) and footer (Cancel/Add) are fixed rows; only the choices scroll. Footer lists what is still required ("Still needed: Seasoning"). |
| Choice cards (`option-choice-card.tsx`) | Checkbox rows; MULTIPLE groups used separate −/+ buttons | The whole card is one button carrying name, price (`+₱20.00` / `Included`) and state (`aria-pressed`). Quantity cards: a tap adds one, a `×N` badge shows the count, and a separate sibling **Remove one** button (not nested) takes one away. A card that would exceed the limit is `aria-disabled` (stays focusable). |
| Rapid taps (`page.tsx` `handleAdjustAddOnAssignment`) | `onAssignmentChange(group, key, renderedValue + 1)` | Delta applied to the latest state and clamped to the group target, so a burst of taps counts each tap once and never overshoots. |
| Flavor picker (`page.tsx`) | Ad-hoc overlay (no focus trap) with plain buttons | Radix dialog with the same layout and cards; tap picks the flavor. Focus returns to the product card (or cart **Edit**) after the flavor → add-ons handoff, via `restoreCustomizationFocus`. |
| Optional groups | Optional MULTIPLE groups needed "No Add-ons" counted up to the target before **Add** enabled; Add-ons checklists showed a "No Add-ons" row | Nothing picked = no add-ons. No "No Add-ons" pseudo-choice; Add-ons groups get a **Clear** button. |

### 1.1 Optional vs required (rule)

A group is optional when `!required && min_selections === 0` — the same minimum the server's publication check uses
(`max(min_selections, required ? 1 : 0)`, `products.service.ts`). Previously the client used `min_selections === 0` alone, so a
group marked **required** with `min_selections 0` offered "No Add-ons". It is now required (exact target). Add-ons-named
(simplified) groups stay optional regardless, as Task 131 decided. Required SINGLE groups (flavors/sizes) still need exactly one;
an optional SINGLE group can now be un-picked by tapping the selected card again.

### 1.2 Payload parity (why "fill with no add-on")

The server does not enforce option min/max (`resolveSelectedOptions`), so the client is the only gate. For a lone MULTIPLE group,
Task 182 splits the line into one unit per pick up to the group target. An optional group's unpicked remainder is filled with the
`__none__` sentinel at confirm (`fillWithNoAddOn`), so the cart lines are byte-identical to what the old flow produced after the
cashier tapped "No Add-ons" up to the target. The dialog now says so: "Adds 2 items — one per Extra Dips pick; any left empty have none."

### 1.3 Existing "No add-on" catalog records

No seed, migration or fixture in the repo defines an option named "No add-on(s)"; production catalog data was not inspected (off
limits). Nothing is filtered or deleted: a real option named "No Add-ons" renders as an ordinary card with its own price and
inventory mapping, and is sent in the payload when tapped, exactly as before.

## 2. Verification

### 2.1 Automated

| Check | Result |
| --- | --- |
| `pnpm type-check` (web) | pass |
| `pnpm lint` (web) | 0 errors, 1 pre-existing warning (`components/profile/two-factor-section.tsx` `<img>`) |
| `pnpm build` (web, production, `NEXT_PUBLIC_API_URL=http://localhost:4460`) | pass (exit 0) |
| Affected suites: `terminal/page.test.tsx`, `components/pos/*`, `lib/pos/*` | 14 files, 269 tests pass |
| Full web suite `pnpm test` (one full run, not isolated reruns) | 153 files, 1378 tests pass |

Baseline before the change: `terminal/page.test.tsx` 124/124 on `b2910f1` (stashed run). Test changes: tap names instead of
`Name (+₱X)` strings; checkbox roles → pressed buttons; `Increase X quantity` → `Add one X`; "No Add-ons" tests rewritten to
**Clear**/second tap; dialog geometry classes. New tests: optional MULTIPLE empty/partial payloads, rapid-tap clamping, Remove one,
required-with-min-0 stays required, flavor dialog pick, Escape cancel, sentinel never counts, `chosenQuantity`/`fillWithNoAddOn`.

### 2.2 Real browser (local only)

- Postgres container `potato-corner-pos-postgres-1` (127.0.0.1:5432), new disposable database **`p46_ui_10291819`**
  (not `pos_verify`): `prisma migrate deploy` + `prisma/seed.ts`. This checkout has no `apps/api/.env`; a scratchpad env pinned
  every DB URL to that database, and each step re-checked host and name before running.
- API built from this tree, `node dist/server.js` with `API_PORT=4460`; web `next start -p 3460`. Docker Desktop was started
  normally (it was stopped). No other session's servers were running or touched.
- Fixture (direct Prisma, `local-db-guard` + `p46_ui_*` name check): **P46 Fries** (required Seasoning incl. a long name;
  optional Add-ons with a literal "No Add-ons" option, Cheese Dip/Bacon Bits mapped to inventory; optional Extra Dips MULTIPLE max 2),
  **P46 Topping Cup** (required Toppings MULTIPLE exactly 2), **P46 Flavored Fries** (variant flavors + Add-ons). All three
  `live_ready`. Staff PIN set through `POST /api/staff-pin/:id/pin`.
- Playwright (Chromium, service workers blocked), branch account, viewports 1440×900, 820×1180, 1180×820, 390×844, 360×640.

Final run: **73/74 checks pass**. Highlights:

- PIN screen on all five viewports: keys 96–120 px wide × 58–80 px tall, no horizontal overflow, branch/terminal/employee shown.
  Continue is in view without scrolling everywhere except 360×640, where it is ~75 px below the fold (page scrolls).
- Wrong PIN rejected and cleared (earlier runs); correct PIN via keyboard + Enter; **Clock In & Open POS** → **Clock In** → grid.
- Dialog within viewport with title, Close, Cancel and Add visible on desktop (960×724), both tablets and both phones (full
  screen); zero clipped cards; on phones the last choice scrolls fully above the footer.
- Required Seasoning blocks Add and is named; optional groups empty → Add enabled; rapid triple tap (one task, before re-render)
  stops at ×2 with the other card `aria-disabled`; Remove one → ×1; add-on toggle on/off; Tab ×30 never leaves the dialog; Space
  toggles a card; Escape closes and focus returns to the product card; reopen starts fresh; flavor → add-ons handoff keeps focus
  in the new dialog and returns it to the product card after Add.
- Cash sale: cart and receipt ₱470.00 (110 + 100 + 2×80 + 100). Stored items: `[Garlic Mayo, BBQ, Cheese Dip]` 110,
  `[BBQ, Cheese Dip]` 100, `2× [Cheese Dip Topping]` 160, flavored fries 100. Stock: Potato 10000 → 9500 (5 units × 100 g),
  Cheese Dip 1000 → 880 (2 × 30 + 2 × 30), Bacon Bits unchanged (toggled off).
- The single failed check is the script's own: it expected an **Add** button in the flavor picker, which by design has only Cancel.

Environment noise (not P46): `pageerror: Cannot read properties of undefined (reading 'waiting')` from PWA registration with
service workers blocked; refused connections to local realtime/storage. The PIN verify rate limiter tripped after repeated runs
(correct behavior); the local API was restarted to clear its in-memory store.

## 3. Limitations and follow-ups

1. ~~**Owner review — optional MULTIPLE semantics.**~~ **Fixed in P46R (§4):** an optional MULTIPLE group is extras on one product.
   (Original note: a lone MULTIPLE group split into `target` units, so an empty optional group with `max_selections 2` added
   **2** plain items.)
2. ~~Add-ons-named groups still ignore `max_selections`.~~ **Fixed in P46R (§4)**, client and server.
3. ~~On 360×640 the PIN Continue button needs a short scroll.~~ **Fixed in P46R (§4.4).**
4. Not tested on physical devices; touch was simulated with clicks in Chromium only.
5. Local leftovers: database `p46_ui_10291819` (drop when done), Docker Desktop left running, scratchpad env/fixture/screenshots
   outside the repo.

## 4. P46R — ordinary add-on quantities, selection limits, small-phone PIN

Starting HEAD `cbfcd42` (`main`, one commit ahead of `origin/main` `b2910f1`, clean tree). Web + API change; no migration,
schema, dependency, Render, Vercel or production change. Not pushed or deployed. Dashboards, payroll, breaks, VAT, promotions and
transfers were not touched. Authentication, PIN limits, clock-in and cashier switching are unchanged.

### 4.1 Proven causes

| # | Defect | Cause (proven by a failing regression first) |
| --- | --- | --- |
| 1 | An optional group with `max_selections 2` and nothing picked added **2** products | `handleAddOnsConfirm` split a lone MULTIPLE group into `multiGroupTarget` (= max) units (Task 182) and P46's `fillWithNoAddOn` padded the unpicked remainder with no-add-on units. The limit became the product quantity. |
| 2 | One or two extras became separate products; editing a line lost its quantity | Same split: each pick was its own unit, and the split ignored the prompt's quantity (1 on add, the line's own on edit). |
| 3 | A null maximum on an optional MULTIPLE group allowed only 1 | `multiGroupTarget` falls back to `max(min, 1)`; the admin UI documents null as ∞. |
| 4 | Groups named "Add-ons" ignored `max_selections` | `handleToggleAddOnOption` (Task 131) never checked a limit. |
| 5 | A crafted request could exceed any configured maximum | `resolveSelectedOptions` (checkout) validated only that each option id is allowed for the variant, never how many. |
| 6 | An extra picked twice was priced twice but deducted once | `computeOptionDeductionLines` read mappings with `IN (ids)`, so a repeated id matched one row. Pricing and the stock pre-check (`stock-availability.service.ts`, "an option listed twice counts twice") already counted per occurrence. |
| 7 | 360×640: Continue about 75 px below the fold | Three-row stacked status panel (~220 px), 52 px key floor, and a `100vh` (`h-screen`) branch layout, which on phones is measured with the browser toolbars retracted. |

### 4.2 Rules: ordinary add-ons versus serving counts

The data cannot tell "N extras on one item" from "N servings" by name. P46R uses the existing explicit model fields, never group
names, and changes only the case that was provably wrong:

| Group | Meaning | Product quantity | Picks |
| --- | --- | --- | --- |
| Optional MULTIPLE (`!required && min_selections 0`, the same "optional" rule as P46/publication) | **Ordinary extras** on the product being added | Prompt quantity: 1 on add, preserved on edit | Attached to that line; ×N = the option id N times. Price and deduction scale per occurrence × line quantity. Cap = `max_selections`; **null = unlimited**. Empty = one plain product. |
| Lone required MULTIPLE (e.g. "Toppings, exactly 2") | **Serving count** (Task 182, unchanged) | One unit per pick (identical picks merge: Cheese ×2 = one line, qty 2) | One per unit; must equal the target |
| Two or more MULTIPLE groups | Task 193B, unchanged | Prompt quantity | All picks folded onto the one line |
| "Add-ons"-named (`isAddOnsGroup`) checklist | Optional toggles (Task 131) | Prompt quantity | Now capped by `max_selections` (null = unlimited) |
| SINGLE | Pick one | Prompt quantity | At most 1 |

Mix & Max (`flavor_slots`) is a separate model and untouched. The schema has no bundle concept (CR-008 `ProductBundleComponent`
was planned, never built). Remaining ambiguity: a *required* MULTIPLE group with min < max (e.g. "choose 1–3 sauces") still
behaves as an exact serving count of `max`. Changing that needs an explicit model flag (e.g. a per-group "picks are units"
setting) and an owner decision, not a name heuristic.

### 4.3 Fixes

- `add-ons-dialog.tsx`: `groupPickLimit` (per-group cap), `servingCountGroup` (only a lone *required* MULTIPLE group splits).
  The optional hint now reads "Optional — up to N extras"; there is no "Adds N items" note for extras; an over-limit Add-ons
  selection (an edited line) blocks Save; Add-ons cards past the cap are `aria-disabled`.
- `terminal/page.tsx`: the confirm handler folds optional extras onto the line at the prompt quantity. Both tap handlers clamp
  against the latest state (rapid taps cannot overshoot; removal always works). `fillWithNoAddOn` was removed (dead).
- API `transactions.service.ts`: `resolveSelectedOptions` rejects per cart line more than 1 pick from a SINGLE group or more than
  `max_selections` from a MULTIPLE group (null = unlimited), with **422 `PRODUCT_OPTION_LIMIT_EXCEEDED`**, thrown before the
  sale transaction opens. `computeOptionDeductionLines` deducts per occurrence. The repository now selects `selectionType` and
  `maxSelections`. Web: the code is on the definite-no-commit allowlist (`checkout-recovery.ts`), with message "Too many options
  selected".
- Minimums stay client-enforced (unchanged). A per-line server minimum would reject legitimate payloads: each split line of a
  serving-count group carries one pick, and Add-ons-named groups are optional by the Task 131 decision. The API therefore
  accepts everything the UI can produce and enforces the same maxima.
- PIN (`terminal/page.tsx`, `pin-keypad.tsx`, `(branch)/layout.tsx`): below 420 px each status row is one label/value line; tighter
  phone gaps; key height `clamp(3rem, 9dvh, 5rem)` (48 px floor = `.touch-target`); the keypad column bottom padding is
  `max(1rem, env(safe-area-inset-bottom))`; "Enter your staff PIN to continue." is `sr-only` only on phones shorter than 700 px
  (the status panel already says "Waiting for a staff PIN"). The branch layout uses `100dvh` where supported (`h-screen` fallback).
  The page still scrolls when content is taller (enlarged text, very short screens). The app sets no `viewport-fit=cover`, so the
  browser keeps content out of unsafe areas today; the safe-area padding is 0 until that changes.

### 4.4 Verification

Disposable LOCAL database **`p46r_10291915`** (new; not `pos_verify`, not P46's `p46_ui_*`) in container
`potato-corner-pos-postgres-1` at 127.0.0.1:5432: `prisma migrate deploy` (never `migrate dev`) + `prisma/seed.ts`
(`ALLOW_DATABASE_SEED=true`). A scratchpad env pinned `DATABASE_URL`/`DIRECT_URL` to that DB with throwaway local secrets. A
guard script refused any target other than `127.0.0.1:5432/p46r_10291915` (and any `PRODUCTION_DATABASE_URL_DIRECT`) before
every migrate, seed, fixture, test and server start; fixtures also ran `tests/e2e/fixtures/local-db-guard.cjs`. API
`node dist/server.js` with `API_PORT=4471`, web `next start -p 3471` (P46's 3460 was in use by another process and was not
touched).

| Check | Result |
| --- | --- |
| New regressions, red before the fix | Web page: 6 of 8 P46R tests failed on `cbfcd42` (the 2 passing are preservation guards: serving count still splits, rapid taps clamp). API: 4 of 5 failed (3 over-limit sales accepted; repeated extra looked up twice). |
| Web affected suites (`app/(branch)`, `components/pos`, `lib`) on final code | 37 files, **438/438** pass |
| API suites `transactions`, `stock-availability`, `products`, `product-options`, `product-readiness` (env → disposable DB) | 32 files pass, 5 skipped (integration gates); 789 tests pass, 65 skipped |
| API integration (`TEST_DATABASE_URL` = disposable DB): `transactions.integration`, `checkout-worker.integration`, `builder-recipe-match.integration` | **38/38** run serially, on this change and on `cbfcd42` alike. Running the files in parallel against one DB failed 2 concurrency/void tests (cross-file interference); serially both pass. |
| `pnpm type-check` web / api | pass / pass |
| `pnpm lint` web | 0 errors, 1 pre-existing warning (`two-factor-section.tsx` `<img>`) |
| `pnpm lint` api | 0 errors (308 pre-existing repo-wide warnings); changed files clean |
| `pnpm build` api / web (`NEXT_PUBLIC_API_URL=http://localhost:4471`) | pass / pass. A first web build overlapped a `git stash` used to compare lint counts, so it was discarded. The final build ran from a recorded tree hash, re-checked unchanged afterwards. |
| Known flake | `terminal/page.test.tsx` P19 detached-sales tests time out (5–7 s against a 5 s limit) in some combined runs; 6/6 isolated on both this change and `cbfcd42`; absent from the final 438/438 run. |

**PIN screen (final build, Chromium):**

| Viewport | Status panel | Keys (w×h) | Continue bottom | In view |
| --- | --- | --- | --- | --- |
| 360×640 | 159 px | 96×58 | 589 | yes (P46: ~715, needed scroll) |
| 360×560 (proxy: 640 px phone with browser bars) | 159 px | 96×50 | 560 | yes, at the edge |
| 320×568 | 159 px | 83×51 | 563 | yes |
| 390×844 / 1440×900 | — | 106×76 / 120×80 | 694 / 730 | yes |

There was no horizontal overflow, the smallest text was 12 px, and the scroll fallback stays.

**Browser script** (copied from P46's into the session scratchpad; branch account, staff PIN set through
`POST /api/staff-pin/:id/pin`; service workers blocked). Final clean run: **82/82**. P46's false expectation was corrected:
`dialogGeometry` required an **Add** button in every dialog, but the flavor picker has none (a tap picks the flavor; only
Close/Cancel exist). It now asserts that for that dialog, keeps Add/Cancel checks on every customization dialog, and still checks
the picker's geometry, focus handoff and focus return. Other expectations updated to the corrected rules: no "Adds 2 items" note
for optional extras; Continue must be in view on all five viewports (P46 only recorded the scroll); cart total ₱380.

New browser checks:
- "Add-ons" max 2: rapid triple tap leaves two picked and the third `aria-disabled`; un-picking frees the limit.
- Garlic Mayo ×2 on one Fries.
- Crafted request: the real checkout intercepted with a third Garlic Mayo got **422 `PRODUCT_OPTION_LIMIT_EXCEEDED`** ("Regular
  allows at most 2 Extra Dips selections"), with **transactions 0 → 0**. The POS showed "Too many options selected" with
  Retry/Edit Cart and kept the cart.
- The honest Retry then completed.

Stored sale `MAIN01-20261029-000001` (₱380.00):

| Line | Qty | Line total | Stored options |
| --- | --- | --- | --- |
| P46 Fries | 1 | ₱120 (80 + 20 + 2×10) | BBQ, Cheese Dip, Garlic Mayo, Garlic Mayo |
| P46 Topping Cup | 2 | ₱160 (2 × (60 + 20)) | Cheese Dip Topping (serving-count split, identical picks merged) |
| P46 Flavored Fries (Sweet Corn) | 1 | ₱100 | — |

Stock: Potato 10000 → 9600 (4 units × 100 g); Cheese Dip 1000 → 910 (30 + 2×30); **Garlic Mayo 1000 → 970 (2 × 15 g — per
occurrence)**; Bacon Bits unchanged.

**Mix & Max browser regression** (`pos-perf-p36r-branch-and-builder.spec.ts`, "Mix & Max: builder …", Desktop Chrome): **1 passed**
(2.0 min). The spec is written for `pos_verify` (fixed branch, snack-item and flavor ids). It ran from an untracked temporary copy,
deleted afterwards, against `p46r_10291915`. The copy substituted this DB's MAIN01 id; the same snack/tray/flavor rows were
provisioned with the spec's ids; it filled Quantity 1 on the gram-based tray component (starts at 0 here); and it moved the
pointer off two success toasts that covered "Add to POS" at 1280×720 (sonner pauses dismissal while hovered). Every POS/product
assertion ran as written. Stored `MAIN01-20261029-000002`: qty 1, ₱45.00, slot selection persisted; snack ingredient and tray
1000 → 999 each. The spec's second test (cross-branch supervisor) needs `supervisor2`, which this seed lacks, and is unrelated to
customization; it was not run.

### 4.5 Remaining limitations

1. Required MULTIPLE groups with min < max remain exact serving counts (§4.2); distinguishing them needs a model flag.
2. ~~Server minimums are not enforced (§4.3).~~ **Fixed in P46R2 (§5):** checkout requires each offered group's minimum at
   the level the POS builds lines.
3. An offline sale queued by an older client with an Add-ons-named group over its maximum would now be refused at sync
   (previously accepted). The current client cannot create one.
4. Physical devices, real browser chrome and iOS safe areas were not tested; 360×560 was a viewport proxy.
5. Local leftovers: database `p46r_10291915` (drop when done); P46's `p46_ui_10291819` still exists (not this session's, left
   alone); session-scratchpad env/fixtures/screenshots outside the repo. The API (4471) and web (3471) servers started here were
   stopped.

### 4.6 State

Starting SHA `cbfcd42`; final SHA: the P46R commit itself (`git log -1`). Local only: `main` ahead of `origin/main` (`b2910f1`) by
two commits. Clean tree after commit.

## 5. P46R2 — required option choices enforced at checkout

Starting HEAD `bf58969` (`main`, preceded by `cbfcd42`; `origin/main` `b2910f1`; clean tree). API + web + shared change; no
migration, schema, dependency, Render, Vercel or production change. Not pushed or deployed. No model flag was added; the
"choose 1–N" interpretation (§4.2) is unchanged.

### 5.1 Reproduced cause

On unchanged `bf58969`, against a real local Postgres (`transactions.option-requirements.integration.test.ts`, §5.4), **9 crafted
sales were accepted** and an offline batch synced a sale with no required choice. 10 of 19 tests failed. The 9 legitimate-payload
tests already passed, which is the baseline proving current POS payloads succeed:

| Gap | Cause |
| --- | --- |
| Required SINGLE/MULTIPLE choice omitted or below minimum | `resolveSelectedOptions` returned early on an empty selection and otherwise checked only membership and maxima (P46R). |
| Option from a **deactivated group** accepted | `findVariantsForSale` never selected `optionGroup.isActive`; `getPosCatalog` hides such groups, so checkout accepted options the POS never offered. |
| Assignment-level `required` override ignored | Checkout never read `ProductVariantOptionGroup.required` (the catalog and publication check use `assignment.required ?? group.required`). |
| Client: SINGLE group with `required false, min_selections 1` could be left empty | The dialog checked `group.required` only, while every other group, and the publication check, treat `min_selections ≥ 1` as required. |

Foreign options (another product's) and inactive options were already rejected (`PRODUCT_OPTION_NOT_AVAILABLE`).

**Why a plain minimum check would reject real sales:** a cart line is not always one whole group selection.

- A lone required MULTIPLE group ("Toppings, exactly 2") is a serving count (Task 182). The POS splits it one pick per unit, so
  every line carries **one** pick, never 2. Identical picks merge into one line with quantity N.
- "Add-ons"-named groups are optional regardless of their flags (Task 131), so a required-flagged Add-ons group is legitimately
  sent empty.

The payload does **not** lose information. The server derives which shape applies from the live configuration, exactly as the
client does. A single serving line (qty 1, one topping) is a legitimate sale because the cart owns quantity: the cashier can
remove one serving of a pair. No payload change was needed.

### 5.2 Validation rules (`transactions.service.ts#resolveSelectedOptions`)

Everything comes from fresh configuration; no client grouping or count claim is trusted. **Offered group** = group active and
at least one active effective option (`allowedOptions`, or every option when empty), which is exactly what `getPosCatalog` and
the POS render. Configured minimum = `max(min_selections, (assignment.required ?? group.required) ? 1 : 0)` (publication rule).

| Group (offered) | Fewest picks per line | Most picks per line |
| --- | --- | --- |
| "Add-ons"-named (`isAddOnsOptionGroup`, now in `@potato-corner/shared` and used by both sides) | 0 (Task 131) | `max_selections` (null = ∞) |
| SINGLE | 1 if configured minimum > 0, else 0 | 1 |
| Serving count: the only non-Add-ons MULTIPLE group, with configured minimum > 0 | 1 (one pick per unit) | `max_selections` (P46R, unchanged) |
| Any other MULTIPLE (folded: two or more MULTIPLE groups, or optional extras) | configured minimum | `max_selections` |

- Option not offered (foreign, inactive, deactivated group, not allowed for the variant) → **422 `PRODUCT_OPTION_NOT_AVAILABLE`**.
- Over a maximum → **422 `PRODUCT_OPTION_LIMIT_EXCEEDED`** (P46R).
- Under a minimum → **422 `PRODUCT_OPTION_REQUIRED`**, for example "Regular needs 1 Extra Dips selection".
- Repeated ids count once per occurrence, consistently for limits, pricing, the stock pre-check and deductions.
- All of these are thrown while resolving the cart, before the checkout transaction, reservation or deduction job.
- A deactivated group, or one with no active option, is never required.
- Web: `PRODUCT_OPTION_REQUIRED` is on the definite-no-commit allowlist (`checkout-recovery.ts`; the attempt is marked `failed`, so
  a retry mints a new key) and titled "Required choice missing" (`cashier-error-messages.ts`).
- The dialog's SINGLE groups now use `!allowNoAddOn` (required, or minimum ≥ 1) for blocking, the hint and the badge, and to stop
  un-picking.

### 5.3 Compatibility

| Payload source | Result |
| --- | --- |
| Current POS (`bf58969` + P46R2): required single, optional extras empty or ×N, Add-ons empty, serving-count split/merged, folded groups, Mix & Max, explicit quantity | Valid. Proven against real Postgres and in the browser (§5.4). |
| **Production web `b2910f1` (pre-P46)**: a MULTIPLE group flagged required with `min_selections 0` could be filled with the "No Add-ons" pseudo-choice, leaving zero real picks | **Now rejected** `PRODUCT_OPTION_REQUIRED`. The config says required; P46 already made the client require it. |
| `b2910f1` and `bf58969`: a SINGLE group with `required false, min_selections 1` left empty | **Now rejected**; the P46R2 client requires it. |
| Any client: an option from a group deactivated after the line was built (persisted cart, detached sale, queued sale) | **Now rejected** `PRODUCT_OPTION_NOT_AVAILABLE` (was accepted). |
| Persisted carts / detached-sale retries | Same payload shape. A rejection shows "Required choice missing" with Retry and Edit Cart, and the cart is kept. In the browser the edit dialog showed the new requirement only after a **page reload** (the in-memory catalog predates the config change; the cart survives the reload). |
| Offline queue (`lib/offline/sync-queue.ts`, same `CreateTransactionInput` shape) | `/sync-offline` returns the item as `failed` with the code and syncs the rest (integration-tested). The client **keeps** the item in IndexedDB and retries it on each reconnect. Nothing is discarded, and no missing choice is generated. **Gap (pre-existing):** a failed queued sale is reported only via `console.error`, and `pendingSyncCount` is not rendered anywhere, so a stuck queued sale is invisible to the cashier. |
| Hold orders | `holdOrder` uses `resolveCartItems`, so the same rules apply. The web has no hold-order UI. |

The older-client rows come from reading `b2910f1`'s `add-ons-dialog.tsx`/`page.tsx` and from testing the equivalent payload shapes
(a line without the group's ids). The `b2910f1` build itself was not run. Production catalog data was not inspected, so it is
unknown whether any production group matches the two "now rejected" configurations.

**Rollout (proposal only; nothing released):** no payload change, but validation is tighter.

1. Release the web first. Its payloads are a subset of what the old API accepts (the old API checks only maxima).
2. Before the API, confirm no production terminal holds pending offline sales from a pre-P46 client (DevTools → IndexedDB
   `offlineTransactions` with `syncedAt` null). Have an admin review groups that are required with `min_selections 0` as MULTIPLE,
   or SINGLE with `required false, min_selections ≥ 1`.
3. Then release the API. Terminals still on the old web during the overlap are refused for those configurations with
   "Required choice missing"; the cashier can Edit Cart after a reload.

### 5.4 Verification

Disposable LOCAL database **`p46r2_10292200`** (new; not `pos_verify`, `p46_ui_*` or `p46r_*`), container
`potato-corner-pos-postgres-1`, 127.0.0.1:5432: `prisma migrate deploy` + `prisma/seed.ts`.

- A scratchpad env pinned `DATABASE_URL`/`DIRECT_URL`/`TEST_DATABASE_URL` with throwaway local secrets.
- A guard refused any other target (and any `PRODUCTION_DATABASE_URL_DIRECT`) before migrate, seed, fixture, tests and server
  start. The browser fixture also ran `local-db-guard.cjs`.
- API `node dist/server.js` with `API_PORT=4482`; web `next start -p 3482` (`NEXT_PUBLIC_API_URL=http://localhost:4482`).

| Check | Result |
| --- | --- |
| New integration suite on `bf58969` code (red first) | 10 failed / 9 passed (9 crafted sales accepted; offline incomplete sale synced) |
| Same suite on final code | **19/19** |
| New unit tests on old service/repository (stash) | 5 of 8 failed; the 3 passing are preservation guards (serving count with SINGLE + Add-ons, Add-ons optional, optional empty) |
| API unit, affected (`transactions`, `stock-availability`, `products`, `product-options`, `product-readiness`), local `DATABASE_URL` | Three runs of the same command: **797 passed / 84 skipped**; then **1 file failed** (`products.publication-setup.integration.test.ts` setup, 11 tests not counted; error output not captured); then **797/84** again on final code. That file passes 11/11 alone. ~20 product integration files gate on a local `DATABASE_URL` and run in parallel on one DB, the cross-file interference §4.4 also saw. |
| API full unit suite (one run, before the final message-wording change) | 178 files, **3053 passed**, 251 skipped |
| API integration, serial (`option-requirements`, `transactions.integration`, `checkout-worker`, `builder-recipe-match`), final code | **57/57** |
| Web full suite (one run, 566 s) | **1384 passed, 3 failed**: `dashboard-low-stock-summary`, `daily-sales-drilldown` and `supervisor/reports/page` each hit the 5 s timeout. None touches changed code; the 3 files pass alone (57 tests). The full-run result stands. |
| Web affected (`app/(branch)`, `components/pos`, `lib`) | 37 files, **441/441** |
| `type-check` web / api / shared | pass / pass / pass |
| `lint` web / api / shared | 0 errors, 1 pre-existing warning / 0 errors, 308 pre-existing warnings (unchanged count) / clean |
| `build` shared / api / web (production) | pass / pass / pass. API rebuilt after the final error-message wording change; web unchanged since its build. |

**Real browser (Chromium, final builds, branch account, staff PIN via `POST /api/staff-pin/:id/pin`, service workers
blocked): 20/20.** Earlier runs were not counted:

- Three stopped on script errors: a wrong card name ("Add one …"), a wrong table name, and an intercept on the API origin while
  the web calls same-origin `/api` via its rewrite. That last one let one honest ₱480 sale through (`…000001`).
- The next run stopped at the stale-cart Save (the exact-max rule below) after storing `…000002`; its "honest retry 201" check
  read the status too early ("Next Customer" also shows while saving), so the script now waits for "View Receipt".
- The run before the final one ended 19/20 on a wrong expectation, corrected below; it stored `…000003` and `…000004`.
- The final run stored `…000005` and the corrected stale-cart sale `…000006`.

Final run:

- Fries: Add disabled; footer "Still needed: Seasoning" only (required-flagged Add-ons stays optional); Garlic Mayo ×2 + BBQ enables Add.
- Garnish Fries (`required false, min 1`): Add disabled, "Still needed: Garnish" (client fix).
- Topping Cup: "Adds 2 items" serving note. Combo: Ketchup ×2 + Coleslaw folded.
- Crafted 1, the real checkout intercepted with Seasoning dropped: **422 `PRODUCT_OPTION_REQUIRED`**. Transactions, deduction jobs,
  movements and every stock row's on-hand/reserved were unchanged. The POS showed "Required choice missing" with Retry and Edit
  Cart, and kept the cart.
- Crafted 2, on Retry, with the Cheese Topping serving line's pick removed: **422**, ledger unchanged.
- Honest Retry: **201**, `MAIN01-20261029-000005` ₱480.00. Payload: fries 1 line `[BBQ, Garlic Mayo, Garlic Mayo]`; two cup lines
  with one pick each; combo 3 picks.
- Stale cart: Fries + Cheese added, then Extra Dips set to `min_selections 1` in the DB. Checkout → **422** "Regular needs 1 Extra
  Dips selection", nothing written. Edit Cart → the edit dialog required Extra Dips **after a page reload**. Extra Dips was then the
  lone required MULTIPLE group, so it behaved as an exact-max (2) serving count, the unchanged §4.2 rule. Garlic Mayo ×2 → Save
  produced one line of qty 2 (identical picks merged) → **201**. An earlier run expected two lines; the expectation was wrong and
  was corrected.

Stored `…000005`:

| Line | Qty | Total | Options |
| --- | --- | --- | --- |
| P46R2 Fries | 1 | ₱100 | BBQ, Garlic Mayo, Garlic Mayo |
| P46R2 Garnish Fries | 1 | ₱90 | Parsley |
| P46R2 Topping Cup | 1 | ₱80 | Cheese Topping |
| P46R2 Topping Cup | 1 | ₱75 | Bacon Bits |
| P46R2 Combo | 1 | ₱135 | Ketchup, Ketchup, Coleslaw |

Deduction job `completed`; movements: Potato −500 g (5 × 100), Garlic Mayo −30 g (2 occurrences × 15), Cheese Dip −30 g.

Mix & Max is covered by the integration suite: a parent with packaging, two flavor slots and a required Dip. It was rejected
without the Dip and accepted with it (box and snack deducted). `builder-recipe-match` also passes. The P36R Mix & Max browser spec
was not re-run.

### 5.5 Remaining limitations

1. The "choose 1–N" required MULTIPLE interpretation is unchanged (§4.2); this needs an owner decision and a model flag.
2. A required-flagged "Add-ons"-named group stays optional on both client and server (Task 131). Changing that is an owner decision.
3. Queued offline sales that fail sync are invisible to the cashier (console only, §5.3). This is pre-existing and not fixed here.
4. After a catalog change, the POS needs a reload before Edit shows a new requirement.
5. Not tested: production data, the `b2910f1` build itself, physical devices.
6. Local leftovers: database `p46r2_10292200` (drop when done) and scratchpad env/fixture/screenshots. The servers on 4482/3482 were
   stopped after verification. Earlier sessions' databases were not touched.

### 5.6 State

Starting SHA `bf58969`; final SHA: the P46R2 commit itself (`git log -1`). Local only: `main` ahead of `origin/main` (`b2910f1`) by
three commits. Clean tree after commit.
