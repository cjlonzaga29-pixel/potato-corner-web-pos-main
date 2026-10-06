// POS-PERF-P15R3 — disposable, non-production Postgres for integration
// tests, using `embedded-postgres` (a real Postgres binary, run as the
// current user, no admin elevation, no Docker). Applies every migration,
// then runs whatever command is passed on the command line with
// DATABASE_URL/TEST_DATABASE_URL pointed at it, then tears the cluster down.
//
// Usage (from apps/api):
//   npx tsx scripts/with-test-postgres.ts "npx vitest run src/modules/transactions/checkout-worker.integration.test.ts"
import EmbeddedPostgres from 'embedded-postgres';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DB_DIR = process.env.TEST_PG_DATA_DIR || path.join(os.tmpdir(), `pos-test-pg-${randomUUID().slice(0, 8)}`);
// Randomized per run (unless explicitly pinned via TEST_PG_PORT) so a
// previous run's not-yet-released port binding can never collide with this
// one and hang pg_ctl's startup wait.
const PORT = Number(process.env.TEST_PG_PORT || 40000 + Math.floor(Math.random() * 20000));
const DB_NAME = 'pos_test';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

const command = process.argv.slice(2).join(' ');
if (!command) {
  console.error('Usage: npx tsx scripts/with-test-postgres.ts "<command>"');
  process.exit(1);
}

/**
 * Runs `cmd` with stdout/stderr actively drained and filtered line-by-line
 * in this process, instead of `stdio: 'inherit'`. The repo's non-production
 * Prisma client logs every single query (apps/api/src/lib/prisma.ts), which
 * floods stdout under this suite's concurrent-checkout tests; piping
 * straight through to this tool's own output-capture file was observed to
 * stall the child process indefinitely under Windows/Git Bash — classic
 * pipe backpressure, nothing draining the pipe fast enough. Reading and
 * discarding noisy lines ourselves guarantees the pipe never backs up,
 * regardless of how the parent shell captures this script's own output.
 */
function runFiltered(cmd, env) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${cmd}`);
    const child = spawn(cmd, { env: { ...process.env, ...env }, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => {
        if (/^prisma:query/.test(line)) return;
        console.log(line);
      });
    }
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  console.log(`[with-test-postgres] starting embedded Postgres at ${DATABASE_URL} (data dir ${DB_DIR})`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);

  const env = { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL, TEST_DATABASE_URL: DATABASE_URL };
  try {
    console.log('[with-test-postgres] applying migrations (prisma migrate deploy)');
    execSync('npx prisma migrate deploy', { stdio: 'inherit', env });
    console.log(`[with-test-postgres] running: ${command}`);
    await runFiltered(command, env);
  } finally {
    console.log('[with-test-postgres] stopping embedded Postgres');
    try {
      await pg.stop();
    } catch (error) {
      // Windows occasionally still holds a file handle in the data dir for
      // a moment after the postgres process exits, so `stop()`'s own
      // rmdir cleanup (non-persistent mode) can fail with EBUSY/ENOTEMPTY
      // even though postgres itself shut down cleanly. Cosmetic only — the
      // dir is in the OS temp folder and gets cleaned up eventually either
      // way; never let it mask a real test failure as a script failure.
      console.warn('[with-test-postgres] non-fatal cleanup error:', error?.message ?? error);
    }
  }
}

main().catch((error) => {
  console.error('[with-test-postgres] failed:', error);
  process.exitCode = 1;
});
