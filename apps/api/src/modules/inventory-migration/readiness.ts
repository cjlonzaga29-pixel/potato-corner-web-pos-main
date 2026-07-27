import type {
  UnitClassificationEntry,
  IdentityCandidateGroup,
  SkuCollision,
  BarcodeCollision,
  FlavorLinkedCandidate,
  InvalidRecord,
} from './types.js';

export interface ReadinessInput {
  normalizedUnits: UnitClassificationEntry[];
  ambiguousGroups: IdentityCandidateGroup[];
  skuCollisions: SkuCollision[];
  barcodeCollisions: BarcodeCollision[];
  flavorLinkedCandidates: FlavorLinkedCandidate[];
  invalidRecords: InvalidRecord[];
}

export interface ReadinessResult {
  migrationReadiness: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * CR-006 Phase B requirement 9 — Phase C readiness is true only when SKU/
 * barcode collisions and invalid records are resolved. Ambiguous identity
 * groups, UNKNOWN/package units, and unresolved flavor links are documented
 * as warnings, not blockers — they do not need automatic resolution here.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.skuCollisions.length > 0) {
    blockers.push(`${input.skuCollisions.length} unresolved SKU collision(s)`);
  }
  if (input.barcodeCollisions.length > 0) {
    blockers.push(`${input.barcodeCollisions.length} unresolved barcode collision(s)`);
  }
  if (input.invalidRecords.length > 0) {
    blockers.push(`${input.invalidRecords.length} invalid legacy ingredient record(s) not excluded`);
  }

  const unknownUnits = input.normalizedUnits.filter((u) => u.classification === 'UNKNOWN');
  if (unknownUnits.length > 0) {
    warnings.push(`${unknownUnits.length} legacy unit(s) classified UNKNOWN and require manual mapping`);
  }

  const packageUnits = input.normalizedUnits.filter((u) => u.classification === 'ITEM_SPECIFIC_PACKAGE_UNIT');
  if (packageUnits.length > 0) {
    warnings.push(`${packageUnits.length} item-specific package unit(s) require per-item conversion review`);
  }

  if (input.ambiguousGroups.length > 0) {
    warnings.push(`${input.ambiguousGroups.length} ambiguous identity group(s) require manual review`);
  }

  const unresolvedFlavorLinks = input.flavorLinkedCandidates.filter((f) => f.unresolved);
  if (unresolvedFlavorLinks.length > 0) {
    warnings.push(`${unresolvedFlavorLinks.length} flavor-linked candidate(s) have no matching legacy ingredient`);
  }

  return { migrationReadiness: blockers.length === 0, blockers, warnings };
}
