// POS-PERF-P30R4 — one-off helper for the real-browser identity-display
// verification spec. Inserts a stock movement row shaped exactly like a
// pre-P29 record (responsible_user_id set, responsible_staff_name/
// pin_verified_at both NULL) directly via Prisma, since the current API has
// no write path left that can ever produce that shape (every receive/
// adjust/waste route now requires a verified staff PIN). Run with cwd set
// to apps/api so @prisma/client resolves against that workspace's generated
// client and its own DATABASE_URL.
const { PrismaClient } = require('@prisma/client');

async function main() {
  const [branchId, inventoryItemId, quantityMarker, responsibleUserId] = process.argv.slice(2);
  if (!branchId || !inventoryItemId || !quantityMarker || !responsibleUserId) {
    throw new Error('usage: seed-legacy-movement.cjs <branchId> <inventoryItemId> <quantityMarker> <responsibleUserId>');
  }
  const prisma = new PrismaClient();
  try {
    const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { baseUnitId: true } });
    await prisma.inventoryStockMovement.create({
      data: {
        branchId,
        inventoryItemId,
        movementType: 'ADJUSTMENT_OUT',
        quantityChange: -1,
        quantityBefore: Number(quantityMarker),
        quantityAfter: Number(quantityMarker),
        unitId: item?.baseUnitId ?? null,
        notes: `P30R4 browser test: legacy pre-PIN row ${quantityMarker}`,
        performedByUserId: responsibleUserId,
        responsibleUserId,
        recordedAsSupervisorDirect: false,
        responsibleStaffName: null,
        pinVerifiedAt: null,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
