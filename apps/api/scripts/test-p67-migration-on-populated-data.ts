// POS-PERF-P67 — populated upgrade rehearsal for
//   20261122130000_pos_perf_p67_branch_deletion_records
// Same technique as test-p66-migration-on-populated-data.ts: the prior state is
// built from a temporary COPY of the migrations folder (the repo's own folder is
// never moved), rows are seeded with raw SQL under that older schema, then the
// real migration is applied with `migrate deploy`.
//
// Asserts:
// - every row of every pre-existing table is byte-identical after the migration;
// - branch_records holds exactly one matching record per branch, none deleted;
// - every new reference is validated; history references branch_records with
//   RESTRICT; only configuration/access tables still reference branches, all CASCADE;
// - the triggers: a new branch gets an id and a record, a rename follows, any
//   deletion marks the record, a deleted branch's id and code cannot be reused,
//   a deleted branch's record is frozen and undeletable, and new operational
//   writes for a deleted branch are refused while evidence (audit) is allowed;
// - deleting a branch with history (even the way an older API does) keeps every
//   history row, amount and name; its configuration goes;
// - the older-reader hazard (joining history to branches) is shown, not hidden;
// - no schema drift.
//
// Needs a throwaway server: it creates and drops its own database. Refuses anything
// but 127.0.0.1. Usage (from apps/api):
//   P67_REHEARSAL_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres npx tsx scripts/test-p67-migration-on-populated-data.ts
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261122130000_pos_perf_p67_branch_deletion_records'];
const EXTRA_BRANCHES = Number(process.env.P67_REHEARSAL_BRANCHES || 300);
const EXTRA_SALES = Number(process.env.P67_REHEARSAL_SALES || 20000);

const adminUrl = process.env.P67_REHEARSAL_ADMIN_URL ?? '';
const parsed = new URL(adminUrl || 'postgresql://invalid');
if (parsed.hostname !== '127.0.0.1') throw new Error('refusing a non-local server: set P67_REHEARSAL_ADMIN_URL to a throwaway 127.0.0.1 Postgres');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const DB_NAME = `p67_rehearsal_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${DB_NAME}`;
const DATABASE_URL = url.toString();
const workDir = path.join(os.tmpdir(), `pos-p67-migration-${randomUUID().slice(0, 8)}`);

const HISTORY_TABLES = [
  'attendance_records', 'audit_logs', 'catalog_management_assignments', 'discount_proof_uploads', 'employee_pay_rates', 'expenses',
  'extra_supply_issue_lines', 'extra_supply_issues', 'extra_supply_operations', 'fraud_alerts', 'ingredients', 'inventory_cost_corrections',
  'inventory_movements', 'inventory_stock_movements', 'manual_discount_types', 'payroll_policies', 'payroll_runs', 'products', 'shifts', 'transactions',
];

function sh(cmd: string, env: Record<string, string>) {
  console.warn(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.warn(`  OK: ${message}`);
}

async function refused(run: () => Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error);
    const matched = pattern.test(text);
    if (!matched) console.warn(`  (refusal text did not match ${pattern}: ${text.slice(0, 300)})`);
    return matched;
  }
}

