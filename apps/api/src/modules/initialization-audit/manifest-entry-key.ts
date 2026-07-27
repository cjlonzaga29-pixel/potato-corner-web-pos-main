/**
 * CR-009.2 - `manifestEntryKey` encoding (locked).
 *
 * `normalizeNaturalKeySegment` implements the 13 normalization rules, in
 * order:
 *  1. Input must be a string (runtime guard for untyped manifest JSON).
 *  2. Unicode-normalize using NFC.
 *  3. Trim leading/trailing whitespace.
 *  4. Locale-independent lowercase (`.toLowerCase()`, never
 *     `.toLocaleLowerCase()`).
 *  5. Reject empty normalized values (throw).
 *  6. Reject ASCII control characters (code points 0-31 and 127) (throw).
 *  7. Reject the reserved character ":" (throw).
 *  8. Reject the reserved sequence "->" (throw).
 *  9. Preserve internal spaces.
 *  10. Do not collapse internal whitespace.
 *  11. Do not transliterate characters.
 *  12. (Caller responsibility) do not use database-generated IDs as input.
 *  13. (Caller responsibility) prefer stable code over mutable display label.
 */

// Detects ASCII control characters: code points 0-31 (C0 controls) and 127
// (DEL). Built from charCodeAt comparisons rather than a regex literal so
// there is no ambiguity about which characters are matched.
function containsControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function normalizeNaturalKeySegment(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('normalizeNaturalKeySegment: input must be a string');
  }

  const normalized = input.normalize('NFC').trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error('normalizeNaturalKeySegment: normalized value must not be empty');
  }
  if (containsControlCharacter(normalized)) {
    throw new Error('normalizeNaturalKeySegment: control characters are not allowed');
  }
  if (normalized.includes(':')) {
    throw new Error('normalizeNaturalKeySegment: reserved character ":" is not allowed');
  }
  if (normalized.includes('->')) {
    throw new Error('normalizeNaturalKeySegment: reserved sequence "->" is not allowed');
  }

  return normalized;
}

export function buildInventoryCategoryKey(categoryName: string): string {
  return `INVENTORY_CATEGORY:${normalizeNaturalKeySegment(categoryName)}`;
}

export function buildUnitOfMeasureKey(unitCode: string): string {
  return `UNIT_OF_MEASURE:${normalizeNaturalKeySegment(unitCode)}`;
}

export function buildUnitConversionKey(fromUnitCode: string, toUnitCode: string): string {
  return `UNIT_CONVERSION:${normalizeNaturalKeySegment(fromUnitCode)}->${normalizeNaturalKeySegment(toUnitCode)}`;
}

export function validateManifestNoDuplicateKeys(
  entries: { manifestEntryKey: string }[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.manifestEntryKey)) {
      throw new Error(`Duplicate manifestEntryKey: "${entry.manifestEntryKey}"`);
    }
    seen.add(entry.manifestEntryKey);
  }
}
