# POS-PERF-P15 — Fast Checkout with Durable Background Inventory Deduction

## What changed

Checkout (`POST /api/transactions`) no longer deducts inventory
synchronously. The atomic `$transaction` now does only:

1. Validate/compute as before (pricing, discounts, payment, stock
   availability).
2. **Reserve** the required quantity per ingredient
   (`InventoryStock.quantityReserved`) via a single atomic conditional
   `UPDATE … WHERE quantity_on_hand - quantity_reserved >= needed`.
3. Insert the `Transaction` + `TransactionItem` rows (unchanged;
   `TransactionItem.deductionSnapshot` is the immutable deduction input).
4. Insert one `InventoryDeductionJob` row (`pending`), scoped to the new
   transaction.

The response returns as soon as that commits — before any ledger
(`InventoryStockMovement`) write, audit row, or low-stock notification.

A new background worker (`inventory-deduction.worker.ts`, started
unconditionally from `server.ts`, polling every 2s) claims pending jobs
and performs the real deduction: decrements `quantityOnHand`, releases the
matching `quantityReserved` in the same statement, writes the `SALE`
ledger movement, and flips the job + `Transaction.inventoryDeductionStatus`
to `completed`. On failure it retries with the same 10s/60s/300s backoff
every other queue in this codebase uses, and marks the job (and the
transaction) `failed` after 3 attempts.

Checkout retries/double-clicks are deduplicated via a client-generated
`idempotency_key` (new `Transaction.idempotencyKey`, unique, nullable).

Void/refund now checks the job's status before reversing anything:
- `completed` (or no job row — pre-cutover transaction): unchanged full
  reversal.
- `pending` / `failed`: cancels the job and releases the reservation —
  nothing was ever deducted.
- `processing`: fails closed with `INVENTORY_DEDUCTION_IN_PROGRESS` (409)
  — retry in a moment.

## Schema changes (migration `20261005150000_add_fast_checkout_background_deduction`)

- `inventory_stocks.quantity_reserved` (`DECIMAL(10,3) NOT NULL DEFAULT 0`)
  — purely additive, zero for every existing row.
- `transactions.idempotency_key` (`TEXT`, unique, nullable) — null for
  every existing row.
- New table `inventory_deduction_jobs` (+ `InventoryDeductionJobStatus`
  enum) — empty on migrate.

No existing column is dropped, retyped, or backfilled with a computed
value. Safe to run against production data with no downtime.

## Deploying

1. Apply the migration (`prisma migrate deploy`) **before** deploying the
   new application code — the migration itself is additive and the old
   code never reads/writes the new columns/table, so running it first is
   schema-safe.
2. Deploy the new application code. The worker starts automatically with
   the API process; no separate deployment or env var is required.
3. Verify in logs: `Inventory deduction worker started (polling every 2s).`

Multiple **new-code** API instances/replicas are safe to run concurrently
— every instance polls the same `inventory_deduction_jobs` table, and the
claim-token guard (`inventory-deduction.repository.ts#claimBatch`) ensures
only one instance ever actually applies a given job.

### The actual rolling-deploy hazard this schema change does NOT cover

The paragraph above is true, but it only establishes that the *migration*
is additive and that *new* code is internally consistent across replicas.
It previously read as "rolling deploy is therefore safe," which does not
follow and is corrected here: **old code and new code must never both be
serving checkout traffic against the same database at the same time.**

Old (pre-P15) checkout code computes availability and decrements
`quantityOnHand` directly, with no awareness that `quantityReserved` even
exists. Concretely, during a window where both versions are live:

1. A **new**-code instance reserves 5 units for a sale
   (`quantityReserved += 5`), `quantityOnHand` unchanged (say, still 10).
2. An **old**-code instance, handling a different checkout on the same
   branch/item, reads `quantityOnHand = 10`, sees "8 available," and sells
   8 — oblivious to the 5 units another sale already has a claim on. It
   decrements `quantityOnHand` straight to 2.
3. The worker then tries to apply the new-code sale's reservation and
   finds only 2 units on hand for a 5-unit deduction — the defensive guard
   in `inventory-deduction.repository.ts#applyDeduction` throws rather than
   drive stock negative, and the job exhausts its retries and goes
   `failed` (stuck, needs a manual void or recovery — see "Known residual
   risks" below). In a worse interleaving (old code's own read-then-write
   is not protected by the new reservation check either), the branch can
   genuinely oversell: two customers are told they each got the last few
   units of something that only existed once.

An additive migration cannot prevent this — it's a **write-semantics**
change (what "available to sell" means), not merely a new column old code
happens to ignore safely. The old code path is actively unsafe to run
concurrently with the new one against shared stock rows.

### Why "scale to a single replica" is not actually sufficient

