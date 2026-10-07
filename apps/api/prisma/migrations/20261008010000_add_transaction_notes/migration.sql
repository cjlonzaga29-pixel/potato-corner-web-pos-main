-- POS-PERF-P25: optional cashier-entered order notes, captured at checkout
-- and surfaced on the Inventory Movements table's "Notes" column (for this
-- sale's background-worker-written SALE movements) and on the sale's own
-- detail view.
--
-- Purely additive: no existing column is dropped or retyped, no existing
-- row's data changes. Nullable with no default, so every pre-existing
-- Transaction row (and any client that never sends one) reads back NULL,
-- which the UI already renders as "—" the same way it does for every other
-- optional field on this table.
--
-- Rollback: see the accompanying rollback.sql in this same migration
-- directory (not run by `prisma migrate`, kept for the runbook only).

ALTER TABLE "transactions" ADD COLUMN "notes" TEXT;
