-- POS-PERF-P55R2 — validate the NOT VALID check from 20261101130000.
-- Takes SHARE UPDATE EXCLUSIVE on transactions, which does not block
-- checkout inserts. Every pre-P55R2 row has calculation_mode NULL.
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_calculation_mode_check";
