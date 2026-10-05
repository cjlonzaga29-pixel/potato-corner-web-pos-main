-- POS-PERF-P15: fast checkout with durable background inventory deduction.
--
-- Checkout no longer deducts inventory (ledger writes, audit rows, low-stock
-- notifications) synchronously inside the sale's own $transaction. It now
-- only reserves the required quantity (InventoryStock.quantityReserved) and
-- writes a durable InventoryDeductionJob row atomically with the sale; a
-- background worker claims that job and performs the real deduction. This
-- migration is purely additive — no existing column is dropped or
-- retyped, no existing row's data changes, and every new/altered column
-- defaults safely for pre-existing rows (quantityReserved=0, idempotencyKey
-- stays NULL for every row that predates it).
--
-- Rollback: see the accompanying rollback.sql in this same migration
-- directory (not run by `prisma migrate`, kept for the runbook only).

-- AlterTable: InventoryStock — reservation column. Zero for every existing
-- row (there is nothing in flight to reserve for as of this migration), so
-- `quantityOnHand - quantityReserved` is immediately equal to today's
-- quantityOnHand for every item until the first reservation is made.
ALTER TABLE "inventory_stocks" ADD COLUMN "quantity_reserved" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable: Transaction — online-checkout idempotency key. NULL for every
-- existing row; Postgres never treats two NULLs as equal for a unique index,
-- so this cannot conflict with any pre-existing data.
ALTER TABLE "transactions" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateEnum
CREATE TYPE "InventoryDeductionJobStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "inventory_deduction_jobs" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "status" "InventoryDeductionJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "claim_token" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_deduction_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_deduction_jobs_transaction_id_key" ON "inventory_deduction_jobs"("transaction_id");
CREATE INDEX "inventory_deduction_jobs_status_next_attempt_at_idx" ON "inventory_deduction_jobs"("status", "next_attempt_at");
CREATE INDEX "inventory_deduction_jobs_branch_id_idx" ON "inventory_deduction_jobs"("branch_id");

ALTER TABLE "inventory_deduction_jobs" ADD CONSTRAINT "inventory_deduction_jobs_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
