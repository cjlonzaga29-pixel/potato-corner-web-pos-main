// POS-PERF-P60 — populated upgrade rehearsal for
//   20261104120000_pos_perf_p60_expense_types
//   20261104120100_pos_perf_p60_validate_expense_type_fk
// Same technique as test-p58-migration-on-populated-data.ts: the prior state is
// built from a temporary COPY of the migrations folder (the repo's own folder is
// never moved), rows are seeded with raw SQL under that older schema, then the
// real migrations are applied with `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical; every expense stays legacy with no type guessed; nothing is
// seeded; an older API's insert and update stay correct and keep reading; the
// constraints refuse bad rows; no schema drift.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api):
//   npx tsx scripts/test-p60-migration-on-populated-data.ts
// P60_WORK_DIR overrides where the throwaway cluster lives (default: OS temp).
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261104120000_pos_perf_p60_expense_types', '20261104120100_pos_perf_p60_validate_expense_type_fk'];
const EXPENSES = Number(process.env.P60_REHEARSAL_EXPENSES || 20000);

const workDir = path.join(process.env.P60_WORK_DIR || os.tmpdir(), `pos-p60-migration-${randomUUID().slice(0, 8)}`);
const PORT = 47900 + Math.floor(Math.random() * 90);
const DB_NAME = `p60_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:479\d{2}\/p60_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
if (process.env.PRODUCTION_DATABASE_URL_DIRECT) throw new Error('refusing to run with PRODUCTION_DATABASE_URL_DIRECT set');

const pg = new EmbeddedPostgres({ databaseDir: path.join(workDir, 'pg'), user: 'postgres', password: 'postgres', port: PORT, persistent: false });

function sh(cmd: string, env: Record<string, string>) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((entry) => /^\d{14}_/.test(entry)).sort();
  assert(migrations.slice(-2).join() === PENDING.join(), `the P60 migrations are the last two: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (!PENDING.includes(entry)) fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const [branch, branchB, sup, ana, shift] = Array.from({ length: 5 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p60.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p60.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P60-N','x','x',now()),($2,'South','P60-S','x','x',now())`, branch, branchB);
    await db.$executeRawUnsafe(`INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`, shift, branch, ana);
    // Every old category, some with proof, some soft-deleted, across two branches.
    await db.$executeRawUnsafe(
      `INSERT INTO expenses (id, branch_id, category, amount, vendor_name, description, receipt_url, receipt_key, incurred_at, created_by, updated_at, deleted_at)
       SELECT gen_random_uuid()::text, CASE WHEN n % 2 = 0 THEN $1 ELSE $2 END,
              (ARRAY['utilities','supplies','staff_meals','miscellaneous'])[n % 4 + 1]::"ExpenseCategory", (n % 977) + 0.25,
              'Vendor ' || (n % 50), 'Bills for ' || n,
              CASE WHEN n % 5 = 0 THEN 'stored-url-' || n END, CASE WHEN n % 5 = 0 THEN 'expenses/' || n || '/proof.webp' END,
              now() - (n % 400) * interval '1 day', $3, now(), CASE WHEN n % 97 = 0 THEN now() END
       FROM generate_series(1, ${EXPENSES}) AS n`,
      branch, branchB, sup,
    );
    await db.$executeRawUnsafe(`INSERT INTO expense_idempotency_keys (id, key, user_id, expense_id) SELECT gen_random_uuid()::text, 'old-' || id, $1, id FROM expenses LIMIT 500`, sup);
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, updated_at, created_at)
       SELECT gen_random_uuid()::text, 'PC-P60-' || n, $1, $2, $3, 'completed', 'cash', 100, 0, 0, 0, 100, now(), now() FROM generate_series(1, 2000) AS n`,
      branch, shift, ana,
    );

    const tables = (await db.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations' ORDER BY 1`)).map((row) => row.table_name);
    const fingerprint = async (table: string) => {
      const columns = (await db.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, table)).map((row) => `"${row.column_name}"`);
      const [row] = await db.$queryRawUnsafe<{ hash: string | null; n: bigint }[]>(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash, count(*) AS n FROM (SELECT ${columns.join(',')} FROM "${table}") t`,
      );
      return { columns, hash: row?.hash ?? null, n: Number(row?.n ?? 0) };
    };
    const before = new Map<string, Awaited<ReturnType<typeof fingerprint>>>();
    for (const table of tables) before.set(table, await fingerprint(table));
    const totalsSql = `SELECT branch_id, category::text, count(*)::int AS n, sum(amount)::text AS total FROM expenses WHERE deleted_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2`;
    const totalsBefore = JSON.stringify(await db.$queryRawUnsafe(totalsSql));
    console.log(`  seeded ${before.get('expenses')?.n} expenses, ${before.get('transactions')?.n} sales; fingerprinted ${tables.length} tables`);

    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    console.log(`  migrate deploy took ${Date.now() - started} ms including Prisma CLI start-up (not a production timing)`);

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
    assert(changed === 0, `all ${tables.length} pre-existing tables' pre-existing columns are byte-identical`);
    assert(JSON.stringify(await db.$queryRawUnsafe(totalsSql)) === totalsBefore, 'expense totals per branch and category are unchanged');

    const count = async (sql: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]?.n ?? 0);
    assert((await count(`SELECT count(*) AS n FROM expenses WHERE expense_type_id IS NOT NULL OR expense_type_name IS NOT NULL`)) === 0, 'every expense stays legacy: no type was guessed');
    assert((await count(`SELECT count(*) AS n FROM expense_types`)) === 0, 'no expense type was seeded');
    assert((await count(`SELECT count(*) AS n FROM expense_idempotency_keys WHERE request_hash IS NOT NULL`)) === 0, 'old idempotency keys carry no hash');
    const validated = await db.$queryRawUnsafe<{ conname: string; convalidated: boolean }[]>(`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('expenses_expense_type_id_fkey', 'expenses_expense_type_name_check')`);
    assert(validated.length === 2 && validated.every((row) => row.convalidated), 'the expenses FK and CHECK are validated');

    // What an older API writes (it knows none of the new columns) is still valid and reads as legacy.
    const olderInsert = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO expenses (id, branch_id, category, amount, incurred_at, created_by, updated_at) VALUES ($1,$2,'supplies',10,now(),$3,now())`, olderInsert, branch, sup);
    const [olderRow] = await db.$queryRawUnsafe<{ category: string; expense_type_id: string | null }[]>(`SELECT category::text, expense_type_id FROM expenses WHERE id=$1`, olderInsert);
    assert(olderRow?.category === 'supplies' && olderRow.expense_type_id === null, 'an older API insert reads as the legacy category it chose');
    await db.$executeRawUnsafe(`INSERT INTO expense_idempotency_keys (id, key, user_id, expense_id) VALUES ($1,'older-api-key',$2,$3)`, randomUUID(), sup, olderInsert);
    assert(true, 'an older API can still record its idempotency key');

    // Types, as the new API writes them, through the real constraints.
    const type = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO expense_types (id, name, normalized_name, created_by_id) VALUES ($1,'Bills','bills',$2)`, type, sup);
    await db.$executeRawUnsafe(`INSERT INTO expense_type_branches (expense_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'bills',true)`, type, branch);
    const typed = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO expenses (id, branch_id, category, expense_type_id, expense_type_name, amount, incurred_at, created_by, updated_at) VALUES ($1,$2,'miscellaneous',$3,'Bills',25,now(),$4,now())`, typed, branch, type, sup);
    // An older API edit of a typed expense leaves the type and recorded name on the row.
    await db.$executeRawUnsafe(`UPDATE expenses SET amount=30, category='utilities' WHERE id=$1`, typed);
    const [typedRow] = await db.$queryRawUnsafe<{ expense_type_id: string; expense_type_name: string }[]>(`SELECT expense_type_id, expense_type_name FROM expenses WHERE id=$1`, typed);
    assert(typedRow?.expense_type_id === type && typedRow.expense_type_name === 'Bills', 'an older API edit keeps the type and its recorded name');
    // The old schema's client reads every enum value it knows, which is the only value a typed row stores.
    const [{ placeholder } = { placeholder: '' }] = await db.$queryRawUnsafe<{ placeholder: string }[]>(`SELECT array_to_string(enum_range(NULL::"ExpenseCategory"), ',') AS placeholder`);
    assert(placeholder === 'utilities,supplies,staff_meals,miscellaneous', 'no enum value was added, so an older API can still read every row');

    const refuses = async (sql: string, label: string) => {
      let refused = false;
      try {
        await db.$executeRawUnsafe(sql);
      } catch {
        refused = true;
      }
      assert(refused, `the database refuses ${label}`);
    };
    const insertType = (name: string, normalized: string) => `INSERT INTO expense_types (id, name, normalized_name, created_by_id) VALUES ('${randomUUID()}', '${name}', '${normalized}', '${sup}')`;
    await refuses(insertType('Legacy', 'legacy'), 'a ledger view name');
    await refuses(insertType('Mixed', 'Mixed'), 'a name that was not normalized');
    await refuses(insertType('', ''), 'an empty name');
    await refuses(insertType('x'.repeat(61), 'x'.repeat(61)), 'an over-long name');
    await refuses(`INSERT INTO expense_type_branches (expense_type_id, branch_id, normalized_name, is_active) VALUES ('${type}', '${branchB}', 'other', true)`, 'a scope row whose name disagrees with its type');
    await refuses(`INSERT INTO expenses (id, branch_id, category, expense_type_id, amount, incurred_at, created_by, updated_at) VALUES ('${randomUUID()}', '${branch}', 'miscellaneous', '${type}', 1, now(), '${sup}', now())`, 'a typed expense with no recorded name');
    await refuses(`INSERT INTO expenses (id, branch_id, category, expense_type_name, amount, incurred_at, created_by, updated_at) VALUES ('${randomUUID()}', '${branch}', 'miscellaneous', 'Bills', 1, now(), '${sup}', now())`, 'a recorded name with no type');
    const dup = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO expense_types (id, name, normalized_name, created_by_id) VALUES ($1,'BILLS','bills',$2)`, dup, sup);
    await refuses(`INSERT INTO expense_type_branches (expense_type_id, branch_id, normalized_name, is_active) VALUES ('${dup}', '${branch}', 'bills', true)`, 'a second active type of one name at one branch');
    await db.$executeRawUnsafe(`INSERT INTO expense_type_branches (expense_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'bills',true)`, dup, branchB);
    assert(true, 'the same name is allowed at another branch');
    await refuses(`DELETE FROM expense_types WHERE id='${type}'`, 'hard-deleting a referenced type');
    await db.$executeRawUnsafe(`UPDATE expense_types SET is_active=false WHERE id=$1`, type);
    const [cascaded] = await db.$queryRawUnsafe<{ is_active: boolean }[]>(`SELECT is_active FROM expense_type_branches WHERE expense_type_id=$1`, type);
    assert(cascaded?.is_active === false, 'deactivation cascades to the scope rows');
    await db.$executeRawUnsafe(`INSERT INTO expense_type_branches (expense_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'bills',true)`, dup, branch);
    assert(true, 'a deactivated name can be reused at its branch');
    await refuses(`UPDATE expense_types SET is_active=true WHERE id='${type}'`, 'reactivating into a name now taken');

    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no schema drift');
    await db.$disconnect();
    console.log('[p60-migration-test] PASS');
  } finally {
    await pg.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
