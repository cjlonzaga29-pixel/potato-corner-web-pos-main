# POS-PERF-P33R — Distinct Staff Attribution and Final Browser Verification

## Starting / final state

- Starting local HEAD: `f2c77f0693d5d38c8c81a46a3232305662b5f0f6` (`fix(pos-perf-p33): supervisor-only inventory operations, remove inventory PIN`), 1 commit ahead of `origin/main`, clean working tree.
- Final local HEAD: see the commit this report ships alongside — 2 commits ahead of `origin/main` (unchanged remote; nothing pushed).
- Local stack: existing disposable local Postgres (`pos_verify` on `127.0.0.1:5432`, verified via `DIRECT_URL`/`DATABASE_URL` before any migration), local Supabase Storage (`127.0.0.1:54321`), `apps/api` (`tsx watch`, port 4000), `apps/web` (`next dev --turbopack`, port 3000). No production connection string, data, uploads, PINs, sales, billing, or Render `autoDeploy` config was touched.

## Part 1 — The defect this corrects

P33 (the prior commit) introduced an optional `staff_involved_name` free-text field for Adjustment/Waste but **reused** the existing `responsibleStaffName`/`pinVerifiedAt` columns to store it:

```
responsibleStaffName: staffPin?.responsibleStaffName ?? body.staff_involved_name ?? undefined
```

This conflated two meanings the task explicitly requires kept distinct:

- `responsibleStaffName` + `pinVerifiedAt` — an **identity-verified** staff member, resolved server-side from a `StaffPinVerification` token. Historical, pre-P33 meaning, used by branch/staff PIN-gated submissions.
- `staff_involved_name` — an optional, **never-verified** free-text note a supervisor/admin may type on a direct Adjustment/Waste write or correction ("who physically reported/caused this").

Reusing the column meant a post-P33 unverified free-text name displayed identically to a pre-P33 PIN-verified identity wherever `responsibleStaffName` was read, and a correction could silently promote free text into the identity-attestation field.

## Part 2 — The fix

### Schema (additive, no backfill)

`apps/api/prisma/schema.prisma` — one new nullable column on each of the two models that carry this attribution, applied via `prisma migrate dev` against the verified-local `DIRECT_URL` (migration `20261012063140_pos_perf_p33r_staff_involved_name`):

```sql
ALTER TABLE "inventory_approval_requests" ADD COLUMN "staff_involved_name" TEXT;
ALTER TABLE "inventory_stock_movements" ADD COLUMN "staff_involved_name" TEXT;
```

Both tables already had a `responsible_staff_name`/`pin_verified_at` pair; this never alters or migrates those columns. Validated against the populated local dev database before and after:

| Table | Rows | `responsible_staff_name` set | `pin_verified_at` set | `staff_involved_name` set |
|---|---|---|---|---|
| `inventory_approval_requests` | 138 | 39 | 39 | 0 (new column, additive) |
| `inventory_stock_movements` | 127 | 14 | 14 | 0 (new column, additive) |

Both counts are identical before and after the migration (an `ADD COLUMN ... TEXT` nullable column cannot alter existing row data — confirmed, not merely assumed, by direct query). No historical PIN-verified row lost or gained its badge.

### Code — the new field plumbed as distinct, end to end

Threaded as a parallel, independent parameter alongside (never merged into) `responsibleStaffName`/`pinVerifiedAt` through:

