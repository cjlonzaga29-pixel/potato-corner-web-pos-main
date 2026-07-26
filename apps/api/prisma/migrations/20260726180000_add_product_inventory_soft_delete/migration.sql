-- AlterTable: soft-delete + audit metadata columns
ALTER TABLE "product_inventory" ADD COLUMN     "deleted_at" TIMESTAMP(3);
ALTER TABLE "product_inventory" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_inventory" ADD COLUMN     "reason" TEXT;
ALTER TABLE "product_inventory" ADD COLUMN     "created_by" TEXT;
ALTER TABLE "product_inventory" ADD COLUMN     "updated_by" TEXT;

-- DropIndex: existing constraint would block reusing (branch_id,
-- product_variant_id, ingredient_id, flavor_id) after a row is soft-deleted
DROP INDEX "product_inventory_branch_id_product_variant_id_ingredient_i_key";

-- CreateIndex: partial unique index — active-row uniqueness only, same
-- pattern as ingredients/recipes/branch_recipe_overrides (see
-- phase8_step2_soft_delete_ingredient_recipe and
-- cr_001_soft_delete_branch_recipe_override migrations)
CREATE UNIQUE INDEX "product_inventory_branch_id_product_variant_id_ingredient_i_key" ON "product_inventory"("branch_id", "product_variant_id", "ingredient_id", "flavor_id") WHERE "deleted_at" IS NULL;
