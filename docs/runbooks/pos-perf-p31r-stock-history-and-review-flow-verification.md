# POS-PERF-P31R — Stock History and Review Flow: Real-Browser Verification

## Starting / final state

- Starting local HEAD: `4ed0360fb0efca73b8b6dc88b2fc0c6d5f50ab41` ("fix(pos-perf-p31): clear inventory review flow and add Stock History"), 1 commit ahead of `origin/main`, with uncommitted working-tree changes already present at session start (the `stock_changed` server-flag fix below, and a new unstaged e2e spec) — carried forward and verified in this session rather than discarded.
- `DATABASE_URL`/`DIRECT_URL` verified pointing at `postgresql://…@127.0.0.1:5432/pos_verify` before any test or server start. Local Supabase stack (`127.0.0.1:54321` Kong gateway, `127.0.0.1:54322` Postgres, Storage/Auth/REST containers) and a separate disposable `pos_verify` Postgres container were already running (Docker Desktop was stopped at session start and was started fresh). API (port 4000) and web dev server (port 3000) were started fresh for this session; a production build (`next build` + `next start -p 3100`) was also run locally for the performance measurements. No production connection string, credential, or deploy action was touched at any point.
- Final local HEAD: this commit, one ahead of the starting SHA above.

## 1. Real-browser workflow verification

Ran `tests/e2e/pos-perf-p31r-stock-history-review-flow.spec.ts` (authored in a prior pass but never executed before this session) against the real local stack — Chromium, `Admin Dashboard (Desktop)` Playwright project, real logins for branch/supervisor/staff accounts, real file upload, real staff-PIN verification.

**Result: 3/3 passed** (2.4 min). Covered in one real run:

- Submit (quantity 5, real evidence upload, real staff-PIN verify) → supervisor returns for correction → branch reopens the returned request and confirms Resubmit starts enabled with current-revision values pre-filled → clearing the quantity field shows "Enter a quantity." next to a disabled Resubmit, restoring it re-enables the button → a notes-only edit (quantity/unit/reason unchanged) still triggers "New Verification Required" and blocks Resubmit, because notes is itself a PIN-bound field under the payload-binding policy → fresh evidence + fresh PIN re-enables it → resubmit → supervisor approves revision 2 → Request History's Approved tab shows "Applied" (never "No stock change"/"No quantity change") → Stock Changes tab shows the real `Adjustment (In)` movement, `+5`, linked back via "Request #…".
- A zero-variance physical count (submitted variance corrected back to on-hand before approval) approves with `stock_changed: false`, reads "No quantity change" in Request History (never "Applied"), and the detail dialog shows "No quantity change — the physical count matched stock on hand." — distinct copy from the generic "No stock change." used for non-approved statuses.
- Cancelling a pending request keeps it `CANCELLED`, leaves on-hand stock unchanged, reads "No stock change" in the Cancelled tab, and a second cancel attempt against the same id is a safe idempotent no-op (still `CANCELLED`, stock still unchanged) rather than erroring or re-applying anything.

Separately scripted (ad hoc Playwright, not added as permanent specs — see "Additional targeted UI checks" below) and confirmed against the production build on port 3100: desktop vs. 390px-narrow layout, pagination controls, empty-state rendering, in-SPA refetch row persistence, and cross-branch API denial.

These are real executed browser runs against a live local stack, not authored-but-unrun specs or component tests.

## 2. `stock_changed` / "no stock change" semantics

