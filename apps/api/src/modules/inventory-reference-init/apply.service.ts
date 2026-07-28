import { prisma } from '../../lib/prisma.js';
import { withInitializationLock } from '../initialization-audit/advisory-lock.js';
import { startApplying, markApplied, markApplyFailed } from '../initialization-audit/run-lifecycle.service.js';
import { transitionRecordOnApply } from '../initialization-audit/record-writer.service.js';
import { computeFingerprint } from '../initialization-audit/fingerprint.js';
import { buildInventoryCategoryKey, buildUnitOfMeasureKey, buildUnitConversionKey } from '../initialization-audit/manifest-entry-key.js';
import { matchCategory } from './category-matcher.js';
import { matchUnit } from './unit-matcher.js';
import { matchConversion } from './conversion-matcher.js';
import type { CanonicalReferenceManifest } from './types.js';

/**
 * R6 "Apply safety" / RC7 — the apply orchestration Phase C0's manifest
 * package requires. THIS FUNCTION IS NOT EXECUTED BY THIS TASK (see
 * NON-NEGOTIABLES) — it exists so the capability is implemented and
 * reviewable, callable only via the explicit CLI script with `--confirm`,
 * never at startup or from any other code path.
 *
 * Refuses to run (throws before any write) unless:
 *  - the dry-run for this exact `migrationBatch` already durably recorded
 *    `DRY_RUN_VALIDATED` (this function does not run its own dry-run);
 *  - re-evaluating the plan against a FRESH live snapshot reports zero
 *    blockers (`BLOCKED_AMBIGUOUS`/`BLOCKED_INCOMPATIBLE`/`MISSING_DEPENDENCY`);
 *  - the caller passed literal `confirm: true` and
 *    `acknowledgeRollbackReviewed: true`.
 *
 * One `prisma.$transaction` per reference type (categories, then units, then
 * conversions), each opened via `withInitializationLock` so the coarse
 * advisory lock and the transaction boundary are the same scope (CR-009's
 * `pg_advisory_xact_lock` requires this — see advisory-lock.ts). The
 * target-table write and its `InitializationRecord` CAS transition happen
 * inside that same transaction, per CR-009's Transaction Boundary. A type's
 * transaction failing aborts that type atomically and stops the whole apply
 * (categories/units failing means conversions are never attempted); the run
 * is marked `APPLY_FAILED` naming the failing type. Never overwrites an
 * existing row's fields — only creates missing rows or reuses exact
 * matches.
 */

export class ApplyRefusedError extends Error {
  public readonly code = 'APPLY_REFUSED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ApplyRefusedError';
  }
}

export interface ApplyManifestParams {
  manifest: CanonicalReferenceManifest;
  migrationBatch: string;
  targetEnvironment: string;
  /** Must be the literal boolean `true` — no implicit/default confirmation (R6, R9's `--confirm`). */
  confirm: true;
  /** Must be the literal boolean `true` — mirrors the plan's `--acknowledge-rollback-reviewed` CLI gate. */
  acknowledgeRollbackReviewed: true;
}

export interface ApplyManifestResult {
  runId: string;
  status: 'APPLIED' | 'APPLY_FAILED';
  failureReason?: string;
}

/**
 * Refuses (throws `ApplyRefusedError`) unless `confirm`/`acknowledgeRollbackReviewed`
 * are literal `true`, the run exists in `DRY_RUN_VALIDATED`, and a
 * freshly-recomputed plan against live data reports zero blockers.
 */
