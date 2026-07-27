import { Prisma } from '@prisma/client';
import { sha256Hex } from '../../lib/hash.js';
import { canonicalizeDecimal } from './decimal-canonicalization.js';

/** CR-009 "Fingerprint strategy": the currently-supported fingerprint version. */
export const FINGERPRINT_VERSION = 1;
/** CR-009.1: the currently-supported decimal canonicalization version. */
export const DECIMAL_CANONICALIZATION_VERSION = 1;

/**
 * Per-entity-type rollback-relevant field lists (CR-009 "Fingerprint
 * strategy"). `id` and timestamp fields (`createdAt`/`updatedAt`) are
 * intentionally excluded from all of them: identity/audit metadata does not
 * affect whether the entity's business data has drifted from the manifest.
 */
const FINGERPRINT_FIELDS: Record<string, readonly string[]> = {
  InventoryCategory: ['name', 'code', 'description', 'isActive'],
  UnitOfMeasure: ['code', 'name', 'dimension', 'isBaseUnit', 'isActive'],
  UnitConversion: ['fromUnitId', 'toUnitId', 'factor'],
};

/** Fields that hold decimal values and must be run through `canonicalizeDecimal`. */
const DECIMAL_FIELDS: Record<string, readonly string[]> = {
  UnitConversion: ['factor'],
};

/**
 * Deterministic, key-order-independent JSON serialization: object keys are
 * sorted recursively and no whitespace is emitted, so structurally identical
 * inputs always serialize to the exact same string.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * CR-009 "Fingerprint strategy": computes a versioned, canonical-JSON
 * SHA-256 fingerprint over an entity's rollback-relevant fields only.
 *
 * - Only the fields listed in `FINGERPRINT_FIELDS[entityType]` are included;
 *   everything else on `fields` (including `id`, `createdAt`, `updatedAt`,
 *   or any other extra property) is ignored.
 * - Decimal-typed fields are passed through `canonicalizeDecimal` before
 *   serialization so manifest strings and database `Prisma.Decimal`
 *   instances of the same value fingerprint identically.
 * - Object keys are sorted recursively before serialization, so the
 *   resulting hash does not depend on the input object's key order.
 */
export function computeFingerprint(
  entityType: string,
  fields: Record<string, unknown>,
  version: number,
): { hash: string; fingerprintVersion: number; decimalCanonicalizationVersion: number } {
  if (version !== FINGERPRINT_VERSION) {
    throw new Error(`computeFingerprint: unsupported fingerprintVersion ${version}`);
  }

  const fieldNames = FINGERPRINT_FIELDS[entityType];
  if (!fieldNames) {
    throw new Error(`computeFingerprint: unknown entityType "${entityType}"`);
  }
  const decimalFieldNames = DECIMAL_FIELDS[entityType] ?? [];

  const normalizedFields: Record<string, unknown> = {};
  for (const field of fieldNames) {
    const rawValue = fields[field];
    normalizedFields[field] = decimalFieldNames.includes(field)
      ? canonicalizeDecimal(rawValue as string | Prisma.Decimal)
      : rawValue;
  }

  const hash = sha256Hex(canonicalJsonStringify(normalizedFields));

  return {
    hash,
    fingerprintVersion: FINGERPRINT_VERSION,
    decimalCanonicalizationVersion: DECIMAL_CANONICALIZATION_VERSION,
  };
}
