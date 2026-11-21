/* eslint-disable no-console -- CLI: the report on stdout is the whole point. */
// POS-PERF-P64 — exact-ID cleanup of confirmed E2E / smoke fixture accounts.
// Dry run by default. See docs/runbooks/pos-perf-p64-account-removal-and-dashboard-cleanup.md §4
// before pointing this at any non-local database.
//
// Usage (from apps/api):
//   npx tsx scripts/p64-fixture-account-cleanup.ts --manifest <file.json> --database-host <host>
//   npx tsx scripts/p64-fixture-account-cleanup.ts --manifest <file.json> --database-host <host> --execute --confirm <token>
//
// --database-host must equal the host in DATABASE_URL (it is printed, the
// credentials never are). --confirm is the token the dry run printed for this
// exact manifest and host, so only a reviewed manifest can execute.
import 'dotenv/config';
import { readFileSync } from 'node:fs';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const manifestPath = arg('manifest');
  const expectedHost = arg('database-host');
  const execute = process.argv.includes('--execute');
  const confirm = arg('confirm');
  if (!manifestPath || !expectedHost) {
    console.error('Usage: --manifest <file.json> --database-host <host> [--execute --confirm <token>]');
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    console.error('Refusing: DATABASE_URL is missing or not a URL');
    return 2;
  }
  console.log(`Target database host: ${host}`);
  if (host !== expectedHost) {
    console.error(`Refusing: --database-host ${expectedHost} does not match the DATABASE_URL host`);
    return 2;
  }

  const manifestText = readFileSync(manifestPath, 'utf8');
  const { fixtureCleanupManifestSchema, runFixtureCleanup, confirmationToken } = await import(
    '../src/modules/employees/fixture-account-cleanup.js'
  );
  const parsed = fixtureCleanupManifestSchema.safeParse(JSON.parse(manifestText));
  if (!parsed.success) {
    console.error('Refusing: manifest is invalid', parsed.error.issues);
    return 2;
  }
  const token = confirmationToken(manifestText, host);
  if (execute && confirm !== token) {
    console.error('Refusing: --confirm does not match this manifest and host. Run the dry run and review it first.');
    return 2;
  }

  const report = await runFixtureCleanup(parsed.data, { execute, token });
  console.log(JSON.stringify(report, null, 2));
  if (!execute) console.log(`\nDry run only — nothing changed. To execute this exact manifest: --execute --confirm ${token}`);
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$disconnect();
  const failed = report.accounts.some((a) => a.outcome === 'failed') || !report.actor.ok;
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
