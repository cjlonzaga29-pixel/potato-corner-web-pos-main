-- POS-PERF-P61 — Extra Supplies. Additive only: five new tables and one new enum.
--
-- No existing table is altered and no row is written: nothing is backfilled, no card
-- or issue is invented. Issues reuse InventoryStockMovementType.ADJUSTMENT_OUT with
-- reference_type 'extra_supply_issue' rather than a new enum value, because an older
-- API's Prisma client fails on an enum value it doesn't know, which would break
-- every movement read after a rollback.

CREATE TYPE "extra_supply_issue_kind" AS ENUM ('free', 'paid');

CREATE TABLE "extra_supplies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "image_path" TEXT,
    "inventory_item_id" TEXT NOT NULL,
    "issue_unit_name" TEXT NOT NULL,
    "entered_quantity" DECIMAL(12,4) NOT NULL,
    "entered_unit_id" TEXT NOT NULL,
    "base_quantity" DECIMAL(10,3) NOT NULL,
    "base_unit_id" TEXT NOT NULL,
    "configured_issue_cost" DECIMAL(10,4),
    "selling_price" DECIMAL(10,2),
    "apply_to_pos" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extra_supplies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "extra_supplies_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 60),
    -- The application computes normalized_name; this refuses a value that can't have come from it.
    CONSTRAINT "extra_supplies_normalized_name_check" CHECK (
        "normalized_name" <> '' AND "normalized_name" = btrim("normalized_name") AND "normalized_name" = lower("normalized_name")
    ),
    CONSTRAINT "extra_supplies_quantity_check" CHECK ("entered_quantity" > 0 AND "base_quantity" > 0),
    CONSTRAINT "extra_supplies_cost_check" CHECK ("configured_issue_cost" IS NULL OR "configured_issue_cost" >= 0),
    CONSTRAINT "extra_supplies_price_check" CHECK ("selling_price" IS NULL OR "selling_price" > 0)
);

CREATE UNIQUE INDEX "extra_supplies_id_normalized_name_is_active_key" ON "extra_supplies"("id", "normalized_name", "is_active");
CREATE INDEX "extra_supplies_inventory_item_id_idx" ON "extra_supplies"("inventory_item_id");

CREATE TABLE "extra_supply_branches" (
    "extra_supply_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "extra_supply_branches_pkey" PRIMARY KEY ("extra_supply_id", "branch_id")
);

CREATE INDEX "extra_supply_branches_branch_id_idx" ON "extra_supply_branches"("branch_id");

-- One ACTIVE card per name per branch, deciding concurrent creates, renames and
-- reactivations. Partial, so a deactivated card keeps its name and the name can be
-- reused. Raw SQL: Prisma's schema DSL cannot express a WHERE-clause index.
CREATE UNIQUE INDEX "extra_supply_branches_active_name_key" ON "extra_supply_branches"("branch_id", "normalized_name") WHERE "is_active";

CREATE TABLE "extra_supply_issues" (
    "id" TEXT NOT NULL,
    "reference_number" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "cashier_id" TEXT NOT NULL,
    "kind" "extra_supply_issue_kind" NOT NULL,
    "payment_method" "PaymentMethod",
    "amount_collected" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "amount_tendered" DECIMAL(10,2),
    "change_amount" DECIMAL(10,2),
    "payment_reference" TEXT,
    "payment_proof_key" TEXT,
    "payment_proof_type" "ImageProofType",
    "reason" TEXT,
    "order_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extra_supply_issues_pkey" PRIMARY KEY ("id"),
    -- A free issue collects nothing and never carries a payment. A paid one always does.
    CONSTRAINT "extra_supply_issues_payment_check" CHECK (
        ("kind" = 'free' AND "payment_method" IS NULL AND "amount_collected" = 0 AND "amount_tendered" IS NULL AND "change_amount" IS NULL AND "payment_proof_key" IS NULL)
        OR ("kind" = 'paid' AND "payment_method" IS NOT NULL AND "amount_collected" > 0)
    )
);

