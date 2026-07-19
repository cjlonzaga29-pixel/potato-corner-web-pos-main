-- Phase 21: product catalog additions (Flavor premium/kcal metadata, ProductVariant kcal + maxFlavors)

ALTER TABLE "product_variants" ADD COLUMN "kcal" INTEGER;
ALTER TABLE "product_variants" ADD COLUMN "max_flavors" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "flavors" ADD COLUMN "is_premium" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "flavors" ADD COLUMN "add_on_price" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "flavors" ADD COLUMN "kcal_offset" INTEGER NOT NULL DEFAULT 0;
