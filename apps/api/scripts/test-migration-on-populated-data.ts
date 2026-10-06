// POS-PERF-P15R3 — a real pre-migration-to-post-migration upgrade test.
//
// The pre-existing "migration safety" test in checkout-worker.integration.
// test.ts only ever inserts rows AFTER every migration (including the one
// it claims to test) has already been applied — that proves the new
// columns' DEFAULTs work for a brand-new row, nothing about what happens to
// rows that existed BEFORE the migration ran. This script controls which
// migrations are applied at each step so it can actually reproduce an
// upgrade: insert data under the OLD schema, apply the migration, then
// check the pre-existing rows.
//
// Covers both recent additive migrations:
//   1. 20261005150000_add_fast_checkout_background_deduction
//      (inventory_stocks.quantity_reserved, transactions.idempotency_key)
//   2. 20261006040000_add_checkout_attempt_fencing (checkout_attempts table)
//
// Usage (from apps/api, no Docker/admin elevation required):
//   npx tsx scripts/test-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
const TARGET_MIGRATIONS = ['20261005150000_add_fast_checkout_background_deduction', '20261006040000_add_checkout_attempt_fencing'];
const backupDir = path.join(os.tmpdir(), `pos-migration-test-backup-${randomUUID().slice(0, 8)}`);

