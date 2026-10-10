// POS-PERF-P29R6 RELEASE VERIFICATION — a real pre-migration-to-post-migration
// upgrade test for 20261009070430_add_staff_pin_evidence_waste_p29.
//
// This migration's new tables (staff_pins, staff_pin_verifications, etc.) are
// irrelevant to existing rows — nothing to verify there. The actual risk is
// its two ALTER TABLE statements against already-populated tables:
//   - inventory_approval_requests gains 3 nullable columns (low risk)
//   - inventory_stock_movements gains "recorded_as_supervisor_direct"
//     BOOLEAN NOT NULL DEFAULT false (the one that matters: a NOT NULL add
//     to a populated table must not violate the constraint on existing rows)
// This script seeds a pre-existing movement + approval request under the
// prior schema, applies the migration under test, and confirms every
// pre-existing row survives with the new column defaulted correctly.
//
// Usage (from apps/api, no Docker/admin elevation required):
//   npx tsx scripts/test-p29-staff-pin-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
const TARGET_MIGRATION = '20261009070430_add_staff_pin_evidence_waste_p29';
const backupDir = path.join(os.tmpdir(), `pos-p29-migration-test-backup-${randomUUID().slice(0, 8)}`);

const DB_DIR = path.join(os.tmpdir(), `pos-p29-migration-test-pg-${randomUUID().slice(0, 8)}`);
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DB_NAME = 'pos_p29_migration_test';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

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
  fs.mkdirSync(backupDir, { recursive: true });
  fs.renameSync(path.join(migrationsDir, TARGET_MIGRATION), path.join(backupDir, TARGET_MIGRATION));

  console.log(`[p29-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p29-migration-test] applying every migration EXCEPT the one under test');
    sh('npx prisma migrate deploy', env);

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const ledgerBefore = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1`,
      TARGET_MIGRATION,
    );
    assert(ledgerBefore.length === 0, 'migration ledger does NOT yet contain the P29 migration');

    const colsBefore = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_stock_movements' AND column_name = 'recorded_as_supervisor_direct'`,
    );
    assert(colsBefore.length === 0, 'recorded_as_supervisor_direct does NOT yet exist on inventory_stock_movements');

    console.log('[p29-migration-test] seeding a populated pre-migration database');
    const branchId = randomUUID();
    const userId = randomUUID();
    const unitId = randomUUID();
    const itemId = randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "branches" ("id","name","code","address","city","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,now(),now())`,
      branchId, 'P29 Migration Test Branch', `P29${randomUUID().slice(0, 6)}`, '1 Test St', 'Testville',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","created_at","updated_at") VALUES ($1,$2,'unused','branch','Submit','Ter',$3::"EmploymentType",now(),now())`,
      userId, `p29-migration-test-${randomUUID()}@potatocorner.test`, 'regular',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "units_of_measure" ("id","code","name","dimension","is_base_unit","updated_at") VALUES ($1,$2,'Piece','COUNT',true,now())`,
      unitId, `p29-${randomUUID().slice(0, 6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_items" ("id","name","base_unit_id","track_inventory","created_at","updated_at") VALUES ($1,$2,$3,true,now(),now())`,
      itemId, `P29 Migration Test Item ${randomUUID().slice(0, 8)}`, unitId,
    );

    // Pre-existing movement rows, inserted under the OLD schema (no
    // recorded_as_supervisor_direct column exists yet at all) — this is
    // exactly the row shape that must survive ADD COLUMN ... NOT NULL
    // DEFAULT false without any constraint violation.
    const movementIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of movementIds) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "inventory_stock_movements" ("id","branch_id","inventory_item_id","movement_type","quantity_change","quantity_before","quantity_after","created_at")
         VALUES ($1,$2,$3,'ADJUSTMENT_IN',10,40,50,now())`,
        id, branchId, itemId,
      );
    }

    const rootId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_approval_requests"
       ("id","root_request_id","previous_request_id","revision_number","target","branch_id","inventory_item_id","operation","quantity_delta","status","submitted_by_user_id","submitted_at","created_at","updated_at")
       VALUES ($1,$1,NULL,1,'UNIVERSAL_ITEM',$2,$3,'ADJUSTMENT',5,'PENDING',$4,now(),now(),now())`,
      rootId, branchId, itemId, userId,
    );

    const movementsBefore = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "inventory_stock_movements" WHERE branch_id = $1`, branchId,
    );
    assert(movementsBefore.length === 3, 'all 3 pre-migration movement rows present before the migration');

    await prisma.$disconnect();

    console.log(`[p29-migration-test] applying the migration under test: ${TARGET_MIGRATION}`);
    fs.renameSync(path.join(backupDir, TARGET_MIGRATION), path.join(migrationsDir, TARGET_MIGRATION));
    sh('npx prisma migrate deploy', env);

    const prisma2 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const ledgerAfter = await prisma2.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1`,
      TARGET_MIGRATION,
    );
    assert(ledgerAfter.length === 1, 'migration ledger now contains the P29 migration');

    const colsAfter = await prisma2.$queryRawUnsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'inventory_stock_movements' AND column_name = 'recorded_as_supervisor_direct'`,
    );
    assert(colsAfter.length === 1, 'recorded_as_supervisor_direct now exists on inventory_stock_movements');
    assert(colsAfter[0].is_nullable === 'NO', 'the new column is genuinely NOT NULL (constraint actually applied, not silently nullable)');

    const movementsAfter = await prisma2.$queryRawUnsafe<{ id: string; recorded_as_supervisor_direct: boolean; pin_verified_at: Date | null; responsible_staff_name: string | null }[]>(
      `SELECT id, recorded_as_supervisor_direct, pin_verified_at, responsible_staff_name FROM "inventory_stock_movements" WHERE branch_id = $1 ORDER BY id`,
      branchId,
    );
    assert(movementsAfter.length === 3, 'all 3 pre-existing movement rows survived the migration — no data loss');
    assert(
      movementsAfter.every((r) => r.recorded_as_supervisor_direct === false),
      'every pre-existing movement row defaulted recorded_as_supervisor_direct to false, with no NOT NULL violation',
    );
    assert(
      movementsAfter.every((r) => r.pin_verified_at === null && r.responsible_staff_name === null),
      'nullable new columns (pin_verified_at, responsible_staff_name) default to NULL on pre-existing rows',
    );

    const approvalColsAfter = await prisma2.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_approval_requests' AND column_name IN ('pin_verified_at','responsible_staff_name','responsible_staff_user_id')`,
    );
    assert(approvalColsAfter.length === 3, 'all three new inventory_approval_requests columns now exist');

    const approvalAfter = (await prisma2.$queryRawUnsafe<{ id: string; status: string; responsible_staff_user_id: string | null }[]>(
      `SELECT id, status, responsible_staff_user_id FROM "inventory_approval_requests" WHERE id = $1`, rootId,
    ))[0];
    assert(approvalAfter.status === 'PENDING', 'pre-existing PENDING approval request status is untouched by the migration');
    assert(approvalAfter.responsible_staff_user_id === null, 'new nullable column defaults to NULL on the pre-existing approval row');

    const enumValsAfter = await prisma2.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'InventoryApprovalOperation'`,
    );
    assert(enumValsAfter.some((r) => r.enumlabel === 'WASTE'), 'WASTE enum value now exists on InventoryApprovalOperation');

    await prisma2.$disconnect();

    console.log('\n[p29-migration-test] ALL CHECKS PASSED — 20261009070430_add_staff_pin_evidence_waste_p29 is safe against a populated pre-migration database; the NOT NULL DEFAULT false column add does not violate existing rows.\n');
  } finally {
    const backupPath = path.join(backupDir, TARGET_MIGRATION);
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, path.join(migrationsDir, TARGET_MIGRATION));
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      await pg.stop();
    } catch (error) {
      console.warn('[p29-migration-test] non-fatal cleanup error:', error instanceof Error ? error.message : error);
    }
  }
}

main().catch((error) => {
  console.error('[p29-migration-test] FAILED:', error);
  process.exitCode = 1;
});
