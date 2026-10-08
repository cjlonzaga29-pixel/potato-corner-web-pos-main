# POS-PERF-P28 — Inventory Approval Gate: Rollout and Rollback

## Why this doc exists

P28 adds one additive migration (`20261008114838_add_inventory_approval_requests`)
and changes the *behavior* of six existing write endpoints (legacy
`/ingredients/:id/stock-in`, `/ingredients/:id/adjust`,
`/:branchId/inventory/count`; universal
`/:branchId/inventory-stock/:itemId/receive`, `/:branchId/inventory-stock/:itemId/adjust`,
`/:branchId/inventory-stock/count`) from "write immediately" to "create a
Pending Review row". Vercel (frontend) and Render (API) deploy on the same
push but **independently and on their own schedules** — there is no atomic
joint cutover. That means there is a real window where one of three
mismatched states can be live simultaneously:

1. **New frontend + old API** — the new Approvals queue UI calls
   `GET/POST /api/inventory-approvals/*`, which doesn't exist yet on the old
   API. Every approvals-queue request 404s; the Stock In/Adjust/Count forms'
   `Submit for Review` button also 404s (they call the same new endpoints).
2. **Old frontend + new API** — the old Stock In/Adjust/Count forms call the
   *old* immediate-write endpoints. Those endpoints still exist (the gate is
   `config.manualInventoryApprovalRequired`, defaulted on, not a removed
   route) but now return a `201` with an approval-request body shaped
   differently from the movement body the old frontend code expects to
   render on the "success" screen — the write still goes through the gate
   safely, but the old UI's immediate-redirect-to-movement-detail flow breaks
   cosmetically.
3. **New frontend/API, mid-migration** — the new API code queries
   `inventory_approval_requests`, which doesn't exist until the migration
   runs. Every approval submit/list/approve call 500s until the migration
   lands.

None of these corrupt data — the underlying `InventoryStock`/`Ingredient`
write path is unchanged by the migration itself, and the approval gate's
conditional-update exactly-once logic doesn't depend on which frontend
version is talking to it. But (1) and (3) are a real availability gap for
Stock In / Adjustment / Physical Count specifically during the deploy
window, so this release uses the existing POS-PERF-P16 operational write
gate to collapse that window to zero rather than accept it.

## Correction to the write gate's scope (fixed as part of this verification)

`write-gate.ts`'s `GATED_PATH_PATTERNS` did **not** include
`/api/inventory-approvals` before this task — `/^\/api\/inventory(\/|$)/`
does not match `/api/inventory-approvals` (no `/` or end-of-string
immediately after `inventory`). That meant closing the gate paused the six
endpoints above but left `POST /api/inventory-approvals/receiving`,
`/adjustment`, `/:id/approve`, `/:id/return`, and `/:id/correct` completely
unpaused — exactly the endpoints this rollout most needs paused during the
migration window, since they are the ones that don't exist pre-migration at
all. Fixed in this task (`write-gate.ts` + a new `write-gate.test.ts` case
for both a submit and an approve path) — the gate's pattern list now also
matches `/api/inventory-approvals(/|$)`. **This must ship before or in the
same release as the P28 rollout below**, or the drain step is incomplete.

## Pre-flight

1. `git status` clean, confirm the intended commit range and that nobody
   else is mid-push (same discipline every prior release in this directory
   requires).
2. Disable Render `autoDeploy` for this push — same reason as every prior
   migration-carrying release here: prevent Render's independent trigger
   from running inventory-approval-aware API code against the
   pre-migration schema before CI's `prisma migrate deploy` step runs.
3. Confirm `MANUAL_INVENTORY_APPROVAL_REQUIRED` is unset (defaults to
   enabled) or explicitly `true` in the target environment — this is the
   kill switch this whole release relies on if an emergency rollback to
   immediate-write behavior is needed later (see "Rollback" below).

## Rollout sequence

1. **`PUT /api/settings/write-gate` `{ "enabled": true, "reason": "POS-PERF-P28 rollout — inventory approval gate cutover" }`**
   against the live (pre-P28) API.
2. Confirm the pause took effect: `POST /api/branches/:id/inventory-stock/:itemId/adjust`
   (an endpoint that already exists pre-P28) now returns
   `503 SERVICE_WRITE_GATE_CLOSED`.
3. Poll `GET /api/settings/write-gate` until `activeGatedRequests` reaches
   `0` on the live instance (same drain discipline as POS-PERF-P16 — do not
   proceed on a fixed sleep).
4. Push to `main`. CI runs, then `prisma migrate deploy` runs the additive
   `20261008114838_add_inventory_approval_requests` migration against
   production, then the deploy-hook step deploys the API. Vercel deploys
   `apps/web` independently on the same push, as always.
5. Watch both deploys explicitly to completion — do not trust a blind
   sleep:
   - Render: poll deploy status until `live`.
   - Vercel: poll until the new deployment is `READY` and promoted to
     production.
6. **Verify exact live SHAs before reopening** — this is the step a
   single push does not guarantee by itself, since the two platforms deploy
   on their own schedules:
   - `curl <render-api-url>/api/health` (or equivalent build-info surface)
     and confirm the API is serving the commit just pushed, not a prior
     one still mid-swap.
   - Fetch the deployed `apps/web` page and confirm its build id / a
     known-new string (e.g. the `/branch/inventory/approvals` route
     resolving instead of 404ing) to confirm Vercel has actually promoted
     the new build, not just started building it.
   - If either platform is still deploying the *previous* commit at this
     point, **do not reopen the gate yet** — reopening early re-admits
     traffic into state (2) or (3) above. Wait and re-check.
