-- AlterTable
ALTER TABLE "product_inventory" ADD COLUMN     "branch_id" TEXT;

-- Backfill branch_id from the related Ingredient row (ingredient_id -> ingredients.branch_id)
UPDATE "product_inventory" pi
SET "branch_id" = i."branch_id"
FROM "ingredients" i
WHERE pi."ingredient_id" = i."id";

-- Null guard: abort the migration if any row could not be backfilled
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "product_inventory" WHERE "branch_id" IS NULL) THEN
    RAISE EXCEPTION 'product_inventory has rows with NULL branch_id after backfill';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "product_inventory" ALTER COLUMN "branch_id" SET NOT NULL;

-- DropIndex
DROP INDEX "product_inventory_product_variant_id_ingredient_id_flavor_i_key";

-- CreateIndex
CREATE UNIQUE INDEX "product_inventory_branch_id_product_variant_id_ingredient_i_key" ON "product_inventory"("branch_id", "product_variant_id", "ingredient_id", "flavor_id");

-- CreateIndex
CREATE INDEX "product_inventory_branch_id_idx" ON "product_inventory"("branch_id");

-- AddForeignKey
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
