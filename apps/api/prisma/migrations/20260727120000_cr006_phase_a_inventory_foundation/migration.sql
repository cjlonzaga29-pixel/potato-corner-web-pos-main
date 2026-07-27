-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM ('RAW', 'FLAVOR', 'CUP', 'BAG', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "UnitDimension" AS ENUM ('WEIGHT', 'VOLUME', 'COUNT');

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" "UnitDimension" NOT NULL,
    "is_base_unit" BOOLEAN NOT NULL DEFAULT false,
    "conversion_to_base" DECIMAL(18,8),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "category" "InventoryCategory" NOT NULL DEFAULT 'OTHER',
    "base_unit_id" TEXT NOT NULL,
    "track_inventory" BOOLEAN NOT NULL DEFAULT true,
    "low_stock_threshold" DECIMAL(10,3),
    "critical_threshold" DECIMAL(10,3),
    "unit_cost" DECIMAL(10,4),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_identity_mappings" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "legacy_ingredient_id" TEXT NOT NULL,
    "legacy_name" TEXT NOT NULL,
    "legacy_unit" TEXT NOT NULL,
    "migration_batch" TEXT NOT NULL,
    "migrated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_identity_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stocks" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "quantity_on_hand" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_components" (
    "id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "flavor_slot_id" TEXT,
    "quantity_required" DECIMAL(10,4) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("code");

-- CreateIndex
CREATE INDEX "inventory_items_category_idx" ON "inventory_items"("category");

-- CreateIndex
CREATE INDEX "inventory_items_base_unit_id_idx" ON "inventory_items"("base_unit_id");

-- CreateIndex
CREATE INDEX "inventory_identity_mappings_inventory_item_id_idx" ON "inventory_identity_mappings"("inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_identity_mappings_legacy_ingredient_id_key" ON "inventory_identity_mappings"("legacy_ingredient_id");

-- CreateIndex
CREATE INDEX "inventory_stocks_inventory_item_id_idx" ON "inventory_stocks"("inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocks_branch_id_inventory_item_id_key" ON "inventory_stocks"("branch_id", "inventory_item_id");

-- CreateIndex
CREATE INDEX "product_components_product_variant_id_idx" ON "product_components"("product_variant_id");

-- CreateIndex
CREATE INDEX "product_components_inventory_item_id_idx" ON "product_components"("inventory_item_id");

-- CreateIndex
CREATE INDEX "product_components_flavor_slot_id_idx" ON "product_components"("flavor_slot_id");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_identity_mappings" ADD CONSTRAINT "inventory_identity_mappings_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_identity_mappings" ADD CONSTRAINT "inventory_identity_mappings_legacy_ingredient_id_fkey" FOREIGN KEY ("legacy_ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_flavor_slot_id_fkey" FOREIGN KEY ("flavor_slot_id") REFERENCES "product_flavor_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CR-007 §3.4: sku/barcode are nullable, mutable business identifiers with
-- case-insensitive platform-wide uniqueness over non-null values. Partial
-- indexes -- Prisma's DSL cannot express WHERE-clause or lower() collation,
-- same limitation as the existing ingredients/product_inventory migrations.
CREATE UNIQUE INDEX "inventory_items_sku_ci_key" ON "inventory_items" (LOWER("sku")) WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "inventory_items_barcode_ci_key" ON "inventory_items" (LOWER("barcode")) WHERE "barcode" IS NOT NULL AND "deleted_at" IS NULL;
