/**
 * CR-006 Phase B normalization utilities. Normalization is whitespace/case
 * folding only — it never maps distinct business terms (units, package
 * types) onto one another. See CR-007 SS20.2/SS3 for why identity must not be
 * inferred from name equality alone.
 */
export interface NormalizedValue {
  raw: string;
  normalized: string;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeInventoryName(value: string): NormalizedValue {
  return { raw: value, normalized: collapseWhitespace(value).toLowerCase() };
}

export function normalizeLegacyUnit(value: string): NormalizedValue {
  return { raw: value, normalized: collapseWhitespace(value).toLowerCase() };
}

export function normalizeSku(value: string | null): NormalizedValue | null {
  if (value === null) return null;
  return { raw: value, normalized: collapseWhitespace(value).toUpperCase() };
}

export function normalizeBarcode(value: string | null): NormalizedValue | null {
  if (value === null) return null;
  return { raw: value, normalized: collapseWhitespace(value).toUpperCase() };
}
