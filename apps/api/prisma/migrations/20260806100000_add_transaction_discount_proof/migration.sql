-- Task 209.5: PWD/Senior Citizen discount proof photo (compliance evidence).
-- Mirrors the payment_proof_key/type/uploaded_at shape added by
-- 20260725120000_add_transaction_payment_proof, but kept in its own columns
-- and its own `discount-proofs` storage bucket -- never mixed with payment
-- proof evidence.
-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "discount_proof_key" TEXT,
ADD COLUMN     "discount_proof_type" "ImageProofType",
ADD COLUMN     "discount_proof_uploaded_at" TIMESTAMP(3);
