import { canonicalizeDecimal } from '../initialization-audit/decimal-canonicalization.js';
import type { ManifestConversionEntry } from './types.js';

export type ConversionMatchResult =
  | { status: 'WILL_CREATE'; fromUnitId: string; toUnitId: string }
  | { status: 'WILL_REUSE'; existingId: string; fromUnitId: string; toUnitId: string }
  | { status: 'BLOCKED_INCOMPATIBLE'; existingId: string; reason: string }
  | { status: 'MISSING_DEPENDENCY'; reason: string };

export interface ExistingConversionRow {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  factor: string;
}

/**
 * R7/R9 conversion duplicate-detection: identity is the directed
 * `(fromUnitId, toUnitId)` pair (schema's own `@@unique`). Reuse regardless
 * of stored factor value UNLESS the factors disagree once both are
 * canonicalized -- a disagreeing factor is `BLOCKED_INCOMPATIBLE`, never
 * silently overwritten. A conversion whose `fromUnitCode`/`toUnitCode`
 * cannot be resolved to a live/about-to-be-created unit id is
 * `MISSING_DEPENDENCY` -- categories/units must resolve before conversions
 * are evaluated (Phase C0 §10's stated dependency order).
 */
export function matchConversion(
  entry: ManifestConversionEntry,
  resolvedUnitIdByCode: ReadonlyMap<string, string>,
  existing: ExistingConversionRow[],
): ConversionMatchResult {
  const fromUnitId = resolvedUnitIdByCode.get(entry.fromUnitCode);
  const toUnitId = resolvedUnitIdByCode.get(entry.toUnitCode);

  if (!fromUnitId) {
    return { status: 'MISSING_DEPENDENCY', reason: `Unit code "${entry.fromUnitCode}" (fromUnitCode) is not yet resolved -- its unit row must be created/reused first` };
  }
  if (!toUnitId) {
    return { status: 'MISSING_DEPENDENCY', reason: `Unit code "${entry.toUnitCode}" (toUnitCode) is not yet resolved -- its unit row must be created/reused first` };
  }

  const match = existing.find((row) => row.fromUnitId === fromUnitId && row.toUnitId === toUnitId);
  if (!match) {
    return { status: 'WILL_CREATE', fromUnitId, toUnitId };
  }

  const canonicalManifestFactor = canonicalizeDecimal(entry.factor);
  const canonicalExistingFactor = canonicalizeDecimal(match.factor);
  if (canonicalManifestFactor !== canonicalExistingFactor) {
    return {
      status: 'BLOCKED_INCOMPATIBLE',
      existingId: match.id,
      reason: `Existing conversion ${entry.fromUnitCode}->${entry.toUnitCode} has factor "${match.factor}", manifest declares "${entry.factor}"`,
    };
  }

  return { status: 'WILL_REUSE', existingId: match.id, fromUnitId, toUnitId };
}
