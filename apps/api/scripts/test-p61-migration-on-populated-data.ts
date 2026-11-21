// POS-PERF-P61 — populated upgrade rehearsal for
//   20261105120000_pos_perf_p61_extra_supplies
// Same technique as test-p60-migration-on-populated-data.ts: the prior state is built
// from a temporary COPY of the migrations folder (the repo's own folder is never
// moved), rows are seeded with raw SQL under that older schema, then the real
// migration is applied with `migrate deploy`.
//
// Asserts: every column of every pre-existing table is byte-identical (sales, expenses,
// balances, reservations, payroll among them); no card or issue is invented; no enum an
// older API reads gained a value; an older API's writes to the stock tables still work;
// the constraints refuse bad rows; no schema drift.
//
// Needs a throwaway server, not a database in use: it creates and drops its own
// database. Refuses anything but 127.0.0.1. Usage (from apps/api):
//   P61_REHEARSAL_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres npx tsx scripts/test-p61-migration-on-populated-data.ts
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261105120000_pos_perf_p61_extra_supplies'];
const SALES = Number(process.env.P61_REHEARSAL_SALES || 20000);

const adminUrl = process.env.P61_REHEARSAL_ADMIN_URL ?? '';
const parsed = new URL(adminUrl || 'postgresql://invalid');
if (parsed.hostname !== '127.0.0.1') throw new Error('refusing a non-local server: set P61_REHEARSAL_ADMIN_URL to a throwaway 127.0.0.1 Postgres');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const DB_NAME = `p61_rehearsal_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${DB_NAME}`;
const DATABASE_URL = url.toString();
const workDir = path.join(os.tmpdir(), `pos-p61-migration-${randomUUID().slice(0, 8)}`);