The server-computed `stock_changed` boolean (added to `inventory-approval.service.ts`'s `toResponse` and the shared Zod response schema) was already present in the working tree at session start. Verified end-to-end this session:

- **API integration test** (`inventory-approval.integration.test.ts`, real Postgres): new test *"stock_changed is false for every non-APPROVED status, and true only for an APPROVED request with a real movement"* walks PENDING → RETURNED → (correct) → CANCELLED and asserts `stock_changed === false` at every step regardless of `applied_movement_id`. Combined with the pre-existing exactly-once-application and zero-variance tests (now also asserting `stock_changed`), **31/31 passed** in the full file.
- **Component tests**: queue and detail-dialog tests assert the "Applied" / "No quantity change" / "No stock change" / "Not yet applied to stock." copy is driven by `stock_changed` alone, never re-derived client-side from `applied_movement_id`'s truthiness or its equality with the request's own id (the documented zero-variance placeholder). **All passed** as part of the full web suite (below).
- **Real browser**: the three scenarios above (real movement, zero-variance, cancelled) each produced the correct, distinct copy against live data, not a mock.

This closes the exact defect class task item 2 warns about: a client-side re-derivation from `applied_movement_id` would have misread the zero-variance placeholder (`applied_movement_id === request.id`) as "applied," and would have had no way to distinguish "never applied" (PENDING/RETURNED) from "applied nothing on purpose" (zero-variance APPROVED) from "actually applied" — the server flag now draws all three lines explicitly.

## 3. Historical ledger coverage audit

Audited whether the new Stock History page (Stock Changes tab, driven by `useInventoryStockMovements` → the universal `InventoryStockMovement` table) hides any previously-accessible history.

**Finding: no regression, but a pre-existing (not P31-introduced) gap confirmed to still exist.**

- `apps/web/components/branch-ops/inventory-movements-view.tsx` — the shared body behind `/supervisor/inventory/movements` and `/admin/inventory/movements`, which existed *before* P31 — was already migrated at **POS-PERF-P27** to read exclusively from `useInventoryStockMovements` (the universal ledger), per its own header comment. Stock History's Stock Changes tab (`stock-changes-view.tsx`) explicitly reuses that same hook/endpoint — "no new accounting data, just a broader filter over it" (its own header comment). It therefore has exactly the same coverage the pre-P31 Supervisor/Admin Inventory Movements screens already had — P31 did not narrow anything.
- The legacy ingredient-based ledger (`apps/api/src/modules/inventory/inventory.service.ts`'s `getMovements`, a different table from `InventoryStockMovement`) has **no UI consumer anywhere in the web app** — confirmed by grepping for the only hook that calls it (`useInventoryMovements` in `use-inventory.ts`): zero imports outside its own file, and `reports-view.test.tsx` has a standing test explicitly titled *"calls the aligned `useInventoryStockMovements` hook (not the legacy `useInventoryMovements` hook)"*. This predates P31 — nothing P31 shipped removed a working legacy-history view, because none existed in the UI to remove.
- The legacy ingredient *mutation* routes (`/ingredients/:id/stock-in|adjust|waste`) are already retired server-side (`rejectRetiredLegacyMutation`, confirmed by reading `inventory.router.ts`) — consistent with the task's "keep legacy retired mutation endpoints retired" instruction; this session made no change to them.
- However, the **approval-queue path** for `LEGACY_INGREDIENT` targets (`submitReceiving`/`submitAdjustment`/`submitWaste` with `target: 'LEGACY_INGREDIENT'`) is still live and exercised by passing integration tests (*"legacy stock-in/adjustment requests also gate through the same approval flow…"*, *"legacy waste requests also gate through the same approval flow…"*) — approving one of these writes to the legacy ledger (`inventoryRepository.appendMovement`/`appendMovementLocked`), **not** to `InventoryStockMovement`. A `LEGACY_INGREDIENT` request therefore still shows correctly in Request History (same table as everything else, `stock_changed` computed the same way) but its resulting movement is **not visible anywhere** — not in the old Inventory Movements screen (already true since P27) and not in the new Stock Changes tab (inherits the same limitation).
- In practice this is narrow: only **one** legacy `Ingredient` row exists in the seeded local database (vs. 12 `InventoryItem` rows), the frontend has no UI entry point that submits a `LEGACY_INGREDIENT` request (grep confirms `legacy_ingredient_id`/`LEGACY_INGREDIENT` appear only in test files on the web side), and CR-001 explicitly superseded this model. The capability is kept for backward compatibility with pre-CR-001 data, reachable only via a direct API call, not through any real workflow a branch/supervisor/admin can click into.

**Conclusion**: no history that was visible before P31 became hidden by P31. The one real gap (legacy-ingredient-approval movements invisible in any movements view) is inherited unchanged from POS-PERF-P27/CR-001, not introduced or worsened here. No code change made for this item, per the task's own "if no relevant history is omitted, document the evidence" branch — closing this as documented, not as a defect to fix, since fixing it would mean reviving a dead write surface's read-side for no active use case while the real architectural answer is already CR-001 (full migration off `LEGACY_INGREDIENT`), which is out of scope for a hardening pass.

## 4. Stock History tab navigation — local performance measurement

**Local measurements only — not a production claim.** Measured against a local production build (`next build` then `next start -p 3100`) talking to the same local API (port 4000) and `pos_verify` Postgres, using a throwaway Playwright script (not committed) driving real Chromium against the real running app.

No true git-history "before" baseline was built (the pre-P31 commit would require a second worktree + a second full `next build`, not done this session given time already spent on the four other investigation items) — numbers below are the "after" (current HEAD) state only, labeled as such:

| Scenario | Result |
|---|---|
| First (cold) navigation to `/supervisor/inventory/stock-history` — tab chrome visible | 675ms |
| First (cold) navigation — table data loaded (network idle) | 5600ms |
| First switch to Request History tab | 50ms (UI), approval-queue fetch completes shortly after in the background |
| Repeated switch back to Stock Changes tab (warm/cached) | 398ms |
| In-SPA filter change (same tab, no navigation) — existing rows stay rendered | confirmed: 25 rows remained visible with an "Updating…" indicator, not a blank/loading flash, while the refetch was in flight |
| Cross-tab content check (Request History → Stock Changes) | confirmed correct, non-stale content after a `waitForLoadState('networkidle')` wait — see note below |

Two API calls back each cold load of the Stock Changes tab: `GET /api/branches/:id/inventory-stock` and `GET /api/branches/:id/inventory-stock/movements?page=1&limit=25` (673ms and 2335ms respectively on the very first request against a cold Next.js production server process — not representative of steady-state; the reload-triggered repeat of the same two calls returned in 290ms/469ms).

**One false alarm, caught and discarded**: an initial version of the measurement script captured `table.first()`'s text immediately after a tab-click + `networkidle` wait and found it still showing the *previous* tab's column headers — suggestive of a `placeholderData` cross-tab leak. Re-verified directly (checked `[role=tabpanel]` `data-state`/hidden attributes and the actual DOM table count before/after the switch): there is exactly one `<table>` in the DOM at a time (Radix unmounts the inactive `TabsContent`), and its header text was correct for the active tab in both directions. The original script's read happened to race the first render path on an already-cached navigation; this was a test-script timing bug, not an app defect. Documented here rather than silently dropped, per the instruction to report evidence rather than invent an improvement or hide a scare that didn't hold up.

No placeholder-data leak across branches was tested directly (would require two seeded branches with distinct Stock History data and a branch-switch mid-session); the tab-to-tab case above is the only cross-boundary case checked this session.

Login/logout cache isolation was not separately re-verified this session — out of scope given time already spent; no code touched this session affects query-key branch/user scoping.

## 5. API test suite reconciliation

Ran the full `apps/api` suite twice this session (isolated `employees.service.test.ts`, then the complete `vitest run`):

```
Test Files  150 passed | 14 skipped (164)
     Tests  2773 passed | 222 skipped (2995)
```

- `employees.service.test.ts`: **60/60 passed**, both in isolation and inside the full run. No failure reproduced.
- The 14 skipped files are the pre-existing `TEST_DATABASE_URL`-gated integration suites (a different env var from `DATABASE_URL`; this is the long-standing convention noted in prior P30 runbooks, not a new skip introduced here).
- Matches the P30R5 baseline exactly on file/skip counts (150/164, 14 skipped); test count is 2773 vs. the prior 2766 baseline, consistent with the new tests added in this session's `stock_changed` matrix and the pre-existing P31 work.

**On the task's premise of "employees.service.test.ts failures"**: this session could not reproduce any failure in that file, against the same local Postgres/stack convention used throughout P30/P31. Reported here honestly rather than fabricated — whatever produced that signal in a prior environment (a different machine state, a stale build, a timing/order issue that didn't recur) is not present now. No fix was made because no defect was found; if the failure recurs in a future session, capturing the exact error text and `vitest run --reporter=verbose` order would be the next step.

`apps/web`: full `vitest run` — **137/137 files, 1206/1206 tests passed.**

## 6. Final validation

- `apps/api`: `tsc -p tsconfig.json --noEmit` clean. `eslint .` — 0 errors, 296 pre-existing `no-console` warnings (unchanged baseline). `tsc -p tsconfig.json` build clean.
- `apps/web`: `tsc --noEmit` clean. `eslint .` — 0 errors, 1 pre-existing `@next/next/no-img-element` warning (unchanged baseline). `next build` — compiled successfully, all routes including `/branch/inventory/stock-history` and `/supervisor/inventory/stock-history` present in the route manifest.
- Real-browser: 3/3 Playwright scenarios passed (section 1).
- API integration (real Postgres): 31/31 passed (section 2).
- Full `apps/api` vitest: 2773/2995 passed, 222 skipped, 0 failed (section 5).
- Full `apps/web` vitest: 1206/1206 passed.

## Remaining limitations

- No true pre-P31 git-worktree performance baseline was built — section 4's numbers are "after" only, explicitly labeled as such rather than implying a measured improvement that wasn't actually measured.
- The legacy-ingredient-approval movement visibility gap (section 3) remains unresolved by design — it predates this task, is narrow in practice (one seeded legacy ingredient, no UI submission path), and the correct fix is the already-planned CR-001 migration off `LEGACY_INGREDIENT` entirely, not a patch to Stock History.
- Cross-branch placeholder-data isolation and logout/identity-change cache isolation were not independently re-verified this session (see section 4); no change in this session touches that code path.
- The `employees.service.test.ts` failures named in the task could not be reproduced (section 5) — documented rather than guessed at.

## Files changed

```
apps/api/src/modules/inventory-approval/inventory-approval.service.ts            (stock_changed server-computed flag — present at session start, verified this session)
apps/api/src/modules/inventory-approval/inventory-approval.integration.test.ts   (new stock_changed status-matrix regression test)
apps/web/components/branch-ops/inventory-approvals/inventory-approval-detail-dialog.tsx   (reads stock_changed, not applied_movement_id truthiness)
apps/web/components/branch-ops/inventory-approvals/inventory-approval-detail-dialog.test.tsx
apps/web/components/branch-ops/inventory-approvals/inventory-approval-queue.tsx           (Stock Change column reads stock_changed)
apps/web/components/branch-ops/inventory-approvals/inventory-approval-queue.test.tsx
packages/shared/src/schemas/inventory-approval.schema.ts                          (stock_changed added to response schema)
tests/e2e/pos-perf-p31r-stock-history-review-flow.spec.ts                         (new, real-browser verification — executed this session)
docs/runbooks/pos-perf-p31r-stock-history-and-review-flow-verification.md        (new, this file)
```

**Explicit confirmation: NOT pushed, NOT deployed.** All work is local-only. No production data, uploads, PINs, or sales were touched; no billing or credential changes; no Render `autoDeploy` configuration touched.
