-- POS-PERF-P51 — staff break intervals. Purely additive: one new enum, one
-- new table. No existing table, column or row is altered, and no break rows
-- are created for historical attendance (past records keep their stored
-- break_minutes exactly as they were).

-- CreateEnum
CREATE TYPE "AttendanceBreakEndReason" AS ENUM ('resumed', 'clock_out');

-- CreateTable
CREATE TABLE "attendance_breaks" (
    "id" TEXT NOT NULL,
    "attendance_record_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "started_by" TEXT NOT NULL,
    "ended_by" TEXT,
    "end_reason" "AttendanceBreakEndReason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_breaks_pkey" PRIMARY KEY ("id"),
    -- An interval never ends before it starts; an open break has neither an
    -- end time nor an end reason, a closed one has both.
    CONSTRAINT "attendance_breaks_interval_order" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
    CONSTRAINT "attendance_breaks_end_consistent" CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL))
);

-- CreateIndex
CREATE INDEX "attendance_breaks_attendance_record_id_started_at_idx" ON "attendance_breaks"("attendance_record_id", "started_at");

-- At most one open break per attendance record, enforced by the database so
-- two concurrent Start Break requests can never both commit.
CREATE UNIQUE INDEX "attendance_breaks_one_open_per_record" ON "attendance_breaks"("attendance_record_id") WHERE "ended_at" IS NULL;

-- AddForeignKey
ALTER TABLE "attendance_breaks" ADD CONSTRAINT "attendance_breaks_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
