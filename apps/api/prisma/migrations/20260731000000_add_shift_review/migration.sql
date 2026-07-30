-- Production Stabilization sprint (2026-07): opening/closing shift review
-- approval, additive-only. Distinct from shifts.variance_approved and its
-- companion columns, which already cover cash variance review end-to-end.

-- CreateEnum
CREATE TYPE "ShiftReviewPhase" AS ENUM ('opening', 'closing');

-- CreateEnum
CREATE TYPE "ShiftReviewStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "shift_reviews" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "phase" "ShiftReviewPhase" NOT NULL,
    "status" "ShiftReviewStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shift_reviews_shift_id_phase_key" ON "shift_reviews"("shift_id", "phase");

-- CreateIndex
CREATE INDEX "shift_reviews_shift_id_idx" ON "shift_reviews"("shift_id");

-- CreateIndex
CREATE INDEX "shift_reviews_status_idx" ON "shift_reviews"("status");

-- CreateIndex
CREATE INDEX "shift_reviews_phase_idx" ON "shift_reviews"("phase");

-- CreateIndex
CREATE INDEX "shift_reviews_reviewed_by_idx" ON "shift_reviews"("reviewed_by");

-- CreateIndex
CREATE INDEX "shift_reviews_created_at_idx" ON "shift_reviews"("created_at");

-- AddForeignKey
ALTER TABLE "shift_reviews" ADD CONSTRAINT "shift_reviews_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_reviews" ADD CONSTRAINT "shift_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: give every pre-existing shift both review rows as 'pending' too,
-- so the new opening/closing review queue isn't empty for shifts opened
-- before this migration. New shifts get both rows from cash.repository.ts's
-- createShift going forward.
INSERT INTO "shift_reviews" ("id", "shift_id", "phase", "status", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "id", 'opening', 'pending', now(), now() FROM "shifts"
UNION ALL
SELECT gen_random_uuid()::text, "id", 'closing', 'pending', now(), now() FROM "shifts";
