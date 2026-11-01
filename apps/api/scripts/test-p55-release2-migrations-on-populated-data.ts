// POS-PERF-P55 Release 2 — populated upgrade rehearsal for the migrations
// production actually lacks: everything after the deployed Release 1
// (44c2099, last migration 20261030190000_pos_perf_p52_payroll), applied in
// one `migrate deploy`, as the cutover does. The two older rehearsals
// (test-p55-…, test-p55r2-…) each cover a subset from an intermediate state
// that never existed in production.
//
// Part A — Release 1 state + populated data → all five migrations:
//   pre-existing columns byte-identical, nothing backfilled (no sale gains a
//   manual discount or a calculation mode), FK and CHECK validated, the
//   partial unique name index present and enforced, no schema drift.
// Part B — duplicate active names (only possible where the first P55
//   migrations ran without 20261101120200): the runbook §12.5 pre-check finds
//   them, the migration fails as designed, and after a supervisor-style
//   deactivation + `migrate resolve --rolled-back` it applies; a deactivated
//   duplicate and the same name at another branch stay.
//
// Disposable embedded Postgres on 127.0.0.1 only. Usage (from apps/api, with
// the app's required env vars set to throwaway values):
//   npx tsx scripts/test-p55-release2-migrations-on-populated-data.ts
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.join(__dirname, '..', 'prisma');
const RELEASE_1_LAST = '20261030190000_pos_perf_p52_payroll';
const PENDING = [
  '20261101120000_pos_perf_p55_manual_discounts',
  '20261101120100_pos_perf_p55_validate_fks',
  '20261101120200_pos_perf_p55_manual_discount_type_unique_name',
  '20261101130000_pos_perf_p55r2_calculation_mode',
  '20261101130100_pos_perf_p55r2_validate_calculation_mode',
];
const UNIQUE_NAME = PENDING[2] as string;
const SALES = Number(process.env.P55_REHEARSAL_SALES || 20000);

const workDir = path.join(os.tmpdir(), `pos-p55-release2-migration-${randomUUID().slice(0, 8)}`);
const PORT = 47000 + Math.floor(Math.random() * 100);
const stamp = Date.now();
const DB_A = `p55rel2_${stamp}_a`;
const DB_B = `p55rel2_${stamp}_b`;
const urlFor = (db: string) => `postgresql://postgres:postgres@127.0.0.1:${PORT}/${db}`;
for (const db of [DB_A, DB_B]) {
  if (!/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:470\d{2}\/p55rel2_\d+_[ab]$/.test(urlFor(db))) throw new Error('refusing a non-local database');
}
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

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** A copy of the migrations folder holding every migration except `exclude` (the repo's own folder is never moved). */
function prismaCopy(name: string, exclude: string[]): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(prismaDir, 'schema.prisma'), path.join(dir, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(prismaDir, 'migrations'))) {
    if (exclude.includes(entry)) continue;
    fs.cpSync(path.join(prismaDir, 'migrations', entry), path.join(dir, 'migrations', entry), { recursive: true });
  }
  return path.join(dir, 'schema.prisma');
}

