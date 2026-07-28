import { z } from 'zod';
import { validateManifestNoDuplicateKeys, buildInventoryCategoryKey, buildUnitOfMeasureKey, buildUnitConversionKey } from '../initialization-audit/manifest-entry-key.js';
import type { CanonicalReferenceManifest } from './types.js';

/**
 * R4 "Initialization manifest" / R11 "Tests" -- structural validation for
 * the Phase C0 manifest, plus the Global-Constraint guards this module must
 * enforce structurally (no auto-derived unit codes, no timestamps/random IDs
 * as identity, no duplicate canonical codes).
 */

const sourceClassification = z.enum(['ARCHITECTURE_REQUIRED', 'OPERATOR_APPROVED']);
const approvalStatus = z.literal('APPROVED');

const categoryEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  isActive: z.boolean(),
  source: sourceClassification,
  evidence: z.string().min(1),
  approvalStatus,
});

const unitEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  symbol: z.string().min(1),
  dimension: z.enum(['WEIGHT', 'VOLUME', 'COUNT']),
  isBaseUnit: z.boolean(),
  isActive: z.boolean(),
  source: sourceClassification,
  evidence: z.string().min(1),
  approvalStatus,
});

const conversionEntrySchema = z.object({
  fromUnitCode: z.string().min(1),
  toUnitCode: z.string().min(1),
  factor: z
    .string()
    .min(1)
    .refine((value) => /^\d+(\.\d+)?$/.test(value), 'factor must be a plain, non-negative, non-exponential decimal string'),
  source: sourceClassification,
  evidence: z.string().min(1),
  approvalStatus,
});

export const manifestSchema = z.object({
  manifestKey: z.string().min(1),
  manifestVersion: z.number().int().positive(),
  categories: z.array(categoryEntrySchema),
  units: z.array(unitEntrySchema),
  conversions: z.array(conversionEntrySchema),
});

export class ManifestValidationError extends Error {
  public readonly code = 'MANIFEST_VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Guards against the "derived by uppercasing/lowercasing a MULTI-WORD name"
 * mistake Global Constraints forbid (e.g. inventing `RAW_MATERIAL` as a code
 * by transforming the display name "Raw Material" instead of an operator
 * explicitly choosing it). A single-word code equal to its own lowercased
 * name (e.g. `pack` for "Pack") is NOT flagged -- that is simply the
 * explicit, operator-approved code for a single-word unit, not a derived
 * abbreviation; only a multi-word name folded into one code is suspect.
 */
function assertUnitCodeNotDerivedFromName(entry: { code: string; name: string }): void {
  const isMultiWordName = /\s/.test(entry.name.trim());
  if (!isMultiWordName) {
    return;
  }
  const trivialUppercase = entry.name.toUpperCase().replace(/\s+/g, '_');
  const trivialLowercase = entry.name.toLowerCase().replace(/\s+/g, '_');
  if (entry.code === trivialUppercase || entry.code === trivialLowercase) {
    throw new ManifestValidationError(
      `Unit code "${entry.code}" looks trivially derived from name "${entry.name}" -- codes must be explicit, not transformed from the display name`,
    );
  }
}

/**
 * Full manifest validation: Zod structural check, then the Global-Constraint
 * guards Zod cannot express (duplicate manifestEntryKey, dangling
 * conversion-unit references, derived-code heuristic). Throws
 * `ManifestValidationError` (never a raw ZodError) on any failure, before any
 * dry-run/apply code sees the manifest.
 */
export function validateManifest(input: unknown): CanonicalReferenceManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManifestValidationError(`Manifest schema validation failed: ${parsed.error.message}`);
  }
  const manifest = parsed.data;

  for (const unit of manifest.units) {
    assertUnitCodeNotDerivedFromName(unit);
  }

  const unitCodes = new Set(manifest.units.map((u) => u.code));
  for (const conversion of manifest.conversions) {
    if (!unitCodes.has(conversion.fromUnitCode)) {
      throw new ManifestValidationError(`Conversion references missing fromUnitCode "${conversion.fromUnitCode}" -- not declared in manifest.units`);
    }
    if (!unitCodes.has(conversion.toUnitCode)) {
      throw new ManifestValidationError(`Conversion references missing toUnitCode "${conversion.toUnitCode}" -- not declared in manifest.units`);
    }
  }

  const entryKeys = [
    ...manifest.categories.map((c) => ({ manifestEntryKey: buildInventoryCategoryKey(c.name) })),
    ...manifest.units.map((u) => ({ manifestEntryKey: buildUnitOfMeasureKey(u.code) })),
    ...manifest.conversions.map((c) => ({ manifestEntryKey: buildUnitConversionKey(c.fromUnitCode, c.toUnitCode) })),
  ];
  try {
    validateManifestNoDuplicateKeys(entryKeys);
  } catch (error) {
    throw new ManifestValidationError(error instanceof Error ? error.message : String(error));
  }

  return manifest;
}
