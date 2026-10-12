-- AlterTable
ALTER TABLE "inventory_approval_requests" ADD COLUMN     "staff_involved_name" TEXT;

-- AlterTable
ALTER TABLE "inventory_stock_movements" ADD COLUMN     "staff_involved_name" TEXT;
