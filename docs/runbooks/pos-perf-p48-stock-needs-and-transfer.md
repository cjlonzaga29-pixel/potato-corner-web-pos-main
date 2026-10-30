# POS-PERF-P48 — Stock needs and assisted inventory transfer

Third item from the October 29 video review. Starting HEAD: `0357ce0` (P47, local only; `origin/main` = `7084291`, clean
tree, `main` one commit ahead). Final commit: the one adding this file
(`git log -1 -- docs/runbooks/pos-perf-p48-stock-needs-and-transfer.md`). P47's unpushed commit stays underneath.
No migration, no schema change, **no API change**. Not pushed or deployed; no production data, settings, smoke accounts or
terminal queues were touched. Payroll, breaks, VAT, promotions/discounts and rate limits were not touched.

## 1. Existing transfer rules (traced, reused unchanged)

| Concern | Where | Behaviour |
| --- | --- | --- |
| Endpoint | `POST /api/branches/:branchId/inventory-stock/transfer` | `:branchId` is the **source**; body `{ inventory_item_id, to_branch_id, quantity > 0, notes? }` (Zod `transferInventoryStockSchema`). `adminOrSupervisor` only; the branch route shows the "managed by supervisor" notice. |
| Source authorization | `branchGuard` → `hasBranchAccess` | Supervisor: active assignment to an active branch, read from the DB each request (never the JWT claim). |
| Destination authorization | `transferStock` → `getTransferDestinationBranchIds` | Supervisor: own active assignments only (`403 TRANSFER_DESTINATION_DENIED`); destination must be active. |
| Same branch | `transferStock` | `422 INVALID_TRANSFER`. |
| Balance check | inside the transaction, after `lockAndGetStock` on both rows (ordered by branch id) | `available = on hand − reserved`; over → `409 INSUFFICIENT_STOCK`. This is the submit-time revalidation of a stale page. |
| Missing item link | same | No stock row at source or destination → `404 STOCK_ROW_NOT_FOUND`. Nothing is created. Both legs use the item's single base unit, so units cannot mismatch between branches. |
| Lifecycle | same | **Immediate**: TRANSFER_OUT + TRANSFER_IN in one transaction, shared `reference_id`, `performed_by_user_id` = actor, notes on both, cost carried at source average. No approval step exists for transfers (`MANUAL_INVENTORY_APPROVAL_REQUIRED` gates branch-actor receive/adjust/waste and physical count only). |
| Audit / proof | `INVENTORY_STOCK_TRANSFERRED` audit entry (actor, role, source branch); proof photo uploaded afterwards against the TRANSFER_OUT movement (`proofKey`/`proofType`) | Proof-upload failure after a recorded transfer shows the existing recovery banner; retry re-attaches, never re-transfers. |
| Idempotency | — | **None** on this route (receive/adjust/waste have `Idempotency-Key`; transfer never did). Not added here. |
| Maintenance | write gate | `503 SERVICE_WRITE_GATE_CLOSED`. |

## 2. Final UI (`/supervisor/inventory/transfer`)

- **Desktop (≥1024px):** two columns, 5:7 — *1. Stock needs* left, *2. Prepare transfer* right, full content width.
- **Phone/tablet:** stacked in that order. Choosing a need scrolls the form card into view and focuses the next field
  (source if empty, else quantity) without the focus jump overriding the scroll. All entries live in one form state, so
  moving between the list and the form loses nothing. No horizontal scrolling at 390px or 820px, including with errors.
