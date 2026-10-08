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

## Migration validation performed for this task (P28)

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

---

## POS-PERF-P28R2 — Permanent Cancellation and Kill-Switch Reconciliation

## Why this addendum exists

The rollback procedure above (Scenario A) told operators to resolve every
outstanding `PENDING` request via `returnForCorrection` before flipping
`MANUAL_INVENTORY_APPROVAL_REQUIRED` off. That advice had a real gap:
**`RETURNED` is not a terminal state.** Any `RETURNED` request can still be
corrected (`POST /:id/correct`) into a brand-new `PENDING` revision, by
design — that is exactly how the normal "fix a mistake and resubmit" flow
works. During a rollback, that same door stays open: a `RETURNED` request
"resolved" during reconciliation could still be corrected and later
approved, applying a physical event the operator believed was closed out.

P28R2 adds a genuine terminal state — `CANCELLED` — and closes that gap.
Everything below is additive to the P28 behavior above; nothing in the
rollout/rollback sequencing already documented changes.

## New status: `CANCELLED`

- Reachable only from `PENDING` or `RETURNED`. **Never** from `APPROVED` —
  an approved request's stock mutation already committed in the same
  transaction as the status flip, and cancellation never unwinds it.
- Terminal: once `CANCELLED`, the row can never be approved (`approve()`
  requires `PENDING`) or corrected (`correct()` requires `RETURNED`) again.
- Requires an authorized reviewer (`adminOrSupervisor` — same role gate as
  approve/return; a branch account cannot cancel, including its own
  request) with branch access and a non-empty reason.
- Never changes stock. Preserves every prior submission/revision/reason/
  actor/timestamp in the row and its revision chain — nothing is deleted or
  overwritten.
- Idempotent: cancelling an already-`CANCELLED` row is a safe no-op (same
  convention as repeatedly polling a finished job), not an error.
- Enforced atomically against a concurrent `approve()`/`correct()` on the
  same row:
  - Cancel vs. approve/return: both are now simple `UPDATE ... WHERE id = ?
    AND status IN (...)` statements against the *same row* — Postgres
    serializes two concurrent UPDATEs to one row for free, so whichever
    commits first wins and the loser's `WHERE` no longer matches on its
    retry. No new locking needed for this pair.
  - Cancel vs. correct: `correct()` instead *inserts a new sibling row*, so
    the row's own status alone can't catch the race. Both `cancel()` and
    `correct()` now take the same advisory lock
    (`inventoryApprovalRowLockId`, `apps/api/src/lib/pg-lock.ts`) on the
    specific row id, and both re-read that row's live status *inside* the
    lock before acting — the loser sees the winner's already-committed
    decision and aborts. This closes the one gap the P28R advisory lock
    didn't cover (see `inventory-approval.service.ts`'s `correct()` for
    the comment describing this exact race).

Verified by seven dedicated real-Postgres integration tests (see
`inventory-approval.integration.test.ts`): cancelled-cannot-approve/correct,
older-sibling-cannot-revive-after-the-newer-revision-is-cancelled, cancel-
vs-approve race (exactly one winner, stock changes 0 or 1 times, never
ambiguous), cancel-vs-correct race (no state where both a `CANCELLED` row
and a live sibling `PENDING` revision exist at once), repeated cancellation
is a no-op, an `APPROVED` row can never be cancelled, and disable/re-enable
of the kill switch cannot revive a cancelled request.

## Kill-switch safety: `approve`/`correct` now blocked while disabled

Before this change, `MANUAL_INVENTORY_APPROVAL_REQUIRED=false` only
affected *new* submissions (the six gated write endpoints fell back to
immediate-write). It said nothing about requests already sitting in the
queue — `approve()`/`correct()` had no awareness of the flag at all, so a
request submitted before the flip could still be approved or corrected
after the flag was disabled, silently reopening the exact double-apply risk
the flag flip exists to prevent.

`approve()` and `correct()` now reject with `409
APPROVAL_PROCESSING_DISABLED` whenever the flag is off. `cancel()` and
`returnForCorrection()` are **not** gated — they remain the only two
actions available during a reconciliation window, which is by design: you
need a way to drain the queue precisely while the flag is off.

### Updated reconciliation procedure (replaces the "resolve every PENDING request" step in both rollback scenarios above)

Wherever the rollback sections above say *"resolve every `PENDING` request
via `returnForCorrection`"*, the corrected procedure is:

