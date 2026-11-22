-- POS-PERF-P66 — permanent account deletion that keeps history attributed.
--
-- Before: every history table (sales, shifts, attendance, expenses, payroll,
-- audit, catalog provenance, discount proofs, extra supplies, settings…)
-- referenced users(id). A users row with history could therefore never be
-- deleted (ON DELETE RESTRICT), and 31 of those references were ON DELETE
-- SET NULL, which would have silently erased who did what.
--
-- After:
-- * "people" is a separate historical attribution record: one row per account
--   ever created, same id, names/role/employee code. It has no email,
--   password, PIN, session or branch access; nothing authenticates against it.
-- * Every history reference now points at people(id) instead of users(id).
--   Deleting a users row leaves all history, names and amounts untouched.
-- * What belongs to the account itself (refresh tokens, reset tokens, device
--   PIN credentials, the staff PIN, branch assignments; notification
--   preferences already did) cascades with the users row.
-- * users.id references people(id): an account can never exist without its
--   attribution record. Triggers keep the record in step with the account and
--   refuse to reuse the id of a deleted account.
--
-- Data: people is backfilled from users (every current account, including
-- P64-removed rows, which still exist and are NOT marked deleted). No
-- existing row in any other table is changed, and no account is deleted.
-- Foreign keys are added NOT VALID and then validated, so validation does
-- not block writes on the large history tables.

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "employee_code" TEXT,
    "account_deleted_at" TIMESTAMP(3),
    "account_deleted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- Backfill: one attribution record per existing account.
INSERT INTO "people" ("id", "first_name", "last_name", "role", "employee_code", "created_at")
SELECT "id", "first_name", "last_name", "role", "employee_id", "created_at" FROM "users";

-- Keep the attribution record in step with its account.
CREATE FUNCTION "pos_perf_p66_users_ensure_person"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- users.id is also the reference to people, so Prisma no longer fills its
  -- client-side uuid() default; the id is generated here instead (Prisma
  -- reads it back through RETURNING).
  IF NEW."id" IS NULL THEN
    NEW."id" := gen_random_uuid()::text;
  END IF;
  INSERT INTO "people" ("id", "first_name", "last_name", "role", "employee_code", "created_at")
  VALUES (NEW."id", NEW."first_name", NEW."last_name", NEW."role", NEW."employee_id", COALESCE(NEW."created_at", CURRENT_TIMESTAMP))
  ON CONFLICT ("id") DO UPDATE
    SET "first_name" = EXCLUDED."first_name",
        "last_name" = EXCLUDED."last_name",
        "role" = EXCLUDED."role",
        "employee_code" = EXCLUDED."employee_code"
    WHERE "people"."account_deleted_at" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS_PERF_P66_ACCOUNT_ID_REUSED: % belonged to a deleted account', NEW."id"
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_perf_p66_users_sync_person"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "people"
     SET "first_name" = NEW."first_name",
         "last_name" = NEW."last_name",
         "role" = NEW."role",
         "employee_code" = NEW."employee_id"
   WHERE "id" = NEW."id";
  RETURN NEW;
END;
$$;

-- Any removal of a users row (the app's Delete, or an older API's delete of
-- an unused account) marks the record deleted, so its id is never reused.
CREATE FUNCTION "pos_perf_p66_users_mark_person_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "people" SET "account_deleted_at" = COALESCE("account_deleted_at", CURRENT_TIMESTAMP) WHERE "id" = OLD."id";
  RETURN OLD;
END;
$$;

CREATE TRIGGER "pos_perf_p66_users_ensure_person" BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p66_users_ensure_person"();
CREATE TRIGGER "pos_perf_p66_users_sync_person" AFTER UPDATE OF "first_name", "last_name", "role", "employee_id" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p66_users_sync_person"();
CREATE TRIGGER "pos_perf_p66_users_mark_person_deleted" AFTER DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p66_users_mark_person_deleted"();

