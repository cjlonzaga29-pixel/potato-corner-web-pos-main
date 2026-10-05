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

**Required deployment procedure** (prevents old writers from ever sharing
traffic with new writers against the same stock rows):

- Do **not** use a gradual/canary rolling update for this specific release
  — any strategy where old and new containers both receive live checkout
  traffic for more than an instant is unsafe for this change, regardless
  of how briefly they overlap.
- Prefer a deploy strategy with **no mixed-version serving window**:
  scale to a single replica (or use the platform's "recreate" rather than
  "rolling" strategy) for this deploy, so the old replica stops receiving
  traffic before the new one starts. On a platform that cannot guarantee
  this (e.g. a load balancer that drains old instances only after new ones
  pass a health check, with both briefly live), pause new checkout
  submissions at the gateway/load balancer for the swap window instead —
  a few seconds of "checkout temporarily unavailable" is strictly safer
  than a stock discrepancy or an oversold item.
- Schedule the deploy outside active shift hours where possible — the
  hazard only materializes if a checkout actually lands on an old
  instance while a new instance holds a live reservation on the same
  item, which is far less likely (though not impossible — a shift can
  still be open) with no shifts active.
- After the deploy, confirm every replica is on the new version (e.g. via
  the "Inventory deduction worker started" log line on each instance)
  before considering the rollout complete.

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
order drains everything *while new code (and its worker) is still live*,
confirms the ledger is clean, and only then swaps application code.

1. **While still running the new application code**, drain every
   `pending`/`processing` `InventoryDeductionJob` row to a terminal state:
   let the worker continue running (do not stop it yet), or for rows stuck
   `failed`, void the affected sale (releases the reservation) or use the
   admin retry-inventory-deduction action to force a fresh attempt. Confirm
   with `SELECT count(*) FROM inventory_deduction_jobs WHERE status IN ('pending','processing')` = `0`
   before proceeding. Do not stop the worker or deploy old code while this
   count is nonzero.
2. Once drained, **prefer rolling back application code only, and retain
   the additive schema** (`quantity_reserved`, `idempotency_key`, the
   `inventory_deduction_jobs` table). Old code never reads or writes any
   of these, so leaving them in place costs nothing and keeps the door
   open for a forward-fix without a second migration. This is sufficient
   for the overwhelming majority of rollback scenarios (a bug in the new
   application code, not in the schema itself).
3. Deploy the previous application code version, using the same
   no-mixed-version deployment procedure described above in "The actual
   rolling-deploy hazard" — old code is just as unsafe to run concurrently
   with new code on the way down as on the way up.
4. Only run the destructive schema rollback
   (`apps/api/prisma/migrations/20261005150000_add_fast_checkout_background_deduction/rollback.sql`,
   manual — not run by `prisma migrate`) if the feature is being fully
   decommissioned, not for an ordinary code revert. If you do run it,
   re-confirm step 1's drain count is still `0` immediately before —
   dropping `quantity_reserved` out from under a row some straggler
   request is still reserving against is a data-loss risk the column's
   own presence otherwise prevents.

## Known residual risks (see delivery report for full list)

- A `failed` job's reservation is only released by voiding that specific
  sale — there is no automated "give up and restore stock" path.
- `void`/`refund` against a `processing` job returns a 409 rather than
  blocking/retrying — the admin UI should surface this as "try again in a
  few seconds," not a hard failure.
