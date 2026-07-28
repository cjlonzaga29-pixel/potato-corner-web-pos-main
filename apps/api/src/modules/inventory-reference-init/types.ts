import type { UnitDimension } from '@prisma/client';

/**
 * Phase C0 manifest entries carry only the two classifications that apply
 * to a deterministic, operator-specified canonical package: a value forced
 * by the schema/architecture itself (e.g. the kg<->g conversion factor,
 * an arithmetic fact), or a value the operator explicitly specified in the
 * Phase C0 initialization request. Neither `LEGACY_OBSERVED` nor
 * `RECIPE_OBSERVED` apply here -- this manifest does not migrate legacy
 * `Ingredient` data (see docs/decisions/PHASE-C0-canonical-inventory-reference-initialization.md).
 */
export type SourceClassification = 'ARCHITECTURE_REQUIRED' | 'OPERATOR_APPROVED';

/** Every Phase C0 manifest row ships pre-approved; nothing is left `UNRESOLVED`. */
export type ManifestApprovalStatus = 'APPROVED';

export interface ManifestCategoryEntry {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly source: SourceClassification;
  readonly evidence: string;
  readonly approvalStatus: ManifestApprovalStatus;
}

export interface ManifestUnitEntry {
  readonly code: string;
  readonly name: string;
  /** Display-only. `UnitOfMeasure` has no `symbol` column (schema.prisma:872-888) -- never written to the database, carried here for CLI/report readability only. */
  readonly symbol: string;
  readonly dimension: UnitDimension;
  readonly isBaseUnit: boolean;
  readonly isActive: boolean;
  readonly source: SourceClassification;
  readonly evidence: string;
  readonly approvalStatus: ManifestApprovalStatus;
}

export interface ManifestConversionEntry {
  readonly fromUnitCode: string;
  readonly toUnitCode: string;
  /** Decimal-safe string, never a `number` -- see initialization-audit's decimal canonicalization rules. */
  readonly factor: string;
  readonly source: SourceClassification;
  readonly evidence: string;
  readonly approvalStatus: ManifestApprovalStatus;
}

export interface CanonicalReferenceManifest {
  readonly manifestKey: string;
  readonly manifestVersion: number;
  readonly categories: readonly ManifestCategoryEntry[];
  readonly units: readonly ManifestUnitEntry[];
  readonly conversions: readonly ManifestConversionEntry[];
}
