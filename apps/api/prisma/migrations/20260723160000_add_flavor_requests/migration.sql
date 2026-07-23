-- CreateTable
CREATE TABLE "flavor_requests" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "proposed_name" TEXT NOT NULL,
    "proposed_description" TEXT,
    "proposed_color_hex" TEXT NOT NULL,
    "proposed_display_order" INTEGER,
    "request_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "created_flavor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flavor_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flavor_requests_branch_id_idx" ON "flavor_requests"("branch_id");

-- CreateIndex
CREATE INDEX "flavor_requests_status_idx" ON "flavor_requests"("status");

-- AddForeignKey
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_created_flavor_id_fkey" FOREIGN KEY ("created_flavor_id") REFERENCES "flavors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
