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
| Web unit tests (`apps/web`, vitest, full suite) | **Corrected in P41R (§8.5): never green in one full run.** The only full run (`.p41-local/web-suite-p41.log`, 01:33–02:13, before the 03:13 commit) ended 22 files / 67 tests failed, 1,252 passed of 1,319; no exit code was recorded. "All pass" below combines that run with partial re-runs. Original text: 151 files, 1,319 tests: all pass. The first full run had 67 failures in 22 files. 11 were real (the recipe form test's hook mock lacked `useProductComponents`, `reset` and `error`; fixed). The other 21 files passed 366/366 when re-run on their own. Their failures were 5 s timeouts while a `next build` and another session's suite held the CPU at 100%. |
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

## 8. P41R — cart safety and isolated release integration

Local only. Nothing was pushed, deployed or merged into shared `main`. Production was never
written to or contacted. Every check below used the disposable database
`127.0.0.1:5432/pos_p41r` (created for this pass), built code on web :3300 / API :4300, and the
isolated worktree `C:/Users/kaile/Downloads/PTTO/p41r-integration` (branch
`integration/pos-perf-p41r`).

### 8.1 Branches and what was integrated

| | SHA | State at the end of this pass |
| --- | --- | --- |
| Shared `main` (`potato-corner-web-pos-main`) | `5a9e48c6644ce1d0cd39d1329a144a73d26b912e` | Untouched, clean |
| Review `review/pos-perf-p40r` (`p40r-review`) | `1da6add5ba796f761873f2d19e1d5fc720743ff7` | Untouched by this pass, clean |
| Integration `integration/pos-perf-p41r` | see the final commit of this pass | Clean after commit |

- **P40R2 status.** When this pass started, P40R2 was running: its server was on :3400, its
  Storage fault proxy was running, and three test files were uncommitted on top of `4de80b3`.
  None of that was integrated while it was in progress. At 04:26 it committed `1da6add`
  (tests, a fault-injection fixture and runbook text only; no product code). Its worktree was
  then clean and its processes had stopped.
- **Integrated, by normal merges with no conflicts:**
  - `4de80b3` P40R (proof-photo 410, deploy overlap, navigation, attendance label). It shares
    no file with P41.
  - `1da6add` P40R2 (verification only).
- **Commits made in this pass:**
  - `eaa7bb8` merge P40R.
  - `25d7d98` the cart fixes (§8.2).
  - `f5fcfcc` test isolation fix (§8.5).
  - `65be432` merge P40R2.
  - This runbook.

### 8.2 Stock-check failure and the Charge policy

**Policy (unchanged): fail-open.** The pre-check is advisory. If it can't produce an answer,
the cart is kept and Charge is allowed. Checkout's atomic reservation stays authoritative:
`transactions.service.ts` decrements stock with a conditional update inside the transaction
and throws `INSUFFICIENT_STOCK` when no row qualifies. P41R makes this explicit. The cart note
now reads: "Stock couldn't be checked. Items stay in the cart and you can still charge — the
sale is checked against stock when it's submitted."

**Advisory failure vs confirmed shortfall:**

| Outcome | Cart | Charge | Message |
| --- | --- | --- | --- |
| Well-formed `ok: true` for the current cart | Kept; "Checking stock…" clears | Enabled | None |
| Well-formed `ok: false` with shortfalls (**confirmed shortfall**) | Only unconfirmed units are taken back | Enabled | Error toast naming the short ingredients and exactly what was taken back |
| Network error, HTTP error, refresh failure, timeout or malformed body (**advisory failure**) | Kept exactly | Enabled (fail-open) | "Stock check unavailable" warning toast plus the cart note with "Check again" |
| Answer for an older cart, branch or cashier | Ignored (an OK still confirms what it covered) | Waits for the re-check | None |

**Defects found and fixed (`25d7d98`):**

1. **A hung check held Charge indefinitely.** `apiClient` uses `fetch` with no timeout. While
   a request stayed open, the hook kept `inFlight` set, so Charge stayed on "Checking stock…".
   A slow request is plausible here: this pass and P41 both measured P2024 pool starvation and
   multi-second API stalls under load. Each check now gives up after
   `STOCK_CHECK_TIMEOUT_MS = 10 s` and counts as an advisory failure. If the abandoned request
   answers later, the answer is discarded, even when a retry is already in flight. The
   underlying request is a read and is left to finish on its own.
2. **A malformed 200 body was treated as a shortfall.** With `data: {}` (or `ok: false` with no
   or empty `shortfalls`, or a string), `!result.ok` was true. The hook rolled back unconfirmed
   units, then threw on `result.shortfalls.map` before `publish()`. The stale pending marks
   then kept Charge disabled until the next cart change. A shape guard now treats such bodies
   as an advisory failure, and `publish()` runs in a `finally`.
3. **The shortfall message didn't say what was undone.** It now names each line and count,
   e.g. "Took back 3 × P41 Fries Large (Regular) just added, not yet confirmed — the rest of
   the cart is unchanged." When a line lost more than one unit, it adds "Fewer may still fit:
   add them again one at a time". It never states a maximum, because none is calculated.

**401 / refresh failure.** The access token 401s, the shared refresh fails, `apiClient` clears
auth, broadcasts logout and returns `SESSION_EXPIRED` with `data: null`.
`useCheckCartAvailability` throws on `data: null`, so the hook records an advisory failure and
never rolls back. The client side is covered in `api-client.test.ts` (refresh failure) and the
new hook test. In the browser it redirected to `/login` with no shortfall toast (§8.4).

**Charge never stays disabled after the request settles.** Every settle path, whether answer,
rejection, timeout, malformed body or stale result, clears `inFlight` and republishes the
pending marks. A stale result re-runs and ends idle when nothing is unconfirmed.
`hasUnresolved()` is synchronous, so a click queued before re-render can't submit.

### 8.3 Burst-shortage behaviour

The documented rollback of the whole unconfirmed burst is kept. A check covering several rapid
taps can only say the total doesn't fit. No max-addable calculation was added.

- Browser (+800 ms checks, potato 1,000 g, Fries Large 300 g): 4 rapid taps were all shown at
  once, used 2 requests and ended at **1**. The answer for the first tap had already confirmed
  that unit. The toast read: "Running low on P41 Potato p41r. Took back 3 × P41 Fries Large
  p41r (Regular) just added, not yet confirmed — the rest of the cart is unchanged. Fewer may
  still fit: add them again one at a time."
- Three Large (900 g) would have fitted, so the message is honest that fewer may fit, and the
  cashier can tap back up one at a time.

### 8.4 Late-response and rapid-intent results

**Deterministic hook tests** (`use-cart-stock-validation.test.tsx`, real cart store, every
answer released by hand). There are 21 tests: 11 from P41, 8 new, and 2 with tightened
assertions. New tests:
- timeout keeps the cart and releases Charge;
- a timed-out request answering out of order after a retry started is ignored;
- 5 malformed bodies;
- expired session then retry;
- interleaved +/− ending at the exact quantity and payload;
- a late OK after remove-then-re-add doesn't resurrect the old quantity.

The shortfall tests now also assert exactly which lines and units were taken back. Run
against the original P41 hook, the timeout (2) and malformed-body (4 of 5) tests fail. The 4
other failures there come only from the new third callback argument.

**Terminal page tests (new):**
- Fail-open: after a failed check, Charge is re-enabled, the note says Charge is allowed, and
  the sale submits.
- A same-tick burst shortfall rolls back `{key: 2}` with one request, and the toast names
  "2 × Mega Mix Fries (Mega Mix)", says "Fewer may still fit", and never states a maximum.

**Real browser.** Script: `p41r-cart.mjs`. It ran on the built integrated code against the real
API and `pos_p41r`, logged in as staff with a real clock-in. Each availability answer was
controlled per scenario (held and released, delayed, aborted, malformed or 401).

| Scenario | Result |
| --- | --- |
| Tap → line visible; 5 rapid taps at +800 ms | First line visible in 82–136 ms; 5 shown before any answer; final 5; 2 requests; confirmed ~1.8 s |
| Add, then remove before the answer; answer is a shortfall | Line stays removed, no toast |
| +, +, −, + while the first check is held | Shown 3, final 3; requests carried quantities `[1]` then `[3]` |
| Check never answers | "Stock couldn't be checked" after 10.1 s; nothing left "Checking"; Charge enabled; Check again recovered |
| ↳ the abandoned request then answers with a shortfall | Ignored; quantity still 1; no toast |
| Malformed `data: {}`, 2 units, then charge | Kept 2; warning toast; Charge enabled; real sale **201**, sold quantity `[2]` (`MAIN01-20261028-000004`); empty cart after Next Customer |
| Burst shortage | §8.3 |
| Checkout during a pending check (+2.5 s) | Charge disabled with "Checking stock for the latest cart changes…"; forced click started no sale; after the answer, the real sale submitted quantity `[2]` and completed (`MAIN01-20261028-000005` `completed`, checked in the DB) |
| Add-on (Cheesy Fries + Extra Cheese) | Request carried `selected_option_ids` |
| Access 401 and refresh 401 during a check | Redirected to `/login`; no shortfall toast |

**Not reachable or not run in the browser, but covered by unit tests:**
- **Clear cart / Next Customer before a late response.** The terminal has no manual clear
  control. `clearCart` runs only after a confirmed or queued sale, and Charge is blocked while
  any check is unresolved. Hold/resume exist in `useCart` but aren't wired to any UI.
- **Branch and cashier switch mid-check.** Covered by the hook test (epoch bump, answer
  discarded, re-check under the new session).
- **Out-of-order answers.** Only one check is ever in flight, except after a timeout. That
  case is covered in both the browser and unit tests.

**Probe artifacts, not product defects.** The first probe runs crashed React with a
`NotFoundError: insertBefore` because the probe deleted Sonner's toast nodes from the DOM. The
crash disappeared once the probe waited for toasts to expire instead. A
`Cannot read … 'waiting'` page error comes from next-pwa's workbox-window registration, because
the probe blocks service workers.

### 8.5 Test evidence

**Was "1,319 passed" one full run on committed P41? No.**
- The only full web run (`.p41-local/web-suite-p41.log`, started 01:33) ended
  `Test Files 22 failed | 129 passed (151)`, `Tests 67 failed | 1252 passed (1319)`, 2,424 s.
  No exit code was logged; vitest exits 1 on failures.
- It ran on the pre-commit tree. `5a9e48c` was committed at 03:13.
- "All pass" combined that run with a 21-file re-run (`web-rerun.log`, 366/366) and a separate
  fix. §4 is annotated accordingly.

**Full web suite on the integration branch (one run).**
- Command: `vitest run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`
  on `25d7d98`, with nothing else from this pass running.
- Machine at the start: 4 logical cores, 7.7 GB RAM, **100% CPU, 0.48 GB free** (other
  sessions' processes).
- Result: **exit code 1**.
  - Test files: 1 failed, 152 passed (153).
  - Tests: **1 failed, 1,348 passed (1,349)**.
  - 528 s of vitest time, 535 s wall.
  - No timeouts.
- The single failure was this pass's new fail-open page test. `mockRollbackUnconfirmed` still
  held a call from an earlier test in the same file, so `not.toHaveBeenCalled` failed. Run
  alone it had passed. The fix (`f5fcfcc`) clears the spy.
- Re-run of the affected files only (whole terminal page file + hook file, one fork):
  **145/145, exit 0**.
- **This is not a clean full run.** No full web run has been made on `f5fcfcc` or later. The
  only changes since `25d7d98` are that test and the P40R2 test/docs merge.
- P40R2's own runbook reports a clean third full run on its tree (152/152, 1,316/1,316). That
  run was on the P40 tree, not the integrated tree.

**API, affected suites** (`stock-availability`, `products`, `transactions`,
`p40-route-boundaries`, `settings`):
- Run with one fork and `TEST_DATABASE_URL` set to `pos_p41r`.
- Result: **33 files passed, 2 skipped; 836 tests passed, 27 skipped; exit 0**. This included
  the real-Postgres transaction integration tests.
- Skipped: `products.integration` (gated on the legacy `TEST_REDIS_URL`) and the opt-in
  `publication-budget.measure`.

**Static checks and builds on `f5fcfcc`:**

| Check | Result |
| --- | --- |
| `tsc --noEmit` web / API / shared | clean / clean / clean |
| API `tsc` build | OK |
| ESLint, web (whole app) | 0 errors, 1 pre-existing warning (`<img>` in two-factor section) |
| ESLint, API (changed modules) | clean |
| Web `next build` | OK, 463 s |

**Browser, other checks:**
- P39 editor spec (`pos-perf-p39-products-management.spec.ts`, Admin Dashboard Desktop, one
  worker, :3300): **4 passed (5.0 min), exit 0**.
- P40 navigation (`p40-nav.mjs`, :3300, desktop 1440×900 and phone 390×844):
  - Supervisors is highlighted on `/admin/employees/:id`, and the breadcrumb doesn't show the
    id.
  - Branches is highlighted on `/admin/branch-accounts`.
- Reused P40R2 evidence: the files P40R changed are byte-identical in the integrated tree
  (`git diff 4de80b3 HEAD` over those paths is empty). P40R2's attendance-label and
  navigation browser results and its 20/20 real API + Storage scenarios therefore apply to
  this code.

**Not verified in this pass:**
- **P40 proof photos in a browser against real Storage.**
  - The shared local Supabase Storage didn't answer HTTP during this pass:
    `/storage/v1/status` and `/version` timed out, although Docker reported the container
    healthy.
  - The P40R2 spec seeds by uploading to Storage, so it can't run.
  - Storage is shared with other sessions, so it was not restarted.
  - P40R2 reports the same gap (its proof-photo browser cases did not run).
- PWA and POS Terminal (Mobile) Playwright projects.
- Offline mode with the new cart flow.
- Real devices.
- Production.

**Environment incident (local only, recorded for honesty).** The API reads `API_PORT`, not
`PORT`. The first API start of this pass therefore listened on the default **:4000** for about
3 minutes, using `pos_p41r` only. Nothing else was listening on :4000 at the time. It was
stopped, `API_PORT=4300` was added to the git-ignored `.env`, and it was restarted on :4300.

### 8.6 Remaining release blockers

1. **A clean full web suite run on the final integration SHA.** The one run here had 1
   test-isolation failure, since fixed and re-verified only in the affected files.
2. **Proof photos in a browser against healthy Storage** (P40/P40R2 carry-over).
3. **Integrate into shared `main`** (not part of this pass), then push and CI. Deploy order:
   - P40R: follow the corrected deploy sequence in its runbook. Its web refuses, with an
     explanation, to build a download link from an older API.
   - P41/P41R work in either order.
4. **Product sign-off on the 10 s pre-check timeout.** It doesn't change the fail-open policy;
   it only bounds how long Charge waits for an advisory answer.
5. **Pilot spot checks:**
   - instant taps;
   - burst shortage message;
   - "Stock couldn't be checked" note with Check again;
   - Charge waits for "Checking stock…".

**Local leftovers in `pos_p41r`** (disposable; drop the database when done):
- the seeded users and Main Branch;
- the P41 fixtures (suffix `p41r`);
- 5 completed probe sales `MAIN01-20261028-000001…000005`;
- the staff clock-in;
- the P39 spec's seeded branches and products.

## 9. P41R2 — final integrated verification (2026-10-28)

Local only. Nothing was merged into shared `main`, pushed or deployed. Production was never
contacted. Worktree `C:/Users/kaile/Downloads/PTTO/p41r-integration`, branch
`integration/pos-perf-p41r`, starting HEAD `8579a74205700959939aa72a2d7f1396a152b0a6`, clean.

### 9.1 Starting state

- `f5fcfcc` (the rollback-spy `mockClear`) is in HEAD. `apps/web` is identical between `f5fcfcc`
  and `8579a74`.
- **P40R3:** no evidence to reuse. `p40r-review` was clean at `1da6add`, which is already merged
  here (`65be432`). No P40R3 commit existed.
- No proof, transaction, report, download or Storage file differs between `1da6add` and HEAD.

### 9.2 Machine and service preflight

- 4 cores, 7.7 GB RAM. At the start: **0.76 GB free, 88% CPU.** No other test servers were
  running.
- **Docker Desktop was stopped**:
  - `com.docker.service` was `STOPPED`;
  - the engine pipe `dockerDesktopLinuxEngine` didn't exist;
  - the WSL distros `docker-desktop` and `Ubuntu` were `Stopped`.
- **Nothing was listening on Postgres `:5432` or Supabase `:54321`.**
  `GET /storage/v1/status` couldn't connect. This was rechecked after the suite: still stopped.
- Per the task rules, Docker and WSL were not started.
- Every database- and Storage-dependent check stopped here. This pass created no database, no
  Storage fixture and no server process.

### 9.3 Full web suite on the final integration code (gap 1: **closed**)

- **Code:** `8579a74205700959939aa72a2d7f1396a152b0a6`. It includes `f5fcfcc` and the merged
  P40R/P40R2 code.
- **Command** (in `apps/web`): `vitest run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`
  - no exclusions;
  - default timeouts;
  - nothing else from this pass was running.
- **Log:** `.p41-local/web-suite-p41r2-8579a74.log` (local, git-ignored).
- **Result: exit code 0.**
  - Test files: **153 passed (153)**.
  - Tests: **1,349 passed (1,349)**.
  - Duration: 676 s (03:24:54Z–03:36:22Z).
  - No failures and no timeouts.
- **Earlier evidence is kept:** §8.5's run on `25d7d98` (exit 1, one isolation failure) and P41's
  pre-commit run (67 failures) stand as recorded. This is the first clean full run on the
  integrated tree.
- No app code changed in this pass, so the API, static check and build results in §8.5 still
  describe this code.

### 9.4 Proof-photo browser cases (gap 2: **open, blocked by the environment**)

Cases A–D did not run:
- A: valid view/download;
- B: 410 `PROOF_FILE_MISSING` → "Photo unavailable";
- C: Storage outage → Try again → recovery;
- D: old-API download refused.

**Why:** they need a disposable database on local Postgres and real local Supabase Storage. Both
are hosted by Docker Desktop, which was stopped (§9.2). No P40/P40R2/P40R3 evidence exists to
reuse either. P40R2's own browser cases were blocked too (P40 runbook §12.3–12.4).

**To finish once Docker Desktop and Supabase are running** (follow the P40 runbook §12.4):
1. Do an authenticated upload/read/delete on a test-owned object to prove Storage really works.
2. Create a uniquely named database. Don't use `pos_verify` or `pos_p41r`. Run
   `prisma migrate deploy` and the seed, with every DB URL pinned to that database.
3. Build the API and web from this branch. Start the API with `API_PORT` (not `PORT`) and
   `SUPABASE_URL` set to `tests/e2e/fixtures/storage-fault-proxy.cjs` on a free port.
4. Run `tests/e2e/pos-perf-p40r2-proof-and-nav.spec.ts` (`Admin Dashboard (Desktop)`,
   `--workers=1`) with `PLAYWRIGHT_BASE_URL` and `E2E_STORAGE_PROXY_URL` set.

### 9.5 Owner-approved advisory stock-check timeout

The owner has approved the 10 s timeout (`STOCK_CHECK_TIMEOUT_MS`). After a timeout:
- the cart is kept as it is;
- an explicit fail-open warning is shown ("Stock couldn't be checked … you can still charge");
- Charge is enabled.

Checkout's server-side atomic reservation (`INSUFFICIENT_STOCK`) remains the final guard. This
closes §8.6 blocker 4. The policy was not changed.

### 9.6 Fixes and cleanup

- **Fixes:** none. No regression was found.
- **Processes:** only the vitest run was started, and it exited on its own.
- **Databases and Storage:** nothing was created, so nothing was removed.
- **Not touched:**
  - `pos_p41r` (§8.6 leftovers). It couldn't be inspected with Postgres down, and it is still to
    be dropped once confirmed unused.
  - P40R2's retained Storage object `payment-proofs/p40r2-fixture/e35480b7-4e64-433f-b3c2-6e2f05140b5e.png`.
- Shared `main` (`5a9e48c`) and `p40r-review` (`1da6add`) were only read.

### 9.7 Remaining release blockers

1. **Proof-photo browser cases A–D** (§9.4). They need Docker Desktop/Supabase running.
2. Integrate into shared `main`, then push and CI. Follow the P40R deploy order (§8.6 item 3).
3. Pilot spot checks (§8.6 item 5).
4. Drop `pos_p41r` and the P40R2 Storage fixture once they are confirmed unused.

## 10. P41R3 — local services restored, proof-photo browser cases run (2026-10-28)

Local only. Nothing was merged into shared `main`, pushed or deployed. Production was never contacted.
Worktree `C:/Users/kaile/Downloads/PTTO/p41r-integration`, branch `integration/pos-perf-p41r`,
starting HEAD `56a92fffb42eefbd0e730b294b81eeb187b3a763`, clean.

### 10.1 Machine and service startup

- **Machine:** 4 cores, 7.7 GB RAM. At the start, 0.67 GB free and 57% CPU. With Docker running, 0.74 GB
  free and 82% CPU.
  - Builds and browser runs were done one at a time.
  - The API `tsc` build took about 6 minutes.
- **Docker Desktop** was started normally (`Docker Desktop.exe`):
  - engine 29.6.1 answered within about 5 s;
  - the existing containers came up through their restart policies, so `supabase start` was not run and no
    second stack was created;
  - `supabase_auth` restarted once, and every container was healthy about 1.5 min later;
  - no force restart, WSL shutdown, reset, prune or volume deletion was used.
- **Health:**
  - Postgres 16.14 on `127.0.0.1:5432` accepted connections;
  - `GET /storage/v1/status` returned 200 on `127.0.0.1:54321`;
  - an authenticated, test-owned upload → read → delete → read in `payment-proofs` worked: the read was
    byte-identical, and the object was gone after delete.
- Every DB and Storage URL was checked to be loopback before any migration, seed or upload.

### 10.2 Full web suite (gap 1: closed, unchanged)

- §9.3's clean run on `8579a74` still describes the integrated code:
  - exit 0;
  - 153/153 files, 1,349/1,349 tests;
  - one fork, default timeouts, no exclusions.
- Since `8579a74`, only docs (`56a92ff`) and this pass's e2e spec change exist.
  - The web suite is rooted at `apps/web`, so it doesn't include `tests/e2e`.
  - No app code changed, so the suite was not re-run.
- `f5fcfcc` (the rollback-spy `mockClear`) is an ancestor of HEAD.

### 10.3 Proof-photo browser setup

- **Database:** new disposable `p41r3_proof_10281146` (not `pos_verify` or `pos_p41r`).
  - `prisma migrate deploy` applied 89 migrations.
  - `prisma/seed.ts` ran with `ALLOW_DATABASE_SEED=true`.
- **API:** built from HEAD (`tsc`) and run as `node dist/server.js` with:
  - `API_PORT=4410` (not `PORT`);
  - `NEXT_PUBLIC_APP_URL=http://localhost:3410`;
  - `SUPABASE_URL` pointing at `tests/e2e/fixtures/storage-fault-proxy.cjs` on `:54410`, which forwards to
    `:54321`.
- **Web:** `next build` with `NEXT_PUBLIC_API_URL=http://localhost:4410`, run with `next start -p 3410`.
  - The build was checked to contain `:4410` and not the `.env.local` port `:4300`.
- **Spec:** `tests/e2e/pos-perf-p40r2-proof-and-nav.spec.ts` on Chromium (`Admin Dashboard (Desktop)`,
  `--workers=1`). Real HTTP, the real API and real local Storage were used. Role and branch checks were left
  on, and the buckets stayed private.

### 10.4 Results

| Case | Result |
| --- | --- |
| **A. Valid proof** | **passed.** The inline image shows, and Download photo saves `payment-proof-<receipt>.png`, byte-identical to the 68-byte fixture. Over real HTTP: API 200 `{download_url, filename, expires_in_seconds}`; Storage 200, `content-type: image/png`, `Content-Disposition: attachment; filename=payment-proof-<receipt>.png`, PNG signature `89504e47`. |
| **B. Missing object, existing bucket** | **passed.** "Photo unavailable" and "no longer in storage" are shown, with no Try again, Download or image. Exactly 1 request in 8 s, so there is no retry loop. Proxy log: sign → Storage 400, then `getBucket` → 200, which is the API's 410 `PROOF_FILE_MISSING` path. Fits at 390 px. |
| **C. Temporary Storage outage** | **passed.** The proxy dropped the socket, and the dialog showed "Failed to load the payment proof." with Try again and no "Photo unavailable". After the proxy was set back to `pass`, Try again (focused, Enter) loaded the image. Fits at 390 px, with Download in view. |
| **D. Old-API download answer** | **passed.** The refusal text "Download photo is not available until the server update finishes…" is shown. The URL didn't change, nothing downloaded, and no `/undefined` request was made. |
| Navigation and Attendance (P40R2) | passed |
| **Focus return after Escape** | **failed.** This is a real defect that existed before P40/P41 (§10.5). |

Screenshots were opened and checked: valid, old-API, missing (desktop and phone), storage down, recovered
(desktop and phone). Evidence is kept locally (git-ignored) in `.p41-local/p41r3/run1…run6/`.

**Run history** (logs in `.p41-local/p41r3/`):
1. **Committed spec as it was:** A passed. D failed because the mock never applied.
   - The production build registers the PWA service worker, and `page.route` doesn't see requests a
     service worker handles.
   - The API log shows the second `?download=1` reaching the real API. Playwright's own `urlMatches`
     confirmed the glob matched.
   - **Fix (test only):** `test.use({ serviceWorkers: 'block' })`.
2. **With that fix:** A and D passed. The run stopped at the focus assertion.
3. **Invalid, my error.** A broken shell chain meant the runner never loaded the disposable-DB settings, so
   the P40 fixture seeded into `pos_p41r` (suffix `r31226`). See §10.6. Later runs went through a guarded
   runner that refuses any database other than `p41r3_proof_*`.
4. **Temporary uncommitted copy** with only the two focus checks made `expect.soft`, and serial mode off:
   - A, B and D assertions passed;
   - B's phone check read 448 px (§10.5);
   - C was not reached because of a flaw in the copy (it re-seeded with the same suffix).
5. **Committed spec, `--grep` on C only:** passed.
6. **Corrected temporary copy:** nav, attendance and C passed, and every A/B/D assertion passed. The only
   failures were the two soft focus checks.

The committed spec is still **red** at the first focus assertion (`toBeFocused` after Escape). It doesn't
run in CI: `deploy-production.yml` runs only `pilot-smoke.spec.ts`.

### 10.5 Findings

- **Focus return (app defect from before P40/P41; not fixed).** Clicking View Proof in the Daily Sales
  transactions sheet replaces that button's DOM node while the dialog is open. On close, Radix restores
  focus to a detached node, so focus falls to `<body>`. This happens even with a plain open → Escape.
  - **Cause:** `components/reports/daily-sales-drilldown.tsx` rebuilds `columns` every render, and
    `DataTable` uses `flexRender`, which renders each `cell` function as a new component type. Opening a
    dialog sets state, so every cell remounts.
  - **Not a regression:** the same unmemoized `columns` exist at baseline `45aab2a`, and `DataTable` hasn't
    changed since before P40. P41's hosted-dialog focus restore (`dialog.tsx`) keeps the baseline's
    `opener?.isConnected` guard.
  - **Not fixed** under the "proven regressions only" rule. This is an owner decision.
  - Keyboard users have to tab back from the top of the sheet. The receipt filter and the "1 transaction
    match" state are kept.
- **Phone-width check race (test defect, fixed).** Right after `setViewportSize`, both proof dialogs
  briefly report their desktop box: 437–448 px, with x < 0. 100 ms later they measure 358 px at x = 16 at
  a 390 px viewport. The app layout is correct.
  - **Fix (test only):** both 390 px checks now wait with `expect.poll`. The threshold is unchanged.
- **Spec validation:** `tsc --noEmit --strict` is clean on the spec. No eslint config covers `tests/e2e`.
  No app code changed, so no app tests, typecheck, lint or build re-runs were needed beyond the builds
  above.

### 10.6 Cleanup

- **Stopped:** the web `:3410`, API `:4410` and proxy `:54410` this pass started. An orphaned
  `next start -p 3410` child was confirmed by its command line before it was stopped. All three ports were
  then free.
- **Dropped:** `p41r3_proof_10281146` (0 connections at drop time).
- **Storage removed** (all created 2026-10-28 04:10–04:44 UTC by this pass and matched to its seed
  suffixes):
  - 9 `payment-proofs/p40/<suffix>/payment.png`;
  - 6 `discount-proofs/p40/<suffix>/discount.png`;
  - suffixes `dm1396 r31209 r31217 r31226 r31229 r31234 rmnfur rmrbrd wmk2b5`;
  - **P40R2 fixture** `payment-proofs/p40r2-fixture/e35480b7-4e64-433f-b3c2-6e2f05140b5e.png`. Before removal
    it was confirmed to be the only object there: 68 bytes, `image/png`.
- **Kept:** the `p40/*` objects from 2026-10-27, which belong to earlier P40 runs.
- **Left in `pos_p41r`** (my run 3; local, not production). One P40 seed set from that run:
  - branches `P40Ar31226`, `P40Br31226`, `P40Cr31226`;
  - 5 users `p40-*-r31226@test.local` or last name `r31226`;
  - 32 transactions, plus their shifts and assignments.
  - It was not removed with a raw multi-table delete in a database this pass doesn't own. `pos_p41r` is
    already marked to be dropped (§9.7 item 4), and dropping it removes these rows.
- **Kept locally (git-ignored):**
  - `.p41-local/p41r3/` logs and screenshots;
  - `apps/api/dist`;
  - `apps/web/.next`, which is now built for API `:4410`, so rebuild it before any other local use;
  - `tests/e2e/fixtures/*.auth.json`, rewritten by global setup.
- **Left running:** the shared Docker Desktop and Supabase stack.
- **Not touched:** shared `main` (`5a9e48c`), `p40r-review` (`dbd21b4`) and the other worktrees.

### 10.7 Remaining

1. **Owner decision on the focus-return defect** (§10.5). It existed before P40/P41. Until it is fixed or
   the assertion is changed, `pos-perf-p40r2-proof-and-nav.spec.ts` stays red at that line.
2. Integrate into shared `main`, then push and CI. Follow the P40R deploy order (§8.6 item 3).
3. Pilot spot checks (§8.6 item 5).
4. Drop `pos_p41r`, which also removes the `r31226` seed set.
