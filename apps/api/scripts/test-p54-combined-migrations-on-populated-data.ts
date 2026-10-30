// POS-PERF-P54 — populated upgrade rehearsal for the five migrations that are
// pending against origin/main once P49, P50R, P51 and P52 ship together:
//   20261030120000_pos_perf_p49_promotions
//   20261030120100_pos_perf_p49_classification_backfill
//   20261030160000_pos_perf_p50r_branch_discounts
//   20261030170000_pos_perf_p51_attendance_breaks
//   20261030190000_pos_perf_p52_payroll
// Same technique as test-p53-combined-migrations-on-populated-data.ts: the
// pre-P49 state is built from a temporary COPY of the migrations folder (the
// repo's own folder is never moved), rows are seeded with raw SQL under that
// older schema, then the real migrations are applied in one `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical (row count + content MD5); the effective discount policy,
// VAT/tax configuration and regular work hours computed by the same code are
// identical before and after; nothing is backfilled (no promotions on sales,
// no tax snapshots, no break rows, no payroll policies/rates/runs); payroll
// constraints are present; no schema drift. Then it exercises the combined
// features on the migrated data (Start Break / Resume / Clock Out on the
// pre-existing open record, a payroll draft that reads P51 intervals for the
// new record and the legacy break_minutes for pre-existing and corrected
// ones) and checks the rollback-prerequisite queries the runbook documents.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p54-combined-migrations-on-populated-data.ts
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
  '20261030190000_pos_perf_p52_payroll',
];
const PAYROLL_TABLES = ['payroll_policies', 'employee_pay_rates', 'payroll_runs', 'payroll_run_lines', 'payroll_adjustments', 'payroll_issue_resolutions', 'payroll_attendance_claims'];
const SALES = Number(process.env.P54_REHEARSAL_SALES || 20000);

