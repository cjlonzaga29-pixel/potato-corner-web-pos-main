-- TASK 115: item-specific unit conversion overrides. UnitConversion applies
-- one factor to every InventoryItem sharing a unit pair, which is wrong for
-- ingredients that differ by density (e.g. Cheese Flavor Powder: 1 tbsp = 7g
-- vs BBQ Flavor Powder: 1 tbsp = 6g). Adds a dedicated table scoped to
-- inventory_item_id; does not modify or remove unit_conversions.

-- CreateTable
CREATE TABLE "inventory_item_unit_conversions" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "from_unit_id" TEXT NOT NULL,
    "to_unit_id" TEXT NOT NULL,
    "factor" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_unit_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_unit_conversions_inventory_item_id_from_un_key" ON "inventory_item_unit_conversions"("inventory_item_id", "from_unit_id", "to_unit_id");

-- CreateIndex
CREATE INDEX "inventory_item_unit_conversions_inventory_item_id_idx" ON "inventory_item_unit_conversions"("inventory_item_id");

-- CreateIndex
CREATE INDEX "inventory_item_unit_conversions_from_unit_id_idx" ON "inventory_item_unit_conversions"("from_unit_id");

-- CreateIndex
CREATE INDEX "inventory_item_unit_conversions_to_unit_id_idx" ON "inventory_item_unit_conversions"("to_unit_id");

-- AddForeignKey
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_from_unit_id_fkey" FOREIGN KEY ("from_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_to_unit_id_fkey" FOREIGN KEY ("to_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
