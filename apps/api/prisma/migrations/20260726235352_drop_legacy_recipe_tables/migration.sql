/*
  Warnings:

  - You are about to drop the `branch_recipe_overrides` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `recipes` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_created_by_fkey";

-- DropForeignKey
ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_flavor_id_fkey";

-- DropForeignKey
ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_ingredient_id_fkey";

-- DropForeignKey
ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_product_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_flavor_id_fkey";

-- DropForeignKey
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_ingredient_id_fkey";

-- DropForeignKey
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_product_variant_id_fkey";

-- DropTable
DROP TABLE "branch_recipe_overrides";

-- DropTable
DROP TABLE "recipes";
