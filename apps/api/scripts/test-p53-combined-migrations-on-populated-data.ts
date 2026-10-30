// POS-PERF-P53 — populated upgrade rehearsal for the four migrations that are
// pending against origin/main once P49, P50R and P51 ship together:
//   20261030120000_pos_perf_p49_promotions
//   20261030120100_pos_perf_p49_classification_backfill
//   20261030160000_pos_perf_p50r_branch_discounts
//   20261030170000_pos_perf_p51_attendance_breaks
// Same technique as test-p50r-migration-on-populated-data.ts: the pre-P49
// state is built from a temporary COPY of the migrations folder (the repo's
// own folder is never moved), rows are seeded with raw SQL under that older
// schema, then the real migrations are applied in one `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical (row count + content MD5, except the one column the P49
// backfill is meant to set); seasonal products become 'seasonal'; no sale gets
// a tax snapshot or promotion; attendance (open, closed, overnight, legacy
// break_minutes, correction) is unchanged and reads as Working; stock is
// unchanged; the effective discount policy equals the pre-upgrade organization
// policy. Then it exercises the new features on the migrated data (Start
// Break / Resume on the pre-existing open record, a cashier-selected discount)
// and checks the rollback-prerequisite queries the runbook documents.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p53-combined-migrations-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = [
  '20261030120000_pos_perf_p49_promotions',
  '20261030120100_pos_perf_p49_classification_backfill',
  '20261030160000_pos_perf_p50r_branch_discounts',
  '20261030170000_pos_perf_p51_attendance_breaks',
];
const SALES = Number(process.env.P53_REHEARSAL_SALES || 20000);

