/*
  Warnings:

  - Made the column `ingredient_name` on table `flavors` required. This step will fail if there are existing NULL values in that column.
  - Made the column `ingredient_unit` on table `flavors` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "flavors" ALTER COLUMN "ingredient_name" SET NOT NULL,
ALTER COLUMN "ingredient_unit" SET NOT NULL;
