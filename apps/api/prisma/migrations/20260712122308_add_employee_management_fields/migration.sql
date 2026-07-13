-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deactivated_at" TIMESTAMP(3),
ADD COLUMN     "deactivated_by" TEXT,
ADD COLUMN     "deactivation_reason" TEXT,
ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT true;