A previous revision of this runbook said to "scale to a single replica
(or use the platform's recreate strategy)" and treated that as the fix.
It is not: **replica count is orthogonal to the hazard.** Render's default
deploy for a Web Service — at any instance count, including one — is a
*health-checked swap*: it starts the new instance, waits for it to pass
its health check, and only *then* stops the old one. With one replica
that still means the old instance keeps accepting live checkout traffic
for the entire time the new instance is building and starting (commonly
tens of seconds). Vercel's deploys are irrelevant here — they are
atomic/immutable per-deployment and the frontend holds no inventory
write semantics at all, so the hazard is 100% on the Render API side
regardless of replica count or how the web app is deployed.

The only thing that actually closes the window is making sure **no
checkout request reaches the service at all** — old or new — while the
swap happens. Render Web Services have a built-in way to do exactly that
without any code change: **Maintenance Mode**. Turning it on serves a
static page to every incoming request while the underlying service
process keeps running underneath, untouched — which matters for the
*rollback* procedure below, where the in-process background worker needs
to keep draining jobs while HTTP traffic is blocked.

### POS-PERF-P15R4 — the actual automated release path, and what it does NOT do

Everything in this section was verified directly against this repo's own
`.github/workflows/deploy-production.yml`, not assumed. **A push to `main`
already fully automates production releases**, with no human step in the
middle:

1. Full CI gate (type-check/lint/test/build) runs first.
2. The migration is applied directly against production from the runner
   itself — `pnpm exec prisma migrate deploy` with
   `DATABASE_URL`/`DIRECT_URL` set to the `PRODUCTION_DATABASE_URL_DIRECT`
   secret. **This already does not use a Render Shell session** — the
   previous revision of this runbook's step 3 (`Apply the migration from a
   Render Shell session`) did not match the real pipeline and is corrected
   here; delete that assumption, it was never exercised and Shell
   availability on the live plan has not been verified (see below).
3. `curl -fsS -X POST "$RENDER_DEPLOY_HOOK_PRODUCTION"` fires Render's
   deploy hook — Render's own health-checked instance swap, asynchronous,
   with no maintenance-mode toggle anywhere in the workflow.
4. The workflow `sleep 45`s and then runs a Playwright smoke suite against
   the live site — it does not confirm the swap finished before that sleep
   elapses, and it does not pause incoming traffic at any point.
5. Vercel auto-deploys `apps/web` independently, triggered directly by its
   own GitHub integration on the same push — not by this workflow at all.

**This means the "Executable no-mixed-version rollout" procedure below has
never actually been wired into a real deploy of this feature.** It
describes a hand-operated Maintenance Mode sequence; the pipeline that
actually ships code on every push to `main` does none of that gating. For
any future push that changes checkout/inventory write semantics (this
P15R4 fix does not — it only touches the checkout-attempt recovery path,
see "Why POS-PERF-P15R4 needs none of the above" below), a human **must**
run the steps below manually, in the gap between the migration step and
the deploy-hook step, by holding the push/merge to `main` until ready to
babysit it — the workflow itself will not pause for you.

**Plan tier — verified POS-PERF-P15R5, via the Render CLI, not assumed.**
The earlier revision of this runbook said plan tier "could not be verified
from this environment" because `RENDER_API_KEY` is unset — that was the
wrong conclusion to draw from an unset env var: the Render CLI
(`render.exe`, already installed on this machine) authenticates via its
own stored browser-login session, independent of that variable, and
`render whoami` / `render services -o json` both succeed with it unset.
Verified for `srv-d9cok48js32c73dss310` (`potato-corner-web-pos-main`,
this service):
- **Runtime plan: `free`** (`serviceDetails.plan`) — this is the one that
  gates Maintenance Mode, and it governs how the service actually serves
  traffic once built.
- **Build plan: `starter`** (`serviceDetails.buildPlan`) — a separate
  setting (controls build-time resources/concurrency only); do not confuse
  the two, and do not use the build plan to conclude anything about
  Maintenance Mode availability.
- `maintenanceMode.enabled: false` (currently off, as expected), `region:
  singapore`, `autoDeploy: yes` / `autoDeployTrigger: commit` on `branch:
  main` (confirms the "push to `main` auto-deploys" behavior asserted
  below), `suspended: not_suspended`.

**Runtime plan is `free` → Maintenance Mode is unavailable on this service
today.** The "if paid" branch below is kept for after a deliberate upgrade
(an owner/billing decision this runbook does not make or suggest making
automatically) — follow the "if free" branch, which is this service's
actual current state. Re-run `render services -o json --confirm | <find
the srv-d9cok48js32c73dss310 entry>` to re-confirm before any future
release if the plan may have changed since this was written.

#### If the plan is confirmed paid (Maintenance Mode available)

1. **Render dashboard → the API service → Settings → Maintenance Mode →
   Enable.** Every request (including `POST /api/transactions` and
   `GET /api/transactions/by-idempotency-key/:key`) now gets a static
   response instead of reaching the app. The currently-running instance
   (old code) keeps its process alive underneath — it just isn't
   receiving anything.
2. Confirm the pause took effect: hit the live checkout URL from a
   browser/curl and confirm you get the maintenance page, not the app.
3. Let (or trigger) the migration step run — it goes straight to
   `PRODUCTION_DATABASE_URL_DIRECT`, not through Render at all, so
   Maintenance Mode has no effect on it either way.
4. Trigger the deploy (the workflow's deploy-hook step, or Render
   dashboard → Manual Deploy → Deploy latest commit). Wait for the build
   to finish and the new instance to report healthy in the Render
   dashboard — don't trust the workflow's blind `sleep 45` for this.
5. Check the new instance's logs for `Inventory deduction worker started
   (polling every 2s).` and `API listening`. Because traffic is still
   paused, this is purely a code-is-live check — nothing has processed a
   real checkout on the new version yet.
6. **Render dashboard → Settings → Maintenance Mode → Disable.** Traffic
   now resumes, 100% on the new instance — there was no point in time
   where old and new code both had live traffic, because there was no
   live traffic to either during the swap.
7. Vercel (web): no special procedure for the write-semantics hazard — each
   Vercel deployment is independent/atomic, and that hazard is entirely in
   the API's stock-write semantics, which the web app has no part in.
   **However**, see "Cached old frontend compatibility" below — a stale
   frontend bundle still open in a browser tab is a separate, real
   compatibility concern this P15R4 change introduces.

#### If the plan is confirmed free (no Maintenance Mode)

Render's free Web Service tier has no Maintenance Mode toggle. Do **not**
substitute an unverified capability for it:
- **Do not assume Render Shell is available** — it was never actually
  used for anything in the real pipeline (migrations go straight to the
  DB from GitHub Actions, see above), so its absence doesn't block
  migrations at all. Its availability on the live plan is simply unknown
  from here; don't plan around it either way without checking the
  dashboard first.
- **Do not assume one replica prevents overlap** — a free-tier service is
  single-instance by construction, but Render's deploy is still a
  health-checked swap: the old instance keeps serving until the new one
  passes its health check, same mixed-traffic window as any other
  instance count.
- The one concretely-available, already-verified-in-this-repo lever that
  works on any plan tier is the direct database connection the workflow
  already uses for migrations (`PRODUCTION_DATABASE_URL_DIRECT`) — because
  it's a plain Postgres credential, not a Render platform feature. It
  cannot pause HTTP traffic, but it is exactly what the rollback section's
  "retry failed jobs while traffic is blocked" step below depends on, and
  it is NOT gated by whatever the live plan turns out to be.
- For an actual traffic-pause lever on the free tier, the only Render
  control worth evaluating is suspending the service via the dashboard
  (stops the instance outright rather than serving a maintenance page).
  Whether a suspended service still accepts/queues the deploy-hook trigger
  correctly has **not** been verified here — confirm this on a low-stakes
  deploy (a docs-only change, say) before ever depending on it for a
  write-semantics-changing release. Until that's confirmed, treat any
  future checkout/inventory write-semantics change on a free-tier plan as
  **blocked on a human first validating a real traffic-pause mechanism**,
  not as something this runbook can currently promise is safe.

#### Cached old frontend compatibility (introduced by this P15R4 change)

This revision makes `branch_id` a **required** query parameter on
`GET /api/transactions/by-idempotency-key/:key` (see "Why POS-PERF-P15R4
needs none of the above" for why the recovery endpoint needed to start
writing a fencing row, which requires a branch to write it under). A
browser tab still running the *previous* frontend bundle — already loaded,
sitting open, not yet reloaded — will keep calling the old URL shape
without `branch_id` and get a `400 VALIDATION_ERROR` instead of the old
`200`/`404`. This is intentional fail-closed behavior (an ambiguous
recovery check must never be treated as safe), and it is **not** a
money-losing bug: checkout itself (`POST /api/transactions`) is unchanged
by this fix and keeps working from a stale tab exactly as before — only
the reload/browser-close *recovery* check degrades, surfacing as "Could
not confirm whether the previous checkout attempt went through" until
that tab is reloaded onto the new bundle. Deploy `apps/web` (Vercel) in
the same push as this API change (the existing push-to-`main` pipeline
already does both together) so the window where any tab is running a
mismatched old frontend against the new API is as short as a normal
Vercel rollout, not an extended one.

## Monitoring / verifying health

- **Per-sale status**: `inventory_deduction_status` on the transaction
  (`pending` → `completed`, or `failed` after 3 attempts). Visible in the
  POS transaction detail dialog (critical badge on `failed`).
- **Stuck jobs**: query
  `SELECT * FROM inventory_deduction_jobs WHERE status = 'failed'` — these
  require a void (which cancels the job and releases the reservation) or a
  manual data fix. There is no automated retry past 3 attempts by design.
- **Lag**: `SELECT count(*) FROM inventory_deduction_jobs WHERE status = 'pending' AND created_at < now() - interval '30 seconds'`
  — a growing count means the worker isn't keeping up (check API process
  health; the worker runs in-process, so an API outage pauses it too).

## Rollback

**Corrected order below** — a previous revision of this section had
"deploy old code first, then drain jobs," which is backwards and unsafe:
reverting to old code *before* every outstanding reservation/job is
resolved recreates the exact oversell hazard described above in "The
actual rolling-deploy hazard" (old code ignoring `quantityReserved` while
new-code reservations are still outstanding), except now permanently —
there is no newer worker left anywhere to ever finish them. The correct
order stops new reservations from being created, drains every existing
one to a terminal state *while new code (and its worker) is still live*,
positively reconciles that nothing is left outstanding, and only then
swaps application code.

A previous revision of this section also treated
`pending`/`processing` count reaching `0` as sufficient to proceed. It is
not: a `failed` job (exhausted retries) still holds its reservation
indefinitely — nothing releases it automatically — so checking only
`pending`/`processing` can read `0` while `failed` jobs are quietly still
holding stock hostage. Both executable steps below close that gap.

1. **Stop new reservations without stopping the drain**: Render dashboard
   → the API service → Settings → Maintenance Mode → **Enable** (paid plan
   — see the plan-tier caveat above; on a free plan, see its fallback
   section instead). This blocks every new `POST /api/transactions` (so no
   *new* reservations can be created) while leaving the running instance's
   process — and therefore its in-process background worker — alive and
   still polling, so it keeps draining whatever is already queued. (This
   is the same lever used for the rollout above, used here for the
   opposite purpose: pausing new writes while keeping the drain worker
   running, rather than pausing everything for a code swap.)
2. Drain every **non-terminal** job, not just `pending`/`processing`:
   - Let the worker run until
     `SELECT count(*) FROM inventory_deduction_jobs WHERE status IN ('pending','processing')` = `0`.
     The worker itself needs no HTTP access — it runs in-process and talks
     to Postgres directly, so Maintenance Mode (an HTTP-layer block) does
     not pause it.
   - Then handle every row with `status = 'failed'` explicitly — these do
     **not** self-resolve. **Maintenance Mode blocks this step's obvious
     path too**: the admin retry-inventory-deduction action and the void
     action are both ordinary authenticated `POST` requests to the same
     API the maintenance page is now intercepting for everyone, admin
     included — there is no bypass allowlist on Render's Maintenance Mode.
     Use the direct database connection instead (the same
     `PRODUCTION_DATABASE_URL_DIRECT` credential `deploy-production.yml`
     already uses for migrations — a plain Postgres connection, unaffected
     by Maintenance Mode or by whatever the live Render plan turns out to
     be) and reproduce exactly what the retry action does server-side
     (`inventory-deduction.repository.ts#requeueFailedJob` — a single
     two-statement transaction, nothing more):
     ```sql
     BEGIN;
     UPDATE inventory_deduction_jobs
       SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = NULL, claim_token = NULL, locked_at = NULL
       WHERE id = '<job id>' AND status = 'failed';
     UPDATE transactions SET inventory_deduction_status = 'pending' WHERE id = '<that job''s transaction_id>';
     COMMIT;
     ```
     The in-process worker (still running, still polling, unaffected by
     Maintenance Mode) picks the now-`pending` job back up on its next
     cycle — no HTTP request required. **Never void a sale automatically
     just to clear the queue**: only void a specific `failed` job's sale
     after confirming, from the transaction and its items, that it was
     never actually fulfilled/paid-for-and-handed-over — a fulfilled sale
     that merely failed its *inventory* deduction is a stock-accounting
     problem, not a reason to erase a valid sale. Repeat until
     `SELECT count(*) FROM inventory_deduction_jobs WHERE status = 'failed'` = `0`
     as well. Do not proceed to step 3 while either count is nonzero.
