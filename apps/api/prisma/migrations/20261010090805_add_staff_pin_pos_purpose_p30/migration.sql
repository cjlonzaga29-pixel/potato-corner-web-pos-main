-- CreateEnum
CREATE TYPE "StaffPinPurpose" AS ENUM ('inventory', 'pos');

-- AlterTable
ALTER TABLE "staff_pin_verifications" ADD COLUMN     "purpose" "StaffPinPurpose" NOT NULL DEFAULT 'inventory',
ALTER COLUMN "operation" DROP NOT NULL;