async function main() {
  const migrations = fs.readdirSync(path.join(prismaDir, 'migrations')).filter((e) => /^\d{14}_/.test(e)).sort();
  const pendingFromFolder = migrations.slice(migrations.indexOf(RELEASE_1_LAST) + 1);
  assert(migrations.includes(RELEASE_1_LAST) && json(pendingFromFolder) === json(PENDING), `pending after Release 1 is exactly the five P55 + P55R2 migrations, in order`);

  await pg.initialise();
  await pg.start();
  const { PrismaClient } = await import('@prisma/client');
  type Db = InstanceType<typeof PrismaClient>;

  try {
    // ── Part A ─────────────────────────────────────────────────────────────
    console.log(`[p55-release2-migration-test] A: Release 1 state at 127.0.0.1:${PORT}/${DB_A}`);
    await pg.createDatabase(DB_A);
    const envA = { DATABASE_URL: urlFor(DB_A), DIRECT_URL: urlFor(DB_A) };
    sh(`npx prisma migrate deploy --schema "${prismaCopy('prisma-release1', PENDING)}"`, envA);
    process.env.DATABASE_URL = urlFor(DB_A);
    const db: Db = new PrismaClient({ datasources: { db: { url: urlFor(DB_A) } } });

    console.log(`[p55-release2-migration-test] seeding ${SALES} sales`);
    const [branchA, branchB, sup, ana, product, variant, shift, promo] = Array.from({ length: 8 }, () => randomUUID());
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES
       ($1,'sup@p55.test','x','supervisor','S','S','regular',false,now()),($2,'ana@p55.test','x','staff','Ana','Reyes','regular',false,now())`,
      sup, ana,
    );
    await db.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P55-N','x','x',now()),($2,'South','P55-S','x','x',now())`, branchA, branchB);
    await db.$executeRawUnsafe(`INSERT INTO products (id, name, status, is_seasonal, classification, updated_at) VALUES ($1,'Classic Fries','active',false,'regular',now())`, product);
    await db.$executeRawUnsafe(`INSERT INTO product_variants (id, product_id, name, size_label, base_price, is_active, updated_at) VALUES ($1,$2,'Regular','Regular',112,true,now())`, variant, product);
    await db.$executeRawUnsafe(
      `INSERT INTO promotions (id, name, discount_kind, discount_value, is_enabled, application_mode, created_by_id, updated_at) VALUES ($1,'Ten Off','fixed_amount',10,true,'automatic',$2,now())`,
      promo, sup,
    );
    await db.$executeRawUnsafe(`INSERT INTO shifts (id, branch_id, cashier_id, opened_by, status, opening_cash_amount, started_at) VALUES ($1,$2,$3,$3,'active',0,now())`, shift, branchA, ana);
    // ⅓ Employee 15%, ⅙ PWD (VAT-exempt, half with a proof key), ⅙ promotional, the rest plain.
    await db.$executeRawUnsafe(
      `INSERT INTO transactions (id, transaction_number, branch_id, shift_id, cashier_id, payment_method, subtotal, discount_amount, vat_amount, vat_exempt_amount, total_amount,
                                 discount_type, discount_rate_used, discount_proof_key, discount_proof_type, discount_proof_uploaded_at, tax_snapshot, updated_at)
       SELECT gen_random_uuid(), 'PC-P55R-' || g, $1, $2, $3, 'cash', 112,
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
              CASE WHEN t.discount_type = 'promotional' THEN $3 END,
              CASE WHEN t.discount_type = 'promotional' THEN '{"name":"Ten Off","unit_discount":10}'::jsonb END
       FROM transactions t`,
      product, variant, promo,
    );

    type Col = { table_name: string; columns: string[] };
    const tables = await db.$queryRawUnsafe<Col[]>(
      `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' GROUP BY table_name ORDER BY table_name`,
    );
    const fingerprint = async (client: Db) => {
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
    console.log(`  fingerprinted ${tables.length} tables (${Object.values(before).filter((v) => !v.startsWith('0:')).length} populated)`);
    await db.$disconnect();

    console.log('[p55-release2-migration-test] A: applying all pending migrations in one deploy');
    const started = Date.now();
    sh('npx prisma migrate deploy', envA);
    const migrationMs = Date.now() - started;

    const after: Db = new PrismaClient({ datasources: { db: { url: urlFor(DB_A) } } });
    const applied = await after.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name = ANY($1::text[]) ORDER BY finished_at, migration_name`,
      PENDING,
    );
    assert(json(applied.map((r) => r.migration_name)) === json(PENDING), 'all five recorded as applied, in order');
    const afterPrints = await fingerprint(after);
    const changed = Object.keys(before).filter((t) => before[t] !== afterPrints[t]);
    assert(changed.length === 0, `all ${tables.length} pre-existing tables: pre-existing columns byte-identical (changed: ${changed.join(', ') || 'none'})`);
    const [untouched] = await after.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM transactions WHERE calculation_mode IS NOT NULL OR manual_discount_type_id IS NOT NULL OR manual_discount_snapshot IS NOT NULL OR discount_type = 'manual'`,
    );
    assert(untouched?.n === 0n, 'no existing sale gains a calculation mode or a manual discount (NULL = recorded before P55R2, VAT-calculated)');
    const [newRows] = await after.$queryRawUnsafe<{ types: bigint; proofs: bigint }[]>(
      `SELECT (SELECT count(*) FROM manual_discount_types) AS types, (SELECT count(*) FROM discount_proof_uploads) AS proofs`,
    );
    assert(newRows?.types === 0n && newRows?.proofs === 0n, 'no discount type invented; no historical proof registered or moved');
    const constraints = await after.$queryRawUnsafe<{ conname: string; convalidated: boolean }[]>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('transactions_manual_discount_type_id_fkey', 'transactions_calculation_mode_check') ORDER BY conname`,
    );
    assert(constraints.length === 2 && constraints.every((c) => c.convalidated), 'manual-discount FK and calculation-mode CHECK both validated');
    const [index] = await after.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'manual_discount_types_branch_active_name_key'`);
    assert(/UNIQUE INDEX .*\(branch_id, lower\(name\)\) WHERE is_active/.test(index?.indexdef ?? ''), 'partial unique (branch_id, lower(name)) WHERE is_active index present');
    const insertType = (client: Db, branch: string, name: string, active = true) =>
      client.$executeRawUnsafe(
        `INSERT INTO manual_discount_types (id, branch_id, name, is_active, created_by_id, updated_at) VALUES ($1, $2, $3, $4, $5, now())`,
        randomUUID(), branch, name, active, sup,
      );
    await insertType(after, branchA, 'Employee');
    let refused = false;
    try {
      await insertType(after, branchA, 'EMPLOYEE');
    } catch {
      refused = true;
    }
    assert(refused, 'a second active "EMPLOYEE" at the same branch is refused');
    await insertType(after, branchB, 'Employee');
    await insertType(after, branchA, 'employee', false);
    assert(true, 'the same name at another branch, and an inactive duplicate, are allowed');
    console.log(`  migration wall time: ${migrationMs} ms for ${SALES} sales (includes prisma CLI start-up)`);
    await after.$disconnect();
    sh(`npx prisma migrate diff --from-url "${urlFor(DB_A)}" --to-schema-datamodel prisma/schema.prisma --exit-code`, envA);
    console.log('  OK: no drift');

    // ── Part B ─────────────────────────────────────────────────────────────
    console.log(`[p55-release2-migration-test] B: active duplicates before ${UNIQUE_NAME} at 127.0.0.1:${PORT}/${DB_B}`);
    await pg.createDatabase(DB_B);
    const envB = { DATABASE_URL: urlFor(DB_B), DIRECT_URL: urlFor(DB_B) };
    sh(`npx prisma migrate deploy --schema "${prismaCopy('prisma-first-pass', PENDING.slice(2))}"`, envB);
    const dupDb: Db = new PrismaClient({ datasources: { db: { url: urlFor(DB_B) } } });
    await dupDb.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, role, first_name, last_name, employment_type, must_change_password, updated_at) VALUES ($1,'sup@p55.test','x','supervisor','S','S','regular',false,now())`,
      sup,
    );
    await dupDb.$executeRawUnsafe(`INSERT INTO branches (id, name, code, address, city, updated_at) VALUES ($1,'North','P55-N','x','x',now()),($2,'South','P55-S','x','x',now())`, branchA, branchB);
    for (const [branch, name, active] of [[branchA, 'Employee', true], [branchA, 'EMPLOYEE', true], [branchA, 'employee', false], [branchB, 'Employee', true], [branchA, 'Rider', true]] as const) {
      await insertType(dupDb, branch, name, active);
    }
    const precheck = await dupDb.$queryRawUnsafe<{ branch_id: string; lower: string; count: bigint }[]>(
      `SELECT branch_id, lower(name), count(*) FROM manual_discount_types WHERE is_active GROUP BY 1, 2 HAVING count(*) > 1;`,
    );
    assert(precheck.length === 1 && precheck[0]?.branch_id === branchA && precheck[0]?.lower === 'employee' && precheck[0]?.count === 2n, 'runbook §12.5 pre-check finds exactly the North "employee" pair');
    let failed = false;
    try {
      execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, ...envB } });
    } catch (error) {
      const out = `${(error as { stdout?: Buffer }).stdout ?? ''}${(error as { stderr?: Buffer }).stderr ?? ''}`;
      failed = /P3018/.test(out) && out.includes(UNIQUE_NAME);
      console.log(`  deploy output: ${(out.match(/P3018[^\n]*/) ?? ['(no P3018 line)'])[0]}`);
    }
    assert(failed, `${UNIQUE_NAME} fails with P3018 while active duplicates exist (nothing after it applied)`);
    const [later] = await dupDb.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'calculation_mode'`,
    );
    assert(later?.n === 0n, 'the P55R2 migrations did not run after the failure');
    await dupDb.$executeRawUnsafe(
      `UPDATE manual_discount_types SET is_active = false, deactivated_at = now(), deactivated_by_id = $1 WHERE branch_id = $2 AND name = 'EMPLOYEE'`,
      sup, branchA,
    );
    sh(`npx prisma migrate resolve --rolled-back ${UNIQUE_NAME}`, envB);
    sh('npx prisma migrate deploy', envB);
    const kept = await dupDb.$queryRawUnsafe<{ branch: string; name: string; is_active: boolean }[]>(
      `SELECT CASE WHEN branch_id = $1 THEN 'N' ELSE 'S' END AS branch, name, is_active FROM manual_discount_types`,
      branchA,
    );
    // Sorted here, not by the cluster's collation (case order differs by locale).
    const key = (r: (typeof kept)[number]) => `${r.branch}|${r.name}`;
    kept.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    assert(
      json(kept) === json([{ branch: 'N', name: 'EMPLOYEE', is_active: false }, { branch: 'N', name: 'Employee', is_active: true }, { branch: 'N', name: 'Rider', is_active: true }, { branch: 'N', name: 'employee', is_active: false }, { branch: 'S', name: 'Employee', is_active: true }]),
      'after deactivating the extra: applied; every type kept (2 inactive duplicates, the South "Employee", "Rider")',
    );
    await dupDb.$disconnect();
    sh(`npx prisma migrate diff --from-url "${urlFor(DB_B)}" --to-schema-datamodel prisma/schema.prisma --exit-code`, envB);
    console.log('  OK: no drift');
    console.log('[p55-release2-migration-test] PASS');
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
