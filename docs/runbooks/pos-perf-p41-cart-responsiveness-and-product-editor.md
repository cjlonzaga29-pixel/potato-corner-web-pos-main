# POS-PERF-P41 — Responsive POS cart and consistent product editor

Starting HEAD: `45aab2a22c5374993f6b2b4a55ac1c9ffde5248e` (POS-PERF-P39R3). The working tree also
held uncommitted P40 work (admin, attendance, settings, transactions). It was left untouched. The
P40 session committed it during this task (`ba4387c`, `4cd9fe2`), so this commit sits on top of
`4cd9fe24d4a2add9ac89c056541727b1898dcebb`. The two touch no common file. No schema change, no migration, no new dependency. Nothing was pushed or
deployed, and nothing touched production data. Every number below is **local** (one Windows
laptop, local Postgres `127.0.0.1:5432/pos_verify`), not a production measurement.

## 1. Cart delay: what was measured

Probe: a real browser (Playwright Chromium, 1366×768) against the built web app and built API,
real login, real catalog and real `POST /api/products/catalog/availability-check`. Only the
attendance read was stubbed (clocked in). Clicks were issued from inside the page so timestamps
are exact; "line visible" is when the cart line shows the expected quantity. The slow condition
adds 800 ms to every availability check (a Playwright route delay), nothing else. Fixtures: four
P41 products at Main Branch seeded into `pos_verify` only (Bottled Water; Fries Small and Fries
Large sharing one potato item; Cheesy Fries with an Extra Cheese add-on mapped to a cheese item).
Scripts: `.p41-local/cart-probe.mjs`, `.p41-local/cart-scenarios.mjs` (local only, excluded from
git).

### Before (HEAD `45aab2a`)

| Interaction | Normal | +800 ms check |
| --- | --- | --- |
| Tap Bottled Water → line visible | 163 ms (check took 126 ms) | 2,114 ms (check 2,062 ms) |
| 5 taps 60 ms apart → quantity added | **1 of 5** (checks 304–515 ms) | **1 of 5** |
| 5 "+" 60 ms apart → quantity added | 5 of 5 when each check (31–60 ms) beat the next tap; **1 of 5** in a run where checks took ~4 s | **1 of 5** |
| Remove / "−" | immediate (no check) | immediate |
| Product with flavors → choice prompt | 16 ms | 22 ms |
| Product-card re-renders per add (5 cards) | 9 | 9 |
| Catalog requests caused by cart edits | 0 | 0 |

### Proven root causes

1. **Every add and "+" waited for a full availability round trip before the cart changed.**
   Click → line visible was the check's duration plus a render, and nothing on screen
   acknowledged the tap meanwhile.
2. **Overlapping taps were silently dropped.** `cartHasCapacityFor` numbered each check and
   treated any answer superseded by a newer tap as a failure (`return false`), so that tap's
   add never happened. The surviving check was also built from the cart as it was rendered at
   tap time, so it added one unit, not five. Whenever taps were faster than the check, increments
   were lost. That is why rapid "+" passed in one run and lost 4 of 5 in another: only the check
   latency differed.
3. **Every product card re-rendered on every cart change.** `handleProductTap` depended on
   `cartHasCapacityFor`, which depended on `items`, so its identity changed with the cart and
   broke `ProductCard`'s memo.
4. **Add-on ingredients weren't in the pre-check.** Checkout deducts each selected option's
   `ProductOptionInventoryMapping`, but the pre-check never received the option ids.

Ruled out by measurement:

- **Catalog reloads:** zero catalog requests during any cart interaction.
- **Authentication refresh:** the only refresh in each run was a 401 at page load, before login.
- **Request serialization:** checks ran concurrently.
- **Rendering cost:** about 20 ms from state change to visible line.

One run's ~4 s availability checks came from the local API's connection pool starving under CPU
load (Prisma P2024 in the API log), not from the client.

## 2. Cart changes

- **Optimistic, whole-cart validation** (`hooks/use-cart-stock-validation.ts`). A tap or "+"
  changes the cart immediately and records that line's unconfirmed units by line identity
  (`cartLineKey`, the same rule `addItem` merges on). One whole-cart check runs at a time. Taps
  made while it's in flight are covered by a single re-check of the cart as it is when the answer
  arrives, never by one request per tap.
