-- Flavor-scoped BOM components. Adds a nullable flavor_id to
-- product_components so a variant can carry both flavor-agnostic rows
-- (flavor_id NULL -- packaging, base powder, etc.) and rows that only apply
-- when a specific flavor is selected (e.g. the flavor-specific seasoning).
-- Additive only: no column is dropped, renamed, or has its existing values
-- changed. Existing rows stay flavor-agnostic (NULL) since none of them are
-- flavor-scoped today.

-- AlterTable
ALTER TABLE "product_components" ADD COLUMN "flavor_id" TEXT;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_flavor_id_fkey" FOREIGN KEY ("flavor_id") REFERENCES "flavors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "product_components_flavor_id_idx" ON "product_components"("flavor_id");