const workDir = path.join(os.tmpdir(), `pos-p53-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 45000 + Math.floor(Math.random() * 5000);
const DB_NAME = `p53_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:4[5-9]\d{3}\/p53_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');

const pg = new EmbeddedPostgres({ databaseDir: DB_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });

function sh(cmd: string, env: Record<string, string>) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  for (const name of PENDING) if (!migrations.includes(name)) throw new Error(`missing migration ${name}`);
  const pendingFromFolder = migrations.slice(migrations.indexOf(PENDING[0] as string));
  assert(json(pendingFromFolder) === json(PENDING), `pending set is exactly the four expected migrations, in order: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (PENDING.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[p53-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p53-migration-test] applying every migration on origin/main (through P46R3; P49/P50R/P51 withheld)');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[p53-migration-test] seeding a populated pre-P49 database (${SALES} sales)`);
    const [branchA, branchB, admin, sup, ana, ben, productSeasonal, productRegular, variantS, variantR, shift] = Array.from({ length: 11 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'admin@p53.test','x','super_admin','A','A','regular',false,now()),($2,'sup@p53.test','x','supervisor','S','S','regular',false,now()),
       ($3,'ana@p53.test','x','staff','Ana','Reyes','regular',false,now()),($4,'ben@p53.test','x','staff','Ben','Cruz','regular',false,now())`,
      admin, sup, ana, ben,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P53-N','x','x',now()),($2,'South','P53-S','x','x',now())`, branchA, branchB);
    for (const user of [sup, ana, ben]) {
      await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id) VALUES ($1,$2,$3)`, randomUUID(), user, branchA);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO products (id, name, status, is_seasonal, updated_at) VALUES ($1,'Holiday Fries','active',true,now()),($2,'Classic Fries','active',false,now())`,
      productSeasonal, productRegular,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',150,true,now()),($3,$4,'Regular','Regular',112,true,now())`,
      variantS, productSeasonal, variantR, productRegular,
    );
    // Organization-wide policy saved before P50R (Employee 15%).
    await db.$executeRawUnsafe(
      `INSERT INTO system_settings (id, key, value, updated_by, updated_at) VALUES ($1,'discount_policy',$2::jsonb,$3,now())`,
      randomUUID(),
      JSON.stringify({ pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 15, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } }),
      admin,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`,
      shift, branchA, ana,
    );
    // Attendance: Ana's open record (selling today), Ben's closed day shift
    // with legacy break_minutes, an overnight closed shift, and a correction
    // plus its soft-deleted original.
    const [openRec, dayRec, nightRec, origRec, corrRec] = Array.from({ length: 5 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_in_gps_status, clock_out_server_time, break_minutes, actual_work_minutes, overtime_minutes, status, correction_reason, corrected_by, original_record_id, deleted_at, updated_at) VALUES
       ($1,$6,$8,now() - interval '3 hours','within_radius',NULL,0,NULL,0,'present',NULL,NULL,NULL,NULL,now()),
       ($2,$7,$8,now() - interval '30 hours','within_radius',now() - interval '21 hours',60,480,0,'present',NULL,NULL,NULL,NULL,now()),
       ($3,$7,$8,now() - interval '60 hours','no_gps_data',now() - interval '50 hours',45,555,75,'present',NULL,NULL,NULL,NULL,now()),
       ($4,$6,$8,now() - interval '80 hours','within_radius',now() - interval '72 hours',30,450,0,'present',NULL,NULL,NULL,now() - interval '70 hours',now()),
       ($5,$6,$8,now() - interval '80 hours','within_radius',now() - interval '71 hours',30,510,30,'corrected','forgot to clock out',$9,$4,NULL,now())`,
      openRec, dayRec, nightRec, origRec, corrRec, ana, ben, branchA, sup,
    );
    // Stock.
    const unit = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, is_base_unit, updated_at) VALUES ($1,'p53g','gram','WEIGHT',true,now())`, unit);
    for (let i = 0; i < 20; i += 1) {
      const item = randomUUID();
      await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, updated_at) VALUES ($1,$2,$3,now())`, item, `P53 item ${i}`, unit);
      for (const branch of [branchA, branchB]) {
        await db.$executeRawUnsafe(
          `INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, low_stock_threshold, version, updated_at) VALUES ($1,$2,$3,$4,10,$5,now())`,
          randomUUID(), branch, item, 1000 + i * 7.125, i,
        );
      }
    }
    // Sales: a third with an Employee discount, the rest regular; Ana and Ben.
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, discount_type, discount_rate_used, updated_at)
       SELECT gen_random_uuid(), 'PC-P53-' || g, $1, $2, CASE WHEN g % 2 = 0 THEN $3 ELSE $4 END, 'cash', 112, CASE WHEN g % 3 = 0 THEN 16.8 ELSE 0 END, CASE WHEN g % 3 = 0 THEN 10.20 ELSE 12 END, 0,
              CASE WHEN g % 3 = 0 THEN 95.2 ELSE 112 END, CASE WHEN g % 3 = 0 THEN 'employee' END, CASE WHEN g % 3 = 0 THEN 15 END, now()
       FROM generate_series(1, ${SALES}) g`,
      branchA, shift, ana, ben,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total)
       SELECT gen_random_uuid(), t.id, $1, $2, 'Classic Fries', 'Regular', 112, 1, 112 FROM transactions t WHERE t.branch_id = $3`,
      productRegular, variantR, branchA,
    );

    // Fingerprint every table that exists now, over the columns it has now.
    type Col = { table_name: string; columns: string[] };
    const tables = await db.$queryRawUnsafe<Col[]>(
      `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' GROUP BY table_name ORDER BY table_name`,
    );
    const fingerprint = async (client: InstanceType<typeof PrismaClient>) => {
      const out: Record<string, string> = {};
      for (const { table_name, columns } of tables) {
        const cols = columns.map((c) => `"${c}"`).join(', ');
        const [row] = await client.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
          `SELECT count(*) AS n, md5(string_agg(r, '|' ORDER BY r)) AS h FROM (SELECT ROW(${cols})::text AS r FROM "${table_name}") s`,
        );
        out[table_name] = `${row?.n}:${row?.h}`;
      }
      return out;
    };
    const before = await fingerprint(db);
    const populated = Object.entries(before).filter(([, v]) => !v.startsWith('0:')).length;
    console.log(`  fingerprinted ${tables.length} tables (${populated} populated)`);
    await db.$disconnect();

    console.log('[p53-migration-test] applying the real migrations (P49 x2, P50R, P51 pending)');
    const startedAt = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - startedAt;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const applied = await after.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 4`,
    );
    assert(json(applied.map((m) => m.migration_name).sort()) === json(PENDING), 'all four pending migrations recorded as applied');
    const afterFp = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterFp[t]);
    assert(changed.length === 0, `all ${tables.length} pre-existing tables: pre-existing columns byte-identical (row count + MD5)${changed.length ? ` — changed: ${changed.join(', ')}` : ''}`);
    const products = await after.product.findMany({ select: { id: true, classification: true } });
    assert(products.find((p) => p.id === productSeasonal)?.classification === 'seasonal', 'P49 backfill: is_seasonal product → classification seasonal');
    assert(products.find((p) => p.id === productRegular)?.classification === 'regular', 'P49 backfill: other product stays regular');
    assert((await after.transactionItem.count({ where: { OR: [{ NOT: { discountAmount: 0 } }, { NOT: { promotionId: null } }] } })) === 0, 'no existing sale line gets a discount amount or promotion');
    assert((await after.transaction.count({ where: { NOT: { taxSnapshot: { equals: null } } } })) === 0, 'no existing sale gets a tax snapshot');
    assert((await after.attendanceBreak.count()) === 0, 'no break intervals invented for historical attendance');
    const [fk] = await after.$queryRawUnsafe<{ convalidated: boolean }[]>(`SELECT convalidated FROM pg_constraint WHERE conname = 'transaction_items_promotion_id_fkey'`);
    assert(fk?.convalidated === true, 'transaction_items.promotion_id FK validated');
    const indexes = await after.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'attendance_breaks'`);
    assert(indexes.some((i) => i.indexname === 'attendance_breaks_one_open_per_record'), 'partial unique index attendance_breaks_one_open_per_record present');
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);

    console.log('[p53-migration-test] schema drift: migrated DB vs schema.prisma');
    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no drift');

    console.log('[p53-migration-test] effective settings and attendance read correctly after the upgrade');
    const { settingsService } = await import('../src/modules/settings/settings.service.js');
    for (const branchId of [branchA, branchB]) {
      const effective = await settingsService.getEffectiveDiscountPolicy(branchId);
      assert(
        effective.policy.employee.percentage === 15 && effective.policy.pwd.percentage === 20 && effective.policy.senior_citizen.percentage === 20,
        `${branchId === branchA ? 'North' : 'South'}: Employee 15% / PWD 20% / Senior 20% from the organization row`,
      );
      assert(effective.requireDiscountChoice === false, 'no required discount choice until a supervisor turns it on');
    }
    const { attendanceService } = await import('../src/modules/attendance/attendance.service.js');
    const summary = await attendanceService.getBranchSummary(branchA);
    const anaRow = summary.clocked_in.find((r) => r.employee_id === ana);
    assert(anaRow?.attendance_state === 'working' && summary.on_break_count === 0, 'pre-existing open record reads as Working; on_break_count 0');

    console.log('[p53-migration-test] new features on migrated data, and the rollback-prerequisite checks');
    const anaActor = { id: ana, role: 'staff' };
    await attendanceService.startBreak(ana, branchA, anaActor);
    const onBreak = await attendanceService.getBranchSummary(branchA);
    assert(onBreak.on_break_count === 1 && onBreak.clocked_in.find((r) => r.employee_id === ana)?.attendance_state === 'on_break', 'Start Break on the pre-existing open record → On Break');
    await after.promotion.create({
      data: { name: 'P53 Loyalty', discountKind: 'percentage', discountValue: 10, applicationMode: 'cashier_selected', createdById: sup },
    });
    const [openBreaks] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM attendance_breaks WHERE ended_at IS NULL`);
    const [selected] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM promotions WHERE application_mode = 'cashier_selected' AND is_enabled`);
    assert(openBreaks?.n === 1n && selected?.n === 1n, 'rollback checks detect 1 open break and 1 enabled cashier-selected discount');
    await attendanceService.endBreak(ana, branchA, anaActor);
    const resumed = await after.attendanceBreak.findMany({ where: { attendanceRecordId: openRec } });
    assert(resumed.length === 1 && resumed[0]?.endReason === 'resumed', 'Resume Work closes it on the SAME pre-existing record (no new clock-in)');
    assert((await after.attendanceRecord.count({ where: { employeeId: ana, clockOutServerTime: null } })) === 1, 'Ana still has exactly one open record');

    await after.$disconnect();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.$disconnect();
    console.log('[p53-migration-test] PASS');
  } finally {
    await pg.stop().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
