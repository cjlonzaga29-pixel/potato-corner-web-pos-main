-- AlterTable
ALTER TABLE "products" ADD COLUMN     "branch_exclusive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exclusive_branch_id" TEXT;

-- CreateTable
CREATE TABLE "branch_price_overrides" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "requested_price" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "request_reason" TEXT NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "effective_from" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_price_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_requests" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "proposed_name" TEXT NOT NULL,
    "proposed_description" TEXT,
    "proposed_category" TEXT,
    "proposed_variants" JSONB NOT NULL,
    "proposed_flavors" JSONB NOT NULL,
    "proposed_recipes" JSONB NOT NULL,
    "request_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "created_product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_recipe_overrides" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "flavor_id" TEXT,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_recipe_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_price_overrides_branch_id_idx" ON "branch_price_overrides"("branch_id");

-- CreateIndex
CREATE INDEX "branch_price_overrides_product_variant_id_idx" ON "branch_price_overrides"("product_variant_id");

-- CreateIndex
CREATE INDEX "branch_price_overrides_status_idx" ON "branch_price_overrides"("status");

-- CreateIndex
CREATE INDEX "product_requests_branch_id_idx" ON "product_requests"("branch_id");

-- CreateIndex
CREATE INDEX "product_requests_status_idx" ON "product_requests"("status");

-- CreateIndex
CREATE INDEX "branch_recipe_overrides_branch_id_product_variant_id_idx" ON "branch_recipe_overrides"("branch_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_recipe_overrides_branch_id_product_variant_id_ingred_key" ON "branch_recipe_overrides"("branch_id", "product_variant_id", "ingredient_id", "flavor_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_exclusive_branch_id_fkey" FOREIGN KEY ("exclusive_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_created_product_id_fkey" FOREIGN KEY ("created_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_flavor_id_fkey" FOREIGN KEY ("flavor_id") REFERENCES "flavors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CR-001: at most one pending price override per branch+variant. Prisma's
-- schema DSL has no WHERE-clause index syntax, so this partial unique index
-- is hand-added here rather than expressed in schema.prisma; the service
-- layer (price-overrides.service.ts submitOverrideRequest) also checks this
-- explicitly first, so callers see a clean 409 rather than a raw constraint
-- violation in the common case.
CREATE UNIQUE INDEX "branch_price_overrides_pending_unique" ON "branch_price_overrides"("branch_id", "product_variant_id") WHERE "status" = 'pending';