const workDir = path.join(os.tmpdir(), `pos-p54-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 46700 + Math.floor(Math.random() * 100);
const DB_NAME = `p54_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:467\d{2}\/p54_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
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

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  for (const name of PENDING) if (!migrations.includes(name)) throw new Error(`missing migration ${name}`);
  const pendingFromFolder = migrations.slice(migrations.indexOf(PENDING[0] as string));
  assert(json(pendingFromFolder) === json(PENDING), `pending set is exactly the five expected migrations, in order: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (PENDING.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[p54-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p54-migration-test] applying every migration on origin/main (P49/P50R/P51/P52 withheld)');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[p54-migration-test] seeding a populated pre-P49 database (${SALES} sales)`);
    const [branchA, branchB, admin, sup, ana, ben, productSeasonal, productRegular, variantS, variantR, shift] = Array.from({ length: 11 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'admin@p54.test','x','super_admin','A','A','regular',false,now()),($2,'sup@p54.test','x','supervisor','S','S','regular',false,now()),
       ($3,'ana@p54.test','x','staff','Ana','Reyes','regular',false,now()),($4,'ben@p54.test','x','staff','Ben','Cruz','regular',false,now())`,
      admin, sup, ana, ben,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P54-N','x','x',now()),($2,'South','P54-S','x','x',now())`, branchA, branchB);
    for (const user of [sup, ana, ben]) {
      await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id, assigned_at) VALUES ($1,$2,$3,now() - interval '400 days')`, randomUUID(), user, branchA);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO products (id, name, status, is_seasonal, updated_at) VALUES ($1,'Holiday Fries','active',true,now()),($2,'Classic Fries','active',false,now())`,
      productSeasonal, productRegular,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',150,true,now()),($3,$4,'Regular','Regular',112,true,now())`,
      variantS, productSeasonal, variantR, productRegular,
    );
    // Organization-wide discount policy (Employee 15%) and work hours (9 h, North override 10 h) saved before the upgrade.
    await db.$executeRawUnsafe(
      `INSERT INTO system_settings (id, key, value, updated_by, updated_at) VALUES ($1,'discount_policy',$2::jsonb,$5,now()),
       ($3,'work_hours_policy','{"regularHours":9}'::jsonb,$5,now()),($4,$6,'{"regularHours":10}'::jsonb,$5,now())`,
      randomUUID(),
      JSON.stringify({ pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 15, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } }),
      randomUUID(),
      randomUUID(),
      admin,
      `work_hours_policy:branch:${branchA}`,
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
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, is_base_unit, updated_at) VALUES ($1,'p54g','gram','WEIGHT',true,now())`, unit);
    for (let i = 0; i < 20; i += 1) {
      const item = randomUUID();
      await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, updated_at) VALUES ($1,$2,$3,now())`, item, `P54 item ${i}`, unit);
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
       SELECT gen_random_uuid(), 'PC-P54-' || g, $1, $2, CASE WHEN g % 2 = 0 THEN $3 ELSE $4 END, 'cash', 112, CASE WHEN g % 3 = 0 THEN 16.8 ELSE 0 END, CASE WHEN g % 3 = 0 THEN 10.20 ELSE 12 END, 0,
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

    // Effective settings as the application computes them (system_settings only — readable on the old schema too).
    const { settingsService } = await import('../src/modules/settings/settings.service.js');
    const effectiveSettings = async () => {
      const out: Record<string, unknown> = { organizationTax: await settingsService.getTaxConfiguration() };
      for (const [label, branchId] of [['North', branchA], ['South', branchB]] as const) {
        out[label] = {
          discount: await settingsService.getEffectiveDiscountPolicy(branchId),
          tax: await settingsService.getTaxConfiguration(undefined, branchId),
          regularShiftMinutes: await settingsService.getRegularShiftMinutes(branchId),
        };
      }
      return out;
    };
    const settingsBefore = await effectiveSettings();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.$disconnect();

    console.log('[p54-migration-test] applying the real migrations (P49 x2, P50R, P51, P52 pending)');
    const startedAt = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - startedAt;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const applied = await after.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 5`,
    );
    assert(json(applied.map((m) => m.migration_name).sort()) === json(PENDING), 'all five pending migrations recorded as applied');
    const afterFp = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterFp[t]);
    assert(changed.length === 0, `all ${tables.length} pre-existing tables: pre-existing columns byte-identical (row count + MD5)${changed.length ? ` — changed: ${changed.join(', ')}` : ''}`);
    const settingsAfter = await effectiveSettings();
    assert(json(settingsAfter) === json(settingsBefore), 'effective discount policy, VAT/tax configuration and regular work hours identical before and after (both branches + organization)');
    const north = settingsAfter.North as { discount: { policy: { employee: { percentage: number } }; requireDiscountChoice: boolean }; regularShiftMinutes: number };
    const south = settingsAfter.South as { regularShiftMinutes: number };
    assert(north.discount.policy.employee.percentage === 15 && north.discount.requireDiscountChoice === false, 'North: Employee 15% from the organization row, no required discount choice');
    assert(north.regularShiftMinutes === 600 && south.regularShiftMinutes === 540, 'regular hours: North 10 h (branch override), South 9 h (global)');

    const products = await after.product.findMany({ select: { id: true, classification: true } });
    assert(products.find((p) => p.id === productSeasonal)?.classification === 'seasonal', 'P49 backfill: is_seasonal product → classification seasonal');
    assert(products.find((p) => p.id === productRegular)?.classification === 'regular', 'P49 backfill: other product stays regular');
    assert((await after.transactionItem.count({ where: { OR: [{ NOT: { discountAmount: 0 } }, { NOT: { promotionId: null } }] } })) === 0, 'no existing sale line gets a discount amount or promotion');
    assert((await after.transaction.count({ where: { NOT: { taxSnapshot: { equals: null } } } })) === 0, 'no existing sale gets a tax snapshot');
    assert((await after.attendanceBreak.count()) === 0, 'no break intervals invented for historical attendance');
    for (const table of PAYROLL_TABLES) {
      const [row] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`);
      assert(row?.n === 0n, `P52: ${table} created empty (no backfill)`);
    }
    const [fk] = await after.$queryRawUnsafe<{ convalidated: boolean }[]>(`SELECT convalidated FROM pg_constraint WHERE conname = 'transaction_items_promotion_id_fkey'`);
    assert(fk?.convalidated === true, 'transaction_items.promotion_id FK validated');
    const indexNames = (await after.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((i) => i.indexname);
    for (const index of [
      'attendance_breaks_one_open_per_record',
      'employee_pay_rates_one_active_per_date',
      'payroll_runs_one_draft_per_period',
      'payroll_runs_one_finalized_per_period',
      'payroll_runs_one_open_revision',
      'payroll_attendance_claims_one_active_per_record',
    ]) {
      assert(indexNames.includes(index), `partial unique index ${index} present`);
    }
    const [checks] = await after.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.contype = 'c' AND t.relname = ANY($1::text[])`,
      PAYROLL_TABLES,
    );
    assert(Number(checks?.n) >= 11, `payroll CHECK constraints present (${checks?.n})`);
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);

    console.log('[p54-migration-test] schema drift: migrated DB vs schema.prisma');
    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no drift');

    console.log('[p54-migration-test] attendance reads correctly after the upgrade');
    const { attendanceService } = await import('../src/modules/attendance/attendance.service.js');
    const summary = await attendanceService.getBranchSummary(branchA);
    assert(summary.clocked_in.find((r) => r.employee_id === ana)?.attendance_state === 'working' && summary.on_break_count === 0, 'pre-existing open record reads as Working; on_break_count 0');

    console.log('[p54-migration-test] combined features on migrated data');
    const anaActor = { id: ana, role: 'staff' };
    await attendanceService.startBreak(ana, branchA, anaActor);
    const onBreak = await attendanceService.getBranchSummary(branchA);
    assert(onBreak.on_break_count === 1 && onBreak.clocked_in.find((r) => r.employee_id === ana)?.attendance_state === 'on_break', 'Start Break on the pre-existing open record → On Break');
    await after.promotion.create({
      data: { name: 'P54 Loyalty', discountKind: 'percentage', discountValue: 10, applicationMode: 'cashier_selected', createdById: sup },
    });
    const [openBreaks] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM attendance_breaks WHERE ended_at IS NULL`);
    const [selected] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM promotions WHERE application_mode = 'cashier_selected' AND is_enabled`);
    assert(openBreaks?.n === 1n && selected?.n === 1n, 'rollback checks detect 1 open break and 1 enabled cashier-selected discount');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await attendanceService.endBreak(ana, branchA, anaActor);
    await attendanceService.clockOut(ana, {}, anaActor);
    const resumed = await after.attendanceBreak.findMany({ where: { attendanceRecordId: openRec } });
    assert(resumed.length === 1 && resumed[0]?.endReason === 'resumed', 'Resume Work closes the break on the SAME pre-existing record');

    const { payrollService } = await import('../src/modules/payroll/payroll.service.js');
    const { businessDateKey } = await import('../src/modules/payroll/payroll-time.js');
    const adminJwt = { user_id: admin, role: 'super_admin', email: 'admin@p54.test', iat: 0, exp: 9_999_999_999 } as Parameters<typeof payrollService.getSettings>[0];
    const unconfigured = await payrollService.getSettings(adminJwt, branchA);
    assert(unconfigured.policy === null, 'P52: North payroll starts "Not configured" (no default policy)');
    await payrollService.savePolicy(adminJwt, branchA, { timezone: 'Asia/Manila', period_type: 'monthly', semi_monthly_first_end_day: null, break_treatment: 'unpaid', paid_break_limit_minutes: null, expected_version: 0 });
    for (const employee of [ana, ben]) {
      await payrollService.createRate(adminJwt, branchA, { employee_id: employee, effective_from: '2025-01-01', hourly_rate: '100', reason: 'p54 rehearsal', expected_latest_rate_id: null });
    }
    const todayKey = businessDateKey(new Date(), 'Asia/Manila');
    const monthStart = `${todayKey.slice(0, 7)}-01`;
    const [y, m] = todayKey.split('-').map(Number) as [number, number];
    const monthEnd = `${todayKey.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const { run } = await payrollService.createRun(adminJwt, branchA, { period_start: monthStart, period_end: monthEnd });
    const detail = await payrollService.getRun(adminJwt, branchA, run.id);
    const shiftsById = new Map(detail.employees.flatMap((e) => e.shifts).map((s) => [s.attendance_record_id, s]));
    const inPeriod = async (recordId: string) => {
      const rec = await after.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
      const key = businessDateKey(rec.clockInServerTime, 'Asia/Manila');
      return key >= monthStart && key <= monthEnd;
    };
    if (await inPeriod(openRec)) assert(shiftsById.get(openRec)?.break_source === 'intervals', 'payroll reads the new P51 interval on the pre-existing record (break_minutes not added again)');
    if (await inPeriod(dayRec)) assert(shiftsById.get(dayRec)?.break_source === 'legacy_total' && shiftsById.get(dayRec)?.payable_ms === 8 * 3_600_000, 'pre-existing legacy break_minutes (60) used once: 9 h span → 8 h payable');
    if (await inPeriod(corrRec)) {
      assert(shiftsById.get(corrRec)?.corrected !== null && shiftsById.get(corrRec)?.break_source === 'legacy_total', 'pre-existing correction used (legacy total), flagged as corrected');
      assert(!shiftsById.has(origRec), 'soft-deleted original excluded');
    }
    assert(detail.issues.some((i) => i.code === 'LEGACY_BREAK_TOTAL' && i.severity === 'warning'), 'legacy break totals surface as review warnings');
    const [drafts] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM payroll_runs WHERE status IN ('finalized','superseded')`);
    assert(drafts?.n === 0n, 'rollback check: finalized/superseded payroll runs to export before any schema rollback = 0 here');

    await after.$disconnect();
    await prisma.$disconnect();
    console.log('[p54-migration-test] PASS');
  } finally {
    await pg.stop().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Exit explicitly: the payroll / clock-out paths imported above leave
// module-level timers (audit outbox) that would otherwise keep the process —
// and a database connection — alive after the cluster is stopped.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
