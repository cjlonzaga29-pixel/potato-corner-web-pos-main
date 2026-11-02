// POS-PERF-P57 — populated upgrade rehearsal for
//   20261102120000_pos_perf_p57_discount_amount_modes
// Same technique as test-p55r2-migration-on-populated-data.ts: the prior state
// is built from a temporary COPY of the migrations folder (the repo's own folder
// is never moved), rows are seeded with raw SQL under that older schema, then
// the real migration is applied with `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical; every existing type becomes staff-entered, whole order, no
// group; the CHECKs refuse bad values; an insert as an older API writes it
// still works; no schema drift. Sales, stock, settings and proofs are covered by
// the byte comparison.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api):
//   npx tsx scripts/test-p57-migration-on-populated-data.ts
// P57_WORK_DIR overrides where the throwaway cluster lives (default: OS temp).
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = '20261102120000_pos_perf_p57_discount_amount_modes';
const SALES = Number(process.env.P57_REHEARSAL_SALES || 20000);

const workDir = path.join(process.env.P57_WORK_DIR || os.tmpdir(), `pos-p57-migration-${randomUUID().slice(0, 8)}`);
const PORT = 47000 + Math.floor(Math.random() * 100);
const DB_NAME = `p57_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:470\d{2}\/p57_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
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
  assert(migrations.at(-1) === PENDING, `the P57 migration is the last one: ${PENDING}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (entry !== PENDING) fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    const [branch, sup, ana, product, variant, shift, activeType, offType, item, unit] = Array.from({ length: 10 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p57.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p57.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P57-N','x','x',now())`, branch);
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, is_seasonal, classification, updated_at) VALUES ($1,'Classic Fries','active',false,'regular',now())`, product);
    await db.$executeRawUnsafe(`INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',112,true,now())`, variant, product);
    await db.$executeRawUnsafe(`INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`, shift, branch, ana);
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, is_base_unit, updated_at) VALUES ($1,'p57-g','Gram','WEIGHT',true,now())`, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, updated_at) VALUES ($1,'Raw Fries',$2,now())`, item, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, updated_at) VALUES ($1,$2,$3,12,now())`, randomUUID(), branch, item);
    await db.$executeRawUnsafe(
      `INSERT INTO manual_discount_types (id, branch_id, name, apply_to_pos, require_proof, is_active, version, created_by_id, updated_at, deactivated_at) VALUES
       ($1,$3,'Staff meal',true,true,true,4,$4,now(),NULL),($2,$3,'Old promo',false,false,false,2,$4,now(),now())`,
      activeType, offType, branch, sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount,
                                 discount_type, manual_discount_type_id, manual_discount_snapshot, discount_proof_key, calculation_mode, updated_at, created_at)
       SELECT gen_random_uuid()::text, 'PC-P57-' || n, $1, $2, $3, 'completed', 'cash', 100,
              CASE WHEN n % 3 = 0 THEN 10 WHEN n % 3 = 1 THEN 28.57 ELSE 0 END, 0, 0,
              CASE WHEN n % 3 = 0 THEN 90 WHEN n % 3 = 1 THEN 71.43 ELSE 100 END,
              CASE WHEN n % 3 = 0 THEN 'manual' WHEN n % 3 = 1 THEN 'pwd' END,
              CASE WHEN n % 3 = 0 THEN $4 END,
              CASE WHEN n % 3 = 0 THEN jsonb_build_object('version', 2, 'source', 'manual', 'name', 'Staff meal', 'amount', 10) END,
              CASE WHEN n % 6 = 0 THEN $1 || '/' || $2 || '/proof-' || n || '.webp' END,
              CASE WHEN n % 3 = 1 THEN NULL ELSE 'manual_total_v1' END,
              now(), now()
       FROM generate_series(1, ${SALES}) AS n`,
      branch, shift, ana, activeType,
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
    console.log(`  seeded ${before.get('transactions')?.n} sales; fingerprinted ${tables.length} tables`);

    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    console.log(`  migrate deploy took ${Date.now() - started} ms including Prisma CLI start-up (not a production timing)`);

    // Pre-existing columns of pre-existing tables, compared in their old shape.
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

    const types = await db.$queryRawUnsafe<{ id: string; amount_mode: string; fixed_amount: unknown; product_scope: string; group_id: string | null; version: number }[]>(
      `SELECT id, amount_mode, fixed_amount, product_scope, group_id, version FROM manual_discount_types ORDER BY name`,
    );
    assert(types.length === 2 && types.every((type) => type.amount_mode === 'manual' && type.fixed_amount === null && type.product_scope === 'all' && type.group_id === null), 'every existing type is staff-entered, whole order, one branch');
    assert(types.find((type) => type.id === activeType)?.version === 4, 'type versions did not move, so nothing on a screen is invalidated by the migration');
    const [{ count: productRows } = { count: 0n }] = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) FROM manual_discount_type_products`);
    assert(Number(productRows) === 0, 'no product limits were invented');
    const [stock] = await db.$queryRawUnsafe<{ low_stock_threshold: unknown; critical_threshold: unknown }[]>(`SELECT low_stock_threshold, critical_threshold FROM inventory_stocks`);
    assert(stock?.low_stock_threshold === null && stock?.critical_threshold === null, 'no stock threshold was invented');

    const refuses = async (sql: string, label: string) => {
      let refused = false;
      try {
        await db.$executeRawUnsafe(sql);
      } catch {
        refused = true;
      }
      assert(refused, `the database refuses ${label}`);
    };
    const insert = (columns: string, values: string) => `INSERT INTO manual_discount_types (id, branch_id, name, created_by_id, updated_at, ${columns}) VALUES ('${randomUUID()}', '${branch}', '${randomUUID()}', '${sup}', now(), ${values})`;
    await refuses(insert('amount_mode', `'percent'`), 'an unknown amount mode');
    await refuses(insert('amount_mode, fixed_amount', `'fixed', NULL`), 'a fixed type with no amount');
    await refuses(insert('amount_mode, fixed_amount', `'fixed', 0`), 'a fixed type of ₱0');
    await refuses(insert('amount_mode, fixed_amount', `'manual', 5`), 'a staff-entered type with an amount');
    await refuses(insert('product_scope', `'some'`), 'an unknown product scope');

    // What an older API writes (it knows none of the new columns) is still valid.
    await db.$executeRawUnsafe(`INSERT INTO manual_discount_types (id, branch_id, name, created_by_id, updated_at) VALUES ($1,$2,'Added by older API',$3,now())`, randomUUID(), branch, sup);
    const [olderRow] = await db.$queryRawUnsafe<{ amount_mode: string; product_scope: string }[]>(`SELECT amount_mode, product_scope FROM manual_discount_types WHERE name='Added by older API'`);
    assert(olderRow?.amount_mode === 'manual' && olderRow.product_scope === 'all', 'an older API insert gets the staff-entered defaults');

    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no schema drift');
    await db.$disconnect();
    console.log('[p57-migration-test] PASS');
  } finally {
    await pg.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
