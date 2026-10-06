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

**Plan tier could not be verified from this environment.** Render's own
docs restrict Maintenance Mode to paid Web Services, and this repository
has no `RENDER_API_KEY`/dashboard credential configured anywhere a script
or assistant here can read — confirm the live plan at **Render dashboard →
the API service → Settings → Plan** before relying on any step below, and
re-confirm it any time the plan may have changed. Do not assume paid or
free; check it.

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