1. For every `PENDING` or `RETURNED` request at the branch(es) affected:
   call `POST /api/inventory-approvals/:id/cancel` with a Super
   Admin/supervisor-authored reason (e.g. *"Manual approval gate disabled —
   resubmit directly, superseding request cancelled 2026-MM-DD"*), **not**
   `returnForCorrection`. `returnForCorrection` alone leaves the request
   correctable — exactly the gap P28R2 closes — so it is no longer the
   terminal step of a rollback.
2. Confirm no actionable request remains: `GET
   /api/inventory-approvals?status=PENDING` and `?status=RETURNED` for the
   affected branch(es) must both return an empty list before proceeding.
   `returnForCorrection` calls already in flight from legitimate day-to-day
   reviewing (unrelated to this rollback) should be let through normally;
   only requests that are being *retired* as part of this procedure get
   cancelled.
3. Only after step 2 is empty, flip `MANUAL_INVENTORY_APPROVAL_REQUIRED=false`
   (or redeploy the prior commit, per Scenario B). From this point,
   `approve()`/`correct()` reject outright for anyone who tries — a defense
   against a request that was missed in step 1, not a replacement for doing
   step 1 correctly.
4. Resubmission of the same physical event happens through the now-
   immediate-write endpoints as before. Because the retired request is
   `CANCELLED` (terminal), it can never be approved later and double-apply
   against the resubmission — this is what the old `RETURNED`-only
   procedure could not guarantee.
5. Before re-enabling the flag (`MANUAL_INVENTORY_APPROVAL_REQUIRED=true`),
   verify the *running process* actually has the flag you expect — an
   environment-variable change takes effect only on the next process start
   for this config (loaded once at boot via `config/index.ts`), not via
   `PUT /api/settings/write-gate` or any other live toggle. Confirm via
   `GET /api/health` (or restart logs / an explicit config-echo endpoint if
   one is added later) that the deployed process reflects the value you
   just set, not the value from before the restart.

### What this procedure does **not** claim

- **An environment-variable flip alone never reconciles anything.** Flag
  state only decides which code path *new* submissions take; it has no
  effect on rows already in the table. Reconciliation is the explicit
  cancel-everything-outstanding step above, performed by a human with
  branch access and a reason — never a side effect of the flag.
- **This release does not provide exactly-once guarantees across
  independent manual resubmissions.** If a branch resubmits the same
  physical stock-in/adjustment twice through the immediate-write path
  during a rollback window (e.g. once by mistake, once as the "real"
  resubmission), nothing in this system — before or after P28R2 —
  deduplicates those two independent submissions against each other. There
  is no stable operation identity (idempotency key) carried from the
  original approval request into the immediate-write resubmission; "cancel
  the old request" only prevents the *old* request from ever applying a
  second time, it does not and cannot detect that a human resubmitted the
  same thing twice by hand. If that guarantee is needed, it requires a
  separate idempotency-key design (e.g. requiring the resubmission to
  reference the cancelled request's id, and rejecting a second
  resubmission against the same reference) — out of scope for this task.

## Migration validation performed for this task (P28R2)

Additive-only migration `20261009050000_add_inventory_approval_cancellation`
(one new enum value `CANCELLED` on `InventoryApprovalStatus`, three new
nullable columns — `cancelled_by_user_id`, `cancelled_at`, `cancel_reason`
— on `inventory_approval_requests`) was validated two ways:

1. `prisma migrate deploy` against a disposable embedded-Postgres instance
   (`apps/api/scripts/with-test-postgres.ts`) with the full 78-migration
   history applied from scratch, including the pre-existing P28 migration —
   reported "All migrations have been successfully applied," no errors.
2. The full `apps/api` Vitest suite (154 test files, 2,820 tests, including
   19 real-Postgres integration tests for this module covering every
   cancellation/race scenario above) ran green against that same migrated
   instance. The full `apps/web` Vitest suite (133 files, 1,170 tests) and
   both `apps/api`/`apps/web` production builds also passed.

No existing column is altered or dropped; `ALTER TYPE ... ADD VALUE` and
`ADD COLUMN` (nullable, no default backfill needed) are the only two
statement kinds in the migration. On a code rollback, this migration is
**never** reverted — the same "no destructive down-migration" rule as
every other release in this directory. A `CANCELLED` row and its
`cancelled_*` columns are inert to any pre-P28R2 code path, which only ever
reads the three original statuses.

## Rollback of P28R2 itself (code rollback, keep the schema)

If P28R2's *code* needs to roll back independently of P28 (e.g. a bug in
`cancel()` itself), the same discipline applies: redeploy the prior commit,
do **not** drop the `CANCELLED` enum value or the three new columns. Prior
(P28-only) code never reads or writes them, so their presence is inert. Any
request already `CANCELLED` stays `CANCELLED` in the data — the rolled-back
code simply has no route that can reach it (no `/cancel` endpoint), which is
the correct outcome (a terminal state should stay terminal even if the
feature that introduced it is rolled back).

## Known limitations (stated plainly, not implied)

- The original P28R test-suite regression mentioned in prior commits
  (`fix(pos-perf-p28r): close write-gate and correction-race gaps, fix test
  regressions`) does not have a recorded root cause available to this
  task — that information was not captured at the time and cannot be
  reconstructed now. The current test suite passing green is evidence the
  present code is correct; it is not evidence of what the original failure
  was, and this document does not claim otherwise.
- No browser/Playwright click-through exists for the inventory-approvals
  UI specifically (no e2e spec covers this feature). Verification for this
  task was performed at three levels instead: real-Postgres service-layer
  integration tests (19 scenarios), a dedicated HTTP-level script driving
  the actual Express routes with real signed JWTs against a disposable
  Postgres instance (proving router/role-middleware/validation wiring, not
  just the service functions), and the full automated unit/integration/
  frontend suites. A true interactive browser session was not performed.
