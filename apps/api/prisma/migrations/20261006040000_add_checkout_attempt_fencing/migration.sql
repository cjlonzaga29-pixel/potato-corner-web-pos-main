-- POS-PERF-P15R3: durable server-side fencing for a checkout attempt,
-- replacing the client-side "poll for ~17s, then assume not-found means
-- safe to mint a replacement key" protocol. That protocol never actually
-- proved the original request was done -- it could still be mid-flight
-- past the poll window (slow DB, GC pause, long lock wait) and commit a
-- moment later, which could mint a second idempotency key under it and
-- risk a duplicate sale.
--
-- checkout_attempts is a compare-and-swap ledger keyed by the same
-- idempotencyKey the Transaction row uses: claiming it (see
-- transactions.service.ts claimCheckoutAttempt) is an atomic
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE, so a key already 'committed'
-- or genuinely still 'in_progress' (live lease) can never be reclaimed by a
-- second request. Only a 'failed' row or an 'in_progress' row whose lease
-- has expired can be reclaimed, and even then the original holder's own
-- commit step re-checks its owner_token before finalizing -- so a "dead"
-- holder that was actually still alive gets ITS OWN commit rolled back
-- instead of allowing a silent duplicate.
--
-- Purely additive: a new table and a new nullable FK column
-- (transactions.* is untouched), no existing data changes.

-- CreateEnum
CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('in_progress', 'committed', 'failed');

-- CreateTable
CREATE TABLE "checkout_attempts" (
    "idempotency_key" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "cashier_id" TEXT NOT NULL,
    "status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'in_progress',
    "transaction_id" TEXT,
    "owner_token" TEXT NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("idempotency_key")
);

CREATE UNIQUE INDEX "checkout_attempts_transaction_id_key" ON "checkout_attempts"("transaction_id");
CREATE INDEX "checkout_attempts_branch_id_idx" ON "checkout_attempts"("branch_id");

ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
