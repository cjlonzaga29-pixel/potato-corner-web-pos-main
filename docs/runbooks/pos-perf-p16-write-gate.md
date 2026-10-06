# POS-PERF-P16 — Operational Write Gate for Safe Free-Plan Rollouts

## Decision this runbook implements

The service stays on Render's **free** Web Service plan. No billing upgrade.
Per `pos-perf-p15-fast-checkout.md`'s POS-PERF-P15R6 section, Render's
Maintenance Mode (the only verified traffic-pause lever) is paid-plan-only,
and no Render-platform suspend/resume behavior on the free tier has ever
been verified safe. Rather than wait on either, this release builds the
pause lever **inside the application**: a database-backed write gate that
every instance (old and new, during a deploy-swap overlap window) checks
independently, requires no Render feature, and costs nothing on the free
tier.

### Why this mechanism, not something else — evidence checked first

Before building anything, the following were checked and rejected as
*simpler* alternatives, per this task's "if a simpler verified free-plan
mechanism exists, explain it before choosing it" instruction:

- **Render Maintenance Mode** — confirmed paid-plan-only
  (`render.com`'s own changelog: "available for any **paid** web service"),
  already verified against this exact service in POS-PERF-P15R6. Rejected:
  not available on the current plan, and the owner decision is to stay on
  free.
- **Render suspend/resume** (`POST /v1/services/{id}/suspend`) — no official
  Render documentation describes whether a manually suspended free Web
  Service keeps its process (and in-process worker) running, still serves
  traffic, or still fires its deploy hook. POS-PERF-P15R6 already flagged
  this as an unverified gap and declined to depend on it; this task's
  instructions explicitly say "do not assume Render suspension behavior."
  Rejected: unverified, and verifying it would mean suspending the live
  service, which is outside this task's authorization.
- **A reverse-proxy / CDN-level pause** (e.g. a Cloudflare Worker or a
  separate always-on gate process) — would need a new piece of
  infrastructure in front of Render, itself a new free-tier dependency with
  its own availability and cost questions, for a problem the application
  already has every tool needed to solve (it already owns its own request
  pipeline and already has a shared Postgres database every instance reads
  from). Rejected as unnecessary complexity relative to the schema-free
  option below.
- **An in-memory flag toggled via a one-off admin route** — rejected
  explicitly by this task's own requirement ("gate state must apply
  consistently to old/new instances during overlap"): two OS processes
  (the outgoing and incoming instance during a Render swap) do not share
  memory, so an in-memory flag set on one is invisible to the other for the
  entire overlap window — exactly the window this gate exists to close.
- **A new dedicated table/migration for the gate's own state** — rejected
  as unnecessary: `system_settings` (migration
  `20260723140609_add_system_settings`, already live in production since
  before P13) is a generic key/value store this codebase already uses for
  exactly this shape of problem (`security_policy`, `discount_policy`,
  `work_hours_policy` all live there, see `settings.service.ts`). Reusing
  it means **this entire feature ships with zero new migrations** — see
  "What changed" below.

**Conclusion: a Postgres-backed flag in the already-existing
`system_settings` table, read by a single Express middleware mounted ahead
of every router, with no migration and no new infrastructure — the
database is the one thing every current and future instance already
shares, free tier or not.**

## What changed

- **No schema change.** The gate's state is one row in the existing
  `system_settings` table: `key = 'operational_write_gate'`,
  `value = { enabled: boolean, reason: string | null }`. No migration
  exists or is needed for this feature — the table, and the
  find/upsert-by-key repository method, already existed.
- **`apps/api/src/middleware/write-gate.ts`** (new). Mounted in `app.ts`
  immediately after the CSRF guard, ahead of every API router. On every
  request:
  1. `GET`/`HEAD`/`OPTIONS`, or a path this gate does not own → pass
     through immediately, **no database read at all**. Dashboards, reports,
     and every other read-only screen keep working during a maintenance
     window.
  2. Otherwise, the gate's current state is read **fresh from Postgres on
     every request — no in-process caching**. This is what makes the gate
     consistent across the old and new instance during a Render deploy-swap
     overlap: both processes query the same row, so there is no window
     where one instance's cached view disagrees with the other's.
  3. If open (`enabled: false`, or no row at all — the default, matching
     every pre-P16 deployment's actual behavior) → pass through.
  4. If closed → **503** with
     `{ error: { code: 'SERVICE_WRITE_GATE_CLOSED', message: 'Temporarily unavailable for maintenance. Please try again shortly.', details: { reason } } }`
     and a `Retry-After: 30` header — a clear, uniform
     temporary-unavailable response, not a 500 or a silent hang.
  5. **Exception — narrowly authorized maintenance/recovery bypass**: a
     request carrying both a valid Super-Admin access token and a
     non-empty `X-Maintenance-Bypass` header (any justification string) is
     let through instead, and the bypass is written to the tamper-evident
     audit log (`MAINTENANCE_GATE_BYPASS`, actor, path, method, reason).
     An ordinary cashier/branch/supervisor client — the real POS app, every
     normal screen — never sends this header, so ordinary checkout and
     inventory traffic is blocked outright while gated. This is what lets
     an admin deliberately run `POST /api/transactions/:id/void`,
     `POST /api/transactions/:id/retry-inventory-deduction`, or any other
     documented recovery action *during* a maintenance window, which
     Render's own Maintenance Mode could never do (POS-PERF-P15R6's
     rollback section had to fall back to a raw SQL connection for exactly
     this reason — this gate does not have that gap).
- **Scope** — every known checkout/inventory-mutating HTTP surface, by path
  pattern (see `write-gate.ts`'s `GATED_PATH_PATTERNS` for the exact regex
  list, and its own test file for the enumerated route list this was built
  against): `/api/transactions/*` (checkout, sync-offline, hold-release,
  void, refund, receipt-printed, and — on the P15 branch — abandon /
  retry-inventory-deduction, both nested under this same prefix so they are
  covered with no extra pattern), `/api/inventory/*`,
  `/api/product-inventory/*`, `/api/universal-inventory/*`,
  `/api/product-components/*`, and the two branch-nested inventory surfaces
  `/api/branches/:branchId/inventory/*` and
  `/api/branches/:branchId/inventory-stock/*`. Every other module
  (employees, branches core, auth, settings, reports, audit, notifications,
  …) is untouched — an admin can still manage staff, read reports, and
  review audit logs during a maintenance window.
- **`GET`/`PUT /api/settings/write-gate`** (new, `adminOnly` on both verbs —
  narrower than most settings endpoints, since this lever blocks every
  branch's checkout at once). `PUT` requires `reason` when closing
  (`enabled: true`); reopening (`enabled: false`) needs no reason. Every
  change is audit-logged (`WRITE_GATE_ENABLED` / `WRITE_GATE_DISABLED`).
  **No unauthenticated or public route can reach either verb** — both sit
  behind the same `authenticate` + `adminOnly` + `requirePasswordChange`
  stack every other admin-only settings route uses.
- **Verified-drain signal**: `write-gate.ts` also tracks, **per process**,
  how many requests are currently inside a gated route
  (`getActiveGatedRequestCount`), counting both allowed-through and
  about-to-be-rejected requests, decremented exactly once per request via a
  guarded `res.once('finish'/'close', …)` pair. `GET /api/settings/write-gate`
  returns this count as `activeGatedRequests`. This is the concrete answer
  to "closing the gate alone does not drain already-running requests" —
  see "Drain procedure" below for how it's used.

## Why this needed its own isolated branch from P13, not a change on top of P15

The live production API is still on P13
(`ec0e0976c02979f48aa3e48438b0df8099108239`, verified directly against
Render's deploy history in POS-PERF-P15R6) — **base P15's
`quantityReserved` stock-reservation feature has never shipped.** That
means two genuinely different releases need this gate:

1. **The prerequisite patch** (this section) — the gate alone, built on top
   of exactly what's live today (P13), with none of P15's reservations,
   worker, or migrations. This can ship on its own, safely, before anything
   else changes, and gives production its first-ever traffic-pause lever.
2. **The gated P15 rollout** (next section) — the full P15 stack
   (`quantityReserved`, the background deduction worker, checkout-attempt
   fencing through R6) shipped *using* the gate the prerequisite patch just
   added, closing the exact "old code oversells while new code reserves"
   hazard POS-PERF-P15R6 already describes in detail.

Building the gate as a diff against `main` (which already carries all nine
unpushed P15 commits) would have produced a patch that could not be
reviewed or deployed independently of that whole stack. Instead:

- **`pos-perf-p16-write-gate-prereq`** — a new branch rooted at `ec0e097`
  (P13), in its own git worktree, containing *only* the gate commit(s).
  `main`'s own commit history (the nine unpushed P15 commits, `30e8e3d` at
  tip) is untouched — this branch is additive, not a replacement.
- **`pos-perf-p16-write-gate`** — a second branch rooted at `main`
  (`30e8e3d`, carrying every P15 commit), with the *same* gate patch
  applied on top (same files, `git apply`'d cleanly — `app.ts`,
  `middleware/authorize.ts`, `middleware/authenticate.ts`, and the entire
  `settings` module are byte-identical between P13 and `main`, confirmed via
  `git diff ec0e097 HEAD`), plus two additional test cases for the two
  P15-only recovery routes nested under `/api/transactions`.

## Exact branches / commits

See the report code block at the end of this task's response for the
literal branch names and full SHAs — this section intentionally does not
duplicate them so there is exactly one place that can go stale.

## Drain procedure — verified, not assumed

Closing the gate (`PUT /write-gate {enabled:true, reason}`) stops **new**
gated requests from reaching their handler. It does nothing for requests
already past that check and currently running their handler — this task's
own instructions call this out explicitly, and POS-PERF-P15R6's "Rollback"
section hit exactly this problem with Render's Maintenance Mode (no
in-flight-request visibility at all, just a black box).

**Before assuming it is safe to stop/swap/deploy over the current
instance:**

1. `PUT /api/settings/write-gate` with `{ "enabled": true, "reason": "<why>" }`
   (Super Admin token required).
2. Poll `GET /api/settings/write-gate` and watch `activeGatedRequests` on
   **that same still-running instance** (this count is per-process, by
   design — see "What changed" above for why a shared/cluster-wide counter
   would not actually prove the *old* instance is idle). On this free-tier,
   single-instance service, that is simply the one instance currently
   serving traffic.
3. Wait for `activeGatedRequests` to reach `0`. Every checkout/inventory
   write handler in this codebase is a single bounded Postgres transaction
   (no long-poll, no SSE, no WebSocket upgrade on these routes) — this
   should take low single-digit seconds in practice, not minutes. Do not
   proceed on a fixed sleep instead of this check; the whole point is that
   "probably done by now" is exactly the assumption POS-PERF-P15R5/R6 were
   written to stop making elsewhere in this codebase.
4. Only once `activeGatedRequests` is confirmed `0` does "no request is
   still running old-version business logic against the database" hold.
   HTTP in-flight drain and the P15 background-job drain (next section) are
   two different things — both matter, for different reasons.

This was exercised directly in `write-gate.test.ts`
(`writeGate — in-flight request counter` describe block): the counter
increments before the open/closed decision and decrements exactly once
per request via a guarded finish/close pair, verified to not double-decrement
and to never count requests outside the gate's own scope.

## Inventory-worker drain compatibility (P15 branch only)

The gate is HTTP-layer only — `middleware/write-gate.ts` is mounted in
`app.ts`'s Express pipeline and is never imported by
`inventory-deduction.worker.ts`, which talks to Postgres directly in-process
and has no HTTP entry point at all. **Closing the gate does not pause the
worker** — this is intentional and is exactly the property POS-PERF-P15's
own rollback procedure (`pos-perf-p15-fast-checkout.md` → "Rollback", steps
1–3) already depends on: close the gate to stop new reservations, then let
the still-running worker keep draining `pending`/`processing` jobs and
require a manual requeue for `failed` ones, then positively reconcile
`quantity_reserved` back to zero, **before** swapping application code back
to a version that doesn't understand reservations at all. Nothing in this
gate changes that procedure — it replaces Maintenance Mode as the "stop new
writes" half of step 1, and additionally gives step 2's manual recovery
actions (`retry-inventory-deduction`, `void`) a real bypass instead of the
raw-SQL-connection workaround that runbook's step 2 previously had to use.

## Release sequence

### Phase 1 — ship the prerequisite patch alone

This is the **first thing** to go to production, independent of and before
any P15 code. It is backward-compatible by construction: the gate defaults
open, no existing route's behavior changes unless someone explicitly closes
it, and no migration runs.

1. Merge `pos-perf-p16-write-gate-prereq` to `main` (or open it as the next
   PR — it is currently its own branch, rooted at P13, not yet merged
   anywhere; this task did not merge or push it).
2. Push to `main`. Per `.github/workflows/deploy-production.yml` (confirmed
   in POS-PERF-P15R6): CI runs, then `prisma migrate deploy` runs against
   production — **this step does nothing new**, since this patch adds no
   migration — then the workflow's own `curl … RENDER_DEPLOY_HOOK_PRODUCTION`
   deploys the API. Vercel deploys `apps/web` independently on the same
   push, as always; this patch touches no frontend code, so that deploy is
   a no-op from the frontend's perspective.
3. **Render `autoDeploy` note**: unlike the P15R6 release (which required
   disabling `autoDeploy` to prevent new code outrunning its own
   migration), this patch needs no such step — there is no migration for
   Render's independent auto-deploy to outrun. Normal `autoDeploy: yes`
   behavior is safe for this specific push.
4. Smoke-check: `GET /api/settings/write-gate` with a Super Admin token
   returns `{ enabled: false, reason: null, activeGatedRequests: 0 }` (or
   close to 0) against the live service — confirms the row genuinely
   defaults open and the endpoint is live, without ever actually closing
   live traffic.
5. **Do not close the gate yet.** This phase only proves the lever exists
   and defaults to a no-op. The first time it is actually *used* to pause
   traffic is Phase 2 below, for the first real P15 rollout.

### Phase 2 — the gated P15 rollout (quantityReserved, worker, full stack)

Everything in `pos-perf-p15-fast-checkout.md`'s POS-PERF-P15R6 "Executable
release sequence" still applies (CI → migration → deploy-hook ordering,
disabling `autoDeploy` first so Render's independent trigger cannot run new
code against the pre-migration schema, watching both Render and Vercel
deploys explicitly rather than trusting the workflow's blind `sleep 45`).
**Replace that section's Branch A/Branch B split** (which required either a
billing decision or staying blocked) **with the sequence below** — the gate
from Phase 1 is now live in production, so there is a verified free-plan
traffic-pause lever and neither branch's blocker applies anymore:

