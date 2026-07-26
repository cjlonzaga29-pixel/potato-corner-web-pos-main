-- Approval workflow removal: Flavor Requests, Inventory Requests, and Price
-- Overrides are replaced by direct branch/supervisor management (mirrors the
-- 20260726120000_remove_product_requests precedent). Drop each table's FKs,
-- then the tables themselves, then their now-unused enums.

ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_branch_id_fkey";
ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_product_variant_id_fkey";
ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_requested_by_fkey";
ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_reviewed_by_fkey";

DROP TABLE "branch_price_overrides";

ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_branch_id_fkey";
ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_requested_by_fkey";
ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_reviewed_by_fkey";
ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_created_flavor_id_fkey";

DROP TABLE "flavor_requests";

ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_branchId_fkey";
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_ingredientId_fkey";
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_requestedById_fkey";
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_approvedById_fkey";

DROP TABLE "inventory_requests";

DROP TYPE "InventoryRequestType";
DROP TYPE "InventoryRequestStatus";
