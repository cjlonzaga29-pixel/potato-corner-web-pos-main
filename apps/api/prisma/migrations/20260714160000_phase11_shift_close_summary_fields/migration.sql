-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "cash_sales_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gcash_sales_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pwd_sc_transaction_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refunded_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total_transaction_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voided_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "updated_at" DROP DEFAULT;