function sh(cmd: string, env: Record<string, string>) {
  console.warn(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.warn(`  OK: ${message}`);
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((entry) => /^\d{14}_/.test(entry)).sort();
  assert(migrations.slice(-1).join() === PENDING.join(), `the P61 migration is the last: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (!PENDING.includes(entry)) fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  try {
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    const [branch, branchB, sup, ana, shift, unit, item, item2] = Array.from({ length: 8 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p61.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p61.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P61-N','x','x',now()),($2,'South','P61-S','x','x',now())`, branch, branchB);
    await db.$executeRawUnsafe(`INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',500,now())`, shift, branch, ana);
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, updated_at) VALUES ($1,'pc-p61','Piece','COUNT',now())`, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, unit_cost, updated_at) VALUES ($1,'Paper Cup',$3,1.5,now()),($2,'Tissue',$3,NULL,now())`, item, item2, unit);
    // Balances with live reservations, as pending sales leave them.
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, quantity_reserved, unit_cost, version, updated_at) VALUES
       (gen_random_uuid()::text,$1,$3,500,12.5,2,7,now()),(gen_random_uuid()::text,$2,$3,90,0,NULL,1,now()),(gen_random_uuid()::text,$1,$4,40,3,NULL,2,now())`,
      branch, branchB, item, item2,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_stock_movements (id, branch_id, inventory_item_id, movement_type, quantity_change, quantity_before, quantity_after, unit_id, notes)
       SELECT gen_random_uuid()::text, $1, $2, (ARRAY['RECEIVING','ADJUSTMENT_OUT','WASTE','SALE'])[n % 4 + 1]::"InventoryStockMovementType", 1, n, n + 1, $3, 'old ' || n FROM generate_series(1, 2000) AS n`,
      branch, item, unit,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, updated_at, created_at)
       SELECT gen_random_uuid()::text, 'PC-P61-' || n, $1, $2, $3, (ARRAY['completed','voided','refunded'])[n % 3 + 1]::"TransactionStatus",
              (ARRAY['cash','gcash','maya','other'])[n % 4 + 1]::"PaymentMethod", 100, 0, 0, 0, 100 + (n % 50), now(), now() FROM generate_series(1, ${SALES}) AS n`,
      branch, shift, ana,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at)
       SELECT gen_random_uuid()::text, $1, (ARRAY['utilities','supplies','staff_meals','miscellaneous'])[n % 4 + 1]::"ExpenseCategory", n % 977 + 0.25, now(), $2, now() FROM generate_series(1, 2000) AS n`,
      branch, sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO payroll_policies (id, branch_id, version, timezone, period_type, break_treatment, created_by, created_by_name)
       VALUES (gen_random_uuid()::text,$1,1,'Asia/Manila','monthly','unpaid',$2,'S S')`,
      branch, sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO payroll_runs (id, branch_id, period_start, period_end, status, created_by, updated_at, basic_pay_total) VALUES (gen_random_uuid()::text,$1,'2026-10-01','2026-10-07','draft',$2,now(),1234.5)`,
      branch, sup,
    );

    const tables = (await db.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations' ORDER BY 1`)).map((row) => row.table_name);
    const fingerprint = async (table: string) => {
      const columns = (await db.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, table)).map((row) => `"${row.column_name}"`);
      const [row] = await db.$queryRawUnsafe<{ hash: string | null; n: bigint }[]>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash, count(*) AS n FROM (SELECT ${columns.join(',')} FROM "${table}") t`);
      return { columns, hash: row?.hash ?? null, n: Number(row?.n ?? 0) };
    };
    const before = new Map<string, Awaited<ReturnType<typeof fingerprint>>>();
    for (const table of tables) before.set(table, await fingerprint(table));
    const enumsSql = `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY 1 ORDER BY 1`;
    const enumsBefore = (await db.$queryRawUnsafe<{ typname: string; labels: string[] }[]>(enumsSql)).map((row) => JSON.stringify(row));
    console.warn(`  seeded ${before.get('transactions')?.n} sales, ${before.get('expenses')?.n} expenses, ${before.get('inventory_stock_movements')?.n} movements; fingerprinted ${tables.length} tables`);

    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    console.warn(`  migrate deploy took ${Date.now() - started} ms including Prisma CLI start-up (not a production timing)`);

    let changed = 0;
    for (const table of tables) {
      const prior = before.get(table);
      if (!prior) continue;
      const [row] = await db.$queryRawUnsafe<{ hash: string | null }[]>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM (SELECT ${prior.columns.join(',')} FROM "${table}") t`);
      if ((row?.hash ?? null) !== prior.hash) {
        changed += 1;
        console.error(`  changed: ${table}`);
      }
    }
    assert(changed === 0, `all ${tables.length} pre-existing tables are byte-identical, including sales, expenses, balances, reservations and payroll`);

    const columnsAdded = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[]) AND column_name LIKE '%extra_supply%'`,
      tables,
    );
    assert(Number(columnsAdded[0]?.n ?? 1) === 0, 'no column was added to any existing table');

    const count = async (sql: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]?.n ?? -1);
    for (const table of ['extra_supplies', 'extra_supply_branches', 'extra_supply_issues', 'extra_supply_issue_lines', 'extra_supply_operations']) {
      assert((await count(`SELECT count(*) AS n FROM ${table}`)) === 0, `${table} starts empty: nothing invented`);
    }

    const enumsAfter = (await db.$queryRawUnsafe<{ typname: string; labels: string[] }[]>(enumsSql)).map((row) => JSON.stringify(row));
    assert(enumsBefore.every((row) => enumsAfter.includes(row)), 'no existing enum gained or lost a value, so an older API can read every row');
    assert(enumsAfter.length === enumsBefore.length + 1, 'the only new enum is extra_supply_issue_kind');

    // What an older API does to the tables a new issue also touches.
    await db.$executeRawUnsafe(`UPDATE inventory_stocks SET quantity_reserved = quantity_reserved + 1 WHERE branch_id = $1 AND inventory_item_id = $2`, branch, item);
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_stock_movements (id, branch_id, inventory_item_id, movement_type, quantity_change, quantity_before, quantity_after) VALUES (gen_random_uuid()::text,$1,$2,'SALE',-1,500,499)`,
      branch, item,
    );
    assert(true, 'an older API can still reserve stock and record a movement');

    const refuses = async (label: string, sql: string, ...params: unknown[]) => {
      let refused = false;
      try {
        await db.$executeRawUnsafe(sql, ...params);
      } catch {
        refused = true;
      }
      assert(refused, `the database refuses ${label}`);
    };
    const supply = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO extra_supplies (id, name, normalized_name, inventory_item_id, issue_unit_name, entered_quantity, entered_unit_id, base_quantity, base_unit_id, created_by_id) VALUES ($1,'Cup','cup',$2,'cup',1,$3,1,$3,$4)`,
      supply, item, unit, sup,
    );
    await db.$executeRawUnsafe(`INSERT INTO extra_supply_branches (extra_supply_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'cup',true)`, supply, branch);
    const other = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO extra_supplies (id, name, normalized_name, inventory_item_id, issue_unit_name, entered_quantity, entered_unit_id, base_quantity, base_unit_id, created_by_id) VALUES ($1,'Cup','cup',$2,'cup',1,$3,1,$3,$4)`,
      other, item, unit, sup,
    );
    await refuses('a second active card with one name at a branch', `INSERT INTO extra_supply_branches (extra_supply_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'cup',true)`, other, branch);
    await db.$executeRawUnsafe(`INSERT INTO extra_supply_branches (extra_supply_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'cup',true)`, other, branchB);
    assert(true, 'the same name is allowed at another branch');
    // A deactivated card may share the name at a branch, until it tries to come back.
    await db.$executeRawUnsafe(`UPDATE extra_supplies SET is_active = false WHERE id = $1`, other);
    await db.$executeRawUnsafe(`INSERT INTO extra_supply_branches (extra_supply_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'cup',false)`, other, branch);
    await refuses('reactivating into a taken name, decided through the composite FK', `UPDATE extra_supplies SET is_active = true WHERE id = $1`, other);
    await refuses('a zero-quantity card', `UPDATE extra_supplies SET base_quantity = 0 WHERE id = $1`, supply);
    await refuses('a free issue with a payment', `INSERT INTO extra_supply_issues (id, reference_number, branch_id, cashier_id, kind, payment_method, amount_collected) VALUES (gen_random_uuid()::text,'R1',$1,$2,'free','cash',0)`, branch, ana);
    await refuses('a free issue with an amount', `INSERT INTO extra_supply_issues (id, reference_number, branch_id, cashier_id, kind, amount_collected) VALUES (gen_random_uuid()::text,'R2',$1,$2,'free',5)`, branch, ana);
    await refuses('a paid issue with no method', `INSERT INTO extra_supply_issues (id, reference_number, branch_id, cashier_id, kind, amount_collected) VALUES (gen_random_uuid()::text,'R3',$1,$2,'paid',5)`, branch, ana);
    await refuses('an operation committed with no issue', `INSERT INTO extra_supply_operations (operation_id, branch_id, cashier_id, request_hash, status) VALUES (gen_random_uuid()::text,$1,$2,'h','committed')`, branch, ana);
    const issue = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO extra_supply_issues (id, reference_number, branch_id, cashier_id, kind) VALUES ($1,'R4',$2,$3,'free')`, issue, branch, ana);
    const line = `INSERT INTO extra_supply_issue_lines (id, issue_id, extra_supply_id, supply_name, supply_version, issue_unit_name, quantity, inventory_item_id, inventory_item_name, base_unit_code, base_quantity_each, base_quantity_total, cost_source, unit_cost, line_cost, branch_id, kind, cashier_id, created_at)
      VALUES (gen_random_uuid()::text,$1,$2,'Cup',1,'cup',1,$3,'Paper Cup','pc',1,1,$4,$5::numeric,$5::numeric,$6,'free',$7,now())`;
    await refuses('an unknown cost recorded as zero', line, issue, supply, item, 'unknown', 0, branch, ana);
    await refuses('a known cost with no figure', line, issue, supply, item, 'inventory', null, branch, ana);
    await db.$executeRawUnsafe(line, issue, supply, item, 'unknown', null, branch, ana);
    await refuses('deleting a card with history', `DELETE FROM extra_supplies WHERE id = $1`, supply);

    // Permanently deleting a branch keeps working, as for expenses and sales.
    await db.$executeRawUnsafe(`DELETE FROM extra_supply_issues WHERE id = $1`, issue);
    assert(true, 'deleting an issue removes its lines by cascade, only through a direct database action');

    const diff = execSync(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`, { env: { ...process.env, ...env }, cwd: path.join(__dirname, '..') }).toString();
    assert(diff.includes('This is an empty migration') || diff.trim() === '-- This is an empty migration.', 'no schema drift');

    console.warn('REHEARSAL PASSED');
    await db.$disconnect();
  } finally {
    await db.$disconnect().catch(() => undefined);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
