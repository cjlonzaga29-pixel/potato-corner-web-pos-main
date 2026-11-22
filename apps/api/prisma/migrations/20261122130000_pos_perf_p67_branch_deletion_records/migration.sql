-- POS-PERF-P67 — permanent branch deletion that keeps business history.
--
-- Before: deleting a branches row CASCADEd its sales, shifts, attendance,
-- expenses, stock movements and Extra Supplies history (and, through
-- ingredients, legacy inventory movements), SET NULL its audit/fraud/catalog
-- links (breaking the audit hash chain), and RESTRICT-failed on payroll,
-- pay rates, discount types/proofs and product-type assignments.
--
-- After:
-- * "branch_records" is the immutable historical identity of a branch: one
--   row per branch ever created, same id, name/code/address/city. It has no
--   status, settings, stock, access or accounts; nothing operates against it.
--   Codes are unique across live AND deleted branches, so a deleted branch's
--   code (and its receipt-number prefix and counters) is never reused.
-- * Every history reference (20 FKs) points at branch_records(id) with
--   ON DELETE RESTRICT, so deleting a branches row leaves every sale, shift,
--   attendance record, expense, payroll run, stock movement, proof and audit
--   entry untouched and still named.
-- * Operational configuration and access (assignments, availability, receipt
--   and payment settings, promotions, expense/extra-supply/product-type
--   enrolment, staff PIN lookups, legacy product_inventory, zero stock rows,
--   finished hold orders) still CASCADE with the branches row.
--   product_type_branches goes from RESTRICT to CASCADE (it is enrolment).
-- * branches.id references branch_records(id). Triggers keep the record in
--   step while the branch is live, mark it deleted when the branches row is
--   deleted, freeze it after that, refuse id or code reuse, and refuse new
--   operational writes (insert, or a branch_id change) that name a branch
--   whose branches row does not exist. That guard locks the branches row
--   FOR KEY SHARE exactly like a foreign-key check, so a write racing a
--   delete waits for it and then fails.
--
-- Data: branch_records is backfilled from branches. No row in any existing
-- table is changed and no branch is deleted. FKs are added NOT VALID and
-- then validated.

CREATE TABLE "branch_records" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "branch_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_records_code_key" ON "branch_records"("code");

INSERT INTO "branch_records" ("id", "name", "code", "address", "city", "created_at")
SELECT "id", "name", "code", "address", "city", "created_at" FROM "branches";

-- Keep the record in step with its live branch.
CREATE FUNCTION "pos_perf_p67_branches_ensure_record"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- branches.id is also the reference to branch_records, so Prisma no longer
  -- fills its client-side uuid() default; generate it here (read back via RETURNING).
  IF NEW."id" IS NULL THEN
    NEW."id" := gen_random_uuid()::text;
  END IF;
  IF EXISTS (SELECT 1 FROM "branch_records" WHERE "id" = NEW."id" AND "deleted_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_ID_REUSED: % belonged to a deleted branch', NEW."id"
      USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "branch_records" WHERE "code" = NEW."code" AND "id" <> NEW."id") THEN
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_CODE_RETIRED: % belongs to another branch record', NEW."code"
      USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO "branch_records" ("id", "name", "code", "address", "city", "created_at")
  VALUES (NEW."id", NEW."name", NEW."code", NEW."address", NEW."city", COALESCE(NEW."created_at", CURRENT_TIMESTAMP))
  ON CONFLICT ("id") DO UPDATE
    SET "name" = EXCLUDED."name", "code" = EXCLUDED."code", "address" = EXCLUDED."address", "city" = EXCLUDED."city";
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_perf_p67_branches_sync_record"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "branch_records"
     SET "name" = NEW."name", "code" = NEW."code", "address" = NEW."address", "city" = NEW."city"
   WHERE "id" = NEW."id";
  RETURN NEW;
END;
$$;

-- Any removal of a branches row (the app's Delete, an older API, a test
-- teardown) marks the record deleted, so its id and code are never reused.
CREATE FUNCTION "pos_perf_p67_branches_mark_record_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "branch_records" SET "deleted_at" = COALESCE("deleted_at", CURRENT_TIMESTAMP) WHERE "id" = OLD."id";
  RETURN OLD;