export async function applyManifest(params: ApplyManifestParams): Promise<ApplyManifestResult> {
  const { manifest, migrationBatch, confirm, acknowledgeRollbackReviewed } = params;

  if (confirm !== true || acknowledgeRollbackReviewed !== true) {
    throw new ApplyRefusedError('applyManifest requires explicit confirm=true and acknowledgeRollbackReviewed=true');
  }

  const run = await prisma.initializationRun.findUnique({ where: { migrationBatch } });
  if (!run) {
    throw new ApplyRefusedError(`No InitializationRun found for migrationBatch "${migrationBatch}" — run dry-run first`);
  }
  if (run.status !== 'DRY_RUN_VALIDATED') {
    throw new ApplyRefusedError(`InitializationRun "${run.id}" is not DRY_RUN_VALIDATED (status: ${run.status}) — apply refuses to proceed`);
  }

  const [liveCategories, liveUnits, liveConversionsRaw] = await Promise.all([
    prisma.inventoryCategory.findMany({ select: { id: true, name: true, code: true, description: true } }),
    prisma.unitOfMeasure.findMany({ select: { id: true, code: true, name: true, dimension: true } }),
    prisma.unitConversion.findMany({ select: { id: true, fromUnitId: true, toUnitId: true, factor: true } }),
  ]);
  const liveConversions = liveConversionsRaw.map((c) => ({ ...c, factor: c.factor.toString() }));

  const categoryMatches = manifest.categories.map((entry) => ({ entry, match: matchCategory(entry, liveCategories) }));
  const unitMatches = manifest.units.map((entry) => ({ entry, match: matchUnit(entry, liveUnits) }));

  const resolvedUnitIdByCode = new Map<string, string>();
  for (const { entry, match } of unitMatches) {
    if (match.status === 'WILL_REUSE') resolvedUnitIdByCode.set(entry.code, match.existingId);
  }
  // Units WILL_CREATE do not yet have an id at plan time; conversion
  // resolution against those happens after the units transaction commits
  // (see below) — pre-check here only rejects genuine ambiguity/incompatibility.
  const conversionPreCheck = manifest.conversions.map((entry) => ({ entry, match: matchConversion(entry, resolvedUnitIdByCode, liveConversions) }));

  const anyBlocked =
    categoryMatches.some((m) => m.match.status === 'BLOCKED_AMBIGUOUS' || m.match.status === 'BLOCKED_INCOMPATIBLE') ||
    unitMatches.some((m) => m.match.status === 'BLOCKED_AMBIGUOUS' || m.match.status === 'BLOCKED_INCOMPATIBLE') ||
    conversionPreCheck.some((m) => m.match.status === 'BLOCKED_INCOMPATIBLE');
  if (anyBlocked) {
    throw new ApplyRefusedError('Apply refused: unresolved BLOCKED_AMBIGUOUS/BLOCKED_INCOMPATIBLE conflicts remain — resolve before retrying');
  }

  const startedRun = await startApplying({ runId: run.id, expectedVersion: run.version });

  try {
    // --- Categories -----------------------------------------------------
    await withInitializationLock(async (tx) => {
      const records = await tx.initializationRecord.findMany({ where: { initializationRunId: run.id, entityType: 'INVENTORY_CATEGORY' } });
      const byKey = new Map(records.map((r) => [r.manifestEntryKey, r]));
      for (const { entry, match } of categoryMatches) {
        const key = buildInventoryCategoryKey(entry.name);
        const record = byKey.get(key);
        if (!record) throw new Error(`Missing dry-run InitializationRecord for ${key}`);

        if (match.status === 'WILL_CREATE') {
          const created = await tx.inventoryCategory.create({
            data: { name: entry.name, code: entry.code, description: entry.description, isActive: entry.isActive },
          });
          const fp = computeFingerprint('InventoryCategory', created, 1);
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'CREATED', entityId: created.id,
            createdByRun: true, reusedExisting: false, expectedVersion: record.version, resultingFingerprint: fp.hash,
          });
        } else if (match.status === 'WILL_REUSE') {
          const existing = liveCategories.find((c) => c.id === match.existingId);
          const fp = existing ? computeFingerprint('InventoryCategory', existing, 1).hash : null;
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'REUSED', entityId: match.existingId,
            createdByRun: false, reusedExisting: true, expectedVersion: record.version, preexistingFingerprint: fp, resultingFingerprint: fp,
          });
        } else {
          throw new Error(`Unexpected blocked category match reached apply for ${key}`);
        }
      }
    });

    // --- Units ------------------------------------------------------------
    const unitIdByCode = new Map(resolvedUnitIdByCode);
    await withInitializationLock(async (tx) => {
      const records = await tx.initializationRecord.findMany({ where: { initializationRunId: run.id, entityType: 'UNIT_OF_MEASURE' } });
      const byKey = new Map(records.map((r) => [r.manifestEntryKey, r]));
      for (const { entry, match } of unitMatches) {
        const key = buildUnitOfMeasureKey(entry.code);
        const record = byKey.get(key);
        if (!record) throw new Error(`Missing dry-run InitializationRecord for ${key}`);

        if (match.status === 'WILL_CREATE') {
          const created = await tx.unitOfMeasure.create({
            data: { code: entry.code, name: entry.name, dimension: entry.dimension, isBaseUnit: entry.isBaseUnit, isActive: entry.isActive },
          });
          unitIdByCode.set(entry.code, created.id);
          const fp = computeFingerprint('UnitOfMeasure', created, 1);
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'CREATED', entityId: created.id,
            createdByRun: true, reusedExisting: false, expectedVersion: record.version, resultingFingerprint: fp.hash,
          });
        } else if (match.status === 'WILL_REUSE') {
          unitIdByCode.set(entry.code, match.existingId);
          const existing = liveUnits.find((u) => u.id === match.existingId);
          const fp = existing ? computeFingerprint('UnitOfMeasure', existing, 1).hash : null;
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'REUSED', entityId: match.existingId,
            createdByRun: false, reusedExisting: true, expectedVersion: record.version, preexistingFingerprint: fp, resultingFingerprint: fp,
          });
        } else {
          throw new Error(`Unexpected blocked unit match reached apply for ${key}`);
        }
      }
    });

    // --- Conversions --------------------------------------------------------
    await withInitializationLock(async (tx) => {
      const freshConversionsRaw = await tx.unitConversion.findMany({ select: { id: true, fromUnitId: true, toUnitId: true, factor: true } });
      const freshConversions = freshConversionsRaw.map((c) => ({ ...c, factor: c.factor.toString() }));
      const records = await tx.initializationRecord.findMany({ where: { initializationRunId: run.id, entityType: 'UNIT_CONVERSION' } });
      const byKey = new Map(records.map((r) => [r.manifestEntryKey, r]));

      for (const entry of manifest.conversions) {
        const key = buildUnitConversionKey(entry.fromUnitCode, entry.toUnitCode);
        const record = byKey.get(key);
        if (!record) throw new Error(`Missing dry-run InitializationRecord for ${key}`);

        const match = matchConversion(entry, unitIdByCode, freshConversions);
        if (match.status === 'MISSING_DEPENDENCY' || match.status === 'BLOCKED_INCOMPATIBLE') {
          throw new Error(`Conversion ${key} blocked at apply time: ${match.reason}`);
        }

        if (match.status === 'WILL_CREATE') {
          const created = await tx.unitConversion.create({
            data: { fromUnitId: match.fromUnitId, toUnitId: match.toUnitId, factor: entry.factor },
          });
          const fp = computeFingerprint('UnitConversion', created, 1);
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'CREATED', entityId: created.id,
            createdByRun: true, reusedExisting: false, expectedVersion: record.version, resultingFingerprint: fp.hash,
          });
        } else {
          const existing = freshConversions.find((c) => c.id === match.existingId);
          const fp = existing ? computeFingerprint('UnitConversion', existing, 1).hash : null;
          await transitionRecordOnApply(tx, {
            runId: run.id, manifestEntryKey: key, action: 'REUSED', entityId: match.existingId,
            createdByRun: false, reusedExisting: true, expectedVersion: record.version, preexistingFingerprint: fp, resultingFingerprint: fp,
          });
        }
      }
    });

    await markApplied({ runId: run.id, expectedVersion: startedRun.version });
    return { runId: run.id, status: 'APPLIED' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const current = await prisma.initializationRun.findUniqueOrThrow({ where: { id: run.id } });
    await markApplyFailed({ runId: run.id, expectedVersion: current.version, failureReason: reason });
    return { runId: run.id, status: 'APPLY_FAILED', failureReason: reason };
  }
}
