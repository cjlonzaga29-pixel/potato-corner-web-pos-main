import { sha256Hex } from '../../lib/hash.js';
import type { CanonicalReferenceManifest } from './types.js';

/**
 * Deterministic, key-order-independent JSON serialization -- same approach
 * as `initialization-audit/fingerprint.ts`'s `canonicalJsonStringify`, not
 * reimplemented differently: object keys sorted recursively, no whitespace.
 * Duplicated here (not imported) because that module's version is a private,
 * unexported helper local to entity-row fingerprinting.
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
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(',')}}`;
}

/**
 * Manifest-level fingerprint: a SHA-256 over the canonical JSON of the
 * manifest's own declared fields (`manifestKey`, `manifestVersion`,
 * categories/units/conversions arrays) -- no timestamps, no generated IDs,
 * per R4 "no timestamps or generated random IDs inside fingerprint inputs".
 * Stable regardless of array/object key declaration order.
 */
export function computeManifestFingerprint(manifest: CanonicalReferenceManifest): string {
  return sha256Hex(canonicalJsonStringify(manifest));
}
