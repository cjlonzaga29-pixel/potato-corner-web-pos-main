// POS-PERF-P66 — populated upgrade rehearsal for
//   20261122120000_pos_perf_p66_account_deletion_people
// Same technique as test-p64-migration-on-populated-data.ts: the prior state is built
// from a temporary COPY of the migrations folder (the repo's own folder is never
// moved), rows are seeded with raw SQL under that older schema, then the real
// migration is applied with `migrate deploy`.
//
// Asserts:
// - every row of every pre-existing table is byte-identical after the migration
//   (amounts, names, actor ids, P64-removed rows; only constraints change);
// - people holds exactly one attribution record per account, with the same names,
//   and marks nobody deleted (P64-removed rows are still accounts);
// - the triggers: a new account gets an id and a record, a rename follows, any
//   deletion marks the record, and a deleted account's id cannot be reused;
// - a users row with history can now be deleted, its history untouched and still
//   resolving to the name through people;
// - what an older (pre-P66) API does still works or fails safely, and the older
//   reader hazard (joining history to users) is shown, not hidden;
// - no schema drift.
//
// Needs a throwaway server: it creates and drops its own database. Refuses anything
// but 127.0.0.1. Usage (from apps/api):
//   P66_REHEARSAL_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres npx tsx scripts/test-p66-migration-on-populated-data.ts
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261122120000_pos_perf_p66_account_deletion_people'];
const EXTRA_USERS = Number(process.env.P66_REHEARSAL_USERS || 2000);

const adminUrl = process.env.P66_REHEARSAL_ADMIN_URL ?? '';
const parsed = new URL(adminUrl || 'postgresql://invalid');
if (parsed.hostname !== '127.0.0.1') throw new Error('refusing a non-local server: set P66_REHEARSAL_ADMIN_URL to a throwaway 127.0.0.1 Postgres');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const DB_NAME = `p66_rehearsal_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${DB_NAME}`;
const DATABASE_URL = url.toString();
const workDir = path.join(os.tmpdir(), `pos-p66-migration-${randomUUID().slice(0, 8)}`);

