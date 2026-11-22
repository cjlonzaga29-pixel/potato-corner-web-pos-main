/* eslint-disable no-console -- CLI: the report on stdout is the whole point. */
// POS-PERF-P68 — diagnosis and exact-ID repair of leftover branch login accounts
// (role `branch`, no live branch assignment) that still hold an email.
// Read docs/runbooks/pos-perf-p68-branch-lifecycle-and-staff.md §2 before
// pointing this at any non-local database. Nothing runs automatically.
//
// Usage (from apps/api):
//   npx tsx scripts/p68-leftover-branch-account-repair.ts --diagnose --database-host <host>
//   npx tsx scripts/p68-leftover-branch-account-repair.ts --manifest <file.json> --database-host <host>
//   npx tsx scripts/p68-leftover-branch-account-repair.ts --manifest <file.json> --database-host <host> --execute --confirm <token>
//
// --database-host must equal the DATABASE_URL host (printed; credentials never are).
// --confirm is the token the dry run printed for this exact manifest and host.
import 'dotenv/config';
import { readFileSync } from 'node:fs';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const expectedHost = arg('database-host');
  const manifestPath = arg('manifest');
  const diagnose = process.argv.includes('--diagnose');
  const execute = process.argv.includes('--execute');
  const confirm = arg('confirm');
  if (!expectedHost || (!diagnose && !manifestPath)) {
    console.error(
      'Usage: --database-host <host> (--diagnose | --manifest <file.json> [--execute --confirm <token>])',
    );
    return 2;
  }
  let host: string;
  try {
    host = new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    console.error('Refusing: DATABASE_URL is missing or not a URL');
    return 2;
  }
  console.log(`Target database host: ${host}`);
  if (host !== expectedHost) {
    console.error(`Refusing: --database-host ${expectedHost} does not match the DATABASE_URL host`);
    return 2;
  }

  const lib = await import('../src/modules/branches/leftover-branch-account-repair.js');
  const { prisma } = await import('../src/lib/prisma.js');
  try {
    if (diagnose) {
      const candidates = await lib.diagnoseLeftoverBranchAccounts();
      console.log(JSON.stringify({ mode: 'diagnose', candidates }, null, 2));
      console.log(
        `\n${candidates.length} candidate(s). Read-only: nothing changed. Review each one before listing it in a manifest.`,
      );
      return 0;
    }
    const manifestText = readFileSync(manifestPath as string, 'utf8');
    const parsed = lib.leftoverRepairManifestSchema.safeParse(JSON.parse(manifestText));
    if (!parsed.success) {
      console.error('Refusing: manifest is invalid', parsed.error.issues);
      return 2;
    }
    const token = lib.repairConfirmationToken(manifestText, host);
    if (execute && confirm !== token) {
      console.error(
        'Refusing: --confirm does not match this manifest and host. Run the dry run and review it first.',
      );
      return 2;
    }
    const report = await lib.runLeftoverRepair(parsed.data, { execute, token });
    console.log(JSON.stringify(report, null, 2));
    if (!execute)
      console.log(
        `\nDry run only — nothing changed. To execute this exact manifest: --execute --confirm ${token}`,
      );
    return report.actor.ok && !report.accounts.some((a) => a.outcome === 'refused') ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