const DB_DIR = path.join(os.tmpdir(), `pos-migration-test-pg-${randomUUID().slice(0, 8)}`);
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DB_NAME = 'pos_migration_test';
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
  // Move the two target migrations OUT so `prisma migrate deploy` applies
  // everything up through 20260816190000_add_inventory_receiving_v2 only.
  for (const name of TARGET_MIGRATIONS) {
    fs.renameSync(path.join(migrationsDir, name), path.join(backupDir, name));
  }

  console.log(`[migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[migration-test] applying pre-existing migrations (everything before the two under test)');
    sh('npx prisma migrate deploy', env);

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log('[migration-test] seeding legacy rows under the OLD (pre-migration) schema');
    const branchId = randomUUID();
    const userId = randomUUID();
    const itemId = randomUUID();
    const unitId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "branches" ("id","name","code","address","city","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,now(),now())`,
      branchId, 'Migration Test Branch', `MIG${randomUUID().slice(0, 6)}`, '1 Test St', 'Testville',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","created_at","updated_at") VALUES ($1,$2,'unused','staff','Migration','Test','regular',now(),now())`,
      userId, `migration-test-${randomUUID()}@potatocorner.test`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "units_of_measure" ("id","code","name","dimension","is_base_unit","updated_at") VALUES ($1,$2,'Piece','COUNT',true,now())`,
      unitId, `mig-${randomUUID().slice(0, 6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_items" ("id","name","base_unit_id","track_inventory","created_at","updated_at") VALUES ($1,$2,$3,true,now(),now())`,
      itemId, `Migration Test Item ${randomUUID().slice(0, 8)}`, unitId,
    );
    // Pre-migration shape: no quantity_reserved column exists yet.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_stocks" ("id","branch_id","inventory_item_id","quantity_on_hand","updated_at") VALUES ($1,$2,$3,100,now())`,
      randomUUID(), branchId, itemId,
    );
    // Pre-migration shape: no idempotency_key column exists yet. Two
    // legacy transactions, to later confirm NULL idempotency_key (added by
    // the migration) never collides between them under the new unique index.
    const txnA = randomUUID();
    const txnB = randomUUID();
    for (const [id, num, amt] of [[txnA, `MIG-A-${randomUUID()}`, 10], [txnB, `MIG-B-${randomUUID()}`, 20]]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "transactions" ("id","transaction_number","branch_id","cashier_id","payment_method","subtotal","vat_amount","total_amount","created_at","updated_at")
         VALUES ($1,$2,$3,$4,'cash',$5,1.07,$5,now(),now())`,
        id, num, branchId, userId, amt,
      );
    }
    assert((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "transactions" WHERE id IN ($1,$2)`, txnA, txnB))[0].c === 2, 'both legacy transactions inserted under the old schema');

    await prisma.$disconnect();

    console.log('[migration-test] applying migration 1/2: 20261005150000_add_fast_checkout_background_deduction');
    fs.renameSync(path.join(backupDir, TARGET_MIGRATIONS[0]), path.join(migrationsDir, TARGET_MIGRATIONS[0]));
    sh('npx prisma migrate deploy', env);

    const prisma2 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const stockRow = (await prisma2.$queryRawUnsafe(`SELECT quantity_on_hand, quantity_reserved FROM "inventory_stocks" WHERE inventory_item_id = $1`, itemId))[0];
    assert(Number(stockRow.quantity_reserved) === 0, `pre-existing InventoryStock row defaults quantity_reserved to 0 after migration (got ${stockRow.quantity_reserved})`);
    assert(Number(stockRow.quantity_on_hand) === 100, 'pre-existing quantity_on_hand is untouched by the migration');

    const legacyRows = await prisma2.$queryRawUnsafe(`SELECT id, idempotency_key FROM "transactions" WHERE id IN ($1,$2)`, txnA, txnB);
    assert(legacyRows.length === 2, 'both legacy transactions survived the migration (no data loss)');
    assert(legacyRows.every((r) => r.idempotency_key === null), 'pre-existing transactions get NULL idempotency_key, never a default collision value');

    // The real proof the unique index is sound for pre-existing data: a
    // THIRD transaction, also with a NULL idempotency_key, must insert
    // without violating the new unique index — Postgres never treats two
    // NULLs as equal.
    const txnC = randomUUID();
    await prisma2.$executeRawUnsafe(
      `INSERT INTO "transactions" ("id","transaction_number","branch_id","cashier_id","payment_method","subtotal","vat_amount","total_amount","created_at","updated_at")
       VALUES ($1,$2,$3,$4,'cash',5,0.54,5,now(),now())`,
      txnC, `MIG-C-${randomUUID()}`, branchId, userId,
    );
    assert(true, 'a third NULL-idempotency_key transaction inserts cleanly post-migration (NULLs never collide under the new unique index)');

    await prisma2.$disconnect();

    console.log('[migration-test] applying migration 2/2: 20261006040000_add_checkout_attempt_fencing');
    fs.renameSync(path.join(backupDir, TARGET_MIGRATIONS[1]), path.join(migrationsDir, TARGET_MIGRATIONS[1]));
    sh('npx prisma migrate deploy', env);

    const prisma3 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    // The checkout_attempts table must exist and accept a row referencing
    // one of the pre-existing (pre-migration-era) transactions via its FK —
    // proves the new table composes correctly with data that predates it.
    await prisma3.$executeRawUnsafe(
      `INSERT INTO "checkout_attempts" ("idempotency_key","branch_id","cashier_id","status","transaction_id","owner_token","lease_expires_at","created_at","updated_at")
       VALUES ($1,$2,$3,'committed',$4,$5,now(),now(),now())`,
      randomUUID(), branchId, userId, txnA, randomUUID(),
    );
    assert(true, 'checkout_attempts row referencing a pre-migration-era transaction inserts cleanly');

    const stillThere = await prisma3.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "transactions" WHERE id IN ($1,$2,$3)`, txnA, txnB, txnC);
    assert(stillThere[0].c === 3, 'all three pre-existing transactions are untouched by the checkout_attempts migration');

    await prisma3.$disconnect();

    console.log('\n[migration-test] ALL CHECKS PASSED — both migrations are safe against populated pre-migration tables.\n');
  } finally {
    // Restore any migration folders still sitting in the backup dir (in
    // case an assertion threw before a later rename ran).
    for (const name of TARGET_MIGRATIONS) {
      const backupPath = path.join(backupDir, name);
      if (fs.existsSync(backupPath)) fs.renameSync(backupPath, path.join(migrationsDir, name));
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      await pg.stop();
    } catch (error) {
      // Windows occasionally still holds a file handle in the data dir for
      // a moment after postgres exits, so stop()'s own rmdir cleanup can
      // fail with EBUSY even though postgres itself shut down cleanly —
      // cosmetic only (see with-test-postgres.ts's identical guard).
      console.warn('[migration-test] non-fatal cleanup error:', error instanceof Error ? error.message : error);
    }
  }
}

main().catch((error) => {
  console.error('[migration-test] FAILED:', error);
  process.exitCode = 1;
});
