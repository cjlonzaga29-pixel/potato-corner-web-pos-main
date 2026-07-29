-- Admin Inventory Valuation cutover: unit cost source for InventoryItem/InventoryStock.
-- InventoryItem.unit_cost is the default per-unit cost; InventoryStock.unit_cost is an
-- optional branch-specific override. Both nullable -- null means "no cost recorded yet",
-- not "cost is zero".
ALTER TABLE "inventory_items" ADD COLUMN "unit_cost" DECIMAL(10,4);

ALTER TABLE "inventory_stocks" ADD COLUMN "unit_cost" DECIMAL(10,4);
