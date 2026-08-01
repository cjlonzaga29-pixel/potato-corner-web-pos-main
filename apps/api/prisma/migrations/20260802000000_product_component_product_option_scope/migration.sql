-- Product-Option-scoped BOM components. Adds a nullable product_option_id to
-- product_components so a variant can carry both option-agnostic rows
-- (product_option_id NULL -- base component, not dependent on a Product
-- Option) and rows that only apply when a specific Product Option is
-- selected. Same nullable-scope pattern as flavor_id (see migration
-- 20260729170000_product_component_flavor_scope). Additive only: no column
-- is dropped, renamed, or has its existing values changed. Existing rows
-- stay option-agnostic (NULL) since none of them are option-scoped today.

-- AlterTable
ALTER TABLE "product_components" ADD COLUMN "product_option_id" TEXT;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_product_option_id_fkey" FOREIGN KEY ("product_option_id") REFERENCES "product_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "product_components_product_option_id_idx" ON "product_components"("product_option_id");
