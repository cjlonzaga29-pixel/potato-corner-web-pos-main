-- CR-006 Phase A corrective pass — see docs/decisions/CR-007-universal-inventory-domain-finalization.md
-- Phase A tables were verified empty before this migration was written; no data migration needed.

-- DropForeignKey
ALTER TABLE "product_components" DROP CONSTRAINT "product_components_flavor_slot_id_fkey";

-- DropIndex
DROP INDEX "inventory_items_category_idx";

-- DropIndex
DROP INDEX "product_components_flavor_slot_id_idx";

-- AlterTable
ALTER TABLE "inventory_items" DROP COLUMN "category",
DROP COLUMN "unit_cost",
ADD COLUMN     "category_id" TEXT;

-- AlterTable
ALTER TABLE "product_components" DROP COLUMN "flavor_slot_id";

-- AlterTable
ALTER TABLE "units_of_measure" DROP COLUMN "conversion_to_base",
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- DropEnum
DROP TYPE "InventoryCategory";

-- CreateTable
CREATE TABLE "inventory_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_conversions" (
    "id" TEXT NOT NULL,
    "from_unit_id" TEXT NOT NULL,
    "to_unit_id" TEXT NOT NULL,
    "factor" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_conversions_from_unit_id_to_unit_id_key" ON "unit_conversions"("from_unit_id", "to_unit_id");

-- CreateIndex
CREATE INDEX "inventory_items_category_id_idx" ON "inventory_items"("category_id");

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_from_unit_id_fkey" FOREIGN KEY ("from_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_to_unit_id_fkey" FOREIGN KEY ("to_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
