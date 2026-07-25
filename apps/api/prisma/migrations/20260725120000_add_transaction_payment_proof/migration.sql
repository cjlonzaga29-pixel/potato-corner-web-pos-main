-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "payment_proof_key" TEXT,
ADD COLUMN     "payment_proof_type" "ImageProofType",
ADD COLUMN     "payment_proof_uploaded_at" TIMESTAMP(3),
ADD COLUMN     "payment_proof_verified_at" TIMESTAMP(3),
ADD COLUMN     "payment_proof_verified_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_proof_verified_by_id_fkey" FOREIGN KEY ("payment_proof_verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
