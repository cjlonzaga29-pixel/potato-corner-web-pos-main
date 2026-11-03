-- POS-PERF-P60 — validates what the previous migration added NOT VALID, in its own
-- transaction, so its SHARE UPDATE EXCLUSIVE lock doesn't block reads or writes.
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_expense_type_id_fkey";
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_expense_type_name_check";
