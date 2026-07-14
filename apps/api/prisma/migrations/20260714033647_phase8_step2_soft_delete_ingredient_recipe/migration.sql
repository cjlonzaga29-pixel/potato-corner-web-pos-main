-- Add soft-delete columns
ALTER TABLE "ingredients" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "recipes" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Replace the plain unique indexes added in the previous migration with
-- partial ones (WHERE deleted_at IS NULL), so a soft-deleted row's name /
-- ingredient+flavor combination can be reused by a new row.
DROP INDEX "ingredients_branch_id_name_key";
CREATE UNIQUE INDEX "ingredients_branch_id_name_key" ON "ingredients"("branch_id", "name") WHERE "deleted_at" IS NULL;

DROP INDEX "recipes_product_variant_id_ingredient_id_flavor_id_key";
CREATE UNIQUE INDEX "recipes_product_variant_id_ingredient_id_flavor_id_key" ON "recipes"("product_variant_id", "ingredient_id", "flavor_id") WHERE "deleted_at" IS NULL;
