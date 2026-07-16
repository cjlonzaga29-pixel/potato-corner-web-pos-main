-- Phase 17: fraud detection engine.
-- discountCustomerIdEncrypted (AES-256-GCM, random IV per row) can never be
-- grouped/compared for equality, so the discount-ID-reuse rule needs a
-- deterministic HMAC-SHA256 companion column instead. The composite index
-- on fraud_alerts supports the nightly job's per-(branch, employee, alertType)
-- dedup lookup (fraudRepository.findRecentOpenAlert).

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "discount_customer_id_hash" TEXT;

-- CreateIndex
CREATE INDEX "transactions_discount_customer_id_hash_idx" ON "transactions"("discount_customer_id_hash");

-- CreateIndex
CREATE INDEX "fraud_alerts_branch_id_alert_type_status_idx" ON "fraud_alerts"("branch_id", "alert_type", "status");
