// POS-PERF-P55 — populated upgrade rehearsal for the two P55 migrations:
//   20261101120000_pos_perf_p55_manual_discounts
//   20261101120100_pos_perf_p55_validate_fks
// Same technique as test-p54-combined-migrations-on-populated-data.ts: the
// pre-P55 state is built from a temporary COPY of the migrations folder (the
// repo's own folder is never moved), rows are seeded with raw SQL under that
// older schema, then the real migrations are applied with `migrate deploy`.
//
// Asserts: every pre-existing column of every pre-existing table is
// byte-identical (row count + content MD5); nothing is backfilled or
// converted (no sale gains a manual discount, no promotion or setting turns
// into a discount type, no proof is registered or moved); the new FK is
// validated; no schema drift. Then prints the promotion cutover inventory
// and checks the rollback-detection queries the runbook documents, and uses
// the new tables on the migrated data (a supervisor creates a type).
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p55-migration-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const PENDING = ['20261101120000_pos_perf_p55_manual_discounts', '20261101120100_pos_perf_p55_validate_fks'];
const SALES = Number(process.env.P55_REHEARSAL_SALES || 20000);

const workDir = path.join(os.tmpdir(), `pos-p55-migration-${randomUUID().slice(0, 8)}`);
const DB_DIR = path.join(workDir, 'pg');
const PORT = 46800 + Math.floor(Math.random() * 100);
const DB_NAME = `p55_${Date.now()}`;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:468\d{2}\/p55_\d+$/.test(DATABASE_URL)) throw new Error('refusing a non-local database');
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

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  for (const name of PENDING) if (!migrations.includes(name)) throw new Error(`missing migration ${name}`);
  const pendingFromFolder = migrations.slice(migrations.indexOf(PENDING[0] as string));
  assert(json(pendingFromFolder) === json(PENDING), `pending set is exactly the two P55 migrations, in order: ${PENDING.join(', ')}`);

  const oldPrisma = path.join(workDir, 'prisma-pre');
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (PENDING.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(oldPrisma, 'migrations', entry), { recursive: true });
  }

  console.log(`[p55-migration-test] starting embedded Postgres at ${DATABASE_URL}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const env = { DATABASE_URL, DIRECT_URL: DATABASE_URL };

  try {
    console.log('[p55-migration-test] applying every migration before P55');
    sh(`npx prisma migrate deploy --schema "${path.join(oldPrisma, 'schema.prisma')}"`, env);

    process.env.DATABASE_URL = DATABASE_URL;
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    console.log(`[p55-migration-test] seeding a populated pre-P55 database (${SALES} sales)`);
    const [branchA, branchB, admin, sup, ana, productPromo, productRegular, variantP, variantR, shift, promoAuto, promoSelected] = Array.from({ length: 12 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'admin@p55.test','x','super_admin','A','A','regular',false,now()),($2,'sup@p55.test','x','supervisor','S','S','regular',false,now()),
       ($3,'ana@p55.test','x','staff','Ana','Reyes','regular',false,now())`,
      admin, sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P55-N','x','x',now()),($2,'South','P55-S','x','x',now())`, branchA, branchB);
    for (const user of [sup, ana]) {
      await db.$executeRawUnsafe(`INSERT INTO user_branch_assignments (id, user_id, branch_id, assigned_at) VALUES ($1,$2,$3,now() - interval '400 days')`, randomUUID(), user, branchA);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO products (id, name, status, is_seasonal, classification, updated_at) VALUES ($1,'Promo Fries','active',false,'promotional',now()),($2,'Classic Fries','active',false,'regular',now())`,
      productPromo, productRegular,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',100,true,now()),($3,$4,'Regular','Regular',112,true,now())`,
      variantP, productPromo, variantR, productRegular,
    );
    // Supervisor-saved settings: organization Employee 15%, a North override with the required choice on.
    await db.$executeRawUnsafe(
      `INSERT INTO system_settings (id, key, value, updated_by, updated_at) VALUES ($1,'discount_policy',$2::jsonb,$5,now()),($3,$4,$6::jsonb,$5,now())`,
      randomUUID(),
      JSON.stringify({ pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 15, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } }),
      randomUUID(),
      `discount_policy:branch:${branchA}`,
      sup,
      JSON.stringify({ employee: { percentage: 10, isEnabled: true }, pwdPercentage: null, requireDiscountChoice: true }),
    );
    // Enabled promotions of both P49/P50R modes at North.
    await db.$executeRawUnsafe(
      `INSERT INTO promotions (id, name, discount_kind, discount_value, is_enabled, application_mode, created_by_id, updated_at) VALUES
       ($1,'Ten Off','fixed_amount',10,true,'automatic',$3,now()),($2,'Loyalty','percentage',10,true,'cashier_selected',$3,now())`,
      promoAuto, promoSelected, sup,
    );
    for (const promo of [promoAuto, promoSelected]) {
      await db.$executeRawUnsafe(`INSERT INTO promotion_branches (promotion_id, branch_id) VALUES ($1,$2)`, promo, branchA);
      await db.$executeRawUnsafe(`INSERT INTO promotion_products (promotion_id, product_id) VALUES ($1,$2)`, promo, productPromo);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`,
      shift, branchA, ana,
    );
    // Sales: ⅓ Employee 15%, ⅙ PWD (VAT-exempt, half with a proof key), ⅙ promotional, the rest plain.
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount,
                                 discount_type, discount_rate_used, discount_proof_key, discount_proof_type, discount_proof_uploaded_at, tax_snapshot, updated_at)
       SELECT gen_random_uuid(), 'PC-P55-' || g, $1, $2, $3, 'cash', 112,
              CASE WHEN g % 3 = 0 THEN 16.8 WHEN g % 6 = 1 THEN 20 WHEN g % 6 = 5 THEN 10 ELSE 0 END,
              CASE WHEN g % 3 = 0 THEN 10.2 WHEN g % 6 = 1 THEN 0 WHEN g % 6 = 5 THEN 10.93 ELSE 12 END, 0,
              CASE WHEN g % 3 = 0 THEN 95.2 WHEN g % 6 = 1 THEN 80 WHEN g % 6 = 5 THEN 102 ELSE 112 END,
              CASE WHEN g % 3 = 0 THEN 'employee' WHEN g % 6 = 1 THEN 'pwd' WHEN g % 6 = 5 THEN 'promotional' END,
              CASE WHEN g % 3 = 0 THEN 15 WHEN g % 6 = 1 THEN 20 END,
              CASE WHEN g % 12 = 1 THEN $1 || '/' || $2 || '/' || $3 || '-' || g || '-id.webp' END,
              CASE WHEN g % 12 = 1 THEN 'live_capture'::"ImageProofType" END,
              CASE WHEN g % 12 = 1 THEN now() END,
              CASE WHEN g % 4 = 0 THEN '{"version":1,"vat_rate_percent":12,"treatment":"vatable"}'::jsonb END,
              now()
       FROM generate_series(1, ${SALES}) g`,
      branchA, shift, ana,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO transaction_items (id, transaction_id, product_id, product_variant_id, product_name_snapshot, variant_name_snapshot, unit_price_snapshot, quantity, line_total, discount_amount, promotion_id, promotion_snapshot)
       SELECT gen_random_uuid(), t.id, $1, $2, 'Classic Fries', 'Regular', 112, 1, 112,
              CASE WHEN t.discount_type = 'promotional' THEN 10 ELSE 0 END,
              CASE WHEN t.discount_type = 'promotional' THEN $4 END,
              CASE WHEN t.discount_type = 'promotional' THEN '{"name":"Ten Off","unit_discount":10}'::jsonb END
       FROM transactions t WHERE t.branch_id = $3`,
      productRegular, variantR, branchA, promoAuto,
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
    const populated = Object.entries(before).filter(([, v]) => !v.startsWith('0:')).length;
    console.log(`  fingerprinted ${tables.length} tables (${populated} populated)`);
    await db.$disconnect();

    const { settingsService } = await import('../src/modules/settings/settings.service.js');
    const effective = async () => json({ north: await settingsService.getEffectiveDiscountPolicy(branchA), south: await settingsService.getEffectiveDiscountPolicy(branchB) });
    const settingsBefore = await effective();

    console.log('[p55-migration-test] applying the P55 migrations');
    const started = Date.now();
    sh('npx prisma migrate deploy', env);
    const migrationMs = Date.now() - started;

    const after = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const applied = await after.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name = ANY($1::text[])`,
      PENDING,
    );
    assert(applied.length === PENDING.length, 'both P55 migrations recorded as applied');
    const afterPrints = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterPrints[t]);
    assert(changed.length === 0, `all ${tables.length} pre-existing tables: pre-existing columns byte-identical (changed: ${changed.join(', ') || 'none'})`);
    assert((await effective()) === settingsBefore, 'effective discount policy at both branches identical (incl. North Employee 10% + required choice)');

    const [manualCols] = await after.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM transactions WHERE manual_discount_type_id IS NOT NULL OR manual_discount_snapshot IS NOT NULL OR discount_type = 'manual'`,
    );
    assert(manualCols?.n === 0n, 'no sale gains a manual discount (columns NULL, no discount_type "manual")');
    const [typeRows] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM manual_discount_types`);
    const [proofRows] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM discount_proof_uploads`);
    assert(typeRows?.n === 0n && proofRows?.n === 0n, 'no discount type invented from rates/promotions; no historical proof registered or moved');
    const [proofKeys] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM transactions WHERE discount_proof_key IS NOT NULL`);
    assert(Number(proofKeys?.n) === Math.floor((SALES + 11) / 12), `historical PWD proof keys intact (${proofKeys?.n})`);
    const [fk] = await after.$queryRawUnsafe<{ convalidated: boolean }[]>(`SELECT convalidated FROM pg_constraint WHERE conname = 'transactions_manual_discount_type_id_fkey'`);
    assert(fk?.convalidated === true, 'transactions → manual_discount_types FK validated');
    console.log(`  migration wall time: ${migrationMs} ms (includes prisma CLI start-up)`);

    console.log('[p55-migration-test] schema drift: migrated DB vs schema.prisma');
    sh(`npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, env);
    console.log('  OK: no drift');

    console.log('[p55-migration-test] promotion cutover inventory (read-only; the runbook query)');
    const inventory = await after.$queryRawUnsafe<{ application_mode: string; enabled: bigint; branches: bigint; products: bigint }[]>(
      `SELECT p.application_mode::text AS application_mode, count(DISTINCT p.id) AS enabled, count(DISTINCT pb.branch_id) AS branches, count(DISTINCT pp.product_id) AS products
       FROM promotions p LEFT JOIN promotion_branches pb ON pb.promotion_id = p.id LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
       WHERE p.is_enabled GROUP BY p.application_mode ORDER BY 1`,
    );
    console.log(`  ${json(inventory)}`);
    assert(inventory.length === 2 && inventory.every((r) => r.enabled === 1n), 'inventory finds 1 enabled automatic and 1 enabled cashier-selected promotion (left untouched)');

    console.log('[p55-migration-test] new tables usable on migrated data');
    const { manualDiscountTypesService } = await import('../src/modules/discounts/discounts.service.js');
    const supJwt = { user_id: sup, role: 'supervisor', email: 'sup@p55.test', branch_ids: [branchA], iat: 0, exp: 9_999_999_999 } as Parameters<typeof manualDiscountTypesService.create>[0];
    const created = await manualDiscountTypesService.create(supJwt, { branch_id: branchA, name: 'Employee', apply_to_pos: true, require_proof: false }, null);
    assert(created.is_active && created.sale_count === 0, 'supervisor creates a branch discount type on the migrated database');
    const pos = await manualDiscountTypesService.listForPos(branchA);
    assert(pos.length === 1 && (await manualDiscountTypesService.listForPos(branchB)).length === 0, 'POS offer list is branch-scoped');
    const [activeTypes] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM manual_discount_types WHERE is_active AND apply_to_pos`);
    const [manualSales] = await after.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM transactions WHERE discount_type = 'manual'`);
    assert(activeTypes?.n === 1n && manualSales?.n === 0n, 'rollback checks: 1 active POS type, 0 manual sales here');
    assert(json(await after.promotion.findMany({ select: { id: true, isEnabled: true, applicationMode: true }, orderBy: { id: 'asc' } })) ===
      json([{ id: promoAuto, isEnabled: true, applicationMode: 'automatic' }, { id: promoSelected, isEnabled: true, applicationMode: 'cashier_selected' }].sort((a, b) => a.id.localeCompare(b.id))),
      'promotions unchanged by creating discount types');

    await after.$disconnect();
    console.log('[p55-migration-test] PASS');
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
