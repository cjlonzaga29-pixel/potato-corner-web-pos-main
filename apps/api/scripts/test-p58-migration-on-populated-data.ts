// POS-PERF-P58 — populated upgrade rehearsal for
//   20261103120000_pos_perf_p58_custom_product_types
//   20261103120100_pos_perf_p58_validate_product_type_fk
// Same technique as test-p57-migration-on-populated-data.ts: the prior state is
// built from a temporary COPY of the migrations folder (the repo's own folder is
// never moved), rows are seeded with raw SQL under that older schema, then the
// real migrations are applied with `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical; every product reads as its existing type with no backfill; an
// insert and an update as an older API writes them stay correct, including on a
// product with a custom type; the constraints refuse bad rows; no schema drift.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api):
//   npx tsx scripts/test-p58-migration-on-populated-data.ts
// P58_WORK_DIR overrides where the throwaway cluster lives (default: OS temp).
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261103120000_pos_perf_p58_custom_product_types', '20261103120100_pos_perf_p58_validate_product_type_fk'];
const PRODUCTS = Number(process.env.P58_REHEARSAL_PRODUCTS || 5000);

const workDir = path.join(process.env.P58_WORK_DIR || os.tmpdir(), `pos-p58-migration-${randomUUID().slice(0, 8)}`);
const PORT = 47900 + Math.floor(Math.random() * 90);
const DB_NAME = `p58_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:479\d{2}\/p58_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
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
  assert(migrations.slice(-2).join() === PENDING.join(), `the P58 migrations are the last two: ${PENDING.join(', ')}`);

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

    const [branch, branchB, sup, ana, shift, unit, item] = Array.from({ length: 7 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p58.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p58.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P58-N','x','x',now()),($2,'South','P58-S','x','x',now())`, branch, branchB);
    await db.$executeRawUnsafe(`INSERT INTO units_of_measure (id, code, name, dimension, is_base_unit, updated_at) VALUES ($1,'p58-g','Gram','WEIGHT',true,now())`, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_items (id, name, base_unit_id, updated_at) VALUES ($1,'Raw Fries',$2,now())`, item, unit);
    await db.$executeRawUnsafe(`INSERT INTO inventory_stocks (id, branch_id, inventory_item_id, quantity_on_hand, updated_at) VALUES ($1,$2,$3,12,now())`, randomUUID(), branch, item);
    await db.$executeRawUnsafe(`INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`, shift, branch, ana);
    // A third of each built-in type, with a season window on the seasonal ones.
    await db.$executeRawUnsafe(
      `INSERT INTO products (id, name, status, classification, is_seasonal, seasonal_start_date, seasonal_end_date, ever_published, version, updated_at)
       SELECT gen_random_uuid()::text, 'Product ' || n, 'active',
              (ARRAY['regular','promotional','seasonal'])[n % 3 + 1]::"ProductClassification", n % 3 = 2,
              CASE WHEN n % 3 = 2 THEN DATE '2026-12-01' END, CASE WHEN n % 3 = 2 THEN DATE '2026-12-31' END, n % 2 = 0, n % 5 + 1, now()
       FROM generate_series(1, ${PRODUCTS}) AS n`,
    );
    await db.$executeRawUnsafe(`INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) SELECT gen_random_uuid()::text, id, 'Regular', 'Regular', 100, true, now() FROM products`);
    await db.$executeRawUnsafe(`INSERT INTO branch_product_availability (id, branch_id, product_id, is_available, updated_at) SELECT gen_random_uuid()::text, $1, id, ever_published, now() FROM products`, branch);
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, status, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, updated_at, created_at)
       SELECT gen_random_uuid()::text, 'PC-P58-' || n, $1, $2, $3, 'completed', 'cash', 100, 0, 0, 0, 100, now(), now() FROM generate_series(1, 2000) AS n`,
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
    console.log(`  seeded ${before.get('products')?.n} products, ${before.get('transactions')?.n} sales; fingerprinted ${tables.length} tables`);

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

    const [{ count: withType } = { count: 0n }] = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) FROM products WHERE product_type_id IS NOT NULL`);
    assert(Number(withType) === 0, 'no product row was written: built-in assignments stay in classification, so nothing can go stale');
    const [{ validated } = { validated: false }] = await db.$queryRawUnsafe<{ validated: boolean }[]>(`SELECT convalidated AS validated FROM pg_constraint WHERE conname='products_product_type_id_fkey'`);
    assert(validated === true, 'the products FK is validated');

    // What an older API writes (it knows none of the new columns) is still valid and reads correctly.
    const olderInsert = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, classification, is_seasonal, updated_at) VALUES ($1,'Added by older API','active','seasonal',true,now())`, olderInsert);
    const [olderRow] = await db.$queryRawUnsafe<{ classification: string; product_type_id: string | null }[]>(`SELECT classification, product_type_id FROM products WHERE id=$1`, olderInsert);
    assert(olderRow?.classification === 'seasonal' && olderRow.product_type_id === null, 'an older API insert reads as the built-in it wrote');
    await db.$executeRawUnsafe(`UPDATE products SET classification='regular', is_seasonal=false WHERE id=$1`, olderInsert);
    const [olderEdit] = await db.$queryRawUnsafe<{ classification: string; product_type_id: string | null }[]>(`SELECT classification, product_type_id FROM products WHERE id=$1`, olderInsert);
    assert(olderEdit?.classification === 'regular' && olderEdit.product_type_id === null, 'an older API edit moves the built-in with no second column to reconcile');

    // Custom types, as the new API writes them, through the real constraints.
    const type = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO product_types (id, name, normalized_name, created_by_id) VALUES ($1,'Marketing','marketing',$2)`, type, sup);
    await db.$executeRawUnsafe(`INSERT INTO product_type_branches (product_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'marketing',true)`, type, branch);
    const typed = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, classification, is_seasonal, product_type_id, updated_at) VALUES ($1,'Typed','active','regular',false,$2,now())`, typed, type);
    // An older API edit of a custom-typed product leaves the custom type on the row.
    await db.$executeRawUnsafe(`UPDATE products SET name='Typed, edited by older API', classification='promotional' WHERE id=$1`, typed);
    const [typedRow] = await db.$queryRawUnsafe<{ product_type_id: string | null; classification: string }[]>(`SELECT product_type_id, classification FROM products WHERE id=$1`, typed);
    assert(typedRow?.product_type_id === type && typedRow.classification === 'promotional', 'an older API edit keeps the custom type and writes classification');

    const refuses = async (sql: string, label: string) => {
      let refused = false;
      try {
        await db.$executeRawUnsafe(sql);
      } catch {
        refused = true;
      }
      assert(refused, `the database refuses ${label}`);
    };
    const insertType = (name: string, normalized: string) => `INSERT INTO product_types (id, name, normalized_name, created_by_id) VALUES ('${randomUUID()}', '${name}', '${normalized}', '${sup}')`;
    await refuses(insertType('Regular', 'regular'), 'a built-in name');
    await refuses(insertType('Mixed', 'Mixed'), 'a name that was not normalized');
    await refuses(insertType('', ''), 'an empty name');
    await refuses(insertType('x'.repeat(61), 'x'.repeat(61)), 'an over-long name');
    await refuses(`INSERT INTO product_type_branches (product_type_id, branch_id, normalized_name, is_active) VALUES ('${type}', '${branchB}', 'other', true)`, 'a scope row whose name disagrees with its type');
    const dup = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO product_types (id, name, normalized_name, created_by_id) VALUES ($1,'MARKETING','marketing',$2)`, dup, sup);
    await refuses(`INSERT INTO product_type_branches (product_type_id, branch_id, normalized_name, is_active) VALUES ('${dup}', '${branch}', 'marketing', true)`, 'a second active type of one name at one branch');
    await db.$executeRawUnsafe(`INSERT INTO product_type_branches (product_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'marketing',true)`, dup, branchB);
    assert(true, 'the same name is allowed at another branch');
    await refuses(`DELETE FROM product_types WHERE id='${type}'`, 'hard-deleting a referenced type');
    await db.$executeRawUnsafe(`UPDATE product_types SET is_active=false WHERE id=$1`, type);
    const [cascaded] = await db.$queryRawUnsafe<{ is_active: boolean }[]>(`SELECT is_active FROM product_type_branches WHERE product_type_id=$1`, type);
    assert(cascaded?.is_active === false, 'deactivation cascades to the scope rows');
    await db.$executeRawUnsafe(`INSERT INTO product_type_branches (product_type_id, branch_id, normalized_name, is_active) VALUES ($1,$2,'marketing',true)`, dup, branch);
    assert(true, 'a deactivated name can be reused at its branch');
    await refuses(`UPDATE product_types SET is_active=true WHERE id='${type}'`, 'reactivating into a name now taken');

    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no schema drift');
    await db.$disconnect();
    console.log('[p58-migration-test] PASS');
  } finally {
    await pg.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
