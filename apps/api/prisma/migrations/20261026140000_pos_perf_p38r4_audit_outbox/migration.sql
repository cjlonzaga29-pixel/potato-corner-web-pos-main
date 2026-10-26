-- POS-PERF-P38R4 — durable audit outbox for product publication.
-- Additive only: a new enum and a new table. No existing table, row or
-- constraint is touched, and audit_logs is unchanged. Must survive an
-- application rollback (an older API ignores it; pending rows wait for a
-- P38R4+ worker). See docs/runbooks/pos-perf-p38-automatic-branch-setup.md.

-- CreateEnum
CREATE TYPE "AuditOutboxStatus" AS ENUM ('pending', 'processing', 'delivered', 'stuck');

-- CreateTable
CREATE TABLE "audit_outbox" (
    "id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "actor_id" TEXT,
    "actor_role" TEXT NOT NULL,
    "branch_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "ip_address" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "status" "AuditOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "claim_token" TEXT,
    "delivered_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_outbox_event_key_key" ON "audit_outbox"("event_key");

-- CreateIndex
CREATE INDEX "audit_outbox_status_next_attempt_at_idx" ON "audit_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "audit_outbox_occurred_at_idx" ON "audit_outbox"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_outbox_group_id_position_key" ON "audit_outbox"("group_id", "position");
