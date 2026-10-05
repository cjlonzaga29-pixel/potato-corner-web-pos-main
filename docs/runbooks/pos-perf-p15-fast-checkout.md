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
   new application code — the old code never reads/writes the new
   columns/table, so running the migration first is backward-compatible.
2. Deploy the new application code. The worker starts automatically with
   the API process; no separate deployment or env var is required.
3. Verify in logs: `Inventory deduction worker started (polling every 2s).`

Multiple API instances/replicas are safe to run concurrently — every
instance polls the same `inventory_deduction_jobs` table, and the
claim-token guard (`inventory-deduction.repository.ts#claimBatch`) ensures
only one instance ever actually applies a given job.

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

See `apps/api/prisma/migrations/20261005150000_add_fast_checkout_background_deduction/rollback.sql`
for the schema rollback statements (manual — not run by `prisma migrate`).

Before rolling back:
1. Deploy the previous application code version **first**.
2. Drain any `pending`/`processing` `InventoryDeductionJob` rows — the
   previous code version has no worker to finish them, so any sale
   reserved-but-not-yet-deducted at the moment of rollback will show
   phantom `quantityReserved` forever unless cleared. For a small number of
   rows, void the affected sales (which releases the reservation) before
   dropping the column; for a larger number, write a one-off script that
   replays `applyDeduction` for every remaining pending job, then confirm
   `SELECT count(*) FROM inventory_deduction_jobs WHERE status IN ('pending','processing')` is `0`.
3. Run the rollback SQL.

## Known residual risks (see delivery report for full list)

- A `failed` job's reservation is only released by voiding that specific
  sale — there is no automated "give up and restore stock" path.
- `void`/`refund` against a `processing` job returns a 409 rather than
  blocking/retrying — the admin UI should surface this as "try again in a
  few seconds," not a hard failure.