- **Answers only count for the cart they describe.** An answer is applied only if the cart is
  the same array that was sent, for the same branch and the same cashier (employee id for a
  branch account, else the user id). A newer edit, a cleared or held cart, or a branch or cashier
  switch discards it. If units are still unconfirmed, it checks again under the current session.
  An OK for an older, smaller cart still confirms what it contained (any quantity at or below it
  fits), so only units added after it stay unconfirmed.
- **Rollback takes back only unconfirmed units.** On a shortfall for the current cart,
  `rollbackUnconfirmed` subtracts only the unconfirmed units and never raises a quantity or adds
  a line. A "−" or removal cancels that line's unconfirmed units first. So a late shortfall can't
  undo a newer decrease or bring a removed line back. The toast names the short ingredients and
  says what was taken back.
- **Fail-open is kept.** A network or API failure keeps the cart, shows the existing "Stock check
  unavailable" warning (now de-duplicated), and leaves a "Stock couldn't be checked … Check
  again" note in the cart until a later check succeeds.
- **Pending state is visible and never described as a sale.** Each line with unconfirmed units
  shows "Checking stock…". Charge is disabled with "Checking stock for the latest cart changes…"
  until the answer for the current cart is applied. `handleCharge` also refuses synchronously
  while anything is unresolved. Checkout's atomic reservation is unchanged and remains the final
  guard.
- **Dialog flows.** Flavor, Mix & Max slot and Add-ons confirms add at once and are checked the
  same way. An Add-ons **Edit** of an existing line replaces that line, so it keeps the previous
  check-before-apply behaviour (the dialog stays open on a shortfall).
- **Add-on ingredients.** The availability request carries an optional `selected_option_ids` per
  line. The server sums each option's mapping exactly as checkout deducts it: base unit, times
  quantity, an option listed twice counted twice. It's one batched query. A mapping checkout
  would refuse (inactive item, no unit conversion) is left out of the pre-check rather than
  failing it; checkout still reports it.
- **Card re-renders.** `handleProductTap`, `handleQuantityChange` and the new `handleRemoveLine`
  read the live cart (`getItems`) instead of a render closure, so they stay stable.

Not changed: checkout idempotency, detached orders, inventory deduction, cashier attribution,
authentication, catalog fetching.

### After (same probe, same conditions, built P41 code)

"Line visible" is the first visible cart change. "Confirmed" is when the line's "Checking stock…"
disappears, meaning the server's answer for that cart was applied.

| Interaction | Before, normal | After, normal | Before, +800 ms | After, +800 ms |
| --- | --- | --- | --- | --- |
| Tap Bottled Water → line visible | 163 ms | **20 ms** (confirmed 104 ms) | 2,114 ms | **34 ms** (confirmed 1,043 ms) |
| 5 taps 60 ms apart → units added | 1 of 5 | **5 of 5** | 1 of 5 | **5 of 5**, 2 requests, confirmed 1,794 ms after the first tap |
| 5 "+" 60 ms apart → units added | 5 of 5 / 1 of 5 (latency-dependent) | **5 of 5** | 1 of 5 | **5 of 5**, 2 requests, confirmed 1,746 ms |
| 3 "−" 60 ms apart | 185 ms, correct | 195 ms, correct | 207 ms, correct | 192 ms, correct |
| Remove line → gone | 9 ms | 20 ms | 14 ms | 35 ms |
| "+" then remove 30 ms later, late answer | line stays removed | line stays removed | — | — |
| Product-card re-renders per add (5 cards) | 9 | **2** | 9 | **2** |
| Catalog requests caused by cart edits | 0 | 0 | 0 | 0 |

With normal latency every check (34–58 ms) finished before the next tap, so each tap still made
its own request. Coalescing only applies when taps overlap a pending check, as in the slow
column. The 5-tap rows are dominated by the taps themselves: the fifth tap happens about 240 ms
in. Remove and the flavor prompt (16–86 ms across runs) didn't change in code; their spread is
machine load. The "before" runs used the P40 session's build of HEAD's terminal code on
:3000/:4000. The "after" runs used this commit's build on :3100/:4100, with the same Postgres
and fixtures.

