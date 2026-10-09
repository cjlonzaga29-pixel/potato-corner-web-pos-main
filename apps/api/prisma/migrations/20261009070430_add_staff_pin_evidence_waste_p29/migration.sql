-- AlterEnum
ALTER TYPE "InventoryApprovalOperation" ADD VALUE 'WASTE';

-- AlterTable
ALTER TABLE "inventory_approval_requests" ADD COLUMN     "pin_verified_at" TIMESTAMP(3),
ADD COLUMN     "responsible_staff_name" TEXT,
ADD COLUMN     "responsible_staff_user_id" TEXT;

-- AlterTable
ALTER TABLE "inventory_stock_movements" ADD COLUMN     "pin_verified_at" TIMESTAMP(3),
ADD COLUMN     "recorded_as_supervisor_direct" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "responsible_staff_name" TEXT;

-- CreateTable
CREATE TABLE "staff_pins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "pin_lookup_digest" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "set_by_user_id" TEXT,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_pin_branch_lookups" (
    "id" TEXT NOT NULL,
    "staff_pin_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "pin_lookup_digest" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pin_branch_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_pin_verifications" (
    "id" TEXT NOT NULL,
    "token_digest" TEXT NOT NULL,
    "staff_pin_id" TEXT NOT NULL,
    "verified_by_actor_user_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "operation" "InventoryApprovalOperation" NOT NULL,
    "inventory_item_id" TEXT,
    "payload_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pin_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_operation_attempts" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "operation" "InventoryApprovalOperation" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "result_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_operation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_evidence_uploads" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "uploaded_by_user_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "proof_type" "ImageProofType" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_evidence_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_pins_user_id_key" ON "staff_pins"("user_id");

-- CreateIndex
CREATE INDEX "staff_pin_branch_lookups_staff_pin_id_idx" ON "staff_pin_branch_lookups"("staff_pin_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_pin_branch_lookups_branch_id_pin_lookup_digest_key" ON "staff_pin_branch_lookups"("branch_id", "pin_lookup_digest");

-- CreateIndex
CREATE UNIQUE INDEX "staff_pin_verifications_token_digest_key" ON "staff_pin_verifications"("token_digest");

-- CreateIndex
CREATE INDEX "staff_pin_verifications_staff_pin_id_idx" ON "staff_pin_verifications"("staff_pin_id");

-- CreateIndex
CREATE INDEX "staff_pin_verifications_expires_at_idx" ON "staff_pin_verifications"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_operation_attempts_idempotency_key_actor_user_id_key" ON "inventory_operation_attempts"("idempotency_key", "actor_user_id");

-- CreateIndex
CREATE INDEX "inventory_evidence_uploads_branch_id_uploaded_by_user_id_idx" ON "inventory_evidence_uploads"("branch_id", "uploaded_by_user_id");

-- CreateIndex
CREATE INDEX "inventory_evidence_uploads_expires_at_idx" ON "inventory_evidence_uploads"("expires_at");

-- AddForeignKey
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_pin_branch_lookups" ADD CONSTRAINT "staff_pin_branch_lookups_staff_pin_id_fkey" FOREIGN KEY ("staff_pin_id") REFERENCES "staff_pins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_pin_branch_lookups" ADD CONSTRAINT "staff_pin_branch_lookups_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_pin_verifications" ADD CONSTRAINT "staff_pin_verifications_staff_pin_id_fkey" FOREIGN KEY ("staff_pin_id") REFERENCES "staff_pins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
