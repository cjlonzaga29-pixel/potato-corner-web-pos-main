-- Phase 10: transactions module. Additive only — every column below is new;
-- transaction_number, subtotal, discount_amount, vat_amount, total_amount,
-- amount_tendered, change_amount, gcash_reference, discount_type,
-- discount_customer_id_encrypted, inventory_deduction_status,
-- is_offline_transaction, offline_provisional_number, synced_at already
-- exist from the init migration and are untouched.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "vat_exempt_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "transactions" ADD COLUMN "gcash_manually_verified" BOOLEAN;
ALTER TABLE "transactions" ADD COLUMN "receipt_printed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transactions" ADD COLUMN "voided_at" TIMESTAMP(3);
ALTER TABLE "transactions" ADD COLUMN "voided_by_id" TEXT;
ALTER TABLE "transactions" ADD COLUMN "void_reason" TEXT;
ALTER TABLE "transactions" ADD COLUMN "refunded_at" TIMESTAMP(3);
ALTER TABLE "transactions" ADD COLUMN "refunded_by_id" TEXT;
ALTER TABLE "transactions" ADD COLUMN "refund_reason" TEXT;
ALTER TABLE "transactions" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refunded_by_id_fkey" FOREIGN KEY ("refunded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RedefineIndex: [branch_id] -> [branch_id, created_at] (leftmost-prefix superset, no query loses coverage)
DROP INDEX "transactions_branch_id_idx";
CREATE INDEX "transactions_branch_id_created_at_idx" ON "transactions"("branch_id", "created_at");

-- AddForeignKey: transaction_items.product_id existed since init but was never
-- given a relation — flagged as missing in the Phase 10 audit.
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "transaction_items_product_variant_id_idx" ON "transaction_items"("product_variant_id");
