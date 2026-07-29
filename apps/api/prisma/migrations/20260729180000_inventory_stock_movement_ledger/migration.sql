-- Branch inventory cutover -- append-only movement ledger for InventoryStock.
-- Additive only: no existing table, column, or constraint is altered. The
-- legacy InventoryMovement table (keyed on Ingredient) is untouched and
-- keeps recording legacy-path changes; this table records every
-- InventoryStock.quantity_on_hand change going forward, written in the same
-- transaction as the balance update it explains.

-- CreateEnum
CREATE TYPE "InventoryStockMovementType" AS ENUM ('RECEIVING', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'WASTE', 'TRANSFER_IN', 'TRANSFER_OUT', 'PHYSICAL_COUNT', 'SALE', 'SALE_REVERSAL');

-- CreateTable
CREATE TABLE "inventory_stock_movements" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "movement_type" "InventoryStockMovementType" NOT NULL,
    "quantity_change" DECIMAL(10,3) NOT NULL,
    "quantity_before" DECIMAL(10,3) NOT NULL,
    "quantity_after" DECIMAL(10,3) NOT NULL,
    "unit_id" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "notes" TEXT,
    "performed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_stock_movements_branch_id_inventory_item_id_idx" ON "inventory_stock_movements"("branch_id", "inventory_item_id");

-- CreateIndex
CREATE INDEX "inventory_stock_movements_inventory_item_id_idx" ON "inventory_stock_movements"("inventory_item_id");

-- CreateIndex
CREATE INDEX "inventory_stock_movements_created_at_idx" ON "inventory_stock_movements"("created_at");

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