3. **Positively reconcile reservations — job-count zero alone does not
   prove this.** After step 2, every job for this branch should be
   `completed` or `cancelled`, which means no `InventoryStock` row should
   still show a nonzero reservation on this branch's items. Verify it
   directly rather than inferring it from the job counts:
   ```sql
   SELECT s.branch_id, s.inventory_item_id, s.quantity_reserved
   FROM inventory_stocks s
   WHERE s.quantity_reserved > 0;
   ```
   Any row returned here is an orphaned reservation — stock a job claimed
   but that didn't get released the normal way (e.g. a job row deleted
   out of band, or a race landing exactly during this drain). Do **not**
   proceed until this query returns zero rows; investigate and manually
   correct (a compensating `quantity_reserved` decrement after confirming
   the matching sale's true state) any that appear.
4. Once both step 2's job counts and step 3's reservation query are
   clean, **prefer rolling back application code only, and retain the
   additive schema** (`quantity_reserved`, `idempotency_key`, the
   `inventory_deduction_jobs` table, and POS-PERF-P15R3's
   `checkout_attempts` table below). Old code never reads or writes any
   of these, so leaving them in place costs nothing and keeps the door
   open for a forward-fix without a second migration. This is sufficient
   for the overwhelming majority of rollback scenarios (a bug in the new
   application code, not in the schema itself).
5. Deploy the previous application code version: Render dashboard →
   Manual Deploy → select the prior successful deploy → Redeploy. Traffic
   is still paused (Maintenance Mode still on from step 1), so there is no
   window where old and new code both see live traffic on the way down,
   same reasoning as the rollout procedure above.
6. Confirm the old version is live and healthy (its own startup logs —
   it will **not** log `Inventory deduction worker started`, since that
   worker doesn't exist in old code; absence of that line here is
   expected, not a problem).
7. Render dashboard → Settings → Maintenance Mode → **Disable.** Old code
   resumes serving checkout traffic — now guaranteed to never encounter a
   reservation it doesn't understand, because step 3 already confirmed
   none exist.
8. Only run the destructive schema rollback
   (`apps/api/prisma/migrations/20261005150000_add_fast_checkout_background_deduction/rollback.sql`,
   manual — not run by `prisma migrate`) if the feature is being fully
   decommissioned, not for an ordinary code revert. If you do run it,
   re-run step 3's reconciliation query immediately before — dropping
   `quantity_reserved` out from under a row some straggler request is
   still reserving against is a data-loss risk the column's own presence
   otherwise prevents.

## Known residual risks (see delivery report for full list)

- A `failed` job's reservation is only released by voiding that specific
  sale — there is no automated "give up and restore stock" path.
- `void`/`refund` against a `processing` job returns a 409 rather than
  blocking/retrying — the admin UI should surface this as "try again in a
  few seconds," not a hard failure.

## POS-PERF-P15R3 — checkout attempt fencing, and why it needs none of the above

Migration `20261006040000_add_checkout_attempt_fencing` adds one new table,
`checkout_attempts`, replacing the client-side "poll for ~17s, then assume
not-found means safe to mint a replacement idempotency key" recovery
protocol with a server-enforced compare-and-swap (claim → commit/fail,
with an owner-token-fenced lease) — see `transactions.service.ts`
`claimCheckoutAttempt`'s doc comment and the schema's doc comment on the
`CheckoutAttempt` model for the full protocol. `GET
/api/transactions/by-idempotency-key/:key` now reports `committed` /
`failed` / `in_progress` instead of a bare found-or-404, and the terminal
UI (`checkout-recovery.ts`) never mints a replacement key while an attempt
is `in_progress` — only ever after the server confirms `failed` or
`not_found`.

**This table needs none of the Deploying/Rollback ceremony above.** Unlike
`quantityReserved`, old (pre-P15R3) code doesn't have a *different,
conflicting* understanding of what a checkout attempt is — it simply
never looks at `checkout_attempts` at all. It only ever calls the
pre-existing `findByIdempotencyKey` fast path, which still works
unchanged: if a new-code instance already committed a sale under some
key, old code presented with that same key still finds and replays it
correctly. There is no interleaving where old code's ignorance of this
table causes a wrong *decision* (unlike `quantityReserved`, where old
code's ignorance directly causes overselling). A normal rolling/canary
deploy of this specific change alone would be safe.

In practice, deploy it under the same Maintenance Mode window as any
other change to this feature anyway (simplest to reason about, and the
window costs seconds) — but know that the strict requirement above is
specifically about the stock-reservation write semantics from P15, not
about this table.

### Rollback

Pure code revert, no data migration needed: drop the `checkout_attempts`
rows for any in-flight attempts if desired (optional — they're harmless
leftovers, not referenced by old code), or just leave the table in place
per the "retain the additive schema" preference above. No reservation
reconciliation applies here since this table never holds inventory.

## POS-PERF-P15R4 — recovery fencing fix, and its one real compatibility cost

Closes a gap in R3's own recovery check: `resolveCheckoutAttempt` used to
report `not_found` straight from a bare "no `CheckoutAttempt` row exists"
read. That proves nothing if the original request is simply delayed
somewhere before `claimCheckoutAttempt`'s own `INSERT` (slow auth/
rate-limit middleware, a queued connection, a GC pause before the handler
body even runs) — a client that trusted that `not_found` could mint and
commit a replacement key for an edited cart, and the merely-delayed
original request could then land and commit a second, genuinely duplicate
sale under its own key. Fixed by having a never-claimed key get atomically
fenced (via the same `claimCheckoutAttempt` INSERT ... ON CONFLICT, not a
plain SELECT) the moment recovery checks it — see
`transactions.service.ts` `resolveCheckoutAttempt`'s doc comment. An
attempt already resolved to `'failed'` is untouched by this change (that
status is written by the original request's own confirmed rollback, not
an absence inference, so the existing "same key, retry immediately" path
stays exactly as fast as before).

**This also needs none of the Deploying/Rollback ceremony above** for the
same reason P15R3 didn't — it is a decision-logic change inside a table
old code never looks at, not a stock-write-semantics change.

**The one real cost: `GET /api/transactions/by-idempotency-key/:key` now
requires a `branch_id` query parameter** (the fencing write needs a branch
to write under, same NOT NULL column a real checkout claim would
populate). See "Cached old frontend compatibility" above in the Deploying
section — ship `apps/web` in the same push as this API change so the
mismatch window for an already-open stale tab is as short as a normal
Vercel rollout.

### Rollback

Pure code revert. No data migration needed — `checkout_attempts` rows this
revision's sentinel claims leave behind are harmless orphans (same as any
other abandoned attempt; they simply wait out their lease). Reverting
`apps/web` independently of the API is safe in either order: old frontend
code without `branch_id` against new API code gets a `400` on the recovery
check only (see compatibility note above); new frontend code with
`branch_id` against old API code gets that query param silently ignored
(old API never reads it) and the old, R3-level recovery behavior.

