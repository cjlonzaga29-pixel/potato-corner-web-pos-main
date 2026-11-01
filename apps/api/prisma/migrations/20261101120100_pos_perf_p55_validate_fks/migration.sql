-- POS-PERF-P55 — validate the NOT VALID foreign key from 20261101120000.
-- Takes SHARE UPDATE EXCLUSIVE on transactions, which does not block
-- checkout inserts. Every pre-P55 row has manual_discount_type_id NULL.
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_manual_discount_type_id_fkey";
