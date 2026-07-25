-- Product Request workflow removal: the Product module is now the sole
-- path to creating/editing products (direct POST /api/products), so the
-- product_requests table and its FKs are dropped outright.
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_branch_id_fkey";
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_requested_by_fkey";
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_reviewed_by_fkey";
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_created_product_id_fkey";

DROP TABLE "product_requests";
