// POS-PERF-P15R3 — starts a disposable local Postgres and keeps it running
// (prints DATABASE_URL, then idles) so a dev session (api + web servers,
// Playwright) can point at it for as long as this process stays alive.
// Ctrl-C / kill to tear down.
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import os from 'node:os';

const DB_DIR = process.env.TEST_PG_DATA_DIR || path.join(os.tmpdir(), 'pos-dev-pg');
const PORT = Number(process.env.TEST_PG_PORT || 55999);
const DB_NAME = 'pos_dev';
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;

const pg = new EmbeddedPostgres({ databaseDir: DB_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });

async function main() {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME).catch(() => {}); // already exists on a restart against the same dir
  console.log(`DATABASE_URL=${DATABASE_URL}`);
  console.log('[dev-local-postgres] ready — leave this running, Ctrl-C to stop');
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  await new Promise(() => {}); // idle forever until signalled
}

async function shutdown() {
  console.log('[dev-local-postgres] stopping...');
  await pg.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error('[dev-local-postgres] failed:', error);
  process.exitCode = 1;
});
