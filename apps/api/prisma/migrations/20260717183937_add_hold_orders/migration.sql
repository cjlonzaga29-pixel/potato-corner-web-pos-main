-- CreateEnum
CREATE TYPE "HoldOrderStatus" AS ENUM ('held', 'released', 'expired');

-- CreateTable
CREATE TABLE "hold_orders" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "cashier_id" TEXT NOT NULL,
    "status" "HoldOrderStatus" NOT NULL DEFAULT 'held',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hold_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hold_order_items" (
    "id" TEXT NOT NULL,
    "hold_order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "flavor_id" TEXT,
    "product_name_snapshot" TEXT NOT NULL,
    "variant_name_snapshot" TEXT NOT NULL,
    "flavor_name_snapshot" TEXT,
    "unit_price_snapshot" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "hold_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hold_orders_shift_id_status_idx" ON "hold_orders"("shift_id", "status");

-- CreateIndex
CREATE INDEX "hold_orders_branch_id_status_idx" ON "hold_orders"("branch_id", "status");

-- CreateIndex
CREATE INDEX "hold_order_items_hold_order_id_idx" ON "hold_order_items"("hold_order_id");

-- AddForeignKey
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_hold_order_id_fkey" FOREIGN KEY ("hold_order_id") REFERENCES "hold_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_flavor_id_fkey" FOREIGN KEY ("flavor_id") REFERENCES "flavors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