function sh(cmd: string, env: Record<string, string>) {
  console.warn(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.warn(`  OK: ${message}`);
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
  assert(migrations.slice(-1).join() === PENDING.join(), `the P66 migration is the last: ${PENDING.join(', ')}`);

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

    // ---- populated pre-P66 state (raw SQL, older schema) ----
    const [branch, sup, removedSup, superAdmin, staff, unused, shift, expenseType] = Array.from({ length: 8 }, () => randomUUID());
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P66-N','x','x',now())`, branch);
    const insertUser = `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, is_active, status, employee_id, updated_at)
      VALUES ($1,$2,'x',$3::"Role",$4,$5,'regular',false,$6,$7::"EmployeeStatus",$8,now())`;
    await db.$executeRawUnsafe(insertUser, sup, 'sup@p66.local', 'supervisor', 'Sam', 'Super', true, 'active', 'EMP-1');
    await db.$executeRawUnsafe(insertUser, superAdmin, 'admin@p66.local', 'super_admin', 'Ada', 'Admin', true, 'active', null);
    await db.$executeRawUnsafe(insertUser, staff, null, 'staff', 'Stef', 'Staff', true, 'active', 'EMP-2');
    await db.$executeRawUnsafe(insertUser, unused, 'unused@p66.local', 'supervisor', 'Una', 'Used', true, 'active', null);
    // A P64-removed account: kept row, inactive, marked removed.
    await db.$executeRawUnsafe(insertUser, removedSup, 'removed@p66.local', 'supervisor', 'Rey', 'Removed', false, 'inactive', null);
    await db.$executeRawUnsafe(`UPDATE users SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, removedSup, superAdmin);
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, is_active, status, updated_at)
       SELECT gen_random_uuid()::text, 'bulk' || g || '@p66.local', 'x', 'staff', 'Bulk' || g, 'User', 'regular', false, (g % 3 <> 0), CASE WHEN g % 3 = 0 THEN 'inactive'::"EmployeeStatus" ELSE 'active'::"EmployeeStatus" END, now()
       FROM generate_series(1, ${EXTRA_USERS}) g`,
    );
    for (const id of [sup, staff, removedSup]) {
      await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id, assigned_at) VALUES (gen_random_uuid()::text,$1,$2,now())`, id, branch);
      await db.$executeRawUnsafe(
        `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_out_server_time, clock_in_gps_status, updated_at)
         VALUES (gen_random_uuid()::text,$1,$2,now() - interval '5 hours', now() - interval '1 hour','within_radius',now())`,
        id,
        branch,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_role, previous_hash, current_hash) VALUES (gen_random_uuid()::text,'P66_SEED','test',$1,$1,'supervisor','p','c')`,
        id,
      );
    }
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, closed_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,$3,'closed',500,now() - interval '6 hours')`,
      shift,
      branch,
      sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, voided_by_id, payment_method, subtotal, vat_amount, total_amount, updated_at)
       VALUES (gen_random_uuid()::text,'PC-P66-1',$1,$2,$3,$3,'cash',250.00,0,250.00,now())`,
      branch,
      shift,
      sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at) VALUES (gen_random_uuid()::text,$1,'supplies',123.45,now(),$2,now())`,
      branch,
      sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO expense_types (id, name, normalized_name, created_by_id) VALUES ($1,'Ice','ice',$2)`,
      expenseType,
      removedSup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_id, expires_at) VALUES (gen_random_uuid()::text,$1,'h1','d1',now() + interval '1 day')`,
      sup,
    );

    // ---- migrate ----
    const preTables = await tables(db);
    const before = await snapshot(db, preTables);
    sh(`npx prisma migrate deploy`, env);
    const after = await snapshot(db, preTables);
    const changed = preTables.filter((t) => before[t] !== after[t]);
    assert(changed.length === 0, `all ${preTables.length} pre-existing tables are byte-identical (changed: ${changed.join(', ') || 'none'})`);

    const counts = await db.$queryRawUnsafe<{ users: bigint; people: bigint; matched: bigint; deleted: bigint }[]>(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM people) AS people,
              (SELECT count(*) FROM users u JOIN people p ON p.id = u.id AND p.first_name = u.first_name AND p.last_name = u.last_name
                 AND p.role = u.role AND p.employee_code IS NOT DISTINCT FROM u.employee_id) AS matched,
              (SELECT count(*) FROM people WHERE account_deleted_at IS NOT NULL) AS deleted`,
    );
    const c = counts[0];
    assert(c && c.users === c.people && c.people === c.matched, `one matching attribution record per account (${c?.people} of ${c?.users})`);
    assert(Number(c?.deleted) === 0, 'the migration marks no account deleted (P64-removed rows are still accounts)');
    const invalid = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'people'::regclass AND NOT convalidated`,
    );
    assert(Number(invalid[0]?.n) === 0, 'every new reference to people is validated');
    const toUsers = await db.$queryRawUnsafe<{ conrelid: string; confdeltype: string }[]>(
      `SELECT conrelid::regclass::text AS conrelid, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'users'::regclass ORDER BY 1`,
    );
    assert(
      toUsers.every((row) => row.confdeltype === 'c'),
      `only account-owned tables still reference users, all ON DELETE CASCADE (${toUsers.map((r) => r.conrelid).join(', ')})`,
    );

    // ---- triggers ----
    const created = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, employment_type, updated_at) VALUES ('new@p66.local','x','supervisor','Nia','New','regular',now()) RETURNING id`,
    );
    const newId = created[0]?.id as string;
    assert(Boolean(newId), 'an insert without an id gets one (Prisma relies on this)');
    await db.$executeRawUnsafe(`UPDATE users SET first_name = 'Nina' WHERE id = $1`, newId);
    const renamed = await db.$queryRawUnsafe<{ first_name: string }[]>(`SELECT first_name FROM people WHERE id = $1`, newId);
    assert(renamed[0]?.first_name === 'Nina', 'a rename follows to the attribution record');

    // ---- physical deletion of an account with history ----
    await db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, sup);
    const gone = await db.$queryRawUnsafe<{ users: bigint; tokens: bigint; assignments: bigint }[]>(
      `SELECT (SELECT count(*) FROM users WHERE id = $1) AS users, (SELECT count(*) FROM refresh_tokens WHERE user_id = $1) AS tokens,
              (SELECT count(*) FROM user_branch_assignments WHERE user_id = $1) AS assignments`,
      sup,
    );
    assert(Number(gone[0]?.users) === 0 && Number(gone[0]?.tokens) === 0 && Number(gone[0]?.assignments) === 0, 'deleting the account removes it and what it owned');
    const kept = await db.$queryRawUnsafe<{ cashier: string; voided: string; total: string; expense: string; shift_closer: string }[]>(
      `SELECT pc.first_name AS cashier, pv.first_name AS voided, t.total_amount::text AS total,
              (SELECT e.amount::text FROM expenses e WHERE e.created_by = $1) AS expense,
              (SELECT s.closed_by FROM shifts s WHERE s.id = $2) AS shift_closer
         FROM transactions t JOIN people pc ON pc.id = t.cashier_id LEFT JOIN people pv ON pv.id = t.voided_by_id
        WHERE t.transaction_number = 'PC-P66-1'`,
      sup,
      shift,
    );
    assert(
      kept[0]?.cashier === 'Sam' && kept[0]?.voided === 'Sam' && kept[0]?.total === '250.00' && kept[0]?.expense === '123.45' && kept[0]?.shift_closer === sup,
      'history keeps its actor ids (including the former SET NULL voided_by), names and amounts',
    );
    const marked = await db.$queryRawUnsafe<{ deleted: boolean }[]>(`SELECT account_deleted_at IS NOT NULL AS deleted FROM people WHERE id = $1`, sup);
    assert(marked[0]?.deleted === true, 'any deletion marks the attribution record deleted');
    let reused = false;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, updated_at) VALUES ($1,'reuse@p66.local','x','supervisor','Re','Use','regular',now())`,
        sup,
      );
    } catch {
      reused = true;
    }
    assert(reused, "a deleted account's id cannot be reused for a new account");

    // ---- older (pre-P66) API behaviour after the migration ----
    await db.$executeRawUnsafe(`UPDATE users SET is_active = false, status = 'inactive' WHERE id = $1`, staff);
    await db.$executeRawUnsafe(`UPDATE users SET is_active = true, status = 'active' WHERE id = $1`, staff);
    assert(true, 'an older API can still deactivate and reactivate an account');
    await db.$executeRawUnsafe(`UPDATE users SET deleted_at = now(), deleted_by = $2, is_active = false, status = 'inactive' WHERE id = $1`, staff, superAdmin);
    assert(true, "an older API's P64 removal (keep the row) still works");
    await db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, unused);
    assert(true, "an older API's P47 delete of an unused account still works");
    const oldJoin = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM transactions t JOIN users u ON u.id = t.cashier_id WHERE t.transaction_number = 'PC-P66-1'`,
    );
    assert(Number(oldJoin[0]?.n) === 0, 'HAZARD shown: an older reader joining history to users no longer finds a deleted person (rollback floor)');

    const diff = execSync(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`, {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, '..'),
    }).toString();
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