async function tables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function snapshot(db: PrismaClient, names: string[]) {
  const out: Record<string, string> = {};
  for (const table of names) {
    const rows = await db.$queryRawUnsafe<{ digest: string; n: bigint }[]>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest, count(*) AS n FROM "${table}" t`,
    );
    out[table] = `${rows[0]?.n}:${rows[0]?.digest}`;
  }
  return out;
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((entry) => /^\d{14}_/.test(entry)).sort();
  assert(migrations.slice(-1).join() === PENDING.join(), `the P67 migration is the last: ${PENDING.join(', ')}`);

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

    // ---- populated pre-P67 state (raw SQL, older schema) ----
    const [north, south, admin1, staff, shift, unit, item] = Array.from({ length: 7 }, () => randomUUID());
    const insertBranch = `INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,$2,$3,'1 Old St','Testville',now())`;
    await db.$executeRawUnsafe(insertBranch, north, 'North', 'P67-N');
    await db.$executeRawUnsafe(insertBranch, south, 'South', 'P67-S');
    await db.$executeRawUnsafe(
      `INSERT INTO branches (id, name, code, address, city, updated_at) SELECT gen_random_uuid()::text, 'Bulk ' || g, 'P67-B' || g, 'x', 'x', now() FROM generate_series(1, ${EXTRA_BRANCHES}) g`,
    );
    const insertUser = `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, is_active, status, updated_at)
      VALUES ($1,$2,'x',$3::"Role",$4,$5,'regular',false,true,'active',now())`;
    await db.$executeRawUnsafe(insertUser, admin1, 'admin@p67.local', 'super_admin', 'Ada', 'Admin');
    await db.$executeRawUnsafe(insertUser, staff, null, 'staff', 'Stef', 'Staff');
    await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id, assigned_at) VALUES (gen_random_uuid()::text,$1,$2,now())`, staff, north);
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, closed_by, status, opening_cash_amount, closing_cash_amount, started_at) VALUES ($1,$2,$3,$3,$3,'closed',500,750,now() - interval '6 hours')`,
      shift, north, staff,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, vat_amount, total_amount, updated_at)
       VALUES (gen_random_uuid()::text,'P67-N-1',$1,$2,$3,'cash',250.00,0,250.00,now())`,
      north, shift, staff,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, vat_amount, total_amount, updated_at)
       SELECT gen_random_uuid()::text, 'P67-S-' || g, $1, NULL, $2, 'cash', 10 + (g % 90), 0, 10 + (g % 90), now() FROM generate_series(1, ${EXTRA_SALES}) g`,
      south, staff,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_out_server_time, clock_in_gps_status, updated_at)
       VALUES (gen_random_uuid()::text,$1,$2,now() - interval '5 hours', now() - interval '1 hour','within_radius',now())`,
      staff, north,
    );
    await db.$executeRawUnsafe(`INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at) VALUES (gen_random_uuid()::text,$1,'supplies',123.45,now(),$2,now())`, north, admin1);
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_role, branch_id, previous_hash, current_hash) VALUES (gen_random_uuid()::text,'P67_SEED','test',$1,$2,'super_admin',$1,'p','c')`,
      north, admin1,
    );
    await db.$executeRawUnsafe(`INSERT INTO fraud_alerts (id, alert_type, severity, branch_id, evidence, updated_at) VALUES (gen_random_uuid()::text,'p67','low',$1,'{}',now())`, north);
    await db.$executeRawUnsafe(`INSERT INTO manual_discount_types (id, branch_id, name, created_by_id, updated_at) VALUES (gen_random_uuid()::text,$1,'Promo',$2,now())`, north, admin1);
    await db.$executeRawUnsafe(
      `INSERT INTO employee_pay_rates (id, employee_id, branch_id, effective_from, hourly_rate, reason, created_by, created_by_name) VALUES (gen_random_uuid()::text,$1,$2,now(),80,'seed',$3,'Ada')`,
      staff, north, admin1,
    );
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, is_base_unit, updated_at) VALUES ($1,'p67g','Gram','WEIGHT',true,now())`, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, updated_at) VALUES ($1,'Potato',$2,now())`, item, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, updated_at) VALUES (gen_random_uuid()::text,$1,$2,0,now())`, north, item);
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_stock_movements (id, branch_id, inventory_item_id, movement_type, quantity_change, quantity_before, quantity_after) VALUES (gen_random_uuid()::text,$1,$2,'RECEIVING',5,0,5)`,
      north, item,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO ingredients (id, branch_id, name, unit, current_stock, low_stock_threshold, critical_threshold, updated_at) VALUES (gen_random_uuid()::text,$1,'Legacy','g',0,1,0,now())`,
      north,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO inventory_movements (id, branch_id, ingredient_id, movement_type, quantity_change, quantity_before, quantity_after)
       SELECT gen_random_uuid()::text, $1, id, 'stock_in', 10, 0, 10 FROM ingredients WHERE branch_id = $1`,
      north,
    );

    // ---- migrate ----
    const preTables = await tables(db);
    const before = await snapshot(db, preTables);
    const started = Date.now();
    sh(`npx prisma migrate deploy`, env);
    console.warn(`  migration took ${Date.now() - started} ms (including the Prisma CLI start)`);
    const after = await snapshot(db, preTables);
    const changed = preTables.filter((t) => before[t] !== after[t]);
    assert(changed.length === 0, `all ${preTables.length} pre-existing tables are byte-identical (changed: ${changed.join(', ') || 'none'})`);

    const counts = await db.$queryRawUnsafe<{ branches: bigint; records: bigint; matched: bigint; deleted: bigint }[]>(
      `SELECT (SELECT count(*) FROM branches) AS branches, (SELECT count(*) FROM branch_records) AS records,
              (SELECT count(*) FROM branches b JOIN branch_records r ON r.id = b.id AND r.name = b.name AND r.code = b.code AND r.address = b.address AND r.city = b.city) AS matched,
              (SELECT count(*) FROM branch_records WHERE deleted_at IS NOT NULL) AS deleted`,
    );
    const c = counts[0];
    assert(c && c.branches === c.records && c.records === c.matched, `one matching record per branch (${c?.records} of ${c?.branches})`);
    assert(Number(c?.deleted) === 0, 'the migration marks no branch deleted');
    const invalid = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND (confrelid = 'branch_records'::regclass OR confrelid = 'branches'::regclass OR conrelid = 'branches'::regclass) AND NOT convalidated`,
    );
    assert(Number(invalid[0]?.n) === 0, 'every new reference is validated');
    const toRecords = await db.$queryRawUnsafe<{ conrelid: string; confdeltype: string }[]>(
      `SELECT conrelid::regclass::text AS conrelid, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'branch_records'::regclass ORDER BY 1`,
    );
    const historyRefs = toRecords.filter((row) => row.conrelid !== 'branches').map((row) => row.conrelid).sort();
    assert(historyRefs.join() === [...HISTORY_TABLES].sort().join(), `exactly the ${HISTORY_TABLES.length} history tables reference branch_records`);
    assert(toRecords.every((row) => row.confdeltype === 'r'), 'all of them ON DELETE RESTRICT');
    const toBranches = await db.$queryRawUnsafe<{ conrelid: string; confdeltype: string }[]>(
      `SELECT conrelid::regclass::text AS conrelid, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'branches'::regclass ORDER BY 1`,
    );
    assert(
      toBranches.every((row) => row.confdeltype === 'c') && toBranches.every((row) => !HISTORY_TABLES.includes(row.conrelid)),
      `only configuration/access tables still reference branches, all CASCADE (${toBranches.map((r) => r.conrelid).join(', ')})`,
    );

    // ---- triggers ----
    const created = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO branches (name, code, address, city, updated_at) VALUES ('Newer','P67-NEW','x','x',now()) RETURNING id`,
    );
    const newId = created[0]?.id as string;
    assert(Boolean(newId), 'an insert without an id gets one (Prisma relies on this)');
    await db.$executeRawUnsafe(`UPDATE branches SET name = 'Newest' WHERE id = $1`, newId);
    const renamed = await db.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM branch_records WHERE id = $1`, newId);
    assert(renamed[0]?.name === 'Newest', 'a rename of a live branch follows to its record');

    // ---- deleting a branch with history, the way an older API does (plain DELETE) ----
    await db.$executeRawUnsafe(`DELETE FROM branches WHERE id = $1`, north);
    const kept = await db.$queryRawUnsafe<{ total: string; branch: string; code: string; shift_close: string; expense: string; audit: bigint; movements: bigint; legacy: bigint }[]>(
      `SELECT t.total_amount::text AS total, r.name AS branch, r.code AS code,
              (SELECT closing_cash_amount::text FROM shifts WHERE id = $2) AS shift_close,
              (SELECT amount::text FROM expenses WHERE branch_id = $1) AS expense,
              (SELECT count(*) FROM audit_logs WHERE branch_id = $1) AS audit,
              (SELECT count(*) FROM inventory_stock_movements WHERE branch_id = $1) AS movements,
              (SELECT count(*) FROM inventory_movements WHERE branch_id = $1) AS legacy
         FROM transactions t JOIN branch_records r ON r.id = t.branch_id WHERE t.transaction_number = 'P67-N-1'`,
      north, shift,
    );
    const k = kept[0];
    assert(
      k?.total === '250.00' && k.branch === 'North' && k.code === 'P67-N' && k.shift_close === '750.00' && k.expense === '123.45' && Number(k.audit) === 1 &&
        Number(k.movements) === 1 && Number(k.legacy) === 1,
      'history keeps its rows, amounts and the branch name/code (sale, shift, expense, audit, stock and legacy movements)',
    );
    const config = await db.$queryRawUnsafe<{ assignments: bigint; stocks: bigint; marked: boolean }[]>(
      `SELECT (SELECT count(*) FROM user_branch_assignments WHERE branch_id = $1) AS assignments, (SELECT count(*) FROM inventory_stocks WHERE branch_id = $1) AS stocks,
              (SELECT deleted_at IS NOT NULL FROM branch_records WHERE id = $1) AS marked`,
      north,
    );
    assert(Number(config[0]?.assignments) === 0 && Number(config[0]?.stocks) === 0, 'its access and configuration cascade');
    assert(config[0]?.marked === true, 'any deletion marks the record deleted');
    assert(
      await refused(() => db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P67-N2','x','x',now())`, north), /BRANCH_ID_REUSED|23505|Unique constraint/),
      "a deleted branch's id cannot be reused",
    );
    assert(
      await refused(() => db.$executeRawUnsafe(`INSERT INTO branches (name, code, address, city, updated_at) VALUES ('North','P67-N','x','x',now())`), /BRANCH_CODE_RETIRED|23505|Unique constraint/),
      "a deleted branch's code cannot be reused",
    );
    assert(
      await refused(() => db.$executeRawUnsafe(`UPDATE branch_records SET name = 'Rewritten' WHERE id = $1`, north), /BRANCH_RECORD_IMMUTABLE|23001/),
      "a deleted branch's record is frozen",
    );
    assert(await refused(() => db.$executeRawUnsafe(`DELETE FROM branch_records WHERE id = $1`, newId), /BRANCH_RECORD_IMMUTABLE|23001/), 'records are never deleted');
    assert(
      await refused(
        () => db.$executeRawUnsafe(`INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at) VALUES (gen_random_uuid()::text,$1,'supplies',1,now(),$2,now())`, north, admin1),
        /POS_PERF_P67_BRANCH_DELETED/,
      ),
      'a new operational write for a deleted branch is refused',
    );
    assert(
      await refused(
        () => db.$executeRawUnsafe(`UPDATE transactions SET branch_id = $1 WHERE transaction_number = 'P67-S-1'`, north),
        /POS_PERF_P67_BRANCH_DELETED|immutable/i,
      ),
      'moving history onto a deleted branch is refused',
    );
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_role, branch_id, previous_hash, current_hash) VALUES (gen_random_uuid()::text,'P67_AFTER','test',$1,$2,'super_admin',$1,'p','c')`,
      north, admin1,
    );
    assert(true, 'evidence (an audit entry naming the deleted branch) can still be written');
    const southSales = await db.$queryRawUnsafe<{ n: bigint; total: string }[]>(`SELECT count(*) AS n, sum(total_amount)::text AS total FROM transactions WHERE branch_id = $1`, south);
    assert(Number(southSales[0]?.n) === EXTRA_SALES, `an untouched branch keeps its ${EXTRA_SALES} sales`);

    // ---- older (pre-P67) readers after a deletion ----
    const oldJoin = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM transactions t JOIN branches b ON b.id = t.branch_id WHERE t.transaction_number = 'P67-N-1'`,
    );
    assert(Number(oldJoin[0]?.n) === 0, 'HAZARD shown: an older reader joining history to branches no longer finds a deleted branch (rollback floor)');

    const diff = execSync(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`, {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, '..'),
    }).toString();
    assert(diff.includes('This is an empty migration') || diff.trim() === '-- This is an empty migration.', `no schema drift${diff.includes('empty') ? '' : `:\n${diff}`}`);

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
