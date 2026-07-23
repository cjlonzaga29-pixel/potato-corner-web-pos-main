-- Add maya/other PaymentMethod enum values
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'maya';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'other';

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "maya_sales_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "maya_sales_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "other_sales_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "other_sales_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gross_sales_total" DECIMAL(10,2) NOT NULL DEFAULT 0;