1. Pre-flight: `git status` clean, confirm the intended commit range,
   confirm nobody else is mid-push (same pre-flight POS-PERF-P15R6 already
   required).
2. Disable Render `autoDeploy` for this push (same reason/same command as
   POS-PERF-P15R6: prevent Render's independent trigger from running the
   new reservation-aware code against the pre-migration schema).
3. **`PUT /api/settings/write-gate` `{ "enabled": true, "reason": "POS-PERF-P15 rollout — quantityReserved cutover" }`** against the live
   (still-P13) API.
4. Confirm the pause took effect from a browser/curl: `POST /api/transactions`
   now returns `503 SERVICE_WRITE_GATE_CLOSED`.
5. Poll `GET /api/settings/write-gate` until `activeGatedRequests` reaches
   `0` on the live instance (Drain procedure above) — there is no P15
   background-job state to drain yet, since this is the *first* rollout of
   that feature (no `inventory_deduction_jobs` rows exist against
   pre-P15 code).
6. Push `pos-perf-p16-write-gate` (or whatever branch/PR carries this gate
   plus the full P15 stack merged together) to `main`. CI → migration
   (`prisma migrate deploy`, additive, see `pos-perf-p15-fast-checkout.md`
   for the full migration list) → the workflow's deploy-hook step, in that
   order, same as POS-PERF-P15R6 already verified.
