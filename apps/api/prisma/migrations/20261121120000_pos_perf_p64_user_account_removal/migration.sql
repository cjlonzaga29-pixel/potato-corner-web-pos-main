-- POS-PERF-P64 — account removal that keeps history.
--
-- Additive only. No existing row is changed: every current account keeps
-- deleted_at NULL, so nothing is removed by running this migration.
--
-- A removed account stays as a non-login historical record so sales,
-- expenses, attendance, payroll, stock movements, proofs and audit entries
-- keep resolving to the real person. deleted_by is a plain user id (no FK),
-- like the other actor columns on this table.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deleted_by" TEXT;

CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- A removed account can never be active again — not through any endpoint,
-- a concurrent request, or an older API version after a rollback (older code
-- only knows is_active/status, and its reactivate/status writes now fail here
-- instead of restoring access). Prisma does not model CHECK constraints, so
-- this is invisible to the schema file but enforced by Postgres.
ALTER TABLE "users"
  ADD CONSTRAINT "users_removed_account_inactive_chk"
  CHECK ("deleted_at" IS NULL OR ("is_active" = false AND "status" <> 'active'));
