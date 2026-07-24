-- CreateEnum
CREATE TYPE "IngredientCategory" AS ENUM ('RAW', 'FLAVOR', 'CUP', 'BAG', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "VariantLifecycleStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "flavors" ADD COLUMN     "ingredient_name" TEXT,
ADD COLUMN     "ingredient_unit" TEXT;

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "category" "IngredientCategory" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_id" TEXT,
ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "last_change_reason" TEXT,
ADD COLUMN     "lifecycle_status" "VariantLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "flavor_slot_index" INTEGER;

-- AlterTable
ALTER TABLE "transaction_items" ADD COLUMN     "selected_flavors" JSONB;

-- CreateTable
CREATE TABLE "product_flavor_slots" (
    "id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "slot_index" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "flavor_qty" DECIMAL(10,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_flavor_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_change_logs" (
    "id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changed_by_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_flavor_slots_product_variant_id_idx" ON "product_flavor_slots"("product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_flavor_slots_product_variant_id_slot_index_key" ON "product_flavor_slots"("product_variant_id", "slot_index");

-- CreateIndex
CREATE INDEX "product_change_logs_product_variant_id_version_idx" ON "product_change_logs"("product_variant_id", "version");

-- CreateIndex
CREATE INDEX "product_change_logs_created_at_idx" ON "product_change_logs"("created_at");

-- CreateIndex
CREATE INDEX "product_variants_lifecycle_status_idx" ON "product_variants"("lifecycle_status");

-- CreateIndex
CREATE INDEX "product_variants_created_by_id_idx" ON "product_variants"("created_by_id");

-- CreateIndex
CREATE INDEX "product_variants_approved_by_id_idx" ON "product_variants"("approved_by_id");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flavor_slots" ADD CONSTRAINT "product_flavor_slots_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_change_logs" ADD CONSTRAINT "product_change_logs_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_change_logs" ADD CONSTRAINT "product_change_logs_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
