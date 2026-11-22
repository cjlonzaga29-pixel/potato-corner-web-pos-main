// POS-PERF-P68 — populated upgrade rehearsal for
//   20261123120000_pos_perf_p68_branch_force_deletion
// on a throwaway local Postgres. Applies every earlier migration, seeds a
// populated pre-P68 state with raw SQL (open shift, open clock-in, stock,
// 20,000 sales, a P67-deleted branch, a leftover branch login), applies the
// real migration with `migrate deploy`, and checks:
// - every pre-existing column of every pre-existing table is byte-identical
//   (new columns are added NULL; no row is changed, no branch or account deleted);
// - no Force Delete operation or closure item exists, nothing is fenced;
// - ShiftStatus has 'terminated'; the guard refuses a fenced branch and still
//   refuses a deleted one; hold_orders and checkout_attempts are guarded;
// - closure items are immutable;
// - no schema drift.
//
// Usage (from apps/api):
//   P68_REHEARSAL_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres npx tsx scripts/test-p68-migration-on-populated-data.ts
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261123120000_pos_perf_p68_branch_force_deletion'];
const EXTRA_SALES = Number(process.env.P68_REHEARSAL_SALES || 20000);
const EXTRA_BRANCHES = Number(process.env.P68_REHEARSAL_BRANCHES || 300);

const adminUrl = process.env.P68_REHEARSAL_ADMIN_URL ?? '';
const parsed = new URL(adminUrl || 'postgresql://invalid');
if (parsed.hostname !== '127.0.0.1')
  throw new Error(
    'refusing a non-local server: set P68_REHEARSAL_ADMIN_URL to a throwaway 127.0.0.1 Postgres',
  );
if (process.env.PRODUCTION_DATABASE_URL_DIRECT)
  throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const DB_NAME = `p68_rehearsal_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${DB_NAME}`;
const DATABASE_URL = url.toString();
const workDir = path.join(os.tmpdir(), `pos-p68-migration-${randomUUID().slice(0, 8)}`);

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

async function columnsByTable(db: PrismaClient): Promise<Map<string, string[]>> {
  const rows = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations' ORDER BY c.table_name, c.ordinal_position`,
  );
  const map = new Map<string, string[]>();
  for (const row of rows)
    map.set(row.table_name, [...(map.get(row.table_name) ?? []), row.column_name]);
  return map;
}

/** Digest of exactly the given columns, so columns added by the migration don't count as a change. */
async function snapshot(db: PrismaClient, columns: Map<string, string[]>) {
  const out: Record<string, string> = {};
  for (const [table, cols] of columns) {
    const list = cols.map((c) => `"${c}"`).join(', ');
    const rows = await db.$queryRawUnsafe<{ digest: string; n: bigint }[]>(
      `SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS digest, count(*) AS n FROM (SELECT ${list} FROM "${table}") r`,
    );
    out[table] = `${rows[0]?.n}:${rows[0]?.digest}`;
  }
  return out;
}

