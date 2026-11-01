// POS-PERF-P55R2 — populated upgrade rehearsal for the two P55R2 migrations:
//   20261101130000_pos_perf_p55r2_calculation_mode
//   20261101130100_pos_perf_p55r2_validate_calculation_mode
// Same technique as test-p55-migration-on-populated-data.ts: the pre-P55R2
// state is built from a temporary COPY of the migrations folder (the repo's
// own folder is never moved), rows are seeded with raw SQL under that older
// schema, then the real migrations are applied with `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical; no sale gains a calculation mode (all NULL = recorded
// before P55R2, VAT-calculated); the CHECK is validated and refuses unknown
// values; no schema drift. Then reads the migrated history through the new
// code: VAT figures, the Daily Sales and Discount Compliance reports and the
// export headers are what the stored amounts say, with no manual-total row.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p55r2-migration-on-populated-data.ts
// P55R2_WORK_DIR overrides where the throwaway cluster lives (default: OS temp).
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261101130000_pos_perf_p55r2_calculation_mode', '20261101130100_pos_perf_p55r2_validate_calculation_mode'];
const SALES = Number(process.env.P55R2_REHEARSAL_SALES || 20000);

const workDir = path.join(process.env.P55R2_WORK_DIR || os.tmpdir(), `pos-p55r2-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 46900 + Math.floor(Math.random() * 100);
const DB_NAME = `p55r2_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:469\d{2}\/p55r2_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
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
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  for (const name of PENDING) if (!migrations.includes(name)) throw new Error(`missing migration ${name}`);
  const pendingFromFolder = migrations.slice(migrations.indexOf(PENDING[0] as string));
  assert(json(pendingFromFolder) === json(PENDING), `pending set is exactly the two P55R2 migrations, in order: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (PENDING.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[p55r2-migration-test] starting embedded Postgres at 127.0.0.1:${PORT}/${DB_NAME}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p55r2-migration-test] applying every migration before P55R2 (incl. the three P55 ones)');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[p55r2-migration-test] seeding a populated pre-P55R2 database (${SALES} sales)`);
    const [branchA, sup, ana, product, variant, shift, manualType] = Array.from({ length: 7 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p55r2.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p55r2.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P55R2-N','x','x',now())`, branchA);
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, is_seasonal, classification, updated_at) VALUES ($1,'Classic Fries','active',false,'regular',now())`, product);
    await db.$executeRawUnsafe(
      `INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',112,true,now())`,
      variant, product,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`,
      shift, branchA, ana,
    );
    // A P55 first-pass type: its sales (only ever on local test data) carry commercial VAT.
    await db.$executeRawUnsafe(
      `INSERT INTO manual_discount_types (id, branch_id, name, apply_to_pos, require_proof, is_active, version, created_by_id, updated_at) VALUES ($1,$2,'Staff meal',true,false,true,1,$3,now())`,
      manualType, branchA, sup,
    );
    // Sales: Employee, PWD (VAT-exempt), promotional, P55 first-pass manual (VAT 12/112 of the rest), plain;
    // every 25th voided and every 40th refunded.
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount,
                                 discount_type, discount_rate_used, manual_discount_type_id, manual_discount_snapshot, tax_snapshot, updated_at, created_at)
       SELECT gen_random_uuid(), 'PC-P55R2-' || g, $1, $2, $3,
              (CASE WHEN g % 25 = 0 THEN 'voided' WHEN g % 40 = 0 THEN 'refunded' ELSE 'completed' END)::"TransactionStatus",
              'cash', 112,
              CASE WHEN g % 5 = 0 THEN 16.8 WHEN g % 5 = 1 THEN 20 WHEN g % 5 = 2 THEN 10 WHEN g % 5 = 3 THEN 12 ELSE 0 END,
              CASE WHEN g % 5 = 0 THEN 10.2 WHEN g % 5 = 1 THEN 0 WHEN g % 5 = 2 THEN 10.93 WHEN g % 5 = 3 THEN 10.71 ELSE 12 END,
              0,
              CASE WHEN g % 5 = 0 THEN 95.2 WHEN g % 5 = 1 THEN 80 WHEN g % 5 = 2 THEN 102 WHEN g % 5 = 3 THEN 100 ELSE 112 END,
              CASE WHEN g % 5 = 0 THEN 'employee' WHEN g % 5 = 1 THEN 'pwd' WHEN g % 5 = 2 THEN 'promotional' WHEN g % 5 = 3 THEN 'manual' END,
              CASE WHEN g % 5 = 0 THEN 15 WHEN g % 5 = 1 THEN 20 END,
              CASE WHEN g % 5 = 3 THEN $4::uuid END,
              CASE WHEN g % 5 = 3 THEN jsonb_build_object('version', 1, 'source', 'manual', 'discount_type_id', $4::text, 'name', 'Staff meal', 'amount', 12, 'eligible_subtotal', 112) END,
              CASE WHEN g % 5 = 3 THEN '{"version":1,"vat_rate_percent":12,"treatment":"vatable","discount_source":"manual","discount_flow":"manual_v1"}'::jsonb
                   WHEN g % 4 = 0 THEN '{"version":1,"vat_rate_percent":12,"treatment":"vatable"}'::jsonb END,
              now(), now() - (g % 30) * interval '1 day'
       FROM generate_series(1, ${SALES}) g`,
      branchA, shift, ana, manualType,
    );

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
    // What the pre-P55R2 reports summed from the stored amounts (completed sales).
    const [legacyTotals] = await db.$queryRawUnsafe<{ vat: string; gross: string; disc: string; n: bigint }[]>(
      `SELECT sum(vat_amount)::text AS vat, sum(subtotal)::text AS gross, sum(discount_amount)::text AS disc, count(*) AS n FROM transactions WHERE status = 'completed'`,
    );
    const legacyGroups = await db.$queryRawUnsafe<{ discount_type: string; n: bigint; disc: string; exempt: string; total: string }[]>(
      `SELECT discount_type, count(*) AS n, sum(discount_amount)::text AS disc, sum(vat_exempt_amount)::text AS exempt, sum(total_amount)::text AS total
       FROM transactions WHERE status = 'completed' AND discount_type IS NOT NULL GROUP BY discount_type ORDER BY discount_type`,
    );
    console.log(`  fingerprinted ${tables.length} tables; ${legacyTotals?.n} completed sales, VAT ${legacyTotals?.vat}`);
    await db.$disconnect();

    console.log('[p55r2-migration-test] applying the P55R2 migrations');
    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - started;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const applied = await after.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name = ANY($1::text[])`,
      PENDING,
    );
    assert(applied.length === PENDING.length, 'both P55R2 migrations recorded as applied');
    const afterPrints = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterPrints[t]);
    assert(changed.length === 0, `all ${tables.length} pre-existing tables: pre-existing columns byte-identical (changed: ${changed.join(', ') || 'none'})`);
    const [modes] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM transactions WHERE calculation_mode IS NOT NULL`);
    assert(modes?.n === 0n, 'no existing sale gains a calculation mode (all NULL = recorded before P55R2, VAT-calculated)');
    const [check] = await after.$queryRawUnsafe<{ convalidated: boolean }[]>(`SELECT convalidated FROM pg_constraint WHERE conname = 'transactions_calculation_mode_check'`);
    assert(check?.convalidated === true, 'transactions_calculation_mode_check validated');
    let refused = false;
    try {
      await after.$executeRawUnsafe(`UPDATE transactions SET calculation_mode = 'no_vat' WHERE id = (SELECT id FROM transactions LIMIT 1)`);
    } catch {
      refused = true;
    }
    assert(refused, 'the CHECK refuses an unknown calculation mode');
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);

    console.log('[p55r2-migration-test] schema drift: migrated DB vs schema.prisma');
    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no drift');

    console.log('[p55r2-migration-test] history read through the P55R2 code');
    const { reportsRepository } = await import('../src/modules/reports/reports.repository.js');
    const { DAILY_SALES_TRANSACTION_COLUMNS, REPORT_COLUMNS, DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS } = await import('../src/modules/reports/reports.columns.js');
    const { generateCsv } = await import('../src/lib/reports/csv.js');
    const filters = { branchId: branchA, page: 1, limit: 100_000 } as Parameters<typeof reportsRepository.getDailySales>[0];
    const daily = await reportsRepository.getDailySales(filters);
    assert(round2(daily.reduce((s, r) => s + r.vat_total, 0)) === round2(Number(legacyTotals?.vat)), `Daily Sales VAT equals the stored VAT of completed sales (${legacyTotals?.vat})`);
    assert(round2(daily.reduce((s, r) => s + r.gross_sales, 0)) === round2(Number(legacyTotals?.gross)), 'Daily Sales gross equals stored subtotals');
    assert(daily.every((r) => r.tax_not_calculated_count === 0 && r.tax_not_calculated_sales === 0), 'no historical sale is reported as "VAT not calculated"');
    const compliance = await reportsRepository.getDiscountCompliance(filters);
    assert(
      json(compliance.map((r) => [r.discount_type, r.transaction_count, round2(r.total_discount_amount), r.total_vat_exempt_amount === null ? null : round2(r.total_vat_exempt_amount)]).sort()) ===
        json(legacyGroups.map((g) => [g.discount_type, Number(g.n), round2(Number(g.disc)), round2(Number(g.exempt))]).sort()),
      'Discount Compliance: one row per discount type with the stored counts and amounts (NULL mode merged as VAT-calculated)',
    );
    assert(compliance.every((r) => r.calculation_mode === 'legacy_vat_v1'), 'every historical compliance row is VAT-calculated, including P55 first-pass manual sales');
    const pwd = compliance.find((r) => r.discount_type === 'pwd');
    assert(pwd?.total_vat_exempt_sales === round2(Number(legacyGroups.find((g) => g.discount_type === 'pwd')?.total)), 'PWD VAT-exempt sales = stored PWD totals');
    const txRows = await reportsRepository.getDailySalesTransactions({ ...filters, limit: 500 });
    assert(txRows.every((r) => r.vat_amount !== null && r.tax_calculation === null), 'transaction rows keep their stored VAT');
    const header = (csv: Buffer) => csv.toString('utf-8').split('\n')[0];
    assert(header(generateCsv(txRows, DAILY_SALES_TRANSACTION_COLUMNS)) === 'Receipt #,Payment,Total,VAT,Discount,Discount Type,Customer ID / Reference,Date,Cashier', 'Daily Sales transaction export header unchanged');
    assert(
      header(generateCsv(txRows, DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS)) === 'Receipt #,Date/Time,Branch,Cashier,Discount Type,Discount Rate Used,Customer ID / Reference,Discount Amount,Proof Available',
      'Discount Compliance transaction export header unchanged',
    );
    assert(
      header(generateCsv(daily as never, REPORT_COLUMNS.DAILY_SALES)) === 'Date,Branch,Gross Sales,Discounts,Refunds,VAT,Net Sales,Operating Expenses,Net Operating Result,Completed,Voided,Refunded,_Branch ID',
      'Daily Sales summary export header unchanged',
    );
    assert(
      header(generateCsv(compliance as never, REPORT_COLUMNS.DISCOUNT_COMPLIANCE)) === 'Branch,Discount Type,Transactions,Total Discount,VAT-Exempt Sales (PWD/Senior),Non-VATable Amount (VAT cap)',
      'Discount Compliance summary export header unchanged',
    );
    const { transactionsService } = await import('../src/modules/transactions/transactions.service.js');
    const firstPass = await after.transaction.findFirstOrThrow({ where: { discountType: 'manual' } });
    const view = await transactionsService.getTransactionById(firstPass.id);
    assert(view.calculation_mode === 'legacy_vat_v1' && view.vat_amount === 10.71, 'a P55 first-pass manual sale keeps its stored VAT (₱10.71) and reads as VAT-calculated');

    await after.$disconnect();
    console.log('[p55r2-migration-test] PASS');
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
