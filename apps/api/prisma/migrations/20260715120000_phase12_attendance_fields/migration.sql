-- Phase 12 (Attendance): add correction-tracking and soft-delete columns
-- that were missing from the Phase-0 scaffolded attendance_records table.
-- clock_in_gps_status / clock_in_time_flag / break_minutes / etc. already
-- exist from the init migration and are unchanged.

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN "original_record_id" TEXT;
ALTER TABLE "attendance_records" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "attendance_records" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "attendance_records" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "attendance_records_corrected_by_idx" ON "attendance_records"("corrected_by");

-- CreateIndex
CREATE INDEX "attendance_records_original_record_id_idx" ON "attendance_records"("original_record_id");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_original_record_id_fkey" FOREIGN KEY ("original_record_id") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