-- Retarget references.
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_corrected_by_fkey";
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_employee_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";
ALTER TABLE "branch_payment_method_configs" DROP CONSTRAINT "branch_payment_method_configs_updated_by_fkey";
ALTER TABLE "branch_receipt_configs" DROP CONSTRAINT "branch_receipt_configs_updated_by_fkey";
ALTER TABLE "catalog_management_assignments" DROP CONSTRAINT "catalog_management_assignments_assigned_by_fkey";
ALTER TABLE "catalog_management_assignments" DROP CONSTRAINT "catalog_management_assignments_new_managed_by_fkey";
ALTER TABLE "discount_proof_uploads" DROP CONSTRAINT "discount_proof_uploads_uploaded_by_id_fkey";
ALTER TABLE "employee_pay_rates" DROP CONSTRAINT "employee_pay_rates_employee_id_fkey";
ALTER TABLE "expense_types" DROP CONSTRAINT "expense_types_created_by_id_fkey";
ALTER TABLE "expense_types" DROP CONSTRAINT "expense_types_updated_by_id_fkey";
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_created_by_fkey";
ALTER TABLE "extra_supplies" DROP CONSTRAINT "extra_supplies_created_by_id_fkey";
ALTER TABLE "extra_supplies" DROP CONSTRAINT "extra_supplies_updated_by_id_fkey";
ALTER TABLE "extra_supply_issues" DROP CONSTRAINT "extra_supply_issues_cashier_id_fkey";
ALTER TABLE "hold_orders" DROP CONSTRAINT "hold_orders_cashier_id_fkey";
ALTER TABLE "initialization_runs" DROP CONSTRAINT "initialization_runs_initiated_by_fkey";
ALTER TABLE "inventory_categories" DROP CONSTRAINT "inventory_categories_created_by_fkey";
ALTER TABLE "inventory_categories" DROP CONSTRAINT "inventory_categories_managed_by_fkey";
ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_created_by_fkey";
ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_managed_by_fkey";
ALTER TABLE "manual_discount_types" DROP CONSTRAINT "manual_discount_types_created_by_id_fkey";
ALTER TABLE "manual_discount_types" DROP CONSTRAINT "manual_discount_types_deactivated_by_id_fkey";
ALTER TABLE "manual_discount_types" DROP CONSTRAINT "manual_discount_types_updated_by_id_fkey";
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_user_id_fkey";
ALTER TABLE "payroll_adjustments" DROP CONSTRAINT "payroll_adjustments_employee_id_fkey";
ALTER TABLE "payroll_run_lines" DROP CONSTRAINT "payroll_run_lines_employee_id_fkey";
ALTER TABLE "pin_credentials" DROP CONSTRAINT "pin_credentials_user_id_fkey";
ALTER TABLE "product_categories" DROP CONSTRAINT "product_categories_created_by_fkey";
ALTER TABLE "product_categories" DROP CONSTRAINT "product_categories_managed_by_fkey";
ALTER TABLE "product_change_logs" DROP CONSTRAINT "product_change_logs_changed_by_id_fkey";
ALTER TABLE "product_option_groups" DROP CONSTRAINT "product_option_groups_created_by_fkey";
ALTER TABLE "product_option_groups" DROP CONSTRAINT "product_option_groups_managed_by_fkey";
ALTER TABLE "product_options" DROP CONSTRAINT "product_options_created_by_fkey";
ALTER TABLE "product_options" DROP CONSTRAINT "product_options_managed_by_fkey";
ALTER TABLE "product_types" DROP CONSTRAINT "product_types_created_by_id_fkey";
ALTER TABLE "product_types" DROP CONSTRAINT "product_types_updated_by_id_fkey";
ALTER TABLE "product_variant_option_groups" DROP CONSTRAINT "product_variant_option_groups_created_by_fkey";
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_approved_by_id_fkey";
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_created_by_id_fkey";
ALTER TABLE "products" DROP CONSTRAINT "products_created_by_fkey";
ALTER TABLE "products" DROP CONSTRAINT "products_managed_by_fkey";
ALTER TABLE "promotions" DROP CONSTRAINT "promotions_created_by_id_fkey";
ALTER TABLE "promotions" DROP CONSTRAINT "promotions_updated_by_id_fkey";
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";
ALTER TABLE "shift_reviews" DROP CONSTRAINT "shift_reviews_reviewed_by_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_cashier_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_opened_by_fkey";
ALTER TABLE "staff_pins" DROP CONSTRAINT "staff_pins_user_id_fkey";
ALTER TABLE "system_settings" DROP CONSTRAINT "system_settings_updated_by_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_cashier_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_payment_proof_verified_by_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_refunded_by_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_voided_by_id_fkey";
ALTER TABLE "unit_conversions" DROP CONSTRAINT "unit_conversions_created_by_fkey";
ALTER TABLE "unit_conversions" DROP CONSTRAINT "unit_conversions_managed_by_fkey";
ALTER TABLE "units_of_measure" DROP CONSTRAINT "units_of_measure_created_by_fkey";
ALTER TABLE "units_of_measure" DROP CONSTRAINT "units_of_measure_managed_by_fkey";
ALTER TABLE "user_branch_assignments" DROP CONSTRAINT "user_branch_assignments_user_id_fkey";