### Cart scenarios (real browser, built code, real API)

`cart-scenarios.mjs` at 1366×768:

| Scenario | Result |
| --- | --- |
| Shared potato (1,000 g): Fries Large (300 g) tapped 4× one at a time | 3 kept; the 4th was taken back with "Running low on P41 Potato… Took back the item just added — the rest of the cart is unchanged." |
| Then Fries Small (100 g) +1, +1 | First fits exactly (1,000 g); second taken back; Large stays 3 |
| Fries Large tapped 4× rapidly with +800 ms checks | All 4 shown at once; 2 requests; ends at **1** (see Limitations) |
| Cheesy Fries + Extra Cheese (10 g of 30 g cheese), quantity raised to 4 | Back to 3 with "Running low on P41 Cheese…". Every request carried the option id. Before P41 the pre-check ignored the cheese entirely. |
| Availability request fails (network) | Line kept; "Stock check unavailable" toast; "Stock couldn't be checked … Check again" in the cart; Check again succeeded and cleared it |
| Open checkout while a "+" is still being checked (+2.5 s) | Charge disabled with "Checking stock for the latest cart changes…"; enabled once the answer arrived |

Narrow layouts (`cart-mobile.mjs`, +800 ms checks). The cart is in a Sheet there, so the tap's
acknowledgement is the sticky "View Cart · N" bar:

| Viewport | Bar updated after each of 5 taps | Kept | Requests | Sheet shows "Checking stock…" | Horizontal overflow |
| --- | --- | --- | --- | --- | --- |
| 390×844 phone | 6, 5, 5, 5, 4 ms | 5 | 2 | yes | none |
| 820×1180 tablet | 7, 5, 5, 13, 4 ms | 5 | 2 | yes | none |

### Automated cart tests

- `hooks/use-cart-stock-validation.test.tsx` (11 tests) drives the hook against the real cart
  store, releasing each answer by hand. Covered:
  - Rapid taps share one follow-up request.
  - A shortfall takes back only unconfirmed units.
  - An OK for an older cart confirms what it covered.
  - An out-of-order shortfall is ignored.
  - A line removed or decreased while pending is never resurrected or over-taken.
  - Clearing the cart mid-request discards the answer.
  - A cashier switch and a branch switch discard the answer and re-check.
  - Network failure, then Check again.
  - Mix & Max slots and option ids are sent for every line.
  - The synchronous unresolved flag.
- `stores/cart.store.test.ts`: `cartLineKey` identity and `rollbackUnconfirmed`.
- Terminal page: add-then-take-back on a shortfall, and Charge held while a check is pending.
- API:
  - `stock-availability.service.test.ts`: option ingredients are summed with recipes, counted
    per selection, and refused mappings are skipped.
  - `products.router.test.ts`: `selected_option_ids` reaches the service, and a malformed id is
    a 422.

## 3. Product editor

### What was wrong

The Edit popup (P39) already hosted every section form inside itself through `DialogHost`, but
each form kept its standalone dialog look. Hosted panels were `mx-auto max-w-2xl`, plus the form's
own `sm:max-w-sm` or `sm:max-w-md`, inside a grid with its own corner X ("Close this form"). That
is the narrow, dialog-shaped "Add Variant" in the video. A failed save only showed a toast, which
disappears. A size or recipe-line version conflict (409) couldn't be told apart from other errors,
because the hooks dropped the error code. The tabs said "Ingredients" and "Choices".

### What changed

- **One editor, five sections:** Details, Sizes & Prices, Ingredients & Packaging, Flavors &
  Choices, Branches.
- **Sub-forms are inline sections** (`components/ui/dialog.tsx`, hosted path only). A hosted form
  is a labelled `region`, not a second dialog. It takes the full width of the editor body with
  the tab content's own padding; the caller's dialog sizing classes are ignored. A "Back to
  (tab name)" button replaces the corner X ("Back to the previous form" for a form opened from
  another, e.g. New Inventory Item from a recipe line). Its heading is left-aligned, and its
  actions sit right-aligned under a divider, where the Details actions are.
  - The tab content underneath is hidden and `inert` while a section is open, so there is one
    scroll area.
  - There is no nested focus trap (hosted dialogs are non-modal; the editor's own modal traps
    focus).
  - Tabs stay locked while a section is open.
  - **Outside the editor nothing changes.** The product page, builder and every other dialog
    render exactly as before; the form logic is shared and only the wrapper differs.
