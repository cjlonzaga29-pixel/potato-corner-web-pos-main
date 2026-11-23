// Product permanent delete — populated upgrade rehearsal for
//   20261124120000_product_permanent_delete + 20261124130000_product_delete_history_guard
// Same technique as test-p55-migration-on-populated-data.ts: the pre-release
// state is built from a temporary COPY of the migrations folder (the repo's
// own folder is never moved), representative history is seeded under that
// older schema, then the real migration is applied with `migrate deploy`.
//
// Asserts: every column of every table is byte-identical after the migration
// (row count + content MD5); the five history foreign keys are gone and the
// live-product triggers and hold_order_items index exist; no schema drift.
// Then, on the migrated data: a sold product is permanently deleted through
// the service and every history table (sales, lines, held lines, change
// logs, stock movements) is still byte-identical; a new sale line or held
// line for the deleted product is refused by the database; a sold size of a
// live product still can't be deleted on its own.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-product-delete-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
// Both migrations of this release; they are deployed together.
const PENDING = ['20261124120000_product_permanent_delete', '20261124130000_product_delete_history_guard'];
const SALES = Number(process.env.PDEL_REHEARSAL_SALES || 20000);
const workDir = path.join(os.tmpdir(), `pos-pdel-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 46900 + Math.floor(Math.random() * 100);
const DB_NAME = `pdel_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:469\d{2}\/pdel_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const pg = new EmbeddedPostgres({ databaseDir: DB_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });

function sh(cmd: string, env: Record<string, string>) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  assert(migrations.slice(-PENDING.length).join(',') === PENDING.join(','), `pending migrations are the last ones: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (PENDING.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[pdel-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[pdel-migration-test] applying every migration before this release');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DIRECT_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[pdel-migration-test] seeding representative history (${SALES} sales)`);
    const branch = await db.branch.create({ data: { name: 'North', code: 'PDEL-N', address: 'x', city: 'x', status: 'active' } });
    const sup = await db.user.create({ data: { role: 'supervisor', firstName: 'S', lastName: 'S', email: 'sup@pdel.test', employmentType: 'regular', mustChangePassword: false } });
    const ana = await db.user.create({ data: { role: 'staff', firstName: 'Ana', lastName: 'Reyes', email: 'ana@pdel.test', employeeId: 'PDEL-ANA', employmentType: 'regular', mustChangePassword: false } });
    await db.userBranchAssignment.createMany({ data: [{ userId: sup.id, branchId: branch.id }, { userId: ana.id, branchId: branch.id }] });
    const shift = await db.shift.create({ data: { branchId: branch.id, cashierId: ana.id, openedBy: ana.id, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
    const unit = await db.unitOfMeasure.create({ data: { code: 'pdel-g', name: 'Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    const item = await db.inventoryItem.create({ data: { name: 'Potato', baseUnitId: unit.id } });
    await db.inventoryStock.create({ data: { branchId: branch.id, inventoryItemId: item.id, quantityOnHand: 5000 } });

    const makeProduct = async (name: string) => {
      const product = await db.product.create({ data: { name, status: 'active', everPublished: true, createdBy: sup.id } });
      const variant = await db.productVariant.create({ data: { productId: product.id, name: 'Regular', sizeLabel: 'Regular', basePrice: 112, isActive: true, lifecycleStatus: 'ACTIVE' } });
      await db.productComponent.create({ data: { productVariantId: variant.id, inventoryItemId: item.id, quantityRequired: 3 } });
      await db.branchProductAvailability.create({ data: { branchId: branch.id, productId: product.id, isAvailable: true } });
      return { product, variant };
    };
    const retired = await makeProduct('Retired Fries');
    const kept = await makeProduct('Classic Fries');

    // Sales: half for each product, completed / voided / refunded, every line with a deduction snapshot.
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, status, updated_at)
       SELECT gen_random_uuid(), 'PC-PDEL-' || g, $1, $2, $3, 'cash', 112, 0, 0, 0, 112,
              (CASE WHEN g % 20 = 0 THEN 'voided' WHEN g % 25 = 0 THEN 'refunded' ELSE 'completed' END)::"TransactionStatus", now()
       FROM generate_series(1, ${SALES}) g`,
      branch.id, shift.id, ana.id,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total, deduction_snapshot)
       SELECT gen_random_uuid(), t.id,
              CASE WHEN right(t.transaction_number, 1) IN ('0','2','4','6','8') THEN $1 ELSE $3 END,
              CASE WHEN right(t.transaction_number, 1) IN ('0','2','4','6','8') THEN $2 ELSE $4 END,
              CASE WHEN right(t.transaction_number, 1) IN ('0','2','4','6','8') THEN 'Retired Fries' ELSE 'Classic Fries' END,
              'Regular', 112, 1, 112, jsonb_build_array(jsonb_build_object('inventoryItemId', $5::text, 'quantity', 3, 'baseUnitId', $6::text))
       FROM transactions t WHERE t.branch_id = $7`,
      retired.product.id, retired.variant.id, kept.product.id, kept.variant.id, item.id, unit.id, branch.id,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_stock_movements (id, branch_id, inventory_item_id, movement_type, quantity_change, quantity_before, quantity_after, unit_id, reference_type, reference_id, created_at)
       SELECT gen_random_uuid(), $1, $2, (CASE WHEN t.status = 'completed' THEN 'SALE' ELSE 'SALE_REVERSAL' END)::"InventoryStockMovementType",
              CASE WHEN t.status = 'completed' THEN -3 ELSE 3 END, 5000, 5000, $3, 'transaction', t.id, now()
       FROM transactions t WHERE t.branch_id = $1`,
      branch.id, item.id, unit.id,
    );
    const movementRows = await db.inventoryStockMovement.count({ where: { branchId: branch.id } });
    assert(movementRows === SALES, `stock movements seeded for every sale (${movementRows})`);
    // A released held order for the product being retired (history), and change logs for its size.
    await db.holdOrder.create({
      data: {
        branchId: branch.id, shiftId: shift.id, cashierId: ana.id, status: 'released', expiresAt: new Date(), releasedAt: new Date(),
        items: { create: [{ productId: retired.product.id, productVariantId: retired.variant.id, productNameSnapshot: 'Retired Fries', variantNameSnapshot: 'Regular', unitPriceSnapshot: 112, quantity: 2 }] },
      },
    });
    await db.productChangeLog.create({ data: { productVariantId: retired.variant.id, version: 1, changedById: sup.id, reason: 'Price change', snapshotJson: { base_price: 100 } } });

    type Col = { table_name: string; columns: string[] };
    const tables = await db.$queryRawUnsafe<Col[]>(
      `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' GROUP BY table_name ORDER BY table_name`,
    );
    const fingerprint = async (client: InstanceType<typeof PrismaClient>, only?: string[]) => {
      const out: Record<string, string> = {};
      for (const { table_name, columns } of tables) {
        if (only && !only.includes(table_name)) continue;
        const cols = columns.map((c) => `"${c}"`).join(', ');
        const [row] = await client.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
          `SELECT count(*) AS n, md5(string_agg(r, '|' ORDER BY r)) AS h FROM (SELECT ROW(${cols})::text AS r FROM "${table_name}") s`,
        );
        out[table_name] = `${row?.n}:${row?.h}`;
      }
      return out;
    };
    const before = await fingerprint(db);
    console.log(`  fingerprinted ${tables.length} tables (${Object.values(before).filter((v) => !v.startsWith('0:')).length} populated)`);
    await db.$disconnect();

    console.log('[pdel-migration-test] applying the product permanent delete migration');
    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - started;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const afterPrints = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterPrints[t]);
    assert(changed.length === 0, `all ${tables.length} tables byte-identical after the migration (changed: ${changed.join(', ') || 'none'})`);

    const fks = await after.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('transaction_items_product_id_fkey','transaction_items_product_variant_id_fkey','hold_order_items_product_id_fkey','hold_order_items_product_variant_id_fkey','product_change_logs_product_variant_id_fkey')`,
    );
    assert(fks.length === 0, 'the five history foreign keys are dropped');
    const triggers = await after.$queryRawUnsafe<{ tgrelid: string }[]>(`SELECT tgrelid::regclass::text AS tgrelid FROM pg_trigger WHERE tgname = 'product_delete_live_product' ORDER BY 1`);
    assert(triggers.map((t) => t.tgrelid).join(',') === 'hold_order_items,product_change_logs,transaction_items', 'live-product triggers on the three history tables');
    const guards = await after.$queryRawUnsafe<{ tgrelid: string }[]>(`SELECT tgrelid::regclass::text AS tgrelid FROM pg_trigger WHERE tgname = 'product_delete_guard_history' ORDER BY 1`);
    assert(guards.map((t) => t.tgrelid).join(',') === 'product_variants,products', 'history delete guards on products and product_variants');
    const [index] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'hold_order_items_product_id_idx'`);
    assert(index?.n === 1n, 'hold_order_items(product_id) index exists');
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);

    console.log('[pdel-migration-test] schema drift: migrated DB vs schema.prisma');
    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no drift');

    console.log('[pdel-migration-test] permanent delete on the migrated data');
    const history = ['transactions', 'transaction_items', 'hold_orders', 'hold_order_items', 'product_change_logs', 'inventory_stock_movements', 'inventory_stocks', 'inventory_items'];
    const tableNames = new Set(tables.map((t) => t.table_name));
    assert(history.every((t) => tableNames.has(t)), 'every history table compared exists');
    const historyBefore = await fingerprint(after, history);
    // The pre-release API's plain delete cascade (no permanent-delete checks) is still refused for a sold product.
    let oldCascadeCode = '';
    try {
      await after.$transaction(async (tx) => {
        await tx.branchProductAvailability.deleteMany({ where: { productId: retired.product.id } });
        await tx.productVariantFlavor.deleteMany({ where: { productVariantId: retired.variant.id } });
        await tx.productVariant.delete({ where: { id: retired.variant.id } });
        await tx.product.delete({ where: { id: retired.product.id } });
      });
    } catch (error) {
      oldCascadeCode = (error as { code?: string }).code ?? String(error);
    }
    assert(oldCascadeCode === 'P2003', `the pre-release delete cascade is refused as before (P2003, got ${oldCascadeCode})`);
    const afterRefusal = await fingerprint(after);
    assert(Object.keys(before).every((t) => before[t] === afterRefusal[t]), 'nothing changed by the refused cascade');
    process.env.PRODUCT_PERMANENT_DELETE_ENABLED = 'true';
    const { productDeletionService } = await import('../src/modules/products/product-deletion.service.js');
    const result = await productDeletionService.permanentlyDelete(retired.product.id, { id: sup.id, role: 'supervisor' }, null);
    assert(result.name === 'Retired Fries', 'sold product permanently deleted through the service');
    assert((await after.product.findUnique({ where: { id: retired.product.id } })) === null, 'product row gone');
    assert((await after.productVariant.count({ where: { productId: retired.product.id } })) === 0, 'its size gone');
    const historyAfter = await fingerprint(after, history);
    const historyChanged = history.filter((t) => historyBefore[t] !== historyAfter[t]);
    assert(historyChanged.length === 0, `history byte-identical after the delete (${history.join(', ')}; changed: ${historyChanged.join(', ') || 'none'})`);
    const [lines] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM transaction_items WHERE product_id = $1 AND product_name_snapshot = 'Retired Fries'`, retired.product.id);
    assert(Number(lines?.n) === Math.floor(SALES / 2), `every sale line keeps the original product id and name (${lines?.n})`);

    let refused = '';
    try {
      await after.$executeRawUnsafe(
        `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total)
         SELECT gen_random_uuid(), id, $1, $2, 'x', 'x', 1, 1, 1 FROM transactions LIMIT 1`,
        retired.product.id, retired.variant.id,
      );
    } catch (error) {
      refused = (error as Error).message;
    }
    assert(refused.includes('PRODUCT_PERMANENTLY_DELETED'), 'a new sale line for the deleted product is refused by the database');
    const { VariantHasHistoryError } = await import('../src/modules/products/products.types.js');
    const { productsRepository } = await import('../src/modules/products/products.repository.js');
    let variantRefused = false;
    try {
      await productsRepository.deleteVariantCascade(kept.variant.id);
    } catch (error) {
      variantRefused = error instanceof VariantHasHistoryError;
    }
    assert(variantRefused, 'a sold size of a live product still cannot be deleted on its own');

    await after.$disconnect();
    console.log('[pdel-migration-test] PASS');
  } finally {
    await pg.stop().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
