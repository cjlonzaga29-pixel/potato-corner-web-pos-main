import type { InitializationEntityType, InitializationRecord, InitializationRun } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { validateManifestNoDuplicateKeys } from './manifest-entry-key.js';
import { markDryRunValidated } from './run-lifecycle.service.js';
import { createDryRunRecord } from './record-writer.service.js';

/**
 * CR-009 R7 "Dry-run integration contract" — the narrow write path a dry-run
 * execution uses. Per CR-009.2's corrected lifecycle model, dry-run is NOT a
 * no-write operation: it durably creates the `InitializationRun` row and one
 * `VALIDATED` / `entityId = null` / `version = 1` `InitializationRecord` row
 * per manifest entry, then transitions the run to `DRY_RUN_VALIDATED`.
 *
 * This module composes R3 (`validateManifestNoDuplicateKeys`), R4
 * (`markDryRunValidated`), and R5 (`createDryRunRecord`) — it reimplements
 * none of their logic.
 *
 * Sequence:
 *   1. Validate no duplicate manifestEntryKeys — before any DB access at all.
 *   2. Insert the InitializationRun row (status PLANNED, version 1). This
 *      task owns the initial insert; R4's run-lifecycle.service.ts only
 *      implements transitions of an existing row.
 *   3. In a single prisma.$transaction, call createDryRunRecord once per
 *      manifest entry. All entries succeed together or the whole batch rolls
 *      back together.
 *   4. Only after step 3 commits, transition PLANNED -> DRY_RUN_VALIDATED via
 *      markDryRunValidated. R4's transition functions use the shared root
 *      `prisma` client internally (not a caller-supplied `tx`), so this
 *      cannot be folded into step 3's transaction — it is a deliberate,
 *      accepted separate call.
 *
 * KNOWN LIMITATION (documented, not solved by this task): if step 3 fails
 * (e.g. a duplicate-key race against a concurrent identical dry-run, or a DB
 * error), the run row created in step 2 is left stuck in PLANNED with zero
 * records, and is never transitioned to a failure state — R4's transition
 * table has no PLANNED -> (failure) arrow. This task does not invent one;
 * see the R7 task brief for the accepted rationale.
 */

export interface DryRunManifestEntry {
  manifestEntryKey: string;
  entityType: InitializationEntityType;
}

export interface RecordDryRunRunParams {
  migrationBatch: string;
  initializationType: 'REFERENCE_DATA';
  manifestVersion: number;
  manifestFingerprint: string;
  manifestSnapshot: Prisma.InputJsonValue;
  targetEnvironment: string;
  initiatedBy: string;
  dryRunReportFingerprint: string;
  manifestEntries: DryRunManifestEntry[];
}

export interface RecordDryRunRunResult {
  run: InitializationRun;
  records: InitializationRecord[];
}

export async function recordDryRunRun(params: RecordDryRunRunParams): Promise<RecordDryRunRunResult> {
  const {
    migrationBatch,
    initializationType,
    manifestVersion,
    manifestFingerprint,
    manifestSnapshot,
    targetEnvironment,
    initiatedBy,
    dryRunReportFingerprint,
    manifestEntries,
  } = params;

  // Step 1: reject duplicate manifest keys before ANY database write.
  validateManifestNoDuplicateKeys(manifestEntries);

  // Step 2: insert the InitializationRun row directly.
  const createdRun = await prisma.initializationRun.create({
    data: {
      migrationBatch,
      initializationType,
      manifestVersion,
      manifestFingerprint,
      manifestSnapshot,
      targetEnvironment,
      executionMode: 'DRY_RUN',
      status: 'PLANNED',
      initiatedBy,
      dryRunReportFingerprint,
      version: 1,
    },
  });

  // Step 3: create every manifest entry's InitializationRecord row, all
  // inside one transaction — all-or-nothing.
  const records = await prisma.$transaction((tx) =>
    Promise.all(
      manifestEntries.map((entry) =>
        createDryRunRecord(tx, {
          runId: createdRun.id,
          manifestEntryKey: entry.manifestEntryKey,
          entityType: entry.entityType,
        }),
      ),
    ),
  );

  // Step 4: only after step 3 commits, transition PLANNED -> DRY_RUN_VALIDATED.
  const validatedRun = await markDryRunValidated({ runId: createdRun.id, expectedVersion: 1 });

  return { run: validatedRun, records };
}
