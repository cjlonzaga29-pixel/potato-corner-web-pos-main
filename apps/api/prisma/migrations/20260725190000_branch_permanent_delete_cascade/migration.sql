-- Branch Permanent Delete — cascade/restrict FK corrections
-- See docs/superpowers/specs/2026-07-25-branch-permanent-delete-design.md

-- Direct children of Branch (branch_id / branchId FK): Restrict -> Cascade
ALTER TABLE "user_branch_assignments" DROP CONSTRAINT "user_branch_assignments_branch_id_fkey";
ALTER TABLE "user_branch_assignments" ADD CONSTRAINT "user_branch_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_product_availability" DROP CONSTRAINT "branch_product_availability_branch_id_fkey";
ALTER TABLE "branch_product_availability" ADD CONSTRAINT "branch_product_availability_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_flavor_availability" DROP CONSTRAINT "branch_flavor_availability_branch_id_fkey";
ALTER TABLE "branch_flavor_availability" ADD CONSTRAINT "branch_flavor_availability_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_branch_id_fkey";
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_branch_id_fkey";
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_branch_id_fkey";
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingredients" DROP CONSTRAINT "ingredients_branch_id_fkey";
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_branch_id_fkey";
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_branch_id_fkey";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT "transactions_branch_id_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shifts" DROP CONSTRAINT "shifts_branch_id_fkey";
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hold_orders" DROP CONSTRAINT "hold_orders_branch_id_fkey";
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_branch_id_fkey";
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "expenses" DROP CONSTRAINT "expenses_branch_id_fkey";
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- InventoryRequest: Restrict -> Cascade on both branchId and ingredientId
-- (this table's columns are camelCase in the DB, no snake_case @map — see schema.prisma)
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_branchId_fkey";
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_ingredientId_fkey";
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Transitive-cascade gaps: children with no branchId column of their own
ALTER TABLE "transaction_items" DROP CONSTRAINT "transaction_items_transaction_id_fkey";
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hold_order_items" DROP CONSTRAINT "hold_order_items_hold_order_id_fkey";
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_hold_order_id_fkey" FOREIGN KEY ("hold_order_id") REFERENCES "hold_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shift_cash_denominations" DROP CONSTRAINT "shift_cash_denominations_shift_id_fkey";
ALTER TABLE "shift_cash_denominations" ADD CONSTRAINT "shift_cash_denominations_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Master Recipe pinning — accepted-risk cascade (see design doc "Recipe pinning" section):
-- deleting a branch that's the pinned identity source for a recipe deletes that master
-- Recipe row too, breaking deduction for that product at every branch. Deliberate.
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_ingredient_id_fkey";
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- audit_logs.branch_id and fraud_alerts.branch_id already ON DELETE SET NULL since the
-- initial migration (20260709172014_init) — no change needed, intentionally not touched here.
