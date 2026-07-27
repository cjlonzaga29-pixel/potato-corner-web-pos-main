-- CR-006 Phase A final schema completion — see docs/decisions/CR-007-universal-inventory-domain-finalization.md
-- Phase A tables (inventory_categories, units_of_measure, unit_conversions,
-- inventory_items, inventory_identity_mappings, inventory_stocks,
-- product_components) were verified empty before this migration was
-- written; no data migration needed.

-- CreateEnum
CREATE TYPE "InventoryMappingStatus" AS ENUM ('PENDING', 'AUTO_MATCHED', 'MANUALLY_MATCHED', 'AMBIGUOUS', 'REJECTED');

-- CreateEnum
CREATE TYPE "InventoryMappingMethod" AS ENUM ('NORMALIZED_NAME_UNIT_CATEGORY', 'FLAVOR_IDENTITY', 'MANUAL', 'IMPORT');

-- AlterTable
ALTER TABLE "inventory_identity_mappings" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "mapping_method" "InventoryMappingMethod",
ADD COLUMN     "mapping_status" "InventoryMappingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "inventory_item_id" DROP NOT NULL,
ALTER COLUMN "migration_batch" DROP NOT NULL,
ALTER COLUMN "migrated_at" DROP NOT NULL,
ALTER COLUMN "migrated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inventory_items" DROP COLUMN "critical_threshold",
DROP COLUMN "low_stock_threshold";

-- AlterTable
ALTER TABLE "inventory_stocks" ADD COLUMN     "critical_threshold" DECIMAL(10,3),
ADD COLUMN     "low_stock_threshold" DECIMAL(10,3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_components" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "quantity_required" SET DATA TYPE DECIMAL(18,6);
