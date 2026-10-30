-- POS-PERF-P49 — product classification + product-scoped promotions.
-- See docs/runbooks/pos-perf-p49-promotional-seasonal-products-and-discounts.md.
--
-- Additive only. Every new column on an existing table has a constant
-- default or is nullable (metadata-only on PostgreSQL 11+, no table rewrite).
-- No existing price, status, availability or sale row is changed here; the
-- classification backfill runs in the next migration (20261030120100) so the
-- ACCESS EXCLUSIVE lock from ADD COLUMN on products is released first.
--
-- transaction_items is the checkout hot table, so:
--   * no index on transaction_items.promotion_id (nothing queries by it and
--     promotions are never deleted; a CREATE INDEX would block sale inserts
--     while it scans the table);
--   * its foreign key is added NOT VALID (no scan, brief lock only) and
--     validated in the next migration under SHARE UPDATE EXCLUSIVE, which
--     does not block inserts. Every existing row is NULL anyway.
-- An older API ignores all of this: its inserts get discount_amount 0 and
-- NULL promotion fields, and it never reads the new tables.

-- CreateEnum
CREATE TYPE "ProductClassification" AS ENUM ('regular', 'promotional', 'seasonal');

-- CreateEnum
CREATE TYPE "PromotionDiscountKind" AS ENUM ('percentage', 'fixed_amount');

-- AlterTable
ALTER TABLE "products" ADD COLUMN "classification" "ProductClassification" NOT NULL DEFAULT 'regular';

-- AlterTable
ALTER TABLE "transaction_items" ADD COLUMN "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "promotion_id" TEXT,
ADD COLUMN "promotion_snapshot" JSONB;

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discount_kind" "PromotionDiscountKind" NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "starts_on" DATE,
    "ends_on" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_products" (
    "promotion_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "promotion_products_pkey" PRIMARY KEY ("promotion_id","product_id")
);

-- CreateTable
CREATE TABLE "promotion_branches" (
    "promotion_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,

    CONSTRAINT "promotion_branches_pkey" PRIMARY KEY ("promotion_id","branch_id")
);

-- CreateIndex
CREATE INDEX "promotions_is_enabled_idx" ON "promotions"("is_enabled");

-- CreateIndex
CREATE INDEX "promotion_products_product_id_idx" ON "promotion_products"("product_id");

-- CreateIndex
CREATE INDEX "promotion_branches_branch_id_idx" ON "promotion_branches"("branch_id");

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NOT VALID — validated in 20261030120100)
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
