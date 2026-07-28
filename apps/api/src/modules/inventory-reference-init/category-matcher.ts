import { normalizeCategory } from '../inventory-migration/normalization.js';
import type { ManifestCategoryEntry } from './types.js';

export type CategoryMatchResult =
  | { status: 'WILL_CREATE' }
  | { status: 'WILL_REUSE'; existingId: string }
  | { status: 'BLOCKED_AMBIGUOUS'; matchedIds: string[] }
  | { status: 'BLOCKED_INCOMPATIBLE'; existingId: string; reason: string };

export interface ExistingCategoryRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
}

/**
 * R7/R9 category duplicate-detection: reuse only on an exact normalized-name
 * fold; two folded matches is an unresolved data-quality conflict, never
 * auto-picked. Description drift alone is never blocking (Phase C0 §8) --
 * this manifest has no `incompatibleIfDescriptionDiffers` flag (every entry
 * defaults to non-blocking), so a description difference is never surfaced
 * here as `BLOCKED_INCOMPATIBLE`.
 */
export function matchCategory(entry: ManifestCategoryEntry, existing: ExistingCategoryRow[]): CategoryMatchResult {
  const normalizedEntryName = normalizeCategory(entry.name).normalized;
  const matches = existing.filter((row) => normalizeCategory(row.name).normalized === normalizedEntryName);

  if (matches.length === 0) {
    return { status: 'WILL_CREATE' };
  }
  if (matches.length > 1) {
    return { status: 'BLOCKED_AMBIGUOUS', matchedIds: matches.map((m) => m.id) };
  }

  const match = matches[0];
  if (!match) {
    return { status: 'WILL_CREATE' };
  }
  if (match.code !== null && entry.code !== null && match.code !== entry.code) {
    return {
      status: 'BLOCKED_INCOMPATIBLE',
      existingId: match.id,
      reason: `Existing category "${match.name}" has code "${match.code}", manifest declares "${entry.code}"`,
    };
  }

  return { status: 'WILL_REUSE', existingId: match.id };
}
