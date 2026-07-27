import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * CR-009 R7 "Dry-run integration contract" — integration tests against the
 * real dev database, same rationale as R4/R5/R6: this composes R3's
 * duplicate-key validation, R4's `markDryRunValidated` CAS transition, and
 * R5's `createDryRunRecord` insert, none of which are meaningfully
 * unit-testable against a mock (real Postgres unique constraints, real CAS
 * row-count semantics).
 *
 * Gated on TEST_DATABASE_URL alone (NOT `&& TEST_REDIS_URL`) — this module
 * has no Redis dependency, matching R4/R5/R6's precedent.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { prisma } = await import('../../lib/prisma.js');
const { recordDryRunRun } = await import('./dry-run-contract.js');

describe.skipIf(!canRunIntegrationTests)('recordDryRunRun integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];
  const createdMigrationBatches: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r7-dry-run-contract-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R7',
        lastName: 'Dry Run Contract Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // InitializationRecord rows first (children), then runs, then the user
    // — same FK-restrict-safe cleanup order as R4/R5's suites.
    await prisma.initializationRecord.deleteMany({ where: { initializationRunId: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.initializationRun.deleteMany({ where: { migrationBatch: { in: createdMigrationBatches } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function baseParams(overrides: { migrationBatch: string; manifestEntries: { manifestEntryKey: string; entityType: 'INVENTORY_CATEGORY' | 'UNIT_OF_MEASURE' | 'UNIT_CONVERSION' }[] }) {
    return {
      migrationBatch: overrides.migrationBatch,
      initializationType: 'REFERENCE_DATA' as const,
      manifestVersion: 1,
      manifestFingerprint: `fp-${randomUUID()}`,
      manifestSnapshot: { entries: overrides.manifestEntries },
      targetEnvironment: 'test',
      initiatedBy: userId,
      dryRunReportFingerprint: `report-fp-${randomUUID()}`,
      manifestEntries: overrides.manifestEntries,
    };
  }

  it('creates one InitializationRun in DRY_RUN_VALIDATED and exactly N InitializationRecord rows, each VALIDATED/entityId=null/version=1', async () => {
    const migrationBatch = `r7-test-${randomUUID()}`;
    createdMigrationBatches.push(migrationBatch);
    const manifestEntries = [
      { manifestEntryKey: `entry-a-${randomUUID()}`, entityType: 'INVENTORY_CATEGORY' as const },
      { manifestEntryKey: `entry-b-${randomUUID()}`, entityType: 'UNIT_OF_MEASURE' as const },
      { manifestEntryKey: `entry-c-${randomUUID()}`, entityType: 'UNIT_CONVERSION' as const },
    ];

    const { run, records } = await recordDryRunRun(baseParams({ migrationBatch, manifestEntries }));
    createdRunIds.push(run.id);

    expect(run.status).toBe('DRY_RUN_VALIDATED');
    expect(run.migrationBatch).toBe(migrationBatch);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.action).toBe('VALIDATED');
      expect(record.entityId).toBeNull();
      expect(record.version).toBe(1);
    }

    const runRows = await prisma.initializationRun.findMany({ where: { migrationBatch } });
    expect(runRows).toHaveLength(1);
    expect(runRows.at(0)?.status).toBe('DRY_RUN_VALIDATED');

    const recordRows = await prisma.initializationRecord.findMany({ where: { initializationRunId: run.id } });
    expect(recordRows).toHaveLength(3);
  });

  it('rejects duplicate manifest keys before any row is created', async () => {
    const migrationBatch = `r7-dup-test-${randomUUID()}`;
    const sharedKey = `entry-dup-${randomUUID()}`;
    const manifestEntries = [
      { manifestEntryKey: sharedKey, entityType: 'INVENTORY_CATEGORY' as const },
      { manifestEntryKey: sharedKey, entityType: 'UNIT_OF_MEASURE' as const },
    ];

    await expect(recordDryRunRun(baseParams({ migrationBatch, manifestEntries }))).rejects.toThrow(/duplicate/i);

    // Zero rows created for this attempt — migrationBatch is unique to this
    // test, so any row found here proves the pre-write check let something
    // through.
    const runRows = await prisma.initializationRun.findMany({ where: { migrationBatch } });
    expect(runRows).toHaveLength(0);
  });

  it('a duplicate migrationBatch across two calls is rejected at insert (DB-level unique constraint)', async () => {
    const migrationBatch = `r7-collision-test-${randomUUID()}`;
    createdMigrationBatches.push(migrationBatch);
    const firstEntries = [{ manifestEntryKey: `entry-${randomUUID()}`, entityType: 'INVENTORY_CATEGORY' as const }];
    const secondEntries = [{ manifestEntryKey: `entry-${randomUUID()}`, entityType: 'UNIT_OF_MEASURE' as const }];

    const { run } = await recordDryRunRun(baseParams({ migrationBatch, manifestEntries: firstEntries }));
    createdRunIds.push(run.id);

    await expect(recordDryRunRun(baseParams({ migrationBatch, manifestEntries: secondEntries }))).rejects.toThrow();

    const runRows = await prisma.initializationRun.findMany({ where: { migrationBatch } });
    expect(runRows).toHaveLength(1);
  });
});
