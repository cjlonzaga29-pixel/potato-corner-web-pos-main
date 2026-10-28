// POS-PERF-P44 — shared refusal for the fixture scripts that open their own
// PrismaClient and write rows directly (p37/p38/p38r/p39r2, seed-legacy-movement,
// seed-shared-branch-product). Those scripts run with cwd apps/api, where
// @prisma/client would otherwise pick up whatever apps/api/.env points at.
//
// Loads apps/api/.env exactly as Prisma would (process env wins, the file
// never overrides it), then refuses unless every database/storage URL that is
// set points at 127.0.0.1 or localhost. Prints variable names only, never values.
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', '..', '..', 'apps', 'api');
const CHECKED = ['DATABASE_URL', 'DIRECT_URL', 'SUPABASE_URL'];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLocal(raw) {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function assertLocalDatabase(env = process.env, { loadDotenv = true } = {}) {
  if (loadDotenv) {
    require(path.join(API_DIR, 'node_modules', 'dotenv')).config({ path: path.join(API_DIR, '.env'), quiet: true });
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set — refusing to run a direct-database fixture');
  for (const name of CHECKED) {
    const value = env[name];
    if (value && !isLocal(value)) throw new Error(`${name} is not local (127.0.0.1/localhost) — refusing to run a direct-database fixture`);
  }
}

module.exports = { assertLocalDatabase, isLocal };
