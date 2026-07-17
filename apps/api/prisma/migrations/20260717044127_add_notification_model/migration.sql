-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_idx" ON "notifications"("recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_branch_id_created_at_idx" ON "notifications"("branch_id", "created_at");
