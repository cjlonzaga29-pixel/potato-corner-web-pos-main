// POS-PERF-P39R2 — fixtures for the Draft / Active / Inactive browser spec.
// Simulates audit delivery having failed for one product, so the spec can show
// the Products tabs do not need its history: every audit_outbox intent about
// the product (its availability rows or the product itself) is set to `stuck`,
// and every audit_logs entry about it is deleted. Local pos_verify only.
// Run with cwd = apps/api.
//
//   strand <productId>  -> { outbox_stuck, audit_logs_deleted }
//   state <productId>   -> { status, ever_published, on: [branchId...] }
const path = require('node:path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'apps', 'api', 'node_modules', '@prisma', 'client'));

async function main() {
  const [mode, productId] = process.argv.slice(2);
  require('./local-db-guard.cjs').assertLocalDatabase(); // POS-PERF-P44: local DB only
  const prisma = new PrismaClient();
  try {
    if (mode === 'strand') {
      const rows = await prisma.branchProductAvailability.findMany({ where: { productId }, select: { id: true } });
      const where = {
        OR: [
          { entityId: { in: [productId, ...rows.map((r) => r.id)] } },
          { afterState: { path: ['productId'], equals: productId } },
          { afterState: { path: ['product_id'], equals: productId } },
        ],
      };
      const stuck = await prisma.auditOutbox.updateMany({ where, data: { status: 'stuck', nextAttemptAt: null, lastError: 'p39r2 browser spec: delivery failed' } });
      const deleted = await prisma.auditLog.deleteMany({ where });
      console.log(JSON.stringify({ outbox_stuck: stuck.count, audit_logs_deleted: deleted.count }));
    } else if (mode === 'state') {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { status: true, everPublished: true, branchAvailability: { where: { isAvailable: true }, select: { branchId: true } } },
      });
      console.log(JSON.stringify({ status: product.status, ever_published: product.everPublished, on: product.branchAvailability.map((r) => r.branchId).sort() }));
    } else {
      throw new Error(`unknown mode ${mode}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
