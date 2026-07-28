-- CR-011.1 -- Recipe/BOM foundation on ProductComponent.
--
-- CreateIndex: active-row uniqueness on (product_variant_id,
-- inventory_item_id), same partial-unique-index pattern as
-- product_inventory/ingredients/recipes (WHERE deleted_at IS NULL) so a
-- soft-deleted component's variant+item pair can be reused by a new
-- component. Prisma's schema DSL cannot express a partial index, so this
-- is applied via raw SQL only -- see the comment on ProductComponent in
-- schema.prisma.
CREATE UNIQUE INDEX "product_components_product_variant_id_inventory_item_id_key" ON "product_components"("product_variant_id", "inventory_item_id") WHERE "deleted_at" IS NULL;