## POS-PERF-P15R5 — GET recovery is now read-only; abandonment moved to an explicit POST, with a permanent tombstone

R4's fix (above) closed the never-claimed-key race, but it did so by
writing a fencing row **from inside a GET request** — `resolveCheckoutAttempt`
called `claimCheckoutAttempt` (a real `INSERT`) the moment the recovery
check observed no row at all. A `GET` must never have a durable write side
effect like that: a browser/proxy retry of an idempotent-looking GET, a
prefetch, or simply checking status out of curiosity could silently fence
a key the client never actually decided to abandon. Separately, that
fencing write only ever created a **temporary** `in_progress` lease
(`CHECKOUT_ATTEMPT_LEASE_MS`) — once that lease's timestamp passed, the
row became reclaimable again by anyone, including the real delayed
original request, *even after the client had already committed a
replacement sale under a different key*. A lease is the wrong tool for "I
have permanently moved on from this key" — it is only ever supposed to
mean "presumed dead, not confirmed."

Both are fixed together:

1. **`GET /api/transactions/by-idempotency-key/:key` is now a pure read.**
   It reports `committed` / `failed` / `abandoned` / `in_progress` /
   `not_found` (404) and never calls `claimCheckoutAttempt` or writes
   anything, regardless of what it finds.
2. **`POST /api/transactions/by-idempotency-key/:key/abandon`** (new route,
   `branch_id` in the body, same `hasBranchAccess` branch-authorization
   check as the GET) is the only place that performs the fencing write.
   `transactions.service.ts` `abandonCheckoutAttempt` runs the same
   `INSERT ... ON CONFLICT ... WHERE` compare-and-swap shape as
   `claimCheckoutAttempt`, except the row it writes on success is the new
   **`abandoned`** status (`CheckoutAttemptStatus`, migration
   `20261006190000_add_checkout_attempt_abandoned_status`) — a permanent
   terminal state `claimCheckoutAttempt`'s own `WHERE` clause never matches,
   so it is **never reclaimable again, for any reason, at any time** —
   unlike `failed` (immediately reclaimable) or an expired-lease
   `in_progress` row (reclaimable because its holder is only presumed
   dead). Whoever calls `createTransaction` under an `abandoned` key next —
   a merely-delayed original request, or an already-issued same-key retry
   racing the abandon decision — gets a hard, non-retryable
   `CHECKOUT_ATTEMPT_ABANDONED` (409) rejection, never the "keep waiting"
   `CHECKOUT_ATTEMPT_IN_PROGRESS`.
