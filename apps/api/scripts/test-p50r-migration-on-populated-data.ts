// POS-PERF-P50R — populated upgrade rehearsal for
// 20261030160000_pos_perf_p50r_branch_discounts, same technique as
// test-p35r-catalog-assignment-migration-on-populated-data.ts, except the
// pre-P50R state is built from a temporary COPY of the migrations folder
// (the repo's own folder is never moved). Seeds rows under the post-P49
// schema with raw SQL (the generated client already knows the new columns),
// applies the real migrations, then asserts every existing row is unchanged,
// promotions default to 'automatic', old sales have no tax snapshot, and the
// effective discount policy a branch gets is exactly the pre-P50R one.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p50r-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const TARGET_MIGRATION = '20261030160000_pos_perf_p50r_branch_discounts';
const SALES = Number(process.env.P50R_REHEARSAL_SALES || 20000);

const workDir = path.join(os.tmpdir(), `pos-p50r-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DB_NAME = 'pos_p50r_migration_test';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/pos_p50r_migration_test$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');

const pg = new EmbeddedPostgres({ databaseDir: DB_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });

function sh(cmd: string, env: Record<string, string>) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

async function main() {
  // Pre-P50R copy of prisma/: schema + every migration except the target.
  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (entry === TARGET_MIGRATION) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[p50r-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p50r-migration-test] applying every migration before P50R (through P49)');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[p50r-migration-test] seeding a populated post-P49 database (${SALES} sales)`);
    const branchA = randomUUID();
    const branchB = randomUUID();
    const admin = randomUUID();
    const sup = randomUUID();
    const cashier = randomUUID();
    const product = randomUUID();
    const variant = randomUUID();
    const promo = randomUUID();
    const shift = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'admin@p50r.test','x','super_admin','A','A','regular',false,now()),($2,'sup@p50r.test','x','supervisor','S','S','regular',false,now()),($3,'cash@p50r.test','x','staff','C','C','regular',false,now())`,
      admin, sup, cashier,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'A','P50R-A','x','x',now()),($2,'B','P50R-B','x','x',now())`,
      branchA, branchB,
    );
    await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id) VALUES ($1,$2,$3)`, randomUUID(), sup, branchA);
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, classification, updated_at) VALUES ($1,'Promo Fries','active','promotional',now())`, product);
    await db.$executeRawUnsafe(
      `INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',112,true,now())`,
      variant, product,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO promotions (id, name, discount_kind, discount_value, is_enabled, created_by_id, updated_at) VALUES ($1,'Old promo','fixed_amount',10,true,$2,now())`,
      promo, sup,
    );
    await db.$executeRawUnsafe(`INSERT INTO promotion_products (promotion_id, product_id) VALUES ($1,$2)`, promo, product);
    await db.$executeRawUnsafe(`INSERT INTO promotion_branches (promotion_id, branch_id) VALUES ($1,$2)`, promo, branchA);
    // A supervisor-saved organization policy (pre-P50R behavior: Employee 15% everywhere).
    await db.$executeRawUnsafe(
      `INSERT INTO system_settings (id, key, value, updated_by, updated_at) VALUES ($1,'discount_policy',$2::jsonb,$3,now())`,
      randomUUID(),
      JSON.stringify({ pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 15, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } }),
      sup,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`,
      shift, branchA, cashier,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount, discount_type, discount_rate_used, updated_at)
       SELECT gen_random_uuid(), 'PC-P50R-' || g, $1, $2, $3, 'cash', 112, CASE WHEN g % 3 = 0 THEN 16.8 ELSE 0 END, CASE WHEN g % 3 = 0 THEN 10.20 ELSE 12 END, 0,
              CASE WHEN g % 3 = 0 THEN 95.2 ELSE 112 END, CASE WHEN g % 3 = 0 THEN 'employee' END, CASE WHEN g % 3 = 0 THEN 15 END, now()
       FROM generate_series(1, ${SALES}) g`,
      branchA, shift, cashier,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total, discount_amount, promotion_id, promotion_snapshot)
       SELECT gen_random_uuid(), t.id, $1, $2, 'Promo Fries', 'Regular', 112, 1, 112, 0, $3, $4::jsonb FROM transactions t WHERE t.branch_id = $5 LIMIT 500`,
      product, variant, promo,
      JSON.stringify({ promotion_id: promo, name: 'Old promo', discount_kind: 'fixed_amount', discount_value: 10, version: 1, base_price: 112, unit_discount: 10, quantity: 1 }),
      branchA,
    );

    type Fingerprint = { count: bigint; total: string; discount: string; vat: string; items: bigint; snaps: string | null; promos: bigint; settings: string | null };
    const fingerprint = async (): Promise<Fingerprint> => {
      const [row] = await db.$queryRawUnsafe<Fingerprint[]>(
        `SELECT (SELECT count(*) FROM transactions) AS count,
                (SELECT sum(total_amount)::text FROM transactions) AS total,
                (SELECT sum(discount_amount)::text FROM transactions) AS discount,
                (SELECT sum(vat_amount)::text FROM transactions) AS vat,
                (SELECT count(*) FROM transaction_items) AS items,
                (SELECT md5(string_agg(promotion_snapshot::text, ',' ORDER BY id)) FROM transaction_items) AS snaps,
                (SELECT count(*) FROM promotions) AS promos,
                (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM system_settings) AS settings`,
      );
      if (!row) throw new Error('no fingerprint');
      return row;
    };
    const before = await fingerprint();
    await db.$disconnect();

    console.log('[p50r-migration-test] applying the real migrations (P50R only is pending)');
    const startedAt = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - startedAt;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const fp = await (async () => {
      const [row] = await after.$queryRawUnsafe<Fingerprint[]>(
        `SELECT (SELECT count(*) FROM transactions) AS count, (SELECT sum(total_amount)::text FROM transactions) AS total,
                (SELECT sum(discount_amount)::text FROM transactions) AS discount, (SELECT sum(vat_amount)::text FROM transactions) AS vat,
                (SELECT count(*) FROM transaction_items) AS items, (SELECT md5(string_agg(promotion_snapshot::text, ',' ORDER BY id)) FROM transaction_items) AS snaps,
                (SELECT count(*) FROM promotions) AS promos, (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM system_settings) AS settings`,
      );
      return row as Fingerprint;
    })();
    assert(JSON.stringify(fp, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      `sales, amounts, items, promotion snapshots, promotions and settings are byte-identical (${SALES} sales)`);
    assert((await after.promotion.findMany()).every((p) => p.applicationMode === 'automatic'), 'every existing promotion is automatic (P49 behavior kept)');
    assert((await after.transaction.count({ where: { NOT: { taxSnapshot: { equals: null } } } })) === 0, 'no existing sale gets a tax snapshot (history untouched)');
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);
    await after.$disconnect();

    console.log('[p50r-migration-test] effective policy after the migration equals the pre-P50R organization-wide policy');
    const { settingsService } = await import('../src/modules/settings/settings.service.js');
    for (const branchId of [branchA, branchB]) {
      const effective = await settingsService.getEffectiveDiscountPolicy(branchId);
      assert(
        effective.policy.employee.percentage === 15 && effective.policy.pwd.percentage === 20 && effective.policy.senior_citizen.percentage === 20,
        `branch ${branchId === branchA ? 'A' : 'B'}: Employee 15% / PWD 20% / Senior 20% from the organization row`,
      );
      assert(effective.requireDiscountChoice === false && effective.vatRegistration === 'unconfirmed', 'no required choice; VAT registration unconfirmed (calculated as before)');
    }
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.$disconnect();
    console.log('[p50r-migration-test] PASS');
  } finally {
    await pg.stop().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