7. Smoke-check with the gate still closed (bypass via
   `X-Maintenance-Bypass` + Super Admin token): submit a Stock In via
   `POST /api/inventory-approvals/receiving`, confirm it returns `201`
   with `status: "PENDING"` and that `InventoryStock.quantityOnHand` is
   unchanged; approve it via `POST /api/inventory-approvals/:id/approve`
   and confirm the stock updates exactly once.
8. **`PUT /api/settings/write-gate` `{ "enabled": false }`.** Traffic
   resumes, 100% on the new frontend and new API — no window existed where
   an old/new frontend or old/new API version combination both saw live
   traffic.
9. Re-enable Render `autoDeploy` afterward if desired.

## Rollback

### Scenario A — revert to immediate-write behavior without rolling back code

Flip `MANUAL_INVENTORY_APPROVAL_REQUIRED=false` and restart the API. Every
one of the six gated endpoints reverts to writing `InventoryStock`/
`Ingredient` immediately, exactly as it did before P28 — this is the
single-env kill switch the commit was built around specifically so this
doesn't require a redeploy.

**What happens to existing PENDING/RETURNED requests when this flips:**

- They are **not** deleted, resolved, or auto-applied. `inventory_approval_requests`
  is untouched by the flag — it only changes which code path new submissions
  take.
- A `PENDING` request created before the flip has no further code path that
  ever reaches it again: the frontend's Approvals queue still lists it (the
  `GET` endpoints are not gated by this flag), but the kill-switch flip does
  not grant staff a new way to act on it through the immediate-write UI —
  the old Stock In/Adjust/Count forms create brand-new movements, they do
  not search for and resolve a pending request first.
- **This creates exactly the double-apply risk the task calls out**: if a
  branch resubmits the same physical stock-in/adjustment through the
  now-immediate-write form after the flip, and *later* someone approves the
  original still-`PENDING` request from before the flip, the same physical
  event gets applied to `InventoryStock` twice — once via the immediate
  write, once via the late approval.
- **Required operational step, not optional**: before (or immediately
  after) flipping the switch, a Super Admin must resolve every `PENDING`
  request that exists at that moment via `returnForCorrection` with a
  reason noting the rollback (e.g. "Manual approval gate disabled —
  resubmit directly"), **not** by deleting the rows (the model's audit
  trail is immutable-by-convention like every other inventory ledger in
  this codebase; a direct `deleteMany` on `InventoryApprovalRequest` is not
  blocked by `prisma-immutability.ts` the way `InventoryMovement`/
  `InventoryStockMovement` are, but doing so anyway would destroy the only
  record that a request was ever submitted). Returning instead of silently
  abandoning:
  - Preserves the audit trail (who submitted, when, what reason) under the
    `RETURNED` status instead of leaving it ambiguously `PENDING` forever.
  - Makes the "needs resubmission" state visible to the submitting branch
    in the Returned for Correction tab, which already exists and needs no
    new UI.
  - Leaves `RETURNED` rows exactly where approving them is already
    impossible (`markApprovedIfPending`'s conditional UPDATE only matches
    `status = 'PENDING'`), closing the double-apply window by construction
    rather than by operator discipline alone.
- A request already `APPROVED` before the flip is inert either way — its
  stock mutation already committed in the same transaction as the status
  flip; the kill switch does not touch historical rows.

### Scenario B — full code rollback (revert the P28 deploy)

Same drain-then-swap discipline as every prior migration-carrying release
here, with the kill-switch step above folded in first:

1. `PUT /api/settings/write-gate {enabled:true, reason:"P28 rollback"}`,
   drain `activeGatedRequests` to `0` (same procedure as rollout step 3).
2. Resolve every still-`PENDING` request as described in Scenario A above
   — do this **before** redeploying old code, while the current (P28) API
   can still run `returnForCorrection` against them. Old code has no
   concept of this table at all, so this is the last point an operator can
   cleanly resolve them without touching the database directly.
3. Redeploy the prior (pre-P28) commit through the normal CI path.
4. **Do not run a down-migration that drops `inventory_approval_requests`.**
   The migration is additive only (new table, new enums, two new nullable
   columns are not touched on any existing table) — leaving it in place
   costs nothing and preserves every resolved request's audit trail. Prior
   code never queries this table, so its continued existence is inert to
   the rolled-back version.
5. Verify the rolled-back API's live SHA matches the intended prior commit
   (same verification discipline as rollout step 6) before reopening.
6. `PUT /api/settings/write-gate {enabled:false}`.

## Migration validation performed for this task

`prisma migrate deploy` was run against a disposable local Postgres
instance already populated with pre-existing data (39 `inventory_stock_movements`
rows, 2 legacy `inventory_movements` rows, non-empty `branches`/
`inventory_items`/`ingredients` tables) — `prisma migrate status` reported
"Database schema is up to date!" with no errors, and every pre-existing row
in every table was confirmed intact afterward (row counts unchanged except
for the new, empty `inventory_approval_requests` table). The migration adds
two new enums, one new table, and does not alter any existing table's
columns — there is no plausible path by which it could have affected
existing rows, and this was verified rather than assumed.
