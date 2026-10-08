-- POS-PERF-P28R2 -- permanent cancellation terminal state for the
-- inventory-approval rollback gap. Purely additive: one new enum value and
-- three new nullable columns on the existing table; no existing row,
-- column, or constraint is altered or dropped.

-- AlterEnum
ALTER TYPE "InventoryApprovalStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "inventory_approval_requests" ADD COLUMN "cancelled_by_user_id" TEXT,
ADD COLUMN "cancelled_at" TIMESTAMP(3),
ADD COLUMN "cancel_reason" TEXT;
