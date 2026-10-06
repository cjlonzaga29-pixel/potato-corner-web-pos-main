-- Manual rollback for 20261005150000_add_fast_checkout_background_deduction.
-- NOT run automatically by `prisma migrate` — this is a runbook artifact
-- only. Before running this against a real environment:
--   1. Stop the API process (or at minimum disable the inventory-deduction
--      worker) so nothing claims/writes InventoryDeductionJob rows while
--      this runs.
--   2. Confirm there are no 'pending'/'processing' InventoryDeductionJob
--      rows left (drain them first — see docs/runbooks for the drain
--      script) or you will be left with sales that were reserved but never
--      actually deducted from quantityOnHand.
--   3. Revert the application code in the same deploy as this rollback —
--      running old code against the new schema (or vice versa) is exactly
--      the deploy-overlap scenario the worker's claim-token design protects
--      against for job rows, but the application code itself is not
--      forward/backward-schema-compatible across this migration.

ALTER TABLE "inventory_deduction_jobs" DROP CONSTRAINT IF EXISTS "inventory_deduction_jobs_transaction_id_fkey";
DROP TABLE IF EXISTS "inventory_deduction_jobs";
DROP TYPE IF EXISTS "InventoryDeductionJobStatus";

DROP INDEX IF EXISTS "transactions_idempotency_key_key";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "idempotency_key";

ALTER TABLE "inventory_stocks" DROP COLUMN IF EXISTS "quantity_reserved";