async function main() {
  const migrations = fs
    .readdirSync(path.join(prismaDir, 'migrations'))
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort();
  assert(
    migrations.slice(-1).join() === PENDING.join(),
    `the P68 migration is the last: ${PENDING.join(', ')}`,
  );

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (!PENDING.includes(entry))
      fs.cpSync(
        path.join(prismaDir, 'migrations', entry),
        path.join(oldPrisma, 'migrations', entry),
        { recursive: true },
      );
  }

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  try {
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    // ---- populated pre-P68 state ----
    const [live, gone, admin1, staff, leftover] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const insertBranch = `INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1, $2, $3, 'x', 'x', now())`;
    await db.$executeRawUnsafe(insertBranch, live, 'Live', 'P68-L');
    await db.$executeRawUnsafe(insertBranch, gone, 'Gone', 'P68-G');
    await db.$executeRawUnsafe(
      `INSERT INTO branches (id, name, code, address, city, updated_at) SELECT gen_random_uuid()::text, 'Bulk ' || g, 'P68-B' || g, 'x', 'x', now() FROM generate_series(1, ${EXTRA_BRANCHES}) g`,
    );
    const insertUser = `INSERT INTO users (id, email, role, first_name, last_name, employment_type, updated_at) VALUES ($1, $2, $3::"Role", $4, $5, 'regular', now())`;
    await db.$executeRawUnsafe(
      insertUser,
      admin1,
      'admin@p68.local',
      'super_admin',
      'Ada',
      'Admin',
    );
    await db.$executeRawUnsafe(insertUser, staff, null, 'staff', 'Sam', 'Staff');
    await db.$executeRawUnsafe(insertUser, leftover, 'leftover@p68.local', 'branch', '', '');
    await db.$executeRawUnsafe(
      `INSERT INTO user_branch_assignments (id, user_id, branch_id) VALUES (gen_random_uuid()::text, $1, $2)`,
      staff,
      live,
    );
    const shift = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',500,now())`,
      shift,
      live,
      staff,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO attendance_records (id, employee_id, branch_id, clock_in_server_time, clock_in_gps_status, updated_at) VALUES (gen_random_uuid()::text,$1,$2,now(),'within_radius',now())`,
      staff,
      live,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, vat_amount, total_amount, updated_at)
       SELECT gen_random_uuid()::text, 'P68-S-' || g, $1, $2, $3, 'cash', 10 + (g % 90), 0, 10 + (g % 90), now() FROM generate_series(1, ${EXTRA_SALES}) g`,
      live,
      shift,
      staff,
    );
    // A branch deleted under P67 (its record stays, marked deleted).
    await db.$executeRawUnsafe(`DELETE FROM branches WHERE id = $1`, gone);

    // ---- migrate ----
    const preColumns = await columnsByTable(db);
    const before = await snapshot(db, preColumns);
    const started = Date.now();
    sh(`npx prisma migrate deploy`, env);
    console.warn(`  migration took ${Date.now() - started} ms (including the Prisma CLI start)`);
    const after = await snapshot(db, preColumns);
    const changed = [...preColumns.keys()].filter((t) => before[t] !== after[t]);
    assert(
      changed.length === 0,
      `all ${preColumns.size} pre-existing tables are byte-identical in their existing columns (changed: ${changed.join(', ') || 'none'})`,
    );

    const state = await db.$queryRawUnsafe<
      {
        ops: bigint;
        items: bigint;
        fenced: bigint;
        terminated: bigint;
        att: bigint;
        leftover: bigint;
      }[]
    >(
      `SELECT (SELECT count(*) FROM branch_deletion_operations) AS ops, (SELECT count(*) FROM branch_closure_items) AS items,
              (SELECT count(*) FROM branches WHERE deletion_fenced_at IS NOT NULL) AS fenced,
              (SELECT count(*) FROM shifts WHERE terminated_at IS NOT NULL OR status = 'terminated') AS terminated,
              (SELECT count(*) FROM attendance_records WHERE administratively_terminated_at IS NOT NULL) AS att,
              (SELECT count(*) FROM users WHERE id = '${leftover}') AS leftover`,
    );
    const s = state[0];
    assert(
      s && Number(s.ops) === 0 && Number(s.items) === 0 && Number(s.fenced) === 0,
      'no operation, closure item or fence exists after the migration',
    );
    assert(
      Number(s?.terminated) === 0 && Number(s?.att) === 0,
      'no shift or attendance is terminated by the migration',
    );
    assert(
      Number(s?.leftover) === 1,
      'the leftover branch login is not cleaned up by the migration',
    );

    // ---- guards ----
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `INSERT INTO hold_orders (id, branch_id, shift_id, cashier_id, expires_at, updated_at) VALUES (gen_random_uuid()::text,$1,$2,$3,now(),now())`,
            gone,
            shift,
            staff,
          ),
        /POS_PERF_P67_BRANCH_DELETED/,
      ),
      'hold_orders for a deleted branch are refused',
    );
    await db.$executeRawUnsafe(
      `UPDATE branches SET deletion_fenced_at = now(), deletion_operation_id = 'rehearsal' WHERE id = $1`,
      live,
    );
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, vat_amount, total_amount, updated_at) VALUES (gen_random_uuid()::text,'P68-F',$1,$2,$3,'cash',1,0,1,now())`,
            live,
            shift,
            staff,
          ),
        /POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS/,
      ),
      'a sale for a fenced branch is refused as in progress',
    );
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `INSERT INTO checkout_attempts (idempotency_key, branch_id, cashier_id, owner_token, lease_expires_at, updated_at) VALUES ('p68-co',$1,$2,'o',now(),now())`,
            live,
            staff,
          ),
        /POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS/,
      ),
      'checkout_attempts for a fenced branch are refused',
    );
    await db.$executeRawUnsafe(
      `UPDATE shifts SET status = 'terminated', terminated_at = now() WHERE id = $1`,
      shift,
    );
    assert(
      true,
      "an existing shift can be set to 'terminated' on a fenced branch (status update is not a guarded write)",
    );
    await db.$executeRawUnsafe(
      `UPDATE branches SET deletion_fenced_at = NULL, deletion_operation_id = NULL WHERE id = $1`,
      live,
    );

    // ---- closure items are immutable ----
    const op = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO branch_deletion_operations (id, branch_id, mode, status, actor_id, plan, plan_hash, updated_at) VALUES ($1,$2,'force','completed',$3,'[]','h',now())`,
      op,
      gone,
      admin1,
    );
    const item = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO branch_closure_items (id, operation_id, branch_id, kind, source_table, source_id, outcome, reason, snapshot, recorded_by) VALUES ($1,$2,$3,'open_shift','shifts','x','o','r','{}',$4)`,
      item,
      op,
      gone,
      admin1,
    );
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `UPDATE branch_closure_items SET reason = 'edited' WHERE id = $1`,
            item,
          ),
        /CLOSURE_ITEM_IMMUTABLE/,
      ),
      'a closure item cannot be edited',
    );
    await db.$executeRawUnsafe(
      `UPDATE branch_closure_items SET reconciled_at = now(), reconciled_by = $2, reconciliation_note = 'ok' WHERE id = $1`,
      item,
      admin1,
    );
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `UPDATE branch_closure_items SET reconciliation_note = 'again' WHERE id = $1`,
            item,
          ),
        /CLOSURE_ITEM_IMMUTABLE/,
      ),
      'it is reconciled once, then frozen',
    );
    assert(
      await refused(
        () => db.$executeRawUnsafe(`DELETE FROM branch_closure_items WHERE id = $1`, item),
        /CLOSURE_ITEM_IMMUTABLE/,
      ),
      'and never deleted',
    );
    assert(
      await refused(
        () =>
          db.$executeRawUnsafe(
            `INSERT INTO branch_deletion_operations (id, branch_id, mode, status, actor_id, plan, plan_hash, updated_at) VALUES ($1,$2,'force','fenced',$3,'[]','h',now()), ($4,$2,'force','fenced',$3,'[]','h',now())`,
            randomUUID(),
            live,
            admin1,
            randomUUID(),
          ),
        /one_fenced_per_branch|23505|unique/i,
      ),
      'at most one fenced operation per branch',
    );

    const diff = execSync(
      `npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`,
      {
        env: { ...process.env, ...env },
        cwd: path.join(__dirname, '..'),
      },
    ).toString();
    assert(
      diff.includes('This is an empty migration'),
      `no schema drift${diff.includes('empty') ? '' : `:\n${diff}`}`,
    );

    console.warn('REHEARSAL PASSED');
  } finally {
    await db.$disconnect().catch(() => undefined);
    await admin
      .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.$disconnect();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
