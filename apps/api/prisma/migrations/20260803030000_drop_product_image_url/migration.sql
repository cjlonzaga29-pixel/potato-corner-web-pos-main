-- Task 128: product image feature removed entirely (admin Media tab, upload/
-- delete endpoints, Supabase Storage bucket usage, POS card art). Drops the
-- now-unused Product.image_url column. ProductOption.image_url (CR-008
-- option/add-on images) is a separate feature and is untouched.
ALTER TABLE "products" DROP COLUMN "image_url";
