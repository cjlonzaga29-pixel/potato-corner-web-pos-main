-- AuditLog: index on createdAt, the hash-chain lookup's sort key on every write
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- RefreshToken: composite index matching revokeAllUserTokens' query pattern
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- Product: indexes on commonly filtered list-endpoint fields
CREATE INDEX "products_status_idx" ON "products"("status");
CREATE INDEX "products_category_idx" ON "products"("category");

-- Ingredient: prevent duplicate ingredient names per branch (verified zero
-- existing rows in the live database before this migration was written)
CREATE UNIQUE INDEX "ingredients_branch_id_name_key" ON "ingredients"("branch_id", "name");

-- Recipe: prevent duplicate master recipe rows for the same variant+ingredient+flavor
-- combination, matching the constraint BranchRecipeOverride already enforces
-- (verified zero existing rows in the live database before this migration was written)
CREATE UNIQUE INDEX "recipes_product_variant_id_ingredient_id_flavor_id_key" ON "recipes"("product_variant_id", "ingredient_id", "flavor_id");
