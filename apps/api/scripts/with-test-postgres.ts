// POS-PERF-P15R3 — disposable, non-production Postgres for integration
// tests, using `embedded-postgres` (a real Postgres binary, run as the
// current user, no admin elevation, no Docker). Applies every migration,
// then runs whatever command is passed on the command line with
// DATABASE_URL/TEST_DATABASE_URL pointed at it, then tears the cluster down.
//
// Exit status (P62): the wrapped command's own code, 128+n if it was killed by
// a signal, 1 if setup or migrations fail, and 1 if Postgres could not be
// stopped (or stop() timed out) after an otherwise passing run. It never exits
// 0 unless the run finished with 0 (P65). See scripts/lib/test-postgres-run.ts
// for why the script must call process.exit itself.
//
// Usage (from apps/api):
//   npx tsx scripts/with-test-postgres.ts "npx vitest run src/modules/transactions/checkout-worker.integration.test.ts"
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exitProcessWith, runFiltered, runWithCluster } from './lib/test-postgres-run';

const DB_DIR = process.env.TEST_PG_DATA_DIR || path.join(os.tmpdir(), `pos-test-pg-${randomUUID().slice(0, 8)}`);
// Randomized per run (unless explicitly pinned via TEST_PG_PORT) so a
// previous run's not-yet-released port binding can never collide with this
// one and hang pg_ctl's startup wait.
const PORT = Number(process.env.TEST_PG_PORT || 40000 + Math.floor(Math.random() * 20000));
const DB_NAME = 'pos_test';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

const command = process.argv.slice(2).join(' ');
if (!command) {
  console.error('Usage: npx tsx scripts/with-test-postgres.ts "<command>"');
  process.exit(1);
}

const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

const env = { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL, TEST_DATABASE_URL: DATABASE_URL };

console.log(`[with-test-postgres] starting embedded Postgres at ${DATABASE_URL} (data dir ${DB_DIR})`);
exitProcessWith(runWithCluster({
  cluster: pg,
  dbName: DB_NAME,
  migrate: () => { execSync('npx prisma migrate deploy', { stdio: 'inherit', env }); },
  runCommand: () => {
    console.log(`[with-test-postgres] running: ${command}`);
    return runFiltered(command, env);
  },
}));
