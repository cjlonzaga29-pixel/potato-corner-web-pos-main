import type { InitializationEntityType, Prisma, UnitDimension } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { recordDryRunRun, type DryRunManifestEntry } from '../initialization-audit/dry-run-contract.js';
import { buildInventoryCategoryKey, buildUnitOfMeasureKey, buildUnitConversionKey } from '../initialization-audit/manifest-entry-key.js';
import { computeManifestFingerprint } from './manifest-fingerprint.js';
import { matchCategory, type CategoryMatchResult } from './category-matcher.js';
import { matchUnit, type UnitMatchResult } from './unit-matcher.js';
import { matchConversion, type ConversionMatchResult } from './conversion-matcher.js';
import type { CanonicalReferenceManifest } from './types.js';

/**
 * R5 "Dry-run" — read-only planning against live `InventoryCategory` /
 * `UnitOfMeasure` / `UnitConversion` rows. Reports create/reuse/conflict
 * classifications for every manifest entry; performs NO insert/update/
 * delete/activate/deactivate against those three tables, and records no
 * `InitializationRun` in APPLIED-adjacent state -- only the durable
 * `DRY_RUN_VALIDATED` row CR-009.2's lifecycle model already requires (see
 * `audit-integration.ts`'s `recordDryRunRun`, which this module composes,
 * not reimplements).
 */

export interface CategoryPlanEntry {
  manifestEntryKey: string;
  name: string;
  match: CategoryMatchResult;
}
export interface UnitPlanEntry {
  manifestEntryKey: string;
  code: string;
  match: UnitMatchResult;
}
export interface ConversionPlanEntry {
  manifestEntryKey: string;
  fromUnitCode: string;
  toUnitCode: string;
  match: ConversionMatchResult;
}

export interface DryRunPlan {
  categories: CategoryPlanEntry[];
  units: UnitPlanEntry[];
  conversions: ConversionPlanEntry[];
  /** True iff every entry across all three lists is WILL_CREATE or WILL_REUSE -- i.e. apply-eligible per pre-apply gate #4. */
  hasZeroBlockers: boolean;
}

export interface LiveReferenceRows {
  categories: { id: string; name: string; code: string | null; description: string | null }[];
  units: { id: string; code: string; name: string; dimension: UnitDimension }[];
  conversions: { id: string; fromUnitId: string; toUnitId: string; factor: string }[];
}

/**
 * Pure planning function: given the manifest and an already-fetched
 * snapshot of live rows, classifies every manifest entry. Zero I/O -- the
 * caller (`runDryRun` below, or a test) supplies `live`.
 */
export function buildDryRunPlan(manifest: CanonicalReferenceManifest, live: LiveReferenceRows): DryRunPlan {
  const categories: CategoryPlanEntry[] = manifest.categories.map((entry) => ({
    manifestEntryKey: buildInventoryCategoryKey(entry.name),
    name: entry.name,
    match: matchCategory(entry, live.categories),
  }));

  const units: UnitPlanEntry[] = manifest.units.map((entry) => ({
    manifestEntryKey: buildUnitOfMeasureKey(entry.code),
    code: entry.code,
    match: matchUnit(entry, live.units),
  }));

  // Resolve unit codes -> ids for conversion evaluation: live matches use the
  // existing row's id; WILL_CREATE entries have no id yet (conversions
  // referencing them are reported MISSING_DEPENDENCY during dry-run, since
  // dry-run never creates a row to resolve against -- apply-time resolution
  // happens after the units transaction actually commits).
  const resolvedUnitIdByCode = new Map<string, string>();
  for (const unit of units) {
    if (unit.match.status === 'WILL_REUSE') {
      resolvedUnitIdByCode.set(unit.code, unit.match.existingId);
    }
  }

  const conversions: ConversionPlanEntry[] = manifest.conversions.map((entry) => ({
    manifestEntryKey: buildUnitConversionKey(entry.fromUnitCode, entry.toUnitCode),
    fromUnitCode: entry.fromUnitCode,
    toUnitCode: entry.toUnitCode,
    match: matchConversion(entry, resolvedUnitIdByCode, live.conversions),
  }));

  const isBlocked = (status: string) => status === 'BLOCKED_AMBIGUOUS' || status === 'BLOCKED_INCOMPATIBLE' || status === 'MISSING_DEPENDENCY';
  const hasZeroBlockers =
    !categories.some((c) => isBlocked(c.match.status)) &&
    !units.some((u) => isBlocked(u.match.status)) &&
    !conversions.some((c) => isBlocked(c.match.status));

  return { categories, units, conversions, hasZeroBlockers };
}

/** Fetches the current live snapshot of all three reference tables -- the only I/O this module performs against target tables (all reads, zero writes). */
export async function fetchLiveReferenceRows(): Promise<LiveReferenceRows> {
  const [categories, units, conversions] = await Promise.all([
    prisma.inventoryCategory.findMany({ select: { id: true, name: true, code: true, description: true } }),
    prisma.unitOfMeasure.findMany({ select: { id: true, code: true, name: true, dimension: true } }),
    prisma.unitConversion.findMany({ select: { id: true, fromUnitId: true, toUnitId: true, factor: true } }),
  ]);
  return {
    categories,
    units,
    conversions: conversions.map((c) => ({ ...c, factor: c.factor.toString() })),
  };
}

function entityTypeForPlanKey(manifestEntryKey: string): InitializationEntityType {
  if (manifestEntryKey.startsWith('INVENTORY_CATEGORY:')) return 'INVENTORY_CATEGORY';
  if (manifestEntryKey.startsWith('UNIT_OF_MEASURE:')) return 'UNIT_OF_MEASURE';
  return 'UNIT_CONVERSION';
}

export interface RunDryRunParams {
  manifest: CanonicalReferenceManifest;
  migrationBatch: string;
  targetEnvironment: string;
  initiatedBy: string;
}

export interface RunDryRunResult {
  plan: DryRunPlan;
  manifestFingerprint: string;
}

/**
 * Full dry-run entry point: fetches the live snapshot, builds the plan, then
 * durably records the run + one `InitializationRecord` per manifest entry via
 * R7's `recordDryRunRun` (composed, not reimplemented). Never writes to
 * `InventoryCategory`/`UnitOfMeasure`/`UnitConversion`.
 */
export async function runDryRun(params: RunDryRunParams): Promise<RunDryRunResult> {
  const { manifest, migrationBatch, targetEnvironment, initiatedBy } = params;

  const live = await fetchLiveReferenceRows();
  const plan = buildDryRunPlan(manifest, live);
  const manifestFingerprint = computeManifestFingerprint(manifest);

  const manifestEntries: DryRunManifestEntry[] = [
    ...plan.categories.map((c) => ({ manifestEntryKey: c.manifestEntryKey, entityType: entityTypeForPlanKey(c.manifestEntryKey) })),
    ...plan.units.map((u) => ({ manifestEntryKey: u.manifestEntryKey, entityType: entityTypeForPlanKey(u.manifestEntryKey) })),
    ...plan.conversions.map((c) => ({ manifestEntryKey: c.manifestEntryKey, entityType: entityTypeForPlanKey(c.manifestEntryKey) })),
  ];

  await recordDryRunRun({
    migrationBatch,
    initializationType: 'REFERENCE_DATA',
    manifestVersion: manifest.manifestVersion,
    manifestFingerprint,
    manifestSnapshot: manifest as unknown as Prisma.InputJsonValue,
    targetEnvironment,
    initiatedBy,
    dryRunReportFingerprint: manifestFingerprint,
    manifestEntries,
  });

  return { plan, manifestFingerprint };
}
