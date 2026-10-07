-- Rollback for 20261008010000_add_transaction_notes.
-- Not run automatically by `prisma migrate` — kept for the runbook only.
-- Safe at any time: drops only the column this migration added, and only
-- if a rollback of this specific feature is ever needed.

ALTER TABLE "transactions" DROP COLUMN IF EXISTS "notes";
