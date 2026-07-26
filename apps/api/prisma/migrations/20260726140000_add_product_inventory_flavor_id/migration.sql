-- AlterTable
ALTER TABLE "product_inventory" ADD COLUMN "flavor_id" TEXT;

-- DropIndex
DROP INDEX "product_inventory_product_variant_id_ingredient_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "product_inventory_product_variant_id_ingredient_id_flavor_i_key" ON "product_inventory"("product_variant_id", "ingredient_id", "flavor_id");

-- CreateIndex
CREATE INDEX "product_inventory_flavor_id_idx" ON "product_inventory"("flavor_id");

-- AddForeignKey
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_flavor_id_fkey" FOREIGN KEY ("flavor_id") REFERENCES "flavors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