CREATE UNIQUE INDEX "extra_supply_issues_reference_number_key" ON "extra_supply_issues"("reference_number");
CREATE INDEX "extra_supply_issues_branch_id_created_at_id_idx" ON "extra_supply_issues"("branch_id", "created_at" DESC, "id");
CREATE INDEX "extra_supply_issues_shift_id_payment_method_idx" ON "extra_supply_issues"("shift_id", "payment_method");
CREATE INDEX "extra_supply_issues_cashier_id_idx" ON "extra_supply_issues"("cashier_id");

CREATE TABLE "extra_supply_issue_lines" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "extra_supply_id" TEXT NOT NULL,
    "supply_name" TEXT NOT NULL,
    "supply_version" INTEGER NOT NULL,
    "issue_unit_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "inventory_item_name" TEXT NOT NULL,
    "base_unit_code" TEXT NOT NULL,
    "base_quantity_each" DECIMAL(10,3) NOT NULL,
    "base_quantity_total" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(10,2),
    "line_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cost_source" TEXT NOT NULL,
    "unit_cost" DECIMAL(12,4),
    "line_cost" DECIMAL(14,4),
    "branch_id" TEXT NOT NULL,
    "kind" "extra_supply_issue_kind" NOT NULL,
    "payment_method" "PaymentMethod",
    "cashier_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extra_supply_issue_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "extra_supply_issue_lines_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "extra_supply_issue_lines_cost_source_check" CHECK ("cost_source" IN ('inventory', 'configured', 'unknown')),
    -- Unknown cost stays null. It must never read as zero.
    CONSTRAINT "extra_supply_issue_lines_cost_check" CHECK (("cost_source" = 'unknown') = ("line_cost" IS NULL) AND ("unit_cost" IS NULL) = ("line_cost" IS NULL)),
    CONSTRAINT "extra_supply_issue_lines_free_amount_check" CHECK ("kind" = 'paid' OR "line_amount" = 0)
);

CREATE INDEX "extra_supply_issue_lines_issue_id_idx" ON "extra_supply_issue_lines"("issue_id");
CREATE INDEX "extra_supply_issue_lines_branch_id_created_at_idx" ON "extra_supply_issue_lines"("branch_id", "created_at");
CREATE INDEX "extra_supply_issue_lines_extra_supply_id_created_at_idx" ON "extra_supply_issue_lines"("extra_supply_id", "created_at");

CREATE TABLE "extra_supply_operations" (
    "operation_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "cashier_id" TEXT NOT NULL,
    "request_hash" TEXT,
    "status" TEXT NOT NULL,
    "issue_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extra_supply_operations_pkey" PRIMARY KEY ("operation_id"),
    CONSTRAINT "extra_supply_operations_status_check" CHECK (
        ("status" = 'committed' AND "issue_id" IS NOT NULL AND "request_hash" IS NOT NULL)
        OR ("status" = 'abandoned' AND "issue_id" IS NULL)
    )
);

CREATE UNIQUE INDEX "extra_supply_operations_issue_id_key" ON "extra_supply_operations"("issue_id");
CREATE INDEX "extra_supply_operations_branch_id_idx" ON "extra_supply_operations"("branch_id");

ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_entered_unit_id_fkey" FOREIGN KEY ("entered_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extra_supply_branches" ADD CONSTRAINT "extra_supply_branches_extra_supply_id_normalized_name_is_a_fkey" FOREIGN KEY ("extra_supply_id", "normalized_name", "is_active") REFERENCES "extra_supplies"("id", "normalized_name", "is_active") ON DELETE CASCADE ON UPDATE CASCADE;
-- Branch cascades match expenses and transactions: permanently deleting a branch keeps working.
ALTER TABLE "extra_supply_branches" ADD CONSTRAINT "extra_supply_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issues" ADD CONSTRAINT "extra_supply_issues_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issues" ADD CONSTRAINT "extra_supply_issues_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issues" ADD CONSTRAINT "extra_supply_issues_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issue_lines" ADD CONSTRAINT "extra_supply_issue_lines_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "extra_supply_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issue_lines" ADD CONSTRAINT "extra_supply_issue_lines_extra_supply_id_fkey" FOREIGN KEY ("extra_supply_id") REFERENCES "extra_supplies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extra_supply_issue_lines" ADD CONSTRAINT "extra_supply_issue_lines_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extra_supply_operations" ADD CONSTRAINT "extra_supply_operations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extra_supply_operations" ADD CONSTRAINT "extra_supply_operations_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "extra_supply_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
