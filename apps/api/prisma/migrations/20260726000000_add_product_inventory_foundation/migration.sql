-- CreateTable
CREATE TABLE "product_inventory" (
    "id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "quantity_required" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_inventory_product_variant_id_idx" ON "product_inventory"("product_variant_id");

-- CreateIndex
CREATE INDEX "product_inventory_ingredient_id_idx" ON "product_inventory"("ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_inventory_product_variant_id_ingredient_id_key" ON "product_inventory"("product_variant_id", "ingredient_id");

-- AddForeignKey
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
