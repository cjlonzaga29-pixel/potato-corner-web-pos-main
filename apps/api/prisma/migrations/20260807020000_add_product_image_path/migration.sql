-- Task 209.6: Product Image Management (Admin Only). Adds a nullable
-- storage-path column, distinct from the `image_url` column Task 128 dropped
-- (see 20260803030000_drop_product_image_url) — this is never a public or
-- signed URL, only the Supabase Storage object key
-- (`<product-id>/image.webp` in the product-images bucket), resolved to a
-- fresh short-lived signed URL only on read.
ALTER TABLE "products" ADD COLUMN "image_path" TEXT;
