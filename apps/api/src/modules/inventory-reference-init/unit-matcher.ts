import type { UnitDimension } from '@prisma/client';
import { normalizeInventoryName } from '../inventory-migration/normalization.js';
import type { ManifestUnitEntry } from './types.js';

export type UnitMatchResult =
  | { status: 'WILL_CREATE' }
  | { status: 'WILL_REUSE'; existingId: string }
  | { status: 'BLOCKED_AMBIGUOUS'; matchedIds: string[] }
  | { status: 'BLOCKED_INCOMPATIBLE'; existingId: string; reason: string };

export interface ExistingUnitRow {
  id: string;
  code: string;
  name: string;
  dimension: UnitDimension;
}

/**
 * R7/R9 unit duplicate-detection: identity is `code` (unique, authoritative),
 * never `name` alone. Exact code match reuses only if `dimension` also
 * matches; a same-code-different-dimension row is a genuine data-integrity
 * conflict. No code match but a folded `name` collision is ambiguous, never
 * silently created under a different code.
 */
export function matchUnit(entry: ManifestUnitEntry, existing: ExistingUnitRow[]): UnitMatchResult {
  const codeMatch = existing.find((row) => row.code === entry.code);
  if (codeMatch) {
    if (codeMatch.dimension !== entry.dimension) {
      return {
        status: 'BLOCKED_INCOMPATIBLE',
        existingId: codeMatch.id,
        reason: `Existing unit code "${codeMatch.code}" has dimension "${codeMatch.dimension}", manifest declares "${entry.dimension}"`,
      };
    }
    return { status: 'WILL_REUSE', existingId: codeMatch.id };
  }

  const normalizedEntryName = normalizeInventoryName(entry.name).normalized;
  const nameMatches = existing.filter((row) => normalizeInventoryName(row.name).normalized === normalizedEntryName);
  if (nameMatches.length > 0) {
    return { status: 'BLOCKED_AMBIGUOUS', matchedIds: nameMatches.map((m) => m.id) };
  }

  return { status: 'WILL_CREATE' };
}