- **Unsaved-change protection:**
  - Each form reports typed values through `DialogContent`'s `hasUnsavedInput`. Back and Escape
    then ask "Discard what you typed in this form?" (Keep editing / Discard and go back).
  - Close and Open product page ask before discarding unsaved Details or an open form.
  - Reloading or leaving the site with unsaved input gets the browser's own prompt.
  - Switching tabs never loses typed Details (that tab stays mounted).
- **Details:** Save Changes / Cancel, "Saving…" while pending, "Changes saved" (with a check)
  until the next edit, inline failure with the typed values kept, and the P39 version-conflict
  handling unchanged.
- **Every sub-form:**
  - A failed save is shown inside the form ("Not saved" plus the server's reason), with
    everything typed kept. Saves no longer reject unhandled.
  - A stale error clears when the form reopens.
  - Size and recipe-line edits keep the version they were loaded from. On 409
    `VARIANT_CONFLICT` / `MAPPING_CONFLICT` they say the item changed elsewhere and offer "Load
    latest (discards your entries)". The next save then claims the newer version.
  - `useCreateVariant`, `useUpdateVariant` and `useUpdateProductComponent` now keep the error
    code (`productApiError`).
- **Immediate actions are labelled as immediate:**
  - Photo: "Saves as soon as you upload or remove it — separate from Save Changes above, and
    Cancel doesn't undo it". ImageUpload already shows uploading and error states.
  - Sizes, ingredients and choices: "saves as soon as you confirm it".
  - Remove option group and Remove snack option are now disabled with a spinner while pending,
    with `aria-busy` and the title "Removes it now". Their hooks already toast success and errors.
  - Branches: "Publish here and Deactivate here take effect immediately, at that branch only".
    Pending, error and Check again were already there.
  - The footer has Close, never a Cancel that would pretend to undo saved sections. There is
    deliberately no global Save All, because the sections persist independently.
- **Not changed:** branch authority (`canEditProductInPlace`, server checks), Mix & Max, required
  fields and validation, product-level optimistic concurrency. Field labels inside the forms
  ("Variant Name", "Add Variant") were kept, because five existing E2E specs and the product page
  use them.

### Save semantics inventory

| Editor action | Persistence | Pending | Success | Failure |
| --- | --- | --- | --- | --- |
| Details fields | Staged until Save Changes; Cancel reverts | "Saving…" | "Changes saved" + toast | Inline, values kept; 409 → Load latest |
| Photo upload / remove | Immediate | Uploading… / spinner | Toast | Toast + ImageUpload error |
| Add / edit size | On Add Variant / Save Changes | Spinner | Back to list + toast | Inline, values kept; 409 → Load latest |
| Delete size | On confirm | Confirm section | Toast | Toast (confirm explains the history rule) |
| Add / edit recipe line, new inventory item | On submit | Spinner | Back + toast | Inline, values kept; 409 → Load latest |
| Delete recipe line | On confirm | Confirm section | Toast | Toast |
| Link flavor, edit flavor pricing, assign option group, add/edit Mix & Max slot, add snack option | On submit | Spinner | Back + toast | Inline, values kept |
| Remove option group / snack option | Immediate | Disabled + spinner | Toast | Toast |
| Delete Mix & Max slot | On confirm | Confirm section | Toast | Toast |
| Publish here / Deactivate here | Immediate (Deactivate: on confirm) | Spinner | Row state + toast | Inline (P38R3 result, Check again) |

### The bug the browser found

The first browser run of the editor showed Back closing a typed "Add Variant" without asking,
although the unit test passed. Each form had reported its typed state with a hook that read
context provided *inside* `DialogContent`. But the form component is the one rendering the
dialog, outside that provider, so the hook did nothing. The unit test's stand-in typed into a
child inside the content, which is why it passed. Fix: the form passes `hasUnsavedInput` on its
own `DialogContent`. A new test hosts the real `VariantFormDialog` the way the editor does and
checks that Back asks first.

### Editor verification (real browser, built code, real API)

`editor-probe.mjs`, real supervisor login, product "P41 Cheesy Fries" at Main Branch.

At 1440×900, full flow:

- **Tabs:** Details, Sizes & Prices, Ingredients & Packaging, Flavors & Choices, Branches.
- **Add Size is an inline section.** It's a `region` and the only dialog in the page is the
  editor. The section is 846 px wide, the editor body's full width inside its 24 px padding, and
  the fields are 798 px. There is no corner X, one Close, "Back to Sizes & Prices" is visible,
  and the other tabs are locked. The same holds for Add Recipe Component ("Back to Ingredients &
  Packaging") and Assign Option Group ("Back to Flavors & Choices"). No page scrolls
  horizontally.
- **Back with typed values** asks "Discard what you typed in this form?". Keep editing keeps
  "Jumbo …".
- **Failed save:** POST size answered 500 (route-injected). The form shows "Not saved —
  Simulated server failure…", with name and price kept. Retry saved it in 2.3 s; the "Variant
  created" toast showed and the size was listed.
- **Version conflict:** while "130" was typed, another API session saved 125 (200). Save Changes
  then showed "changed elsewhere after you opened it" with 130 kept. Load latest showed 125.
  Saving 135 succeeded, and the server holds 135.
- **Details:** Save Changes showed "Changes saved" after 618 ms. An unsaved edit survived a tab
  switch. Open product page and Close each asked first ("Discard and open product page" /
  "Discard and close"); after discarding, the server kept the saved description, not the
  discarded one.
- **Keyboard:** Escape on a clean Add Recipe Component closed it, and focus returned to "Add
  Component". Fifteen Tabs kept focus inside the editor.
- **Branches tab:** says "Publish here and Deactivate here take effect immediately, at that
  branch only".

At 820×1180 and 390×844:

- The editor fits the viewport (788 and 374 px wide), with no horizontal overflow.
- The Add Size and Add Flavor Slot (Mix & Max) sections take the editor's width (746 and 340
  px; fields 698 and 308 px).
- Back and Close are visible.
- The Back guard asks first, Escape closes a clean section, and Close closes the editor.

Screenshots (local only): `.p41-local/editor-*.png`.

### Editor tests

- `product-editor-dialog.test.tsx`: tab names; a section is an inline region with Back and no
  second dialog or corner X; Back asks before discarding typed input; Open product page asks
  before discarding Details.
- `variant-form-dialog.test.tsx`: a failed add keeps the values and shows why. A conflict keeps
  typed values, and Load latest saves against the newer version. The real form, hosted as the
  editor hosts it, makes Back ask first.
- `product-details-form.test.tsx`: Save Changes / Cancel, "Changes saved", and a non-conflict
  failure inline with values kept.
- `dialog-host.test.tsx`: hosted sections are regions with Back.
- Server-side authority is unchanged and still covered: the read-only editor test, and
  `products.catalog-revocation` / `products.bulk-availability-authority` (real Postgres).

## 4. Verification summary

All local: Postgres `127.0.0.1:5432/pos_verify` (checked first: every URL in `apps/api/.env`
points at it), local Supabase storage, this commit's API on :4100 and web on :3100. The P40
session was using :3000/:4000 at the same time; those servers were never restarted or rebuilt
from here.

| Check | Result |
| --- | --- |
| Web unit tests (`apps/web`, vitest, full suite) | 151 files, 1,319 tests: all pass. The first full run had 67 failures in 22 files. 11 were real (the recipe form test's hook mock lacked `useProductComponents`, `reset` and `error`; fixed). The other 21 files passed 366/366 when re-run on their own. Their failures were 5 s timeouts while a `next build` and another session's suite held the CPU at 100%. |
| API tests, products + stock-availability (real Postgres included) | 22 files passed, 2 skipped (environment-gated); 345 tests passed, 27 skipped |
| API tests, full suite | 194 files: 176 passed, 16 skipped (environment-gated). 3,015 tests passed, 248 skipped, **0 failed**. Two files (`publication-budget`, `single-publication`) failed in their setup hooks (Prisma init error / 10 s hook timeout under load); both passed 16/16 when re-run alone. An earlier full run also picked up this task's compiled `dist-p41` copy of the tests and raced the local API's audit-outbox worker; that copy and that server were removed before this run. |
| Shared tests (`packages/shared`) | 4 files, 30 tests pass |
| Type-check | Web `tsc --noEmit` clean; shared `tsc --noEmit` clean; API compiled cleanly with `tsc` (to `dist-p41`) |
| Lint (`eslint`) on every changed file | 0 problems (web, API, shared) |
| Production builds | API `tsc` OK. Web `next build` OK (29.2 min on this loaded machine; its type-check passed). |
| P39 editor spec, against this build (`PLAYWRIGHT_BASE_URL=http://localhost:3100`) | 4 passed (6.2 min). Labels updated in that spec and P39R2's for the renamed tabs, Save Changes, "Changes saved" and the Add Variant region. |
| Real sale through the optimistic cart | 2 rapid taps, Charge enabled once confirmed, `POST /api/transactions` 201 `completed` (receipt `MAIN01-20261028-000001`), "Sale completed" shown |

## 5. Compatibility

- No schema change, no migration, no new dependency.
- The availability request gains an optional `selected_option_ids`:
  - A newer web against an older API: the older API's Zod schema strips the unknown key, so it
    behaves as before P41 (add-ons not pre-checked).
  - An older web against a newer API: the key is absent, so the result is identical to before.
  - API and web can deploy in either order.
- Checkout payloads, idempotency, detached orders, inventory deduction, attribution and auth are
  unchanged.
- The cart store's persisted shape is unchanged (sessionStorage carts and held orders survive
  the upgrade). Lines restored from storage count as already confirmed, as before.
- Dialogs outside the product editor render exactly as before. Only a dialog inside a
  `DialogHost` changes.

## 6. Limitations and remaining risks

- **A shortfall during a burst takes back the whole unconfirmed burst.** A check covering
  several rapid taps can only say the total doesn't fit, not how many would. Example: 4 rapid
  taps where 3 fit leave 1 (the confirmed unit), with a toast. Each later tap is instant and
  checked on its own, so the cashier can tap back up. A finer answer needs the server to return
  how many more units fit; that's out of scope here.
- **Quantities show before they are confirmed.** They are marked "Checking stock…" (about
  0.1 s locally, about 1 s with +800 ms), and Charge is disabled until confirmed. On a confirmed
  shortfall the unit disappears again with a toast. That is the trade-off for instant
  acknowledgement.
- **Fail-open is unchanged.** When the check can't run (offline, API error) items stay with an
  "unverified" note, and checkout's reservation decides. Offline, every burst of taps shows the
  (de-duplicated) warning toast, as before.
- **The browser's own Back button isn't intercepted by the editor.** The App Router offers no
  clean way to block a history pop. Reload and close get the browser's prompt, the modal blocks
  other in-app navigation, and Open product page is guarded.
- **A hosted confirmation shows Back as well as its own Cancel.** They do the same thing.
- **"Variant" vs "Size" wording inside the size form is unchanged** (five E2E specs and the
  product page rely on it).
- **The machine was very loaded throughout.** Local Supabase storage made the catalog take
  8–287 s until it was restarted. With the CPU at 100%, the API's 5-connection Prisma pool timed
  out (P2024) on a few logins. Both are environmental and pre-existing; no P41 code is involved.
- **Not run:**
  - production;
  - real phones and tablets;
  - the PWA and POS Terminal (Mobile) Playwright projects;
  - offline mode with the new cart flow;
  - a browser test with a second supervisor for partial authority (covered by unit tests and
    server tests).
- **Local leftovers in `pos_verify`:**
  - the P41 fixture products, items and option group (suffix `as2o5b`);
  - "Jumbo …" sizes added to P41 Cheesy Fries by the editor probe;
  - one completed sale `MAIN01-20261028-000001` and the staff's clock-in;
  - the P39 spec's own seeded branches, supervisor and products.

  Nothing outside the disposable local database was written.

## 7. Release notes

Not pushed or deployed. Before release:

- Push.
- Watch CI.
- Deploy the API and web (either order).
- Spot-check on the pilot branch:
  - a tap adds instantly;
  - rapid taps all land;
  - an add-on shortfall is caught at the pre-check;
  - Charge waits for "Checking stock…" to clear;
  - the editor's Add Size shows as an inline section with Back.