-- Account-owned rows go with the account.
ALTER TABLE "user_branch_assignments" ADD CONSTRAINT "user_branch_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pin_credentials" ADD CONSTRAINT "pin_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History (and users.id itself) references the attribution record.
ALTER TABLE "users" ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_variant_option_groups" ADD CONSTRAINT "product_variant_option_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_change_logs" ADD CONSTRAINT "product_change_logs_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_managed_by_fkey" FOREIGN KEY ("managed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_new_managed_by_fkey" FOREIGN KEY ("new_managed_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refunded_by_id_fkey" FOREIGN KEY ("refunded_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_proof_verified_by_id_fkey" FOREIGN KEY ("payment_proof_verified_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_deactivated_by_id_fkey" FOREIGN KEY ("deactivated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_proof_uploads" ADD CONSTRAINT "discount_proof_uploads_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "shift_reviews" ADD CONSTRAINT "shift_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supplies" ADD CONSTRAINT "extra_supplies_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supply_issues" ADD CONSTRAINT "extra_supply_issues_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "branch_receipt_configs" ADD CONSTRAINT "branch_receipt_configs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "branch_payment_method_configs" ADD CONSTRAINT "branch_payment_method_configs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "initialization_runs" ADD CONSTRAINT "initialization_runs_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "users" VALIDATE CONSTRAINT "users_id_fkey";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_created_by_fkey";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_managed_by_fkey";
ALTER TABLE "product_types" VALIDATE CONSTRAINT "product_types_created_by_id_fkey";
ALTER TABLE "product_types" VALIDATE CONSTRAINT "product_types_updated_by_id_fkey";
ALTER TABLE "product_variants" VALIDATE CONSTRAINT "product_variants_created_by_id_fkey";
ALTER TABLE "product_variants" VALIDATE CONSTRAINT "product_variants_approved_by_id_fkey";
ALTER TABLE "product_categories" VALIDATE CONSTRAINT "product_categories_created_by_fkey";
ALTER TABLE "product_categories" VALIDATE CONSTRAINT "product_categories_managed_by_fkey";
ALTER TABLE "product_option_groups" VALIDATE CONSTRAINT "product_option_groups_created_by_fkey";
ALTER TABLE "product_option_groups" VALIDATE CONSTRAINT "product_option_groups_managed_by_fkey";
ALTER TABLE "product_options" VALIDATE CONSTRAINT "product_options_created_by_fkey";
ALTER TABLE "product_options" VALIDATE CONSTRAINT "product_options_managed_by_fkey";
ALTER TABLE "product_variant_option_groups" VALIDATE CONSTRAINT "product_variant_option_groups_created_by_fkey";
ALTER TABLE "product_change_logs" VALIDATE CONSTRAINT "product_change_logs_changed_by_id_fkey";
ALTER TABLE "inventory_categories" VALIDATE CONSTRAINT "inventory_categories_created_by_fkey";
ALTER TABLE "inventory_categories" VALIDATE CONSTRAINT "inventory_categories_managed_by_fkey";
ALTER TABLE "units_of_measure" VALIDATE CONSTRAINT "units_of_measure_created_by_fkey";
ALTER TABLE "units_of_measure" VALIDATE CONSTRAINT "units_of_measure_managed_by_fkey";
ALTER TABLE "unit_conversions" VALIDATE CONSTRAINT "unit_conversions_created_by_fkey";
ALTER TABLE "unit_conversions" VALIDATE CONSTRAINT "unit_conversions_managed_by_fkey";
ALTER TABLE "inventory_items" VALIDATE CONSTRAINT "inventory_items_created_by_fkey";
ALTER TABLE "inventory_items" VALIDATE CONSTRAINT "inventory_items_managed_by_fkey";
ALTER TABLE "catalog_management_assignments" VALIDATE CONSTRAINT "catalog_management_assignments_assigned_by_fkey";
ALTER TABLE "catalog_management_assignments" VALIDATE CONSTRAINT "catalog_management_assignments_new_managed_by_fkey";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_cashier_id_fkey";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_voided_by_id_fkey";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_refunded_by_id_fkey";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_payment_proof_verified_by_id_fkey";
ALTER TABLE "promotions" VALIDATE CONSTRAINT "promotions_created_by_id_fkey";
ALTER TABLE "promotions" VALIDATE CONSTRAINT "promotions_updated_by_id_fkey";
ALTER TABLE "manual_discount_types" VALIDATE CONSTRAINT "manual_discount_types_created_by_id_fkey";
ALTER TABLE "manual_discount_types" VALIDATE CONSTRAINT "manual_discount_types_updated_by_id_fkey";
ALTER TABLE "manual_discount_types" VALIDATE CONSTRAINT "manual_discount_types_deactivated_by_id_fkey";
ALTER TABLE "discount_proof_uploads" VALIDATE CONSTRAINT "discount_proof_uploads_uploaded_by_id_fkey";
ALTER TABLE "shifts" VALIDATE CONSTRAINT "shifts_cashier_id_fkey";
ALTER TABLE "shifts" VALIDATE CONSTRAINT "shifts_opened_by_fkey";
ALTER TABLE "shift_reviews" VALIDATE CONSTRAINT "shift_reviews_reviewed_by_fkey";
ALTER TABLE "hold_orders" VALIDATE CONSTRAINT "hold_orders_cashier_id_fkey";
ALTER TABLE "attendance_records" VALIDATE CONSTRAINT "attendance_records_employee_id_fkey";
ALTER TABLE "attendance_records" VALIDATE CONSTRAINT "attendance_records_corrected_by_fkey";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_actor_id_fkey";
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_created_by_fkey";
ALTER TABLE "expense_types" VALIDATE CONSTRAINT "expense_types_created_by_id_fkey";
ALTER TABLE "expense_types" VALIDATE CONSTRAINT "expense_types_updated_by_id_fkey";
ALTER TABLE "extra_supplies" VALIDATE CONSTRAINT "extra_supplies_created_by_id_fkey";
ALTER TABLE "extra_supplies" VALIDATE CONSTRAINT "extra_supplies_updated_by_id_fkey";
ALTER TABLE "extra_supply_issues" VALIDATE CONSTRAINT "extra_supply_issues_cashier_id_fkey";
ALTER TABLE "system_settings" VALIDATE CONSTRAINT "system_settings_updated_by_fkey";
ALTER TABLE "branch_receipt_configs" VALIDATE CONSTRAINT "branch_receipt_configs_updated_by_fkey";
ALTER TABLE "branch_payment_method_configs" VALIDATE CONSTRAINT "branch_payment_method_configs_updated_by_fkey";
ALTER TABLE "initialization_runs" VALIDATE CONSTRAINT "initialization_runs_initiated_by_fkey";
ALTER TABLE "employee_pay_rates" VALIDATE CONSTRAINT "employee_pay_rates_employee_id_fkey";
ALTER TABLE "payroll_run_lines" VALIDATE CONSTRAINT "payroll_run_lines_employee_id_fkey";
ALTER TABLE "payroll_adjustments" VALIDATE CONSTRAINT "payroll_adjustments_employee_id_fkey";
