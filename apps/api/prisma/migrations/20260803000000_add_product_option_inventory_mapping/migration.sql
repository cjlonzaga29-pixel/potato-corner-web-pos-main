-- TASK 74: dedicated inventory deduction owned directly by ProductOption,
-- global across products/variants (distinct from product_components, which
-- is scoped to a product_variant). One product_option has zero or one
-- mapping (unique constraint on product_option_id). Category/base unit are
-- intentionally not stored here -- derive them from inventory_items.
-- Creates only this table, its constraints, indexes, and foreign keys. Does
-- not touch product_components or migrate any existing data.

-- CreateTable
CREATE TABLE "product_option_inventory_mappings" (
    "id" TEXT NOT NULL,
    "product_option_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "quantity_required" DECIMAL(18,6) NOT NULL,
    "deduction_unit_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_option_inventory_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_option_inventory_mappings_product_option_id_key" ON "product_option_inventory_mappings"("product_option_id");

-- CreateIndex
CREATE INDEX "product_option_inventory_mappings_inventory_item_id_idx" ON "product_option_inventory_mappings"("inventory_item_id");

-- CreateIndex
CREATE INDEX "product_option_inventory_mappings_deduction_unit_id_idx" ON "product_option_inventory_mappings"("deduction_unit_id");

-- AddForeignKey
ALTER TABLE "product_option_inventory_mappings" ADD CONSTRAINT "product_option_inventory_mappings_product_option_id_fkey" FOREIGN KEY ("product_option_id") REFERENCES "product_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_inventory_mappings" ADD CONSTRAINT "product_option_inventory_mappings_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_inventory_mappings" ADD CONSTRAINT "product_option_inventory_mappings_deduction_unit_id_fkey" FOREIGN KEY ("deduction_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
