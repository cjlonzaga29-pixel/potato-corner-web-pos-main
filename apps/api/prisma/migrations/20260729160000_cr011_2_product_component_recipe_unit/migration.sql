-- CR-011.2 -- Recipe/BOM unit conversion. Adds a nullable recipe_unit_id to
-- product_components so a component's quantity can be authored in a unit
-- other than the InventoryItem's base unit (e.g. grams for a kg-based item).
-- Additive only: no column is dropped, renamed, or has its existing values
-- changed.

-- AlterTable
ALTER TABLE "product_components" ADD COLUMN "recipe_unit_id" TEXT;

-- Backfill: every existing row's implicit unit was always the mapped
-- InventoryItem's base unit (CR-011.1's original "Base-unit quantity"
-- comment) -- reflect that explicitly rather than leaving it null.
UPDATE "product_components" pc
SET "recipe_unit_id" = ii."base_unit_id"
FROM "inventory_items" ii
WHERE pc."inventory_item_id" = ii."id";

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_recipe_unit_id_fkey" FOREIGN KEY ("recipe_unit_id") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "product_components_recipe_unit_id_idx" ON "product_components"("recipe_unit_id");