3. The client protocol (`checkout-recovery.ts`) is now two steps:
   `resolveCheckoutAttempt` (GET) first; **only** if it reports `not_found`
   does the client call `abandonCheckoutAttempt` (POST) and act on *that*
   call's result — `failed`/`abandoned` from the GET are still immediately
   safe to remint on with no POST call needed (unchanged from R4, since
   both are confirmed-terminal facts, not absence inferences).
   `resolveAndFenceCheckoutAttempt` wraps this two-step protocol so every
   existing call site in `terminal/page.tsx` keeps the same
   `ResolveCheckoutOutcome` shape it already switches on.

Proven against real Postgres (`checkout-worker.integration.test.ts`,
`describe('checkout attempt recovery durability and lease takeover
(POS-PERF-P15R4/R5)')`):
- the never-claimed-key race from R4, now closed via the explicit abandon
  call instead of a GET side effect, **and proven to hold even after
  manually setting the row's `lease_expires_at` ten minutes into the
  past** — because `abandoned` never consults that column for a reclaim
  decision at all;
- the new race this revision specifically targets: an already-issued
  same-key retry racing the client's own abandon decision — exactly one
  side may ever win, and whichever loses is rejected outright, never
  silently producing a second sale under a replacement key.

**This still needs none of the Deploying/Rollback stock-write ceremony
above**, for the same reason R3/R4 didn't: old code never looks at
`checkout_attempts` or this new status value at all; the hazard that
ceremony exists for is specifically the `quantityReserved` write-semantics
change from the base P15 feature.

### The compatibility cost this revision introduces (read before deploying)

**A stale R3/R4-era frontend tab is unsafe against the new API, in a way
that is new to this revision — not just degraded like the R4 cost above.**
The old frontend's `resolveCheckoutAttempt` treats a GET `404`
(`IDEMPOTENCY_KEY_NOT_FOUND`) as immediately safe to remint — that was
correct under R4, where the GET itself performed the fencing write before
returning 404. Under R5's API, the GET performs no write at all, so an old
tab that still believes "404 means safe" can mint and commit a replacement
key while the real original request is still merely delayed and
un-fenced — reopening the exact race this whole feature exists to close,
for that one stale tab, until it reloads onto the new bundle. This is
materially worse than the R4 compatibility cost (which only ever
degraded a check to a `400`, never silently removed a safety guarantee).

