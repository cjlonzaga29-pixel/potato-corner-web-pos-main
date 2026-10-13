-- CreateEnum
CREATE TYPE "catalog_resource_type" AS ENUM ('PRODUCT', 'PRODUCT_CATEGORY', 'PRODUCT_OPTION_GROUP', 'PRODUCT_OPTION', 'INVENTORY_CATEGORY', 'UNIT_OF_MEASURE', 'UNIT_CONVERSION', 'INVENTORY_ITEM');

-- AlterTable
ALTER TABLE "inventory_categories" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "product_option_groups" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "product_options" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "unit_conversions" ADD COLUMN     "managed_by" TEXT;

-- AlterTable
ALTER TABLE "units_of_measure" ADD COLUMN     "managed_by" TEXT;

-- CreateTable
CREATE TABLE "catalog_management_assignments" (
    "id" TEXT NOT NULL,
    "resource_type" "catalog_resource_type" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "previous_managed_by" TEXT,
    "new_managed_by" TEXT NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "branch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_management_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_management_assignments_resource_type_resource_id_idx" ON "catalog_management_assignments"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "catalog_management_assignments_new_managed_by_idx" ON "catalog_management_assignments"("new_managed_by");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_new_managed_by_fkey" FOREIGN KEY ("new_managed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
