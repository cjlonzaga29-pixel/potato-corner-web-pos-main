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

1. **Owner review — optional MULTIPLE semantics.** A lone MULTIPLE group splits into `target` units (Task 182). For an optional
   add-on group with `max_selections 2`, pressing Add with nothing picked adds **2** plain items — exactly what the old flow
   forced, now stated in the footer. If such groups mean "up to N extras on one item", that is a behavior decision for a later batch.
2. Add-ons-named groups still ignore `max_selections` (unchanged from Task 131).
3. On 360×640 the PIN Continue button needs a short scroll.
4. Not tested on physical devices; touch was simulated with clicks in Chromium only.
5. Local leftovers: database `p46_ui_10291819` (drop when done), Docker Desktop left running, scratchpad env/fixture/screenshots
   outside the repo.