- `universal-inventory.types.ts` / `.repository.ts` / `.service.ts` (`applyAdjustmentInTx`, `applyWasteInTx`, `adjustStock`, `wasteStock`, `toStockMovementResponse`) — Adjustment/Waste only, per the original P33 scope (Receiving never had this field).
- `universal-inventory.router.ts` — `staffInvolvedName: body.staff_involved_name` passed as its own key instead of `?? body.staff_involved_name` folded into `responsibleStaffName`.
- `inventory-approval.types.ts` (already correct from P33), `.repository.ts`, `.service.ts` (`submitAdjustment`, `submitWaste`, `correct`, `toResponse`, `applyApprovedRequest`) — same separation through the submit → correct → approve → movement pipeline. `correct()`'s inheritance rule: `responsibleStaffUserId`/`responsibleStaffName`/`pinVerifiedAt` only carry forward when no PIN-bound field changed (unchanged policy); `staffInvolvedName` is never PIN-bound, so it always takes the caller's fresh value when supplied and otherwise carries forward unconditionally.
- `packages/shared` response schemas (`inventory-approval.schema.ts`, `universal-inventory.schema.ts`) — added `staff_involved_name` to the response shape.
- Frontend: `inventory-approval-queue.tsx`, `inventory-approval-detail-dialog.tsx`, `inventory-adjustment-history.tsx` now render `staff_involved_name` as its own column/field, labeled **"Staff Involved (reported)"**, next to (never substituting for) the PIN-verified "Responsible Staff" identity display. Input labels in `inventory-adjust-form.tsx` / `inventory-waste-form.tsx` / the correction form renamed from "Staff Involved / Reported By" to "Staff Involved (reported)" for consistency.
- Recorded By (the authenticated submitting account) was already correct from P33 and is untouched by this fix.

### Disposable P33 test fixtures corrected

Backend integration test (`universal-inventory.http-concurrency.integration.test.ts`) previously asserted the overloaded behavior (`movement.responsibleStaffName === 'Juan Dela Cruz'` for a free-text submission). Corrected to assert the distinct fields: `movement.staffInvolvedName === 'Juan Dela Cruz'` and `movement.responsibleStaffName === null`. Frontend component test fixtures (adjustment history, approval queue, approval detail dialog) updated the same way — tests exercising the free-text field now set `staff_involved_name`, tests exercising PIN identity now set `responsible_staff_name`/`pin_verified_at`, and new assertions cover both appearing distinctly on the same row. No production or historical data was touched by any of this — only disposable local test fixtures and local dev-database rows created during this session's own verification runs.

## Part 3 — Legacy transfer endpoint consumer audit

`POST /api/branches/:branchId/inventory/transfer` (legacy `inventory.router.ts`) already unconditionally 410s as of P33. This task re-audited for any consumer beyond "no frontend caller":

- **Frontend**: `useTransferStock` (`apps/web/hooks/queries/use-inventory.ts`) still calls this route but is imported by zero components — grep-confirmed across `apps/web`. The live transfer UI (`inventory-transfer-form.tsx`, mounted at `/branch/inventory/transfer` and `/supervisor/inventory/transfer`) calls `useTransferInventoryStock` against the replacement endpoint instead; the shared URL path segment (`/inventory/transfer`) is a page route, unrelated to the retired API path.
- **Scripts**: no `scripts/` directory exists at the repo root; no reference anywhere under `apps/api/scripts/`.
- **Tests**: every match (`inventory.router.test.ts`, `write-gate.test.ts`, `inventory.integration.test.ts`, `branch-sidebar.test.tsx`) exercises or asserts the 410/retirement behavior itself — none is a live caller.
- **Docs**: `docs/architecture/api-contracts.md` was the one stale reference, still describing the route as live (`admin+sup`, writes a transfer). Corrected to document the retirement, the audit evidence above, and the live replacement (`POST /inventory-stock/transfer`). The adjacent `/inventory/count` row, also already retired, was corrected the same way since it was equally stale and directly adjacent.
- **Integrations / external consumers**: none found in this repository (no mobile app, no separate integration directory, no Postman/OpenAPI collection). This audit cannot see outside this codebase — stated as an explicit limitation, not claimed as a guarantee no external caller exists anywhere.
- **Conclusion**: retains `410` as-is. No new consumer found; branch/staff transfer writes remain denied either way (role-gated at `adminSupervisorOrBranch`, then the handler itself always 410s regardless of role).

## Part 4 — Real-browser verification (executed, not authored-only)

