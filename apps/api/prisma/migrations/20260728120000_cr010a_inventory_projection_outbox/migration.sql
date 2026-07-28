-- CreateEnum
CREATE TYPE "InventoryProjectionOutboxStatus" AS ENUM ('pending', 'processing', 'deferred', 'processed', 'stuck');

-- CreateTable
CREATE TABLE "inventory_projection_outbox" (
    "id" TEXT NOT NULL,
    "movement_id" TEXT NOT NULL,
    "status" "InventoryProjectionOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_projection_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_projection_outbox_movement_id_key" ON "inventory_projection_outbox"("movement_id");

-- CreateIndex
CREATE INDEX "inventory_projection_outbox_status_idx" ON "inventory_projection_outbox"("status");

-- CreateIndex
CREATE INDEX "inventory_projection_outbox_next_attempt_at_idx" ON "inventory_projection_outbox"("next_attempt_at");

-- CreateIndex
CREATE INDEX "inventory_projection_outbox_created_at_idx" ON "inventory_projection_outbox"("created_at");

-- AddForeignKey
ALTER TABLE "inventory_projection_outbox" ADD CONSTRAINT "inventory_projection_outbox_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "inventory_movements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