**Do not ship the new API ahead of the new frontend.** Deploy `apps/web`
(Vercel) in the same push as this API change, exactly as the existing
push-to-`main` pipeline already does both together — and treat any gap
between the two deploys actually landing (Render's health-checked swap
duration, Vercel's own rollout time) as the real exposure window for this
specific risk, not just a cosmetic one.

### Rollback

Pure code revert, no data migration needed. `checkout_attempts` rows
carrying the new `abandoned` status are harmless to leave in place (same
"retain the additive schema" preference as elsewhere in this doc) — old
(pre-R5) code never reads this status value, so it simply never reclaims
or touches those rows, identical to how it already treats every other
`checkout_attempts` row it doesn't understand. The new enum value itself
(`ALTER TYPE ... ADD VALUE`) cannot be dropped by a down-migration in
Postgres without recreating the type; do not attempt that as part of an
ordinary rollback — leaving the unused enum value in place costs nothing.

## Executable rollout procedure for THIS release (POS-PERF-P15R5) — SUPERSEDED, see POS-PERF-P15R6 below

**This section's premise is wrong and must not be followed as written.** It
assumed R3/R4 were already live in production and only this R5 diff was
being shipped on top of them. Verified directly against the live Render API
deploy history and the live Vercel deployment metadata (see POS-PERF-P15R6
below): **nothing in the P15 feature set — base P15 through R5 — has ever
been deployed.** Production (both API and web) is still on
`ec0e0976c02979f48aa3e48438b0df8099108239` (P13). This section's claim that
"this release does not strictly need the base-feature Maintenance Mode
ceremony" is therefore false for the actual next release: shipping any of
R3/R4/R5 means shipping all of base P15 (`quantityReserved`) with it, for
the first time, in one push. Read POS-PERF-P15R6 instead of acting on the
steps immediately below.

Everything below reflects what is actually true of this repo and this
Render service right now (service `srv-d9cok48js32c73dss310`,
`potato-corner-web-pos-main`, runtime plan `free`, `buildPlan: starter`,
`autoDeploy: yes` on `branch: main`) — not an assumed/generic procedure.
This release's actual code change (the GET→POST split above) does **not**
touch `quantityReserved` write semantics, so it does not strictly need
the P15/base-feature Maintenance Mode ceremony on its own merits — but it
**does** need the frontend/API deploy ordering guarantee below, which the
existing pipeline already provides as a side effect of deploying both from
one push, not from any explicit gating step.

1. **Before pushing to `main` — confirm nothing else is mid-flight.**
   `deploy-production.yml` triggers on every push to `main` with no manual
   gate beyond the "production" GitHub Environment's required-reviewers
   setting; Render's `autoDeploy: yes`/`commit` trigger and Vercel's own
   GitHub integration then both fire independently off the same push, on
   their own schedules, with no coordination between them. Concretely:
   `git log origin/main..main` is empty and `git status` is clean before
   pushing (this task made no commits itself — see the report below for
   why), and nobody else is mid-push, so this push is the only thing
   those three systems will be reacting to.
2. **Push to `main`.** This one push is all three deploys' trigger:
   - GitHub Actions runs full CI, then applies `prisma migrate deploy`
     directly against `PRODUCTION_DATABASE_URL_DIRECT` (this migration —
     `20261006190000_add_checkout_attempt_abandoned_status` — is a single
     additive `ALTER TYPE ... ADD VALUE`, which Postgres cannot run inside
     the same transaction as other DDL on that type but imposes no lock
     contention or downtime beyond that; it has no rollback.sql by design,
     see above).
   - The workflow then `curl`s `RENDER_DEPLOY_HOOK_PRODUCTION`, which
     starts Render's own health-checked swap for the API service — old
     code keeps serving every request (including `POST
     /api/transactions` and both `by-idempotency-key` routes) until the
     new instance passes its health check, per Render's documented
     behavior for this plan tier.
   - Vercel's GitHub integration deploys `apps/web` on the same push,
     independently, on its own timeline — not sequenced against the
     Render swap by anything in this repo.
3. **Do not treat the workflow's `sleep 45` as confirmation of anything.**
   It is a blind wait, not a health check, for either deploy target. Watch
   the actual rollout status yourself:
   - Render: `render deploys list -o json <service-id>` (or the dashboard)
     until the new deploy's status is `live`.
   - Vercel: its own dashboard/CLI until the new deployment is `READY` and
     promoted to production.
4. **The one correctness-relevant ordering constraint this specific
   release has**: do not let a stale R3/R4-era `apps/web` bundle remain
   the production-serving one once the new API is live and accepting
   traffic — see "The compatibility cost this revision introduces" above
   for exactly what breaks (a stale tab's 404-means-safe assumption) if
   that window is extended. The existing single-push pipeline already
   keeps this window to "however long the slower of the two independent
   deploys takes," which is the best this repo's current automation can
   do without adding real cross-system sequencing (out of scope for this
   task — no CI/deploy-pipeline changes were made here).
5. **Smoke-check after both deploys report healthy**: hit
   `GET /api/transactions/by-idempotency-key/<any-nonexistent-key>?branch_id=<a
   real branch>` on the live API and confirm a `404
   IDEMPOTENCY_KEY_NOT_FOUND` with **no** `checkout_attempts` row created
   for that key afterward (`SELECT * FROM checkout_attempts WHERE
   idempotency_key = '<key>'` should return nothing) — this is the
   concrete, checkable proof that the GET is actually read-only in
   production, not just in the test suite above.

### What remains genuinely unavailable right now, and why this report does not paper over it

- **Maintenance Mode is unavailable on this service today** because its
  verified runtime plan is `free`, and Render restricts that feature to
  paid Web Services. This is now a **confirmed fact** (see the CLI output
  above), not the earlier "could not verify" placeholder. Upgrading to a
  paid plan would unlock it — that is a billing decision for the service's
  owner to make deliberately, and this report does not make it, recommend
  a specific tier, or take any action that would incur or change cost.
- **Whether suspending the free-tier service via the dashboard cleanly
  pauses traffic without breaking the deploy-hook trigger remains
  unverified**, exactly as the earlier revision of this runbook already
  stated, and this task's instructions explicitly forbid treating an
  unverified suspend/recreate behavior as if it were confirmed. Nothing
  in this revision changes that: it was not tested (doing so would mean
  actually suspending the live production service, which is outside what
  this task authorized), and the runbook continues to say so rather than
  assume it works.
- **Net effect**: for this specific release (a decision-logic-only
  change, no stock-write-semantics change), the single-push pipeline's
  existing "both deploys land from the same push, roughly together" is
  the actual, available safety property — there is no traffic-pause lever
  to layer on top of it on the current plan. For any *future* change that
  does touch `quantityReserved` write semantics (unlike this one), treat
  it exactly as the "If the plan is confirmed free" section above already
  says: blocked on a human first validating a real traffic-pause
  mechanism (a plan upgrade enabling Maintenance Mode, or a confirmed-safe
  suspend procedure), not something to ship on a "the window is probably
  short enough" assumption.

  **This "net effect" conclusion was itself built on a false premise — see
  POS-PERF-P15R6 immediately below, which corrects it with directly
  verified production state.**

## POS-PERF-P15R6 — correcting the production-version assumption, and the actual executable release sequence

Every revision above (R3 through R5) reasoned about "a stale R3/R4-era
frontend tab" as if R3/R4 were already serving production traffic. **That
was never true, and this section corrects it with facts pulled directly
from the live services, not from git history on this machine alone:**

- `git log origin/main..main` on this repo shows **7 unpushed commits**:
  every one of base P15, R, R2, R3, R4, and R5
  (`30a1231`…`67185c9`, this repo's current `HEAD`). `origin/main` itself is
  still at `ec0e0976c02979f48aa3e48438b0df8099108239` ("P13").
- **Render** (`render deploys list srv-d9cok48js32c73dss310 -o json
  --confirm`): the live (`status: "live"`) deploy, and the two before it,
  all carry `commit.id = ec0e0976c02979f48aa3e48438b0df8099108239`. The
  production API has never run any P15 code.
- **Vercel**: the current production deployment aliased to
  `potatorenovare.com`/`www.potatorenovare.com` (`dpl_31eBzGQiDnPuwTdioVJU8oWFdSwZ`,
  queried via the authenticated Vercel REST API, `GET
  /v13/deployments/{id}`) has `gitSource.sha =
  ec0e0976c02979f48aa3e48438b0df8099108239` — the identical commit. The
  production frontend has never run any P15 code either.

**Consequences:**

1. **There is no R3/R4/R5 tab to be stale, anywhere.** Every passage above
   discussing "a stale R3/R4-era frontend tab" (R4's `branch_id`-required
   cost, R5's "404-means-safe is now unsafe" cost) describes a hazard
   between two states that have never both existed in production. It is
   not a live compatibility blocker for this release and must not be
   treated as one. Do not spend release-gating effort on it.

2. **The real compatibility question is P13 (currently live, both sides)
   vs. the full P15 stack being shipped for the first time**, and it has
   been checked directly, not assumed:
   - `POST /api/transactions`'s `idempotency_key` body field is optional
     (`transactions.router.ts`); the live P13 frontend never sends it and
     never calls either new `by-idempotency-key` route (that code doesn't
     exist in its bundle) — it only hits request/response shapes that are
     an unchanged superset (`toTransactionResponse`), so it keeps working,
     unmodified, against the new API.
   - The live P13 frontend's checkout-success handler
     (`apps/web/hooks/queries/use-transactions.ts`) invalidates only the
     `transactions`, `current-shift`, and `shift` query keys — never an
     inventory/stock key — so it never assumed the synchronous-deduction
     response the old API used to return. The new ~2s async worker lag
     before `inventory_deduction_status` flips to `completed` causes no
     UI regression for this specific, actually-deployed frontend.
   - **This was verified by actually running the live P13 frontend against
     the new response shape, not inferred from the optional `idempotency_key`
     field alone.** A disposable worktree was checked out at the exact
     commit currently live in production (`ec0e0976c02979f48aa3e48438b0df8099108239`),
     its `packages/shared` was rebuilt against this repo's current (HEAD)
     type/schema definitions, and:
     - `tsc --noEmit` on `apps/web` reported **zero** type errors in any
       checkout-path file (`terminal/page.tsx`, `receipt-modal.tsx`,
       `use-transactions.ts`, `view-transaction-detail-dialog.tsx`) — no
       field the P13 frontend reads was renamed, removed, or narrowed. (The
       only errors anywhere in the old `apps/web` tree were two unrelated
       pre-existing test fixtures for a low-stock-alert type that tightened
       unrelated optional fields to required — not on the checkout path, and
       not shipped in any built bundle.)
     - P13's own existing test suite for the terminal page, run unmodified
       against those rebuilt types, **passed all 105 tests** — including
       the charge-success assertions that exercise cart-clear/checkout-close
       ("New Sale") behavior.
     - A new, targeted render test exercised `ReceiptModal` (P13's actual
       component, unmodified) against a transaction object shaped exactly
       like `toTransactionResponse`'s real P15 output for a sale whose
       background deduction has **not** completed
       (`inventory_deduction_status: 'pending'`): the receipt number and
       total rendered correctly and the "New Sale" control closed the
       receipt as expected — confirming the pending status causes no
       render error and no missed UI update, empirically, not just by
       reading `use-transactions.ts`'s invalidation list.
   - **Conclusion: the new API is forward-compatible with the currently-live
     frontend for the full duration of any rollout window.** This removes
     a false urgency (no "ship both together or a tab breaks" pressure) —
     but does **not** remove the real hazard in (3).

3. **This push is the first production rollout of base P15's
   `quantityReserved` write-semantics change — in full**, not a small
   decision-logic diff on top of an already-shipped foundation as R4/R5
   assumed. "The actual rolling-deploy hazard this schema change does NOT
   cover" and every Maintenance-Mode-ceremony requirement in "Deploying"
   and "Rollback" above apply to this release without exception. Treat the
   whole P15 stack as shipping together, not R5 alone.

4. **Correcting "a single push enforces ordering":** verified against
   `.github/workflows/deploy-production.yml`, not assumed.
   - Migration-before-API-deploy **is** enforced *inside the workflow*:
     `prisma migrate deploy` against `PRODUCTION_DATABASE_URL_DIRECT` and the
     `curl … RENDER_DEPLOY_HOOK_PRODUCTION` step are sequential steps in the
     same job, in that order. A push cannot reach the *workflow's own*
     deploy-hook step without the migration step having already succeeded.
   - **This does NOT mean migration-before-deploy is enforced for the API
     service as a whole — Render's `autoDeploy` is a second, independent
     deploy trigger the workflow has no control over.** Re-verified directly
     (`render services -o json --confirm` for `srv-d9cok48js32c73dss310`):
     `autoDeploy: "yes"`, `autoDeployTrigger: "commit"` on `branch: "main"`.
     Per Render's own documentation (`render.com/docs/deploys`), "On Commit"
     auto-deploy "triggers a deploy as soon as you push or merge a change to
     your linked branch" — it watches the GitHub branch directly via
     Render's own GitHub App integration and does not wait for, or know
     about, any GitHub Actions run on that same push. (Render's docs note an
     alternative trigger, "After CI Checks Pass", which *does* wait for
     GitHub-reported check results — this service is not configured that
     way; it is on "On Commit".) Concretely, the moment this release's push
     lands on GitHub, **two independent things start deploying the API
     service**: Render's own auto-deploy (immediate) and this workflow's CI
     → migration → `curl` sequence (only after the full CI gate passes,
     commonly several minutes later). Auto-deploy's build+swap routinely
     finishes **before** the workflow even reaches its migration step,
     which means the new application code — expecting `quantityReserved`,
     `idempotency_key`, and `inventory_deduction_jobs` to exist — can go
     live and start serving checkout traffic against the *old*, pre-migration
     schema. This is strictly worse than the old/new-code write-semantics
     hazard described above in "The actual rolling-deploy hazard": that
     hazard is about two versions of *code* disagreeing on write semantics;
     this is new code running with its required schema not there at all,
     which fails hard (every checkout 500s) rather than silently overselling.
     **Corrective step, required before any push for this release (added to
     the Executable release sequence below):** disable Render `autoDeploy`
     for this service (dashboard → Settings → Build & Deploy → Auto-Deploy →
     **Off**, or `render services update srv-d9cok48js32c73dss310
     --auto-deploy=false --confirm`) before pushing to `main`, so the
     workflow's own post-migration `curl … RENDER_DEPLOY_HOOK_PRODUCTION`
     step becomes the *only* thing that deploys the API service. Deploy
     hooks are a separate, always-available mechanism — Render's docs list
     them as a manual-trigger method distinct from auto-deploy, so turning
     auto-deploy off does not disable the hook the workflow already curls.
     Re-enabling auto-deploy afterward (if desired for ordinary, non-schema
     -changing pushes) is the owner's call, not required by this task.
   - **Frontend-vs-API ordering is not enforced, by anything.** The
     workflow has no step for `apps/web` at all — Vercel's own GitHub
     integration deploys it independently, on its own schedule, with zero
     coordination with the Render swap. That the current production
     Render and Vercel deployments happen to carry the identical commit SHA
     today is an *observed* fact from this specific push history, not a
     guarantee the pipeline provides for the next one. Do not rely on "it
     usually lands together" — watch both deploys explicitly (step 5 below).

### Traffic-pause mechanism: re-verified, still none available on the free plan

Re-confirmed read-only against the live service and official docs (not
re-asserted from the earlier revision):

- `render services -o json --confirm` for `srv-d9cok48js32c73dss310`:
  `serviceDetails.plan: "free"`, `maintenanceMode.enabled: false`,
  `suspended: "not_suspended"`, `autoDeploy: "yes"` /
  `autoDeployTrigger: "commit"` on `branch: "main"` — unchanged from the
  last verification.
- Render CLI v2.28.0 (`render services update --help`): a `--maintenance-mode`
  flag exists, but Render's own changelog
  ("Enable maintenance mode to temporarily disable incoming service
  traffic") states it is available "for any **paid** web service" and that
  "while in maintenance mode, a web service is not reachable from the
  public internet (but it remains up and running)" — paid-only, confirmed
  from Render's own docs, not inferred.
- **No `suspend` subcommand exists anywhere in the Render CLI**
  (`render --help`, `render services --help`) — suspend/resume is only a
  Render-dashboard bulk action or the REST API (`POST
  /v1/services/{id}/suspend` / `/resume`), per Render's changelog and API
  reference.
- Render's official docs (`render.com/docs/free`) only describe suspension
  in the context of *automatic* suspension after exhausting free instance
  hours — where the documented way back is "mov[ing] it to any paid compute
  plan," a different mechanism from a deliberate manual suspend. **No
  official Render documentation found describes whether a manually
  suspended free Web Service keeps its process (and in-process background
  worker) running, whether it still serves traffic, or whether the deploy
  hook still fires while suspended.** This is a confirmed gap in Render's
  public documentation, not an assumption being made here to fill it.
- No application-level maintenance/read-only toggle exists in this codebase
  today (checked `apps/api/src` for any existing checkout-disable flag —
  none found), and building one is out of scope for this release-prep task.

**Conclusion: no verified mechanism on the current plan can pause incoming
checkout traffic.** The only verified lever that does that (Maintenance
Mode) requires a paid Web Service plan. Confirming whether suspend is a
usable substitute would require actually suspending the live production
service to observe its behavior — outside what this task authorizes (no
production writes/suspend actions). This report states that limitation
plainly rather than treating an unverified suspend/recreate behavior as
confirmed, and it does not change billing on its own authority.

**This is the first P15 rollout — not a rollback — so the requirement is a
plain traffic pause, nothing more.** No P15 job/reservation rows exist on
the currently-live (pre-P15) application; there is nothing to drain. The
"keep the in-process worker alive while traffic is paused" property that
Maintenance Mode happens to also provide (process stays up, only HTTP is
blocked) is what the *rollback* procedure above depends on, to drain
already-created jobs before swapping code back. For this rollout, a lever
that paused traffic by stopping the instance outright (if one existed and
were verified safe) would be just as sufficient as Maintenance Mode,
because there is no in-flight worker state this release needs preserved
while paused — do not treat "must keep the worker running" as a blocking
requirement for *this* release; it is not one. It only becomes relevant the
first time this feature is ever rolled back.

### Executable release sequence

**Pre-flight (either branch):** confirm `git status` is clean, confirm the
intended commit range with `git log origin/main..main`, and confirm no one
else is mid-push — the moment this push lands, GitHub Actions, Render, and
Vercel all begin reacting to it independently, per the ordering facts in
(4) above.

**Mandatory for this release specifically — disable Render auto-deploy
before pushing:** re-confirm `render services -o json --confirm` still
shows `autoDeployTrigger: "commit"` for `srv-d9cok48js32c73dss310`, then
turn it off (dashboard → the service → Settings → Build & Deploy →
Auto-Deploy → **Off**, or `render services update
srv-d9cok48js32c73dss310 --auto-deploy=false --confirm`). Per (4) above,
leaving it on means Render deploys the new code the instant the push
reaches GitHub — independent of, and almost always faster than, this
workflow's own CI-gate-then-migrate-then-deploy-hook sequence — which can
put the new application code live against the *pre-migration* schema. The
workflow's `curl … RENDER_DEPLOY_HOOK_PRODUCTION` step (confirmed above to
run only after the production migration succeeds) is unaffected by this
change and remains the way the API actually gets deployed for this
release.

#### Branch A — owner approves a temporary paid-plan upgrade for this release window (unlocks Maintenance Mode)

*Billing decision — not made or executed by this report. Requires someone
with Render billing access.*

1. Upgrade `srv-d9cok48js32c73dss310` to any paid Web Service plan.
2. Render dashboard → the service → Settings → Maintenance Mode → **Enable**.
   Confirm from a browser/curl that the live checkout URL now returns the
   maintenance page, not the app.
3. Push to `main`. CI gate runs, then the production migration
   (`prisma migrate deploy` against `PRODUCTION_DATABASE_URL_DIRECT`), then
   the workflow's `curl … RENDER_DEPLOY_HOOK_PRODUCTION` — all three
   sequential, per (4).
4. **Do not trust the workflow's blind `sleep 45`.** Poll
   `render deploys list srv-d9cok48js32c73dss310 -o json --confirm` until
   the new deploy's `status` is `"live"`. Separately watch Vercel
   (`vercel ls potato-corner-pos --prod`, or the dashboard) until the new
   production deployment is `Ready`/promoted — these are two independent
   things to confirm, per (4).
5. Check the new Render instance's logs for `Inventory deduction worker
   started (polling every 2s).` and the API's listening line. Traffic is
   still paused, so this only proves the new code is live, not that it has
   processed a real request yet.
6. Render dashboard → Settings → Maintenance Mode → **Disable.** Traffic
   resumes 100% on the new API, and the new frontend is already confirmed
   live from step 4 — no window existed where old/new API code or old/new
   frontend code both saw live traffic.
7. Smoke-check a real checkout end-to-end: confirm
   `inventory_deduction_status` transitions `pending → completed` within a
   few seconds, and run the existing R5 read-only-GET check (`GET
   /api/transactions/by-idempotency-key/<nonexistent key>?branch_id=<real
   branch>` returns `404` with no `checkout_attempts` row created).
8. Owner's call, not required by this task: downgrade the plan back
   afterward if the paid tier was only wanted for this release window.

#### Branch B — owner does not want to touch billing right now

1. **Do not push.** There is no verified, available way on the current
   plan to stop new checkout writes while keeping the worker alive to
   drain in-flight ones, which base P15's own "Deploying"/"Rollback"
   sections above require for this release (per (3), this is no longer
   optional — it's the first rollout of the whole stack).
2. The only paths that could unblock this without a plan change are
   themselves not currently available: (a) Render Shell access, unverified
   on this plan and never exercised by the real pipeline either way, or
   (b) a confirmed-safe suspend/resume behavior, which would first need to
   be validated on a disposable low-stakes deploy — a separate, deliberate
   action this task does not authorize taking against the live service.
3. Until Branch A is approved or one of (2)'s paths is independently
   validated, this release stays blocked on exactly the condition the
   "If the plan is confirmed free" section above already states — this
   section just confirms that condition now definitely applies to the next
   push, rather than leaving it as a hypothetical "future change."