All of the following were driven against the actual running stack (real Chromium via Playwright, real Express API, real local Postgres, real local Supabase Storage) — not substituted with component tests:

1. **Branch sidebar** (`branch@potatocorner.test`) — confirmed zero links to Adjust/Waste/Transfer/Stock History under Overview.
2. **Direct branch inventory URLs** (`/branch/inventory`, `/adjust`, `/waste`, `/transfer`, `/stock-history`, `/count`, `/approvals`, `/stock-in`) — every one renders "Inventory is managed by your supervisor" instead of a form or 404.
3. **Branch direct API mutations** — `POST .../inventory-stock/:itemId/adjust` and `/waste` as a branch-role bearer token both return `403 INSUFFICIENT_PERMISSIONS` (`allowedRoles: ["super_admin","supervisor"]`). The legacy transfer endpoint returns `410 LEGACY_INVENTORY_MUTATION_RETIRED` for the same role.
4. **Order Deductions** — present on the branch Overview/dashboard, scoped and read-only (unchanged from P33, re-confirmed).
5. **Supervisor Stock Adjustment/Waste, no PIN** (`supervisor@potatocorner.test`) — uploaded a real proof photo to local Supabase Storage via `POST .../inventory-stock/evidence`, then submitted `adjust`/`waste` with **no** `verification_token` and a `staff_involved_name`. Both returned `201`. Verified on the response: `staff_involved_name` matches what was sent; `responsible_staff_name` is `null` (never populated from the free text); `pin_verified_at` is `null` (never falsely marked verified); `recorded_as_supervisor_direct` is `true`.
6. **Proof required** — the same adjust call with no `evidence_key` returns `422 VALIDATION_ERROR` ("A proof photo must be uploaded before this can be submitted").
7. **Proof viewable** — fetched the branch's movements list; the just-created movement's `proof_url` resolves to a real, fetchable `image/webp` (200).
8. **Existing branch-submitted pending request resolved by a permitted supervisor** — found a real PENDING request in the dev DB submitted by a branch account (`Liza Mendoza`) carrying a pre-existing PIN-verified identity (`Jenny Santos`, `pin_verified_at` set). Approved it as a different supervisor (`Marco Reyes`, self-approval correctly blocked by role difference). Confirmed after approval: `submitted_by_name`, `responsible_staff_name`, and `pin_verified_at` are byte-for-byte unchanged from before approval; `staff_involved_name` (null before) stays null — approval never fabricates attribution; `reviewed_by_name` is the approving supervisor, distinct from the original submitter.
9. **Cross-branch access denied** — `GET .../inventory-stock` against a branch the authenticated supervisor has no assignment to returns `403 BRANCH_ACCESS_DENIED`.
10. **POS PIN / normal checkout unaffected** — `/branch/terminal` for a branch account renders the staff-PIN keypad ("Terminal Locked — Enter your staff PIN to continue") exactly as before; this flow (`StaffPin`/attendance) is entirely separate from the inventory-PIN (`StaffPinVerification`) removed in P33, and nothing in this task touched it.

## Part 5 — Regression suites (executed)

