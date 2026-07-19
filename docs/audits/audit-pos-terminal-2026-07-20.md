# POS Terminal Audit — 2026-07-20

Scope: static code audit of `apps/web/app/(pos)/terminal/page.tsx` (432 lines) and `apps/web/components/pos/pos-header.tsx`. No Playwright run (no staff auth fixture in `tests/e2e/`). No code changes made.

## 1. Executive Summary

- **Critical: 1, High: 3, Medium: 2, Low: 2**
- Top 5 fixes: (1) fix branch-name rendering bug in `pos-header.tsx`, (2) confirm shift-open flow is just a discoverability gap, not missing, (3) investigate data source for variant name/price gaps (not a template bug), (4) add a selected/added visual state on card tap, (5) verify grid gap is cosmetic only.
- **Usable for a live cashier: mostly yes**, with friction. Charge, cart, discount/VAT, and offline queueing all work. The two real blockers are the branch-ID display bug (confirmed code bug) and the reported missing variant/price on some cards (likely a data issue, not code — needs live-catalog inspection to confirm).

## 2. Critical Issues

- **Card variant/price inconsistency (#1, #2, #7):** The card template (`terminal/page.tsx:246-263`) is uniform — every card renders `product.name`, `variant.name`, and `formatPeso(variant.price)` identically, one card per variant (not per product). There is no branching logic that would explain some cards showing price/variant and others not. This means the "Crunchy Chicken Pops" duplicates and blank variant labels are most likely a **catalog data issue** (e.g., duplicate variant rows with empty `name`/`price`, or bad category/product seed data), not a rendering bug. **Needs live catalog data pull to confirm** — this is the top item for Phase 2 investigation, not a straight code fix.

## 3. High Issues

- **Branch shown as raw ID (#4) — confirmed code bug.** `components/pos/pos-header.tsx:44`: `` `Branch ${branchId.slice(0, 8)}` `` — literally slices the UUID and prefixes it, there is no branch-name lookup at all. Terminal page itself doesn't render branch name (only uses `branchId` internally for queries and offline-queue keys, which is correct/intentional there per `terminal/page.tsx:200`). Fix is isolated to `pos-header.tsx`; needs a branch name source (likely `user.branches` or a `useBranch(branchId)` lookup — not currently fetched in the header).
- **Empty grid cells (#5):** `terminal/page.tsx:244` uses `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` with one `<Card>` per variant and no filler cells — gaps at the end of a row are just CSS grid behavior when the variant count isn't a multiple of the column count. Not a bug per se; cosmetic only. Confirms low actual impact once #1 (data) is resolved, since duplicate/blank cards inflate the grid and make gaps more visible.
- **Selected state unclear (#6):** Cards have no active/selected visual state — `Card` only has `hover:border-primary` (`terminal/page.tsx:249`). Tapping a card calls `handleProductTap` which immediately adds to cart (or opens a flavor prompt), it's a tap-to-add pattern, not select-then-confirm. There's no flash/feedback confirming the tap registered, which is likely what reads as "selected state unclear."

## 4. Medium Issues

- Duplicate "identical-looking" cards (#2) is the same root cause as #1 (data-side duplicate variants), not a separate template issue.
- No cart-add visual feedback beyond the cart panel updating — no toast/flash on tap.

## 5. Low / Polish

- No keyboard shortcut or barcode-scanner input handling anywhere in `terminal/page.tsx` (grep for `keydown`/`barcode`/`scanner` returned nothing).
- Card image fallback is a plain gray block (`h-20 w-full rounded bg-muted`) when `image_url` is missing — fine, just plain.

## 6. Shift-Open Flow (#3)

Not missing — it's a separate route, not inline on `/terminal`:
- `/shift` (`shift/page.tsx:56`) has an "Open Shift" button routing to `/shift/open`.
- `/shift/open` (`shift/open/page.tsx`) uses `useOpenShift(branchId)` to actually open it.
- `/terminal` itself only shows a passive warning when there's no shift: `"No active shift — open a shift before charging."` (`terminal/page.tsx:406`) with **no link/button to `/shift/open`** from that message.
- Flow is: Clock In → (navigate to `/shift` separately) → Open Shift → back to `/terminal` → Charge. This is a **discoverability gap**, not a missing feature — the no-shift warning on `/terminal` should link directly to `/shift/open`.

## 7. Category Tabs (Step 5)

Dynamic, not hardcoded — `categories` is derived via `useMemo` from the loaded catalog (`terminal/page.tsx:110`), filtering (`visibleProducts`, line 114) is a simple `category === activeCategory` match. No issues found here.

## 8. Cart / Checkout Flow (Step 6)

- Add-to-cart: `handleProductTap` → `addItem()` (Zustand `useCart`), or opens a flavor-selection prompt first if the variant has flavors (`terminal/page.tsx:124-129`).
- Discount/VAT/change calculation lives in `previewAmounts()` (lines 46-58) — implements the PWD/Senior VAT formula and employee/promotional discounts per architecture spec.
- Charge gating (`canCharge`, line 163): requires branch + active shift + non-empty cart + valid discount ID (if PWD/senior) + valid tender/GCash ref. Matches CLAUDE.md's stated business rules.
- Offline: `is_offline_transaction` flag set from `useOffline()`; when offline, transactions are queued locally via `enqueueOfflineTransaction()` (Dexie) with a provisional ID rather than calling the API directly.

## 9. Offline-First Assessment

**Working**, per code: catalog and price overrides are cached to Dexie (`cacheProductCatalog`, `cacheBranchPriceOverrides`) and re-read on load/offline (`getCachedProductCatalog`, `getCachedPriceOverrides`); offline sales enqueue via `enqueueOfflineTransaction` and show a banner ("This device is offline. The sale is saved locally...", line 422) plus a top bar. No live/runtime verification performed (no Playwright run).

## 10. Screenshots

None captured — no `tests/e2e/fixtures/*.auth.json` or `tests/e2e/.auth/*.json` staff auth fixture exists. Visual verification requires either a fixture or manual login.

## 11. Recommended Fix Batches

- **Batch 1 (cashier-blocking):**
  - Fix `pos-header.tsx:44` branch-name rendering (needs branch-name source).
  - Add a direct "Open Shift" link/button to the no-shift warning on `/terminal` (`terminal/page.tsx:406`).
  - Pull live catalog data to confirm/deny the variant/price data issue (#1/#2/#7) before writing any card-template fix.
- **Batch 2 (pre-pilot polish):**
  - Add tap/selected visual feedback on product cards.
  - Consider filler/placeholder cells or different grid sizing to reduce empty-cell appearance once duplicate data is cleaned up.
- **Batch 3 (post-pilot backlog):**
  - Barcode scanner / keyboard shortcut support.
  - Cart-add toast/animation polish.
