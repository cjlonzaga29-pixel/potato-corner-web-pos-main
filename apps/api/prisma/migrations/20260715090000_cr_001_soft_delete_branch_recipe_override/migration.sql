-- Add soft-delete column
ALTER TABLE "branch_recipe_overrides" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Replace the plain unique index with a partial one (WHERE deleted_at IS
-- NULL), so a soft-deleted override's ingredient+flavor combination can be
-- reused by a new override for the same branch — same reasoning as
-- recipes' partial unique index.
DROP INDEX "branch_recipe_overrides_branch_id_product_variant_id_ingred_key";
CREATE UNIQUE INDEX "branch_recipe_overrides_branch_id_product_variant_id_ingred_key" ON "branch_recipe_overrides"("branch_id", "product_variant_id", "ingredient_id", "flavor_id") WHERE "deleted_at" IS NULL;