- **Typecheck**: `turbo run type-check` — 4/4 packages (`shared`, `api`, `web`, `config`) clean, 0 errors.
- **Lint**: `turbo run lint` — 0 errors (296 pre-existing `no-console` warnings in `api`, 1 pre-existing `no-img-element` warning in `web`, both unrelated to this change and present before it).
- **Build**: `turbo run build` — all 4 packages built successfully, including `next build`'s full static-page generation (75/75 pages) and `tsc` for `api`/`shared`.
- **API tests**: full `vitest run` (single-fork, to avoid local-Postgres contention with the two dev servers also connected) — **2,772/2,773 tests passed** across 149/150 files. The one failure (a transaction timeout in `staff-pin.service.ts` setup code, unrelated to any file this task touched) was confirmed, by rerunning that file alone, to pass cleanly (4/4) — environmental contention under full-suite load, not a regression. The three files this task directly modified (`inventory-approval.integration.test.ts`, `universal-inventory.http-concurrency.integration.test.ts`, and the unit suites) each pass 100% in isolation.
- **Web tests**: full `vitest run` — first pass: 8 failures, all "Test timed out in 5000ms" scattered across files unrelated to this change (login redirect, dashboard table, item-conversion dialog) plus 2 in files this task touched; rerun after the production build finished (freeing CPU): **1,222/1,223 tests passed**, the single remaining failure (a different, also-unrelated file) confirmed passing in isolation (2.3s vs. the 5s timeout). Every test file this task modified or added assertions to (`inventory-adjustment-history.test.tsx`, `inventory-approval-queue.test.tsx`, `inventory-approval-detail-dialog.test.tsx`, `inventory-adjust-form.test.tsx`) passes 100% both in the full run and in isolation.

## Final role matrix (unchanged from P33, re-confirmed in Part 4)

| Action | Branch | Supervisor | Super Admin |
|---|---|---|---|
| View inventory (Order Deductions only) | ✅ read-only | ✅ | ✅ |
| Manual Receive/Adjust/Waste/Transfer/Count | ❌ 403 (direct API); UI shows managed-by-supervisor notice | ✅ no PIN, evidence required | ✅ no PIN, evidence required |
| Approval queue (list/detail/correct/proof) | ❌ 403 | ✅ | ✅ |
| Legacy `/inventory/transfer`, `/inventory/count` | ❌ 410 regardless of role | ❌ 410 regardless of role | ❌ 410 regardless of role |
| POS checkout / attendance PIN | ✅ unaffected | ✅ unaffected | ✅ unaffected |

PIN usage: retained exactly where it always was for POS attendance/checkout (`StaffPin`/`verify-pos`); fully removed from the supervisor/admin manual-inventory write path (`StaffPinVerification`), replaced by always-mandatory evidence + the authenticated actor as Recorded By. The new `staff_involved_name` field never substitutes for either.

## Write-gate coverage

No write-gate changes in this task — `write-gate.test.ts` already covers `POST /api/branches/:id/inventory/transfer` and `/count` in its retired-route assertions (confirmed still present and passing). No new mutating route was added.

## Deployment compatibility

- **Old frontend (pre-P33R) + new API**: the new `staff_involved_name` field is purely additive on every response; an old frontend ignores unknown keys exactly as the P32R compatibility pattern established — no new required field, no breaking response-shape change.
- **New frontend + old API (mid-rollout)**: `staff_involved_name` would simply be absent/`null`/`undefined` from an old API's response and renders as `—`, the same safe fallback already used everywhere else in these components for a missing optional field. Submitting `staff_involved_name` to an old API that doesn't read it is a no-op (ignored extra field) — no 400, no data loss beyond the attribution simply not being recorded until the API side deploys.
- **Migration**: purely additive (`ADD COLUMN ... TEXT`, nullable, no default-value backfill, no data transformation). Safe to run ahead of, during, or after the code deploy in either order. Rollback is a plain `DROP COLUMN` with zero data-loss risk to any other column.

## Historical overloaded-data handling

No backfill, reinterpretation, or guess was applied to any pre-existing `responsible_staff_name`/`pin_verified_at` row (branch or PIN-verified historical identity data was not touched — confirmed by the before/after row counts in Part 2). The only rows that briefly held the P33 overloaded-column behavior were disposable local test fixtures and this session's own local dev-database writes, corrected directly; no production data of this shape exists to reconcile.

## Release / rollback

- **Release**: ship the Prisma migration and this commit together, in either order relative to the API/web deploy (see Deployment compatibility above) — no coordinated-timing requirement.
- **Rollback**: revert this commit; the two new nullable columns can remain in place indefinitely (unused by older code, harmless) or be dropped with a follow-up `DROP COLUMN` migration — never required for a safe rollback.
