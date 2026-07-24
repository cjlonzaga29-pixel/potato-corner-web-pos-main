-- Branch Operating System (CR-003)
-- Add branch role enum value
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'branch';

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('active', 'inactive', 'suspended', 'resigned', 'terminated');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "status" "EmployeeStatus" NOT NULL DEFAULT 'active';

-- Backfill status from the existing is_active boolean so previously
-- deactivated accounts are not silently reactivated by the new column's
-- default.
UPDATE "users" SET "status" = 'inactive' WHERE "is_active" = false;
