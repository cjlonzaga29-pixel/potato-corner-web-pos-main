// POS-PERF-P28R RELEASE VERIFICATION — a real pre-migration-to-post-migration
// upgrade test for 20261009050000_add_inventory_approval_cancellation.
//
// The runbook's existing "Migration validation performed for this task
// (P28R2)" entry only describes applying the full migration history from
// scratch to an empty database -- that proves the migration runs, not that
// it is safe against rows that existed BEFORE it ran. This script
// reproduces a real upgrade: apply every migration up to and including
// 20261008114838_add_inventory_approval_requests (P28, no cancellation
// support), seed a populated database (branch, stock, a movement, and an
// approval request correction chain: root PENDING -> RETURNED -> a second
// revision still PENDING), confirm the cancellation enum value/columns do
// not exist yet, then apply 20261009050000_add_inventory_approval_cancellation
// and confirm every pre-existing row and relationship survived intact.
//
// Usage (from apps/api, no Docker/admin elevation required):
//   npx tsx scripts/test-cancellation-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
const TARGET_MIGRATION = '20261009050000_add_inventory_approval_cancellation';
const backupDir = path.join(os.tmpdir(), `pos-cancel-migration-test-backup-${randomUUID().slice(0, 8)}`);

const DB_DIR = path.join(os.tmpdir(), `pos-cancel-migration-test-pg-${randomUUID().slice(0, 8)}`);
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DB_NAME = 'pos_cancel_migration_test';
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

  console.log(`[cancel-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[cancel-migration-test] applying every migration EXCEPT the cancellation migration under test');
    sh('npx prisma migrate deploy', env);

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const ledgerBefore = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1`,
      TARGET_MIGRATION,
    );
    assert(ledgerBefore.length === 0, 'migration ledger does NOT yet contain the cancellation migration');

    const enumValsBefore = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'InventoryApprovalStatus'`,
    );
    assert(!enumValsBefore.some((r) => r.enumlabel === 'CANCELLED'), 'CANCELLED enum value does NOT yet exist');

    const colsBefore = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_approval_requests' AND column_name IN ('cancelled_by_user_id','cancelled_at','cancel_reason')`,
    );
    assert(colsBefore.length === 0, 'cancellation columns do NOT yet exist on inventory_approval_requests');

    console.log('[cancel-migration-test] seeding a populated pre-migration database');
    const branchId = randomUUID();
    const userId = randomUUID();
    const reviewerId = randomUUID();
    const unitId = randomUUID();
    const itemId = randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "branches" ("id","name","code","address","city","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,now(),now())`,
      branchId, 'Cancel Migration Test Branch', `CMB${randomUUID().slice(0, 6)}`, '1 Test St', 'Testville',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","created_at","updated_at") VALUES ($1,$2,'unused','branch','Submit','Ter',$3::"EmploymentType",now(),now())`,
      userId, `cancel-migration-test-${randomUUID()}@potatocorner.test`, 'regular',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","password_hash","role","first_name","last_name","employment_type","created_at","updated_at") VALUES ($1,$2,'unused','supervisor','Review','Er',$3::"EmploymentType",now(),now())`,
      reviewerId, `cancel-migration-test-reviewer-${randomUUID()}@potatocorner.test`, 'regular',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "units_of_measure" ("id","code","name","dimension","is_base_unit","updated_at") VALUES ($1,$2,'Piece','COUNT',true,now())`,
      unitId, `cmb-${randomUUID().slice(0, 6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_items" ("id","name","base_unit_id","track_inventory","created_at","updated_at") VALUES ($1,$2,$3,true,now(),now())`,
      itemId, `Cancel Migration Test Item ${randomUUID().slice(0, 8)}`, unitId,
    );
    const stockId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_stocks" ("id","branch_id","inventory_item_id","quantity_on_hand","quantity_reserved","version","updated_at") VALUES ($1,$2,$3,50,0,0,now())`,
      stockId, branchId, itemId,
    );
    const movementId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_stock_movements" ("id","branch_id","inventory_item_id","movement_type","quantity_change","quantity_before","quantity_after","created_at")
       VALUES ($1,$2,$3,'ADJUSTMENT_IN',10,40,50,now())`,
      movementId, branchId, itemId,
    );

    // Correction chain under the OLD schema (pre-cancellation): root
    // request (revision 1) was RETURNED, then corrected into revision 2,
    // which is still live and PENDING. This is exactly the shape the
    // cancellation migration must not disturb.
    const rootId = randomUUID();
    const revision2Id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_approval_requests"
       ("id","root_request_id","previous_request_id","revision_number","target","branch_id","inventory_item_id","operation","quantity_delta","status","submitted_by_user_id","submitted_at","reviewed_by_user_id","reviewed_at","return_reason","created_at","updated_at")
       VALUES ($1,$1,NULL,1,'UNIVERSAL_ITEM',$2,$3,'ADJUSTMENT',5,'RETURNED',$4,now(),$5,now(),'Needs correction',now(),now())`,
      rootId, branchId, itemId, userId, reviewerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "inventory_approval_requests"
       ("id","root_request_id","previous_request_id","revision_number","target","branch_id","inventory_item_id","operation","quantity_delta","status","submitted_by_user_id","submitted_at","created_at","updated_at")
       VALUES ($1,$2,$2,2,'UNIVERSAL_ITEM',$3,$4,'ADJUSTMENT',7,'PENDING',$5,now(),now(),now())`,
      revision2Id, rootId, branchId, itemId, userId,
    );

    const chainBefore = await prisma.$queryRawUnsafe<{ id: string; status: string; revision_number: number }[]>(
      `SELECT id, status, revision_number FROM "inventory_approval_requests" WHERE root_request_id = $1 ORDER BY revision_number`,
      rootId,
    );
    assert(chainBefore.length === 2, 'pre-migration correction chain has both revisions');
    assert(chainBefore[0].status === 'RETURNED' && chainBefore[1].status === 'PENDING', 'pre-migration chain statuses are RETURNED then PENDING');

    await prisma.$disconnect();

    console.log(`[cancel-migration-test] applying the migration under test: ${TARGET_MIGRATION}`);
    fs.renameSync(path.join(backupDir, TARGET_MIGRATION), path.join(migrationsDir, TARGET_MIGRATION));
    sh('npx prisma migrate deploy', env);

    const prisma2 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const ledgerAfter = await prisma2.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1`,
      TARGET_MIGRATION,
    );
    assert(ledgerAfter.length === 1, 'migration ledger now contains the cancellation migration');

    const enumValsAfter = await prisma2.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'InventoryApprovalStatus'`,
    );
    assert(enumValsAfter.some((r) => r.enumlabel === 'CANCELLED'), 'CANCELLED enum value now exists');

    const colsAfter = await prisma2.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_approval_requests' AND column_name IN ('cancelled_by_user_id','cancelled_at','cancel_reason')`,
    );
    assert(colsAfter.length === 3, 'all three cancellation columns now exist');

    const stockAfter = (await prisma2.$queryRawUnsafe<{ quantity_on_hand: string }[]>(
      `SELECT quantity_on_hand FROM "inventory_stocks" WHERE id = $1`, stockId,
    ))[0];
    assert(Number(stockAfter.quantity_on_hand) === 50, 'pre-existing InventoryStock row untouched by the migration');

    const movementAfter = await prisma2.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "inventory_stock_movements" WHERE id = $1`, movementId,
    );
    assert(movementAfter.length === 1, 'pre-existing InventoryStockMovement row survived');

    const chainAfter = await prisma2.$queryRawUnsafe<{ id: string; status: string; revision_number: number; cancelled_at: Date | null }[]>(
      `SELECT id, status, revision_number, cancelled_at FROM "inventory_approval_requests" WHERE root_request_id = $1 ORDER BY revision_number`,
      rootId,
    );
    assert(chainAfter.length === 2, 'both correction-chain revisions survived the migration (no data loss)');
    assert(chainAfter[0].status === 'RETURNED' && chainAfter[1].status === 'PENDING', 'pre-existing statuses unchanged by the migration');
    assert(chainAfter.every((r) => r.cancelled_at === null), 'new cancellation columns default to NULL on pre-existing rows, never an unsolicited value');
    assert(chainAfter[0].id === rootId && chainAfter[1].id === revision2Id, 'root/revision identities and the correction-chain link are unchanged');

    // The real proof the new terminal state composes correctly with
    // pre-existing data: cancel the still-live PENDING revision using the
    // exact column set the migration added, and confirm nothing about the
    // superseded RETURNED root is touched by that update.
    await prisma2.$executeRawUnsafe(
      `UPDATE "inventory_approval_requests" SET status = 'CANCELLED', cancelled_by_user_id = $1, cancelled_at = now(), cancel_reason = 'release-verification cancel' WHERE id = $2 AND status = 'PENDING'`,
      reviewerId, revision2Id,
    );
    const afterCancel = await prisma2.$queryRawUnsafe<{ id: string; status: string }[]>(
      `SELECT id, status FROM "inventory_approval_requests" WHERE root_request_id = $1 ORDER BY revision_number`,
      rootId,
    );
    assert(afterCancel[1].status === 'CANCELLED', 'the live revision transitions to CANCELLED cleanly post-migration');
    assert(afterCancel[0].status === 'RETURNED', 'the superseded root revision is untouched by cancelling its successor');

    await prisma2.$disconnect();

    console.log('\n[cancel-migration-test] ALL CHECKS PASSED — 20261009050000_add_inventory_approval_cancellation is safe against a populated pre-migration database with a real correction chain, stock, and movement rows.\n');
  } finally {
    const backupPath = path.join(backupDir, TARGET_MIGRATION);
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, path.join(migrationsDir, TARGET_MIGRATION));
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      await pg.stop();
    } catch (error) {
      console.warn('[cancel-migration-test] non-fatal cleanup error:', error instanceof Error ? error.message : error);
    }
  }
}

main().catch((error) => {
  console.error('[cancel-migration-test] FAILED:', error);
  process.exitCode = 1;
});
