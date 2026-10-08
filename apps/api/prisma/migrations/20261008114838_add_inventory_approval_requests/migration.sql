-- CreateEnum
CREATE TYPE "InventoryApprovalOperation" AS ENUM ('RECEIVING', 'ADJUSTMENT', 'PHYSICAL_COUNT');

-- CreateEnum
CREATE TYPE "InventoryApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "InventoryApprovalTarget" AS ENUM ('UNIVERSAL_ITEM', 'LEGACY_INGREDIENT');

-- DropIndex
DROP INDEX "inventory_stock_movements_entered_unit_id_idx";

-- DropIndex
DROP INDEX "product_components_flavor_id_idx";

-- CreateTable
CREATE TABLE "inventory_approval_requests" (
    "id" TEXT NOT NULL,
    "root_request_id" TEXT NOT NULL,
    "previous_request_id" TEXT,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "batch_id" TEXT,
    "target" "InventoryApprovalTarget" NOT NULL,
    "branch_id" TEXT NOT NULL,
    "inventory_item_id" TEXT,
    "legacy_ingredient_id" TEXT,
    "operation" "InventoryApprovalOperation" NOT NULL,
    "entered_quantity" DECIMAL(12,4),
    "entered_unit_id" TEXT,
    "total_cost" DECIMAL(12,4),
    "delivery_reference" TEXT,
    "quantity_delta" DECIMAL(12,4),
    "counted_quantity" DECIMAL(12,4),
    "quantity_on_hand_at_submission" DECIMAL(12,4),
    "stock_version_at_submission" INTEGER,
    "reason_code" TEXT,
    "notes" TEXT,
    "proof_key" TEXT,
    "proof_type" "ImageProofType",
    "status" "InventoryApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_by_user_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "return_reason" TEXT,
    "applied_movement_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_approval_requests_branch_id_status_idx" ON "inventory_approval_requests"("branch_id", "status");

-- CreateIndex
CREATE INDEX "inventory_approval_requests_root_request_id_idx" ON "inventory_approval_requests"("root_request_id");

-- CreateIndex
CREATE INDEX "inventory_approval_requests_batch_id_idx" ON "inventory_approval_requests"("batch_id");

-- RenameForeignKey
ALTER TABLE "product_variant_option_group_options" RENAME CONSTRAINT "product_variant_option_group_options_variant_option_group_id_fk" TO "product_variant_option_group_options_variant_option_group__fkey";

-- RenameIndex
ALTER INDEX "inventory_item_unit_conversions_inventory_item_id_from_un_key" RENAME TO "inventory_item_unit_conversions_inventory_item_id_from_unit_key";

-- RenameIndex
ALTER INDEX "product_flavor_slot_snack_options_flavor_slot_id_snack_pro_key" RENAME TO "product_flavor_slot_snack_options_flavor_slot_id_snack_prod_key";

-- RenameIndex
ALTER INDEX "product_variant_option_group_options_variant_option_group__key" RENAME TO "product_variant_option_group_options_variant_option_group_i_key";

-- RenameIndex
ALTER INDEX "product_variant_option_groups_product_variant_id_option_g_key" RENAME TO "product_variant_option_groups_product_variant_id_option_gro_key";
