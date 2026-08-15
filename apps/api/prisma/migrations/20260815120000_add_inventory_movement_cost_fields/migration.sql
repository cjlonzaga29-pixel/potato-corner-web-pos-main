-- Inventory cost accountability: receiving, waste, and transfer movements
-- carried quantity but never a monetary cost, so there was no way to value
-- inventory, compute COGS-adjacent waste loss, or attribute waste to a
-- specific staff member. unit_cost/total_cost snapshot the carrying cost at
-- the moment of the movement (never recomputed later); responsible_user_id
-- separates "who is accountable" (WASTE) from performed_by_user_id ("who
-- recorded it").
--
-- Nullable, no backfill: every existing row predates cost capture and must
-- read as "cost not initialized", never as a fake 0.

-- AlterTable
ALTER TABLE "inventory_stock_movements" ADD COLUMN "unit_cost" DECIMAL(10,4);
ALTER TABLE "inventory_stock_movements" ADD COLUMN "total_cost" DECIMAL(12,4);
ALTER TABLE "inventory_stock_movements" ADD COLUMN "responsible_user_id" TEXT;
