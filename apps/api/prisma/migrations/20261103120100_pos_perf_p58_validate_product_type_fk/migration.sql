-- POS-PERF-P58 — validate the NOT VALID foreign key from 20261103120000. Takes
-- SHARE UPDATE EXCLUSIVE on products, which doesn't block product reads or writes.
ALTER TABLE "products" VALIDATE CONSTRAINT "products_product_type_id_fkey";
