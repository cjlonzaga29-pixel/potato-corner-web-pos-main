-- POS-PERF-P57 — manual discount types: staff-entered or fixed peso amount,
-- optional product eligibility, and a link between rows that one supervisor
-- action created for several branches.
-- See docs/runbooks/pos-perf-p57-shortages-and-workflow-simplification.md.
--
-- Additive only. Constant defaults are metadata-only on PostgreSQL 11+. Every
-- existing type becomes what it already was: staff-entered, whole order, one
-- branch. transactions is not touched; past sales keep their own snapshots.
--
-- An older API ignores all of this and would offer every active type as
-- staff-entered for the whole order, so fixed and product-limited types must
-- be taken off the POS before rolling the API back (see the runbook).

-- AlterTable
ALTER TABLE "manual_discount_types"
    ADD COLUMN "amount_mode" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "fixed_amount" DECIMAL(10,2),
    ADD COLUMN "product_scope" TEXT NOT NULL DEFAULT 'all',
    ADD COLUMN "group_id" TEXT;

-- The table is small and new in P55, so these are validated immediately.
ALTER TABLE "manual_discount_types"
    ADD CONSTRAINT "manual_discount_types_amount_mode_check" CHECK ("amount_mode" IN ('manual', 'fixed')),
    ADD CONSTRAINT "manual_discount_types_fixed_amount_check" CHECK (
        ("amount_mode" = 'fixed' AND "fixed_amount" IS NOT NULL AND "fixed_amount" > 0)
        OR ("amount_mode" = 'manual' AND "fixed_amount" IS NULL)
    ),
    ADD CONSTRAINT "manual_discount_types_product_scope_check" CHECK ("product_scope" IN ('all', 'selected'));

-- CreateIndex
CREATE INDEX "manual_discount_types_group_id_idx" ON "manual_discount_types"("group_id");

-- CreateTable
CREATE TABLE "manual_discount_type_products" (
    "manual_discount_type_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "manual_discount_type_products_pkey" PRIMARY KEY ("manual_discount_type_id","product_id")
);

-- CreateIndex
CREATE INDEX "manual_discount_type_products_product_id_idx" ON "manual_discount_type_products"("product_id");

-- AddForeignKey
ALTER TABLE "manual_discount_type_products" ADD CONSTRAINT "manual_discount_type_products_manual_discount_type_id_fkey" FOREIGN KEY ("manual_discount_type_id") REFERENCES "manual_discount_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_discount_type_products" ADD CONSTRAINT "manual_discount_type_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