END;
$$;

-- A deleted branch's record is frozen; records are never removed.
CREATE FUNCTION "pos_perf_p67_branch_records_protect"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_RECORD_IMMUTABLE: branch records are historical and never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."deleted_at" IS NOT NULL THEN
    -- Only the deleting transaction's own deleted_by stamp may follow the mark.
    IF NEW."id" = OLD."id" AND NEW."name" = OLD."name" AND NEW."code" = OLD."code"
       AND NEW."address" = OLD."address" AND NEW."city" = OLD."city"
       AND NEW."created_at" = OLD."created_at" AND NEW."deleted_at" = OLD."deleted_at"
       AND OLD."deleted_by" IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_RECORD_IMMUTABLE: % is a deleted branch', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- New operational writes need a live branch. Locks the branches row
-- FOR KEY SHARE, as a foreign-key check would, so it serializes with a delete.
-- raise_exception (P0001), not foreign_key_violation: Prisma reports a 23503
-- as a generic P2003 without the message, and the API must tell this apart.
CREATE FUNCTION "pos_perf_p67_assert_live_branch"(target TEXT, table_name TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "branches" WHERE "id" = target FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_DELETED: branch % has been deleted; % cannot be written for it', target, table_name
      USING ERRCODE = 'raise_exception';
  END IF;
END;
$$;

CREATE FUNCTION "pos_perf_p67_require_live_branch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."branch_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."branch_id" IS DISTINCT FROM OLD."branch_id") THEN
    PERFORM "pos_perf_p67_assert_live_branch"(NEW."branch_id", TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_perf_p67_require_live_exclusive_branch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."exclusive_branch_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."exclusive_branch_id" IS DISTINCT FROM OLD."exclusive_branch_id") THEN
    PERFORM "pos_perf_p67_assert_live_branch"(NEW."exclusive_branch_id", TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_perf_p67_branches_ensure_record" BEFORE INSERT ON "branches"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_branches_ensure_record"();
CREATE TRIGGER "pos_perf_p67_branches_sync_record" AFTER UPDATE OF "name", "code", "address", "city" ON "branches"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_branches_sync_record"();
CREATE TRIGGER "pos_perf_p67_branches_mark_record_deleted" AFTER DELETE ON "branches"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_branches_mark_record_deleted"();
CREATE TRIGGER "pos_perf_p67_branch_records_protect" BEFORE UPDATE OR DELETE ON "branch_records"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_branch_records_protect"();

-- Retarget history references from branches to branch_records.
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_branch_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_branch_id_fkey";
ALTER TABLE "catalog_management_assignments" DROP CONSTRAINT "catalog_management_assignments_branch_id_fkey";
ALTER TABLE "discount_proof_uploads" DROP CONSTRAINT "discount_proof_uploads_branch_id_fkey";
ALTER TABLE "employee_pay_rates" DROP CONSTRAINT "employee_pay_rates_branch_id_fkey";
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_branch_id_fkey";
ALTER TABLE "extra_supply_issue_lines" DROP CONSTRAINT "extra_supply_issue_lines_branch_id_fkey";
ALTER TABLE "extra_supply_issues" DROP CONSTRAINT "extra_supply_issues_branch_id_fkey";
ALTER TABLE "extra_supply_operations" DROP CONSTRAINT "extra_supply_operations_branch_id_fkey";
ALTER TABLE "fraud_alerts" DROP CONSTRAINT "fraud_alerts_branch_id_fkey";
ALTER TABLE "ingredients" DROP CONSTRAINT "ingredients_branch_id_fkey";
ALTER TABLE "inventory_cost_corrections" DROP CONSTRAINT "inventory_cost_corrections_branch_id_fkey";
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_branch_id_fkey";
ALTER TABLE "inventory_stock_movements" DROP CONSTRAINT "inventory_stock_movements_branch_id_fkey";
ALTER TABLE "manual_discount_types" DROP CONSTRAINT "manual_discount_types_branch_id_fkey";
ALTER TABLE "payroll_policies" DROP CONSTRAINT "payroll_policies_branch_id_fkey";
ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_branch_id_fkey";
ALTER TABLE "products" DROP CONSTRAINT "products_exclusive_branch_id_fkey";
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_branch_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_branch_id_fkey";
-- Product-type enrolment is configuration: it goes with the branch.
ALTER TABLE "product_type_branches" DROP CONSTRAINT "product_type_branches_branch_id_fkey";

ALTER TABLE "branches" ADD CONSTRAINT "branches_id_fkey" FOREIGN KEY ("id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "product_type_branches" ADD CONSTRAINT "product_type_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "catalog_management_assignments" ADD CONSTRAINT "catalog_management_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "discount_proof_uploads" ADD CONSTRAINT "discount_proof_uploads_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supply_issue_lines" ADD CONSTRAINT "extra_supply_issue_lines_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supply_issues" ADD CONSTRAINT "extra_supply_issues_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "extra_supply_operations" ADD CONSTRAINT "extra_supply_operations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_cost_corrections" ADD CONSTRAINT "inventory_cost_corrections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "manual_discount_types" ADD CONSTRAINT "manual_discount_types_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "products" ADD CONSTRAINT "products_exclusive_branch_id_fkey" FOREIGN KEY ("exclusive_branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "branches" VALIDATE CONSTRAINT "branches_id_fkey";
ALTER TABLE "product_type_branches" VALIDATE CONSTRAINT "product_type_branches_branch_id_fkey";
ALTER TABLE "attendance_records" VALIDATE CONSTRAINT "attendance_records_branch_id_fkey";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_branch_id_fkey";
ALTER TABLE "catalog_management_assignments" VALIDATE CONSTRAINT "catalog_management_assignments_branch_id_fkey";
ALTER TABLE "discount_proof_uploads" VALIDATE CONSTRAINT "discount_proof_uploads_branch_id_fkey";
ALTER TABLE "employee_pay_rates" VALIDATE CONSTRAINT "employee_pay_rates_branch_id_fkey";
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_branch_id_fkey";
ALTER TABLE "extra_supply_issue_lines" VALIDATE CONSTRAINT "extra_supply_issue_lines_branch_id_fkey";
ALTER TABLE "extra_supply_issues" VALIDATE CONSTRAINT "extra_supply_issues_branch_id_fkey";
ALTER TABLE "extra_supply_operations" VALIDATE CONSTRAINT "extra_supply_operations_branch_id_fkey";
ALTER TABLE "fraud_alerts" VALIDATE CONSTRAINT "fraud_alerts_branch_id_fkey";
ALTER TABLE "ingredients" VALIDATE CONSTRAINT "ingredients_branch_id_fkey";
ALTER TABLE "inventory_cost_corrections" VALIDATE CONSTRAINT "inventory_cost_corrections_branch_id_fkey";
ALTER TABLE "inventory_movements" VALIDATE CONSTRAINT "inventory_movements_branch_id_fkey";
ALTER TABLE "inventory_stock_movements" VALIDATE CONSTRAINT "inventory_stock_movements_branch_id_fkey";
ALTER TABLE "manual_discount_types" VALIDATE CONSTRAINT "manual_discount_types_branch_id_fkey";
ALTER TABLE "payroll_policies" VALIDATE CONSTRAINT "payroll_policies_branch_id_fkey";
ALTER TABLE "payroll_runs" VALIDATE CONSTRAINT "payroll_runs_branch_id_fkey";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_exclusive_branch_id_fkey";
ALTER TABLE "shifts" VALIDATE CONSTRAINT "shifts_branch_id_fkey";
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_branch_id_fkey";

-- Live-branch guard on operational history writes. audit_logs and
-- fraud_alerts are evidence about a branch and may be written after it is
-- deleted (the deletion's own audit entry names it), so they are not guarded.
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "attendance_records" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "catalog_management_assignments" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "discount_proof_uploads" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "employee_pay_rates" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "expenses" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "extra_supply_issue_lines" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "extra_supply_issues" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "extra_supply_operations" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "ingredients" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "inventory_cost_corrections" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "inventory_movements" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "inventory_stock_movements" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "manual_discount_types" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "payroll_policies" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "payroll_runs" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "exclusive_branch_id" ON "products" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_exclusive_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "shifts" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "transactions" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