- **Stock needs:** destination picker lists the user's active branches (`GET /api/branches?status=active`, server-scoped).
  Rows = the destination's stock rows whose server-computed `status` is not `healthy`: the same rule as P47's
  Inventory › Needs attention filter and the alerts endpoint (shared via `lib/inventory-stock-status.ts`). Each row shows
  item, status badge, available quantity (or **Out of stock**), reserved, the relevant threshold and unit. Critical
  first, then least available. Loading skeleton, error with retry, and empty state ("Items without thresholds are never
  listed"). A response for another branch is never rendered (`branch_id` must match). Rows are buttons (`aria-pressed`).
- **Form:** destination comes from the needs pane; item select (destination's items, needs first); destination
  availability and low threshold; source select (active branches minus the destination); source availability with
  on-hand and reserved, in the item's unit. **Suggestion:** shortfall to the low threshold (`low − available`), shown
  with its basis and a "Use N" button. Nothing is filled or submitted automatically. Proof photo (optional) and notes
  unchanged. Confirm dialog states quantity, item, source and destination.
- **Reconciliation:** changing destination clears item and quantity (with notice); a source that becomes the destination is
  cleared (with notice); changing item clears quantity (with notice); a linked item the destination doesn't stock is
  cleared (with notice); a source that doesn't stock the item is explained ("ask the inventory owner to assign it — this
  page does not create assignments") and blocks submit.
- **Client pre-checks** (the server re-checks all of them): source loaded, item at both branches, quantity ≤ source available.

## 3. Entry points / handoff

- Dashboard Inventory Alerts: each alert has **Prepare transfer** (`?to_branch_id=<active>&inventory_item_id=…`), shown
  only when the supervisor has more than one active branch. P47 card links (`?status=low|alerts`) unchanged.
- Inventory list: **Prepare transfer** on every low/critical row (same params); header **Transfer** now opens with
  `?from_branch_id=<active>` (it was implicitly "from the active branch" before).
- URL params only pre-fill. Non-UUIDs are dropped; a branch outside the user's active list is ignored with a notice and
  its stock is never requested. Server authorization is unchanged and applies regardless.

## 4. Save and failure behaviour

- One submit: a ref guard plus the dialog's own pending state; a double click on confirm sent exactly one POST.
- Refusals (validation, 403, 409, 404, 503 maintenance) → inline `role="alert"` "Transfer not recorded" with the server's
  message; every field, the photo and notes are kept.
- No response (network error / unreadable response) → "Transfer status unknown": check the destination's stock movements
  before resubmitting, because this form cannot detect a duplicate (no idempotency key; not claimed).
- Both branches' stock queries are invalidated after every attempt. Before, only the source was. A refused attempt
  therefore shows the fresh balance.
- Success → **Transfer completed** panel (not "submitted" or "pending": there is no approval step) with both
  post-transfer on-hand balances and whether a proof photo was attached; *Prepare another transfer* keeps both branches.

## 5. Verification

Disposable LOCAL database `p48_20852754` in `potato-corner-pos-postgres-1` (127.0.0.1:5432), new for this session (not
`pos_verify`, not another session's DB): `prisma migrate deploy` + `prisma/seed.ts` (`ALLOW_DATABASE_SEED=true`) + a P48
fixture (Main/North/South assigned to the seed supervisor, Foreign unassigned; items in g/ml/pc; critical, low,
out-of-stock, reserved and North-only stock). A scratchpad guard refused any URL other than `127.0.0.1:5432/p48_<digits>`
(and unset `PRODUCTION_DATABASE_URL_DIRECT`) before migrate, seed, fixture, tests and server start; fixture/browser scripts
also ran `tests/e2e/fixtures/local-db-guard.cjs`. Throwaway JWT/encryption secrets; local Supabase storage for proof.
API `node dist/server.js` on **4498**, web `next start -p 3498` built with `NEXT_PUBLIC_API_URL=http://localhost:4498`.
Afterwards the database was dropped (0 `p48_*` remain), and the env file and logs were deleted.

| Check | Result |
| --- | --- |
| Web unit: `inventory-transfer-form.test.tsx` (rewritten) | 20/20: needs = low/critical only, critical first, out-of-stock label, stale-branch guard, empty state, row → item, source excludes destination, destination change reconciliation, foreign link ignored and never fetched, missing-at-source blocked, suggestion only on click, over-available blocked, refused keeps form, network → unknown, double click → one call, proof recovery never re-transfers |
| Web unit: inventory list (+2), dashboard alerts (+1) | 8/8, 6/6 |
| **Web full suite** | **159 files, 1466/1466 passed** |
| API integration `p48-transfer.integration.test.ts` (real Postgres) | 8/8: needs = alerts; destinations/sources = own active branches; unassigned destination 403 with no movement; same-branch 422; reserved-aware 409; stale balance 409 at submit; missing destination row 404 with no row created; success moves both legs with one reference, actor, notes, unit and audit entry |
| API `universal-inventory` + `branch-access` + middleware tests | 12 files, 303/303 |
| HTTP against live API (supervisor) | 9/9: foreign stock read 403; destinations list excludes foreign; foreign **source** 403 `BRANCH_ACCESS_DENIED`; foreign destination 403; same-branch 422; reserved-exceeding 409; zero qty 422; missing destination row 404, no assignment created; no stock moved |
| Real browser (Playwright Chromium, SW blocked; 1440×900, 820×1180, 390×844) | **49/49** on the final build: dashboard Prepare transfer → prefilled page; needs list equals DB-classified low/critical rows; side-by-side desktop; source availability "35 g (40 on hand, 5 reserved)"; suggestion fills only on click; branch switch never flashes previous branch items, clears with notices; over-available blocked; missing-at-source explained; **stale balance** (DB drained after load) refused 409, form kept, displayed balance refreshed; aborted request → "status unknown", nothing moved; 503 maintenance shown inline, form kept; prepared form moved nothing; double-click confirm → one POST; North 40→31, Main 1→10; two legs one reference, supervisor as actor, notes, audit entry; proof stored on TRANSFER_OUT; foreign link ignored with no API request; inventory Needs-attention rows 3/3 with Prepare transfer; keyboard (Enter on need, focus to source, listbox via arrows, Escape cancels confirm); tablet/phone stacked, no overflow, form brought into view, notes kept, errors/buttons on screen |
| `turbo run type-check lint` | 7/7 tasks, 0 errors (308 pre-existing API `no-console` warnings, 1 pre-existing web `<img>` warning; changed files lint clean) |
| `next build` (web), `tsc` build (API) | Pass |

Failures found and fixed in browser runs:

1. A linked item was silently cleared. Radix Select reports `''` while its value isn't among options yet (the item list loads
   after the URL value is set). The select handlers now ignore `''`; no option has an empty value. A unit test was added.
2. On phones, focusing the next field after choosing a need overrode the smooth scroll and left the form heading off
   screen. The field is now focused with `preventScroll` in the stacked layout.
Two script-only corrections: the "foreign id never requested" check counted the page navigation itself, and the tablet
"form in view" threshold was too strict.

## 6. Limitations

1. **No idempotency on transfers** (pre-existing). Double submission is prevented in the page only; a retry after a lost
   response could record a second transfer, which is why the page says "status unknown" and points to stock movements.
2. Items with no thresholds are never "needs" (same definition as P47), even at zero stock.
3. Item/source pre-checks use the last fetched balance; the server's locked check is authoritative (proven above).
4. Branch list is capped at 100 active branches (same query as the sidebar selector).
5. Physical tablets/phones and screen readers were not tested; viewport sizes and roles/labels were the proxies.
6. A small empty gap under "Sending to …" (the hidden destination-error slot) is visible in the form; cosmetic, left as is.

## 7. State

Starting SHA `0357ce0`; final SHA = the commit adding this runbook, directly on top of P47. Working tree clean after
commit; `main` two commits ahead of `origin/main` (`7084291`). Nothing pushed or deployed.
