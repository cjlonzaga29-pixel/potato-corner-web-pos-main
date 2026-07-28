-- CR-012.1 -- Shadow BOM Deduction Calculation.
--
-- Append-only comparison table: for every eligible completed sale line,
-- records what the future ProductComponent/BOM deduction would have been
-- versus the legacy ProductInventory deduction that actually ran, in
-- shadow. Nothing in this migration touches an existing table, column, or
-- constraint -- purely additive, per CR-012.1 scope.

-- CreateEnum
CREATE TYPE "ShadowBomComparisonClassification" AS ENUM ('MATCH', 'BOM_NOT_READY', 'MISSING_LEGACY_MAPPING', 'MISSING_BOM_COMPONENT', 'EXTRA_BOM_COMPONENT', 'QUANTITY_MISMATCH', 'UNIT_CONVERSION_UNSUPPORTED', 'FLAVOR_DEPENDENCY', 'ERROR');

-- CreateTable
CREATE TABLE "shadow_bom_comparisons" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "sale_line_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "legacy_calculation" JSONB NOT NULL,
    "bom_calculation" JSONB,
    "classification" "ShadowBomComparisonClassification" NOT NULL,
    "error_details" JSONB,
    "compared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_bom_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shadow_bom_comparisons_transaction_id_sale_line_id_key" ON "shadow_bom_comparisons"("transaction_id", "sale_line_id");

-- CreateIndex
CREATE INDEX "shadow_bom_comparisons_classification_idx" ON "shadow_bom_comparisons"("classification");

-- CreateIndex
CREATE INDEX "shadow_bom_comparisons_branch_id_idx" ON "shadow_bom_comparisons"("branch_id");

-- CreateIndex
CREATE INDEX "shadow_bom_comparisons_product_variant_id_idx" ON "shadow_bom_comparisons"("product_variant_id");

-- CreateIndex
CREATE INDEX "shadow_bom_comparisons_compared_at_idx" ON "shadow_bom_comparisons"("compared_at");
