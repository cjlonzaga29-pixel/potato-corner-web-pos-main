// POS-PERF-P64 — populated upgrade rehearsal for
//   20261121120000_pos_perf_p64_user_account_removal
// Same technique as test-p61-migration-on-populated-data.ts: the prior state is built
// from a temporary COPY of the migrations folder (the repo's own folder is never
// moved), rows are seeded with raw SQL under that older schema, then the real
// migration is applied with `migrate deploy`.
//
// Asserts: every pre-existing users row (active, inactive, resigned, Super Admin,
// branch, staff without credentials) and every history row that names them is
// byte-identical; no account is marked removed by the migration; an older API's
// writes (deactivate, reactivate, status) still work on non-removed rows; the CHECK
// constraint refuses re-activating a removed row (what an older API would try after a
// rollback); no schema drift.
//
// Needs a throwaway server: it creates and drops its own database. Refuses anything
// but 127.0.0.1. Usage (from apps/api):
//   P64_REHEARSAL_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres npx tsx scripts/test-p64-migration-on-populated-data.ts
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261121120000_pos_perf_p64_user_account_removal'];
const EXTRA_USERS = Number(process.env.P64_REHEARSAL_USERS || 2000);

const adminUrl = process.env.P64_REHEARSAL_ADMIN_URL ?? '';
const parsed = new URL(adminUrl || 'postgresql://invalid');
if (parsed.hostname !== '127.0.0.1') throw new Error('refusing a non-local server: set P64_REHEARSAL_ADMIN_URL to a throwaway 127.0.0.1 Postgres');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const DB_NAME = `p64_rehearsal_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${DB_NAME}`;
const DATABASE_URL = url.toString();
const workDir = path.join(os.tmpdir(), `pos-p64-migration-${randomUUID().slice(0, 8)}`);

