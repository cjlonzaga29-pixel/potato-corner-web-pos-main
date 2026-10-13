// POS-PERF-P35R — populated pre-migration-to-post-migration upgrade test for
// 20261013061526_pos_perf_p35r_catalog_management_assignment, same technique
// as test-migration-on-populated-data.ts: seed rows under the OLD (pre-P35R,
// post-P35) schema, apply only this migration, then assert the pre-existing
// rows are untouched and the new managedBy/catalog_management_assignments
// surface composes correctly with them.
//
// Usage (from apps/api, no Docker/admin elevation required):
//   npx tsx scripts/test-p35r-catalog-assignment-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
const TARGET_MIGRATION = '20261013061526_pos_perf_p35r_catalog_management_assignment';
const backupDir = path.join(os.tmpdir(), `pos-p35r-migration-test-backup-${randomUUID().slice(0, 8)}`);

const DB_DIR = path.join(os.tmpdir(), `pos-p35r-migration-test-pg-${randomUUID().slice(0, 8)}`);
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DB_NAME = 'pos_p35r_migration_test';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

const pg = new EmbeddedPostgres({ databaseDir: DB_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });

function sh(cmd, env) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

async function main() {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.renameSync(path.join(migrationsDir, TARGET_MIGRATION), path.join(backupDir, TARGET_MIGRATION));

  console.log(`[p35r-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p35r-migration-test] applying pre-existing migrations (everything through P35, before P35R)');
    sh('npx prisma migrate deploy', env);

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log('[p35r-migration-test] seeding legacy rows under the OLD (post-P35, pre-P35R) schema');
    const branchId = randomUUID();
    const adminId = randomUUID();
    const supervisorId = randomUUID();
    const unitId = randomUUID();
    const categoryId = randomUUID();
    const itemId = randomUUID();
    const productCategoryId = randomUUID();
    const exclusiveProductId = randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "branches" ("id","name","code","address","city","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,now(),now())`,
      branchId, 'P35R Migration Test Branch', `P35R${randomUUID().slice(0, 6)}`, '1 Test St', 'Testville',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","is_active","created_at","updated_at")
       VALUES ($1,$2,'unused','super_admin','Admin','Legacy','regular',true,now(),now())`,
      adminId, `p35r-admin-${randomUUID()}@potatocorner.test`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","is_active","created_at","updated_at")
       VALUES ($1,$2,'unused','supervisor','Juan','DelaCruz','regular',true,now(),now())`,
      supervisorId, `p35r-sup-${randomUUID()}@potatocorner.test`,
    );
    // POS-PERF-P35's createdBy already exists here but POS-PERF-P35R's
    // managedBy does not yet — the exact pre-migration shape this script
    // reproduces.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "units_of_measure" ("id","code","name","dimension","is_base_unit","created_by","updated_at") VALUES ($1,$2,'Gram','WEIGHT',true,NULL,now())`,
      unitId, `p35r-${randomUUID().slice(0, 6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_categories" ("id","name","created_by","updated_at") VALUES ($1,'Legacy Toppings',NULL,now())`,
      categoryId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_items" ("id","name","base_unit_id","category_id","track_inventory","created_by","created_at","updated_at")
       VALUES ($1,$2,$3,$4,true,$5,now(),now())`,
      itemId, `P35R Legacy Item ${randomUUID().slice(0, 8)}`, unitId, categoryId, adminId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "product_categories" ("id","code","name","created_by","created_at","updated_at") VALUES ($1,$2,'Legacy Category',$3,now(),now())`,
      productCategoryId, `p35r-cat-${randomUUID().slice(0, 6)}`, supervisorId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "products" ("id","name","category_id","branch_exclusive","exclusive_branch_id","created_by","created_at","updated_at")
       VALUES ($1,'Legacy Exclusive Product',$2,true,$3,$4,now(),now())`,
      exclusiveProductId, productCategoryId, branchId, supervisorId,
    );

    assert(
      (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "inventory_items" WHERE id = $1`, itemId))[0].c === 1,
      'legacy InventoryItem inserted under the old (pre-managed_by) schema',
    );

    await prisma.$disconnect();

    console.log(`[p35r-migration-test] applying migration: ${TARGET_MIGRATION}`);
    fs.renameSync(path.join(backupDir, TARGET_MIGRATION), path.join(migrationsDir, TARGET_MIGRATION));
    sh('npx prisma migrate deploy', env);

    const prisma2 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const item = (await prisma2.$queryRawUnsafe(`SELECT name, created_by, managed_by FROM "inventory_items" WHERE id = $1`, itemId))[0];
    assert(item.created_by === adminId, 'pre-existing InventoryItem.created_by (an Admin-created row) is untouched by the migration');
    assert(item.managed_by === null, 'pre-existing InventoryItem defaults managed_by to NULL — no guessed/backfilled assignment');

    const category = (await prisma2.$queryRawUnsafe(`SELECT created_by, managed_by FROM "inventory_categories" WHERE id = $1`, categoryId))[0];
    assert(category.created_by === null && category.managed_by === null, 'pre-existing NULL-owned InventoryCategory stays NULL/NULL (still frozen, not auto-claimed)');

    const unit = (await prisma2.$queryRawUnsafe(`SELECT created_by, managed_by FROM "units_of_measure" WHERE id = $1`, unitId))[0];
    assert(unit.managed_by === null, 'pre-existing UnitOfMeasure defaults managed_by to NULL');

    const productCategory = (await prisma2.$queryRawUnsafe(`SELECT created_by, managed_by FROM "product_categories" WHERE id = $1`, productCategoryId))[0];
    assert(productCategory.created_by === supervisorId && productCategory.managed_by === null, 'pre-existing supervisor-owned ProductCategory keeps created_by, gets NULL managed_by');

    const product = (await prisma2.$queryRawUnsafe(`SELECT name, created_by, exclusive_branch_id FROM "products" WHERE id = $1`, exclusiveProductId))[0];
    assert(product.created_by === supervisorId && product.exclusive_branch_id === branchId, 'pre-existing branch-exclusive Product survives untouched (name, created_by, exclusive_branch_id)');

    const tableExists = await prisma2.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'catalog_management_assignments') AS exists`,
    );
    assert(tableExists[0].exists === true, 'catalog_management_assignments table was created');

    const assignmentCountBefore = await prisma2.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "catalog_management_assignments"`);
    assert(assignmentCountBefore[0].c === 0, 'catalog_management_assignments starts empty — no backfilled/guessed assignment rows');

    // The real proof the new FK-backed table composes with pre-existing
    // data: assign the legacy Admin-created InventoryItem to the
    // pre-existing supervisor and confirm the FK + managed_by update both
    // succeed against rows that predate this migration.
    const assignmentId = randomUUID();
    await prisma2.$executeRawUnsafe(
      `INSERT INTO "catalog_management_assignments"
         ("id","resource_type","resource_id","previous_managed_by","new_managed_by","assigned_by","reason","branch_id","created_at")
       VALUES ($1,'INVENTORY_ITEM',$2,NULL,$3,$4,'Migration verification assignment',NULL,now())`,
      assignmentId, itemId, supervisorId, adminId,
    );
    await prisma2.$executeRawUnsafe(`UPDATE "inventory_items" SET managed_by = $1 WHERE id = $2`, supervisorId, itemId);

    const itemAfterAssignment = (await prisma2.$queryRawUnsafe(`SELECT created_by, managed_by FROM "inventory_items" WHERE id = $1`, itemId))[0];
    assert(
      itemAfterAssignment.created_by === adminId && itemAfterAssignment.managed_by === supervisorId,
      'assigning management sets managed_by without overwriting the original created_by provenance',
    );

    await prisma2.$disconnect();

    console.log('\n[p35r-migration-test] ALL CHECKS PASSED — the P35R migration is safe against populated pre-migration tables.\n');
  } finally {
    const backupPath = path.join(backupDir, TARGET_MIGRATION);
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, path.join(migrationsDir, TARGET_MIGRATION));
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      await pg.stop();
    } catch (error) {
      console.warn('[p35r-migration-test] non-fatal cleanup error:', error instanceof Error ? error.message : error);
    }
  }
}

main().catch((error) => {
  console.error('[p35r-migration-test] FAILED:', error);
  process.exitCode = 1;
});
