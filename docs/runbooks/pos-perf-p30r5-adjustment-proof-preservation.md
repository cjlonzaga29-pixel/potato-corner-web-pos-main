# POS-PERF-P30R5 — Preserve Proof on Approved Adjustments

## Starting / final state

- Starting local HEAD: `021c03788585a6247db1c602e1d67364cbd8c239` (2 commits ahead of `origin/main`, clean working tree).
- Final local HEAD: see the commit this report ships alongside — one commit ahead of the starting SHA above.
- `DATABASE_URL`/`DIRECT_URL` verified pointing at `127.0.0.1:5432/pos_verify` (the same disposable local Postgres used throughout P30/P30R) before any test run. Local Supabase Storage (`127.0.0.1:54321`) confirmed live before the real-browser proof-upload test. API (port 4000) was already running from a prior session; the web dev server (port 3000) was not running and was started fresh for this task — both local-only, no production connection string used at any point.

## Defect found

`applyApprovedRequest`'s ADJUSTMENT branch in `inventory-approval.service.ts` called `applyAdjustmentInTx` without forwarding `proofKey`/`proofType`, even though:

- `applyAdjustmentInTx` (`universal-inventory.service.ts`) already accepts and persists both fields.
- The RECEIVING and WASTE branches immediately above/below it in the same function already forwarded them (POS-PERF-P30R4 fixed the matching gap for `responsibleStaffName`/`pinVerifiedAt` on this exact pair of branches but didn't touch proof).

Effect: a branch account could upload real evidence, verify staff PIN, and submit an ADJUSTMENT request — the pending request correctly showed "View Proof Photo" (the request row's own `proofKey` is always intact) — but the moment a supervisor approved it, the resulting `InventoryStockMovement` was created with `proofKey: null`. The Supervisor/Admin Inventory Movements screen's "Receipt" column (`inventory-movements-view.tsx`) would show no "View Receipt" link at all for an approved adjustment that genuinely had verified evidence on file, silently losing the audit trail at the exact moment it's needed (post-approval history).

## Fix

One-line addition in `applyApprovedRequest`'s ADJUSTMENT branch (`inventory-approval.service.ts`):

```ts
const movement = await applyAdjustmentInTx(tx, {
  ...
  proofKey: request.proofKey ?? undefined,
  proofType: request.proofType ?? undefined,
  ...
});
```

Mirrors exactly what RECEIVING/WASTE already do. No change to the storage model, no re-upload, no new signed-URL path — the request's existing `proofKey` (pointing at the one object already uploaded at submission time) is simply carried onto the movement row that gets created at approval time, same as the staff-identity fields already are.

### Sibling paths checked, not changed

- RECEIVING/WASTE (UNIVERSAL_ITEM): already correct — no defect.
- LEGACY_INGREDIENT (RECEIVING/ADJUSTMENT/WASTE/PHYSICAL_COUNT): `inventoryRepository.appendMovement`/`appendMovementLocked` have no proof parameter at all, and the legacy router never resolves `evidence`/`staffPin` for any legacy-ingredient submission (by design — predates P29's evidence/PIN requirement entirely, per `requestRequiresStaffVerification`'s doc comment). No concrete defect found; left unchanged.
- PHYSICAL_COUNT (UNIVERSAL_ITEM): never collects evidence by design (no `evidence` field on `SubmitPhysicalCountData`). Not applicable.

## Real-Postgres regression test

Added to `inventory-approval.integration.test.ts`: *"approving an ADJUSTMENT request with evidence on file carries the proof key/type onto the resulting movement"*.

- Submits an ADJUSTMENT with a real `evidence.proofKey`/`proofType` and a PIN-verified `staffPin` fixture.
- Asserts the stored `InventoryApprovalRequest` row has the proof (sanity check on submission).
- Approves it through the real service, then asserts the resulting `InventoryStockMovement` row has the same `proofKey`/`proofType`.

**Verified the test actually catches the regression**: ran it against the pre-fix code (`git stash` on the service file only) — failed with `expected null to be 'approval-requests/…'`. Restored the fix, re-ran the full file: **28/28 passed**.

Also exercised in the same run (pre-existing, unmodified):
- Exactly-once application and 409 on re-approval (`approving applies the movement exactly once…`).
- Concurrent double-approve resolves to exactly one winner.
- A failed stock application (insufficient available/reserved stock) throws before any status flip or movement — `approveAndApply`'s `prisma.$transaction` wraps both the status-flip and the apply step, so a thrown `UniversalInventoryError`/`IngredientError` inside `applyApprovedRequest` rolls back the `markApprovedIfPending` write in the same transaction; no separate test needed to prove this since it's the same transaction wrapper already covered by the stale-physical-count and below-reserved-stock tests.

## Real-browser verification

New spec: `tests/e2e/pos-perf-p30r5-adjustment-proof-preservation.spec.ts`, run against the local disposable stack (web :3000, API :4000, Postgres `pos_verify`, local Supabase Storage). Fresh real UI logins for both branch and supervisor roles (not the shared `*.auth.json` storageState files — those are single-use/rotating and may already be consumed by another spec in the same run; see `staff-pin-inventory-ops.spec.ts`'s header comment for the established reason).

**Scenario:**
1. Branch account uploads a real evidence image (`fixtures/gcash-test.png`) into the Adjust Stock form, verifies a real staff PIN, and submits for review. Confirmed the pending request's own detail dialog ("Review") already shows "View Proof Photo".
2. A different account (supervisor — distinct from the submitter, satisfying the self-approval check) opens the same request, confirms "View Proof Photo" is visible pre-approval, then approves it through the real `/api/inventory-approvals/:id/approve` endpoint (captured via `waitForResponse` and asserted `response.ok()`).
3. Navigated to `/supervisor/inventory/movements`, located the resulting `Adjustment (In)` movement row for the item, and confirmed a "View Receipt" link is present with a real signed Supabase Storage URL (`https://…`) — fetched it directly and asserted `200 OK` with `Content-Type: image/*`, proving it resolves to the actual uploaded image, not a stale/placeholder link.
4. Confirmed unauthorized access: a supervisor scoped only to a freshly-created, unassigned branch cannot retrieve this branch's approval requests via the list endpoint (`403` or an empty result set — verified both are acceptable outcomes depending on how the branch filter is enforced, and asserted whichever the API actually returns).
5. Confirmed the Inventory Movements list as a whole doesn't crash when rendering rows that have no proof at all (every pre-existing PHYSICAL_COUNT/legacy row in the seeded data has no proof) — no "Something went wrong" error boundary triggered.

**Result: 4/4 passed.**

### Two test-authoring mistakes found and fixed while writing this spec (test bugs, not production defects)

1. Clicking a table row directly does not open the detail dialog — the queue only wires `onClick` to the row's "Review" button (`inventory-approval-queue.tsx`). Fixed both branch and supervisor steps to click the button, not the row.
2. The `waitForResponse` regex targeted `/api/inventory-approval/` (singular) — the router is actually mounted at `/api/inventory-approvals` (plural, `app.ts`). The mismatch caused the wait to hang until the 120s test timeout rather than ever matching. Fixed the regex.
3. The Inventory Movements table renders movement types via `MOVEMENT_TYPE_LABELS` (`inventory-movement-labels.ts`) — `ADJUSTMENT_IN` renders as `"Adjustment (In)"`, not `"Stock Adjustment"` (that string is the *approval queue's* operation label, a different mapping). Fixed the row filter to match the movements-view label.

None of these three were production defects — all caught and fixed by re-running against the real app until the assertions matched real rendered text/real routes.

## Validation

- `apps/api`: `tsc --noEmit` clean. `eslint .` clean (0 errors; 296 pre-existing `no-console` warnings, unchanged baseline). Full `vitest run`: **150/164 files passed (14 skipped, pre-existing `TEST_DATABASE_URL`-gated convention), 2766/2988 tests passed (222 skipped)** — matches prior P30 baselines, no regressions.
- `apps/web`: `tsc --noEmit` clean. `eslint .` clean (0 errors; 1 pre-existing `@next/next/no-img-element` warning in an untouched file). Full `vitest run`: **136/136 files, 1186/1186 tests passed.**
- `apps/api` build: `tsc -p tsconfig.json` — clean, no errors.
- `apps/web` build: `next build` — compiled successfully, no errors (two pre-existing Sentry config informational warnings, unrelated to this change).

## Remaining limitations

- The cross-branch-access test (`a supervisor with no access to another branch…`) asserts a `403`-or-empty-list outcome rather than a single hard-coded status, since this task did not trace which exact enforcement point (middleware vs. service-level branch filter) the list endpoint uses for a `branch_id` the supervisor isn't assigned to — both are correct "cannot see it" outcomes; a future session could tighten this to the one actual code path if that specific precision becomes a dedicated concern. (This is the same category of request as the task's required cross-branch check, just not narrowed to one exact HTTP status, since both are equally valid to prove denial.)
- No concurrency-specific regression test for proof specifically was added beyond the existing exactly-once/concurrent-approve coverage already in the file — proof forwarding happens inside the same single `applyAdjustmentInTx` call the exactly-once guarantee already protects, so a failure in one would already be a failure in the other; a separate concurrency test for proof alone would be redundant coverage, not new signal.

## Files changed

```
apps/api/src/modules/inventory-approval/inventory-approval.service.ts            (1-line fix: forward proofKey/proofType)
apps/api/src/modules/inventory-approval/inventory-approval.integration.test.ts   (new regression test)
tests/e2e/pos-perf-p30r5-adjustment-proof-preservation.spec.ts                   (new, real-browser verification)
docs/runbooks/pos-perf-p30r5-adjustment-proof-preservation.md                   (new, this file)
```

**Explicit confirmation: NOT pushed, NOT deployed.** All work is local-only, committed to `main` on top of the verified starting HEAD, ahead of `origin/main` by 3 commits (2 pre-existing + this one) with a clean working tree after commit.
