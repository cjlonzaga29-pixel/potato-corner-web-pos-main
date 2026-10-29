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
2. Server minimums are not enforced (§4.3). A crafted request can omit a required pick, but cannot exceed any maximum.
3. An offline sale queued by an older client with an Add-ons-named group over its maximum would now be refused at sync
   (previously accepted). The current client cannot create one.
4. Physical devices, real browser chrome and iOS safe areas were not tested; 360×560 was a viewport proxy.
5. Local leftovers: database `p46r_10291915` (drop when done); P46's `p46_ui_10291819` still exists (not this session's, left
   alone); session-scratchpad env/fixtures/screenshots outside the repo. The API (4471) and web (3471) servers started here were
   stopped.

### 4.6 State

Starting SHA `cbfcd42`; final SHA: the P46R commit itself (`git log -1`). Local only: `main` ahead of `origin/main` (`b2910f1`) by
two commits. Clean tree after commit.