7. Watch Render (`render deploys list … -o json`) until `live`, and Vercel
   until `Ready`/promoted — do not trust the blind `sleep 45`.
8. Check the new instance's logs for `Inventory deduction worker started
   (polling every 2s).` and the API's listening line. Traffic is still
   paused, so this only proves the new code is live, not that it has
   processed a request yet.
9. **`PUT /api/settings/write-gate` `{ "enabled": false }`.** Traffic
   resumes, 100% on the new (P15 + gate) API and the already-confirmed-live
   new frontend — no window existed where old/new API code or old/new
   frontend code both saw live traffic, same guarantee Maintenance Mode
   would have given on a paid plan, achieved here without one.
10. Smoke-check a real checkout end-to-end: `inventory_deduction_status`
    transitions `pending → completed` within a few seconds; re-run the
    R5/R6 read-only-GET check (`GET /api/transactions/by-idempotency-key/<nonexistent key>?branch_id=<real branch>`
    returns `404` with no `checkout_attempts` row created).
11. Re-enable Render `autoDeploy` afterward if desired for future ordinary
    (non-schema-changing) pushes — owner's call, not required.

### Rollback (if the P15 rollout needs to be reverted)

Follow `pos-perf-p15-fast-checkout.md`'s "Rollback" section exactly, with
one substitution throughout: **every instruction there that says "Render
dashboard → Settings → Maintenance Mode → Enable/Disable" now reads "`PUT
/api/settings/write-gate {enabled:true/false, reason}`."** Everything else
in that section — draining `pending`/`processing` jobs, manually requeuing
`failed` ones via the now-available `retry-inventory-deduction` endpoint
(reachable during the gate via the `X-Maintenance-Bypass` header instead of
a raw SQL connection), positively reconciling `quantity_reserved` to zero
before swapping code back, redeploying the prior version, then reopening
the gate — is unchanged, because none of it was ever actually about
Maintenance Mode specifically; it was about pausing new writes while
keeping the in-process worker alive to drain, which this gate does
identically.

## Remaining limitations (stated plainly, not papered over)

- **The bypass is Super-Admin-only, not Super-Admin-or-Supervisor**, even
  though `retry-inventory-deduction` itself is normally reachable by a
  Supervisor (`adminOrSupervisor`). This is a deliberate narrowing for the
  maintenance window specifically — during a declared incident, escalate to
  a Super Admin rather than widening the bypass. If this proves too narrow
  in practice, widening it is a one-line change to the role check in
  `write-gate.ts`'s `resolveBypassActor` caller, not a design change.
- **The in-flight counter is per-process.** On this free-tier,
  single-instance service that is exactly the right scope (see "What
  changed" above), but if the service is ever scaled to multiple
  concurrent replicas, draining would require checking the counter on
  *every* instance, not just one — this runbook's Phase 2 sequence does not
  yet describe that case, since it does not apply to the current plan.
- **This gate does not and cannot verify that a *client's* own in-flight
  request (e.g. a slow upload already streaming into `POST
  /api/transactions/payment-proof` type routes outside this gate's scope)
  has finished** — it only tracks server-side handler execution for the
  routes it protects. Multer-backed upload routes are intentionally outside
  this gate's scope (they are not checkout or inventory-mutating), so this
  is not a gap in what the gate promises, just a boundary worth stating.
- **No automated test exercises the real Render deploy-swap overlap
  itself** (two real OS processes, one old-code, one new-code, both
  querying the same live `system_settings` row concurrently) — that would
  require an actual multi-instance deploy to observe, which this task does
  not authorize. The DB-read-per-request design is what makes that scenario
  safe *in principle* (both processes see the same row), and the unit tests
  prove the per-request decision logic is correct in isolation; the
  cross-process scenario itself is architecturally covered, not empirically
  observed.
