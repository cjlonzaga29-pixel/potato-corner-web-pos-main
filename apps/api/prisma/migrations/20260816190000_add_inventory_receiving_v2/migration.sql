-- Inventory Receiving Simplification + Cost Correction V2. Additive only:
-- no existing column, table, or constraint is altered or dropped.
--
-- entered_quantity/entered_unit_id on inventory_stock_movements capture the
-- purchase-unit quantity as the user actually typed it (e.g. "1" / kg),
-- distinct from unit_id (always the item's base unit) and quantity_change
-- (always the converted base-unit quantity) -- previously only the
-- converted base quantity was persisted, so receiving/waste history could
-- never show "Purchase Quantity: 1 kg". proof_key/proof_type are an
-- optional receipt/waste photo, mirroring expenses.receipt_key's
-- storage-key-only shape (never a public/signed URL).
--
-- inventory_cost_corrections is a new, append-only audit table for
-- controlled valuation corrections to InventoryStock.unit_cost -- the one
-- sanctioned direct-mutation path outside the RECEIVING/TRANSFER_IN
-- weighted-average blend. Deliberately separate from
-- inventory_stock_movements since a correction has no quantity change.

-- AlterTable
ALTER TABLE "inventory_stock_movements" ADD COLUMN "entered_quantity" DECIMAL(12,4);
ALTER TABLE "inventory_stock_movements" ADD COLUMN "entered_unit_id" TEXT;
ALTER TABLE "inventory_stock_movements" ADD COLUMN "proof_key" TEXT;
ALTER TABLE "inventory_stock_movements" ADD COLUMN "proof_type" "ImageProofType";

-- CreateIndex
CREATE INDEX "inventory_stock_movements_entered_unit_id_idx" ON "inventory_stock_movements"("entered_unit_id");

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_entered_unit_id_fkey" FOREIGN KEY ("entered_unit_id") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "inventory_cost_corrections" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "old_unit_cost" DECIMAL(10,4),
    "new_unit_cost" DECIMAL(10,4) NOT NULL,
    "quantity_on_hand" DECIMAL(10,3) NOT NULL,
    "valuation_difference" DECIMAL(12,4) NOT NULL,
    "reason_code" TEXT NOT NULL,
    "notes" TEXT,
    "proof_key" TEXT,
    "proof_type" "ImageProofType",
    "corrected_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_cost_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_cost_corrections_branch_id_inventory_item_id_idx" ON "inventory_cost_corrections"("branch_id", "inventory_item_id");

-- CreateIndex
CREATE INDEX "inventory_cost_corrections_created_at_idx" ON "inventory_cost_corrections"("created_at");

-- AddForeignKey
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