function sh(cmd: string, env: Record<string, string>) {
  console.warn(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.warn(`  OK: ${message}`);
}

const SNAPSHOT_TABLES = ['users', 'user_branch_assignments', 'shifts', 'attendance_records', 'refresh_tokens', 'audit_logs'];

async function snapshot(db: PrismaClient, excludeUserColumns: boolean) {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    const columns =
      table === 'users' && excludeUserColumns
        ? (await db.$queryRawUnsafe<{ column_name: string }[]>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name NOT IN ('deleted_at','deleted_by') ORDER BY ordinal_position`,
          )).map((c) => `"${c.column_name}"`)
        : ['*'];
    const rows = await db.$queryRawUnsafe<{ digest: string; n: bigint }[]>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest, count(*) AS n FROM (SELECT ${columns.join(',')} FROM ${table}) t`,
    );
    out[table] = `${rows[0]?.n}:${rows[0]?.digest}`;
  }
  return out;
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((entry) => /^\d{14}_/.test(entry)).sort();
  assert(migrations.slice(-1).join() === PENDING.join(), `the P64 migration is the last: ${PENDING.join(', ')}`);

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

    const [branch, sup, inactiveSup, resigned, superAdmin, branchUser, staff, shift] = Array.from({ length: 8 }, () => randomUUID());
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P64-N','x','x',now())`, branch);
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, is_active, status, deactivated_at, deactivated_by, deactivation_reason, updated_at) VALUES
       ($1,'sup@p64.test','x','supervisor','Sam','Active','regular',false,true,'active',NULL,NULL,NULL,now()),
       ($2,'old@p64.test','x','supervisor','Ola','Inactive','regular',false,false,'inactive',now(),$4,'left the company',now()),
       ($3,'res@p64.test','x','supervisor','Rey','Resigned','regular',false,false,'resigned',now(),$4,'resigned',now()),
       ($4,'admin@p64.test','x','super_admin','Ada','Admin','regular',false,true,'active',NULL,NULL,NULL,now()),
       ($5,'branch@p64.test','x','branch','North','Branch','regular',false,true,'active',NULL,NULL,NULL,now()),
       ($6,NULL,NULL,'staff','Ana','Staff','regular',false,true,'active',NULL,NULL,NULL,now())`,
      sup, inactiveSup, resigned, superAdmin, branchUser, staff,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, is_active, status, updated_at)
       SELECT gen_random_uuid()::text, 'bulk' || g || '@p64.test', 'x', 'supervisor', 'Bulk', g::text, 'regular', false, (g % 3 <> 0), CASE WHEN g % 3 = 0 THEN 'inactive'::"EmployeeStatus" ELSE 'active'::"EmployeeStatus" END, now()
       FROM generate_series(1, $1::int) g`,
      EXTRA_USERS,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO user_branch_assignments (id, user_id, branch_id, assigned_at) VALUES (gen_random_uuid()::text,$1,$3,now()),(gen_random_uuid()::text,$2,$3,now()),(gen_random_uuid()::text,$4,$3,now())`,
      sup, staff, branch, branchUser,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, closed_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,$3,'closed',500,now())`,
      shift, branch, inactiveSup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_out_server_time, clock_in_gps_status, updated_at) VALUES (gen_random_uuid()::text,$1,$2,now() - interval '5 hours',now() - interval '1 hour','within_radius',now())`,
      resigned, branch,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_id, expires_at) VALUES (gen_random_uuid()::text,$1,'h1','d1',now() + interval '1 day')`,
      sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_role, previous_hash, current_hash) VALUES (gen_random_uuid()::text,'EMPLOYEE_DEACTIVATED','user',$1,$2,'super_admin','0','1')`,
      inactiveSup, superAdmin,
    );

    const before = await snapshot(db, false);
    sh(`npx prisma migrate deploy`, env);
    const after = await snapshot(db, true);
    for (const table of SNAPSHOT_TABLES) assert(before[table] === after[table], `${table}: every pre-existing row is unchanged (${before[table]?.split(':')[0]} rows)`);

    const removed = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM users WHERE deleted_at IS NOT NULL OR deleted_by IS NOT NULL`);
    assert(Number(removed[0]?.n) === 0, 'the migration marks no account as removed');
    const constraint = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_constraint WHERE conname = 'users_removed_account_inactive_chk' AND convalidated`,
    );
    assert(Number(constraint[0]?.n) === 1, 'the CHECK constraint exists and was validated against every existing row');

    // What an older API (no deleted_at awareness) does, on accounts that are not removed.
    await db.$executeRawUnsafe(`UPDATE users SET is_active = false, status = 'inactive', deactivated_at = now() WHERE id = $1`, sup);
    await db.$executeRawUnsafe(`UPDATE users SET is_active = true, status = 'active', deactivated_at = NULL WHERE id = $1`, sup);
    await db.$executeRawUnsafe(`UPDATE users SET status = 'active', is_active = true WHERE id = $1`, inactiveSup);
    assert(true, 'an older API can still deactivate, reactivate and change status of a non-removed account');

    // A removal, then what an older API would try after a rollback.
    await db.$executeRawUnsafe(`UPDATE users SET deleted_at = now(), deleted_by = $2, is_active = false, status = 'inactive' WHERE id = $1`, resigned, superAdmin);
    const refuses = async (label: string, sql: string, ...params: unknown[]) => {
      let refused = false;
      try {
        await db.$executeRawUnsafe(sql, ...params);
      } catch {
        refused = true;
      }
      assert(refused, `the database refuses ${label}`);
    };
    await refuses('an older reactivate (is_active = true) on a removed account', `UPDATE users SET is_active = true WHERE id = $1`, resigned);
    await refuses('an older status change to active on a removed account', `UPDATE users SET status = 'active', is_active = true WHERE id = $1`, resigned);
    await refuses('marking an active account removed without deactivating it', `UPDATE users SET deleted_at = now() WHERE id = $1`, sup);
    const names = await db.$queryRawUnsafe<{ first_name: string }[]>(
      `SELECT u.first_name FROM attendance_records a JOIN users u ON u.id = a.employee_id WHERE a.employee_id = $1`,
      resigned,
    );
    assert(names[0]?.first_name === 'Rey', 'history still resolves the removed person by name');

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
