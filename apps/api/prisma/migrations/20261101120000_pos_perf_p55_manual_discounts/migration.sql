-- POS-PERF-P55 — manual peso discounts: supervisor-managed discount types,
-- a server-side registry of discount-proof uploads, and the per-sale manual
-- discount reference/snapshot.
-- See docs/runbooks/pos-perf-p55-manual-discounts-and-proof.md.
--
-- Additive only. Two new tables; two nullable columns without a default on
-- transactions (metadata-only on PostgreSQL 11+, no table rewrite, no scan).
-- No existing row is changed: every pre-P55 sale keeps NULL in the new
-- columns, and no promotion, discount setting or proof is converted.
--
-- transactions is the checkout hot table, so:
--   * no index on transactions.manual_discount_type_id (nothing queries by
--     it on the hot path; CREATE INDEX would block sale inserts while it
--     scans the table);
--   * its foreign key is added NOT VALID (no scan, brief lock only) and
--     validated in the next migration under SHARE UPDATE EXCLUSIVE, which
--     does not block inserts.
-- An older API ignores all of this: its inserts leave the new columns NULL
-- and it never reads the new tables.

-- CreateTable
CREATE TABLE "manual_discount_types" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apply_to_pos" BOOLEAN NOT NULL DEFAULT true,
    "require_proof" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "deactivated_at" TIMESTAMP(3),
    "deactivated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_discount_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_proof_uploads" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "proof_type" "ImageProofType" NOT NULL,
    "transaction_id" TEXT,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_proof_uploads_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "manual_discount_type_id" TEXT,
ADD COLUMN "manual_discount_snapshot" JSONB;

-- CreateIndex
CREATE INDEX "manual_discount_types_branch_id_is_active_idx" ON "manual_discount_types"("branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "discount_proof_uploads_storage_key_key" ON "discount_proof_uploads"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "discount_proof_uploads_transaction_id_key" ON "discount_proof_uploads"("transaction_id");

-- CreateIndex
CREATE INDEX "discount_proof_uploads_branch_id_created_at_idx" ON "discount_proof_uploads"("branch_id", "created_at");

-- AddForeignKey
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_deactivated_by_id_fkey" FOREIGN KEY ("deactivated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_proof_uploads" ADD CONSTRAINT "discount_proof_uploads_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_proof_uploads" ADD CONSTRAINT "discount_proof_uploads_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_proof_uploads" ADD CONSTRAINT "discount_proof_uploads_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (NOT VALID: validated in 20261101120100 without blocking checkout inserts)
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_manual_discount_type_id_fkey" FOREIGN KEY ("manual_discount_type_id") REFERENCES "manual_discount_types"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
