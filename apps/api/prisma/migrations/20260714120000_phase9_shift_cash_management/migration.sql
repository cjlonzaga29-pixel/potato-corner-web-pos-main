-- Phase 9 — Shift & Cash Management
--
-- The `shifts` / `shift_cash_denominations` tables and their enums already
-- existed (Phase 0 scaffolding for the `cash` module). This migration adds
-- only what Phase 9 actually needs on top of that: tri-state variance
-- approval, the cashier's own variance explanation (distinct from the
-- approver's reason, already present as variance_approval_reason), who
-- closed the shift, the composite indexes Phase 9 queries need, and the
-- one-open-shift-per-branch invariant enforced at the database level.

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN "closed_by" TEXT;
ALTER TABLE "shifts" ADD COLUMN "variance_approved" BOOLEAN;
ALTER TABLE "shifts" ADD COLUMN "variance_explanation" TEXT;

-- CreateIndex
CREATE INDEX "shifts_branch_id_status_idx" ON "shifts"("branch_id", "status");

-- CreateIndex
CREATE INDEX "shifts_opened_by_idx" ON "shifts"("opened_by");

-- Replace the single-column denominations index with the (shift_id, count_type)
-- composite Phase 9 actually queries (opening vs. closing breakdown lookups).
DROP INDEX "shift_cash_denominations_shift_id_idx";
CREATE INDEX "shift_cash_denominations_shift_id_count_type_idx" ON "shift_cash_denominations"("shift_id", "count_type");

-- Only one OPEN ('active') shift per branch at a time. Enforced here rather
-- than relying solely on the service-layer check in cash.service.ts, so a
-- race between two concurrent open-shift requests can't both succeed.
CREATE UNIQUE INDEX "shift_one_open_per_branch" ON "shifts"("branch_id") WHERE "status" = 'active';
