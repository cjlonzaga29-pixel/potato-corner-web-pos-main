-- Sale-time deduction snapshot per TransactionItem, additive alongside the
-- existing recipe_version column (not a replacement).
ALTER TABLE "transaction_items" ADD COLUMN "deduction_snapshot" JSONB;
