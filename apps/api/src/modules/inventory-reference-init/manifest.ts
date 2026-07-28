import type { CanonicalReferenceManifest } from './types.js';

/**
 * Phase C0 — canonical inventory reference-data manifest, v1.
 *
 * Scope: `InventoryCategory`, `UnitOfMeasure`, globally-valid
 * `UnitConversion` rows only. No `InventoryItem`, no legacy `Ingredient`
 * migration, no item-specific packaging conversion (box/case/pack/bag/
 * bottle/cup) -- those stay `NOT PROPOSED` here (see R3 non-goals in
 * docs/decisions/PHASE-C0-canonical-inventory-reference-initialization.md).
 *
 * Every row here is `source: 'OPERATOR_APPROVED'` (explicitly specified by
 * the operator in the Phase C0 initialization request, 2026-07-28) except
 * the four arithmetic mass/volume conversions, which are
 * `'ARCHITECTURE_REQUIRED'` (exact, schema-comment-sanctioned unit facts,
 * not business data -- see schema.prisma:890-892).
 *
 * Stable, declared ordering: categories, then units (mass -> volume ->
 * count), then conversions (each depends on both its units already being
 * declared above it). No timestamps or generated IDs appear anywhere in
 * this file -- fingerprints (`manifest-fingerprint.ts`) are computed over
 * exactly this declared shape.
 */

const OPERATOR_EVIDENCE = 'Operator-specified canonical value, Phase C0 canonical-inventory-reference-initialization request (2026-07-28)';
const ARCHITECTURE_EVIDENCE = 'Exact arithmetic mass/volume conversion fact, sanctioned by schema.prisma:890-892 as the intended universal-conversion use case';

export const PHASE_C0_MANIFEST: CanonicalReferenceManifest = {
  manifestKey: 'phase-c0-canonical-inventory-reference-data',
  manifestVersion: 1,
  categories: [
    { code: 'RAW_MATERIAL', name: 'Raw Material', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'FLAVORING', name: 'Flavoring', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'PACKAGING', name: 'Packaging', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'BEVERAGE', name: 'Beverage', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'CONSUMABLE', name: 'Consumable', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'CLEANING_SUPPLY', name: 'Cleaning Supply', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'EQUIPMENT', name: 'Equipment', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'OTHER', name: 'Other', description: null, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
  ],
  units: [
    // MASS
    { code: 'mg', name: 'Milligram', symbol: 'mg', dimension: 'WEIGHT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'g', name: 'Gram', symbol: 'g', dimension: 'WEIGHT', isBaseUnit: true, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'kg', name: 'Kilogram', symbol: 'kg', dimension: 'WEIGHT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    // VOLUME
    { code: 'mL', name: 'Milliliter', symbol: 'mL', dimension: 'VOLUME', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'L', name: 'Liter', symbol: 'L', dimension: 'VOLUME', isBaseUnit: true, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    // COUNT
    { code: 'pc', name: 'Piece', symbol: 'pc', dimension: 'COUNT', isBaseUnit: true, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'pack', name: 'Pack', symbol: 'pack', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'box', name: 'Box', symbol: 'box', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'case', name: 'Case', symbol: 'case', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'sachet', name: 'Sachet', symbol: 'sachet', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'bottle', name: 'Bottle', symbol: 'bottle', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'cup', name: 'Cup', symbol: 'cup', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
    { code: 'bag', name: 'Bag', symbol: 'bag', dimension: 'COUNT', isBaseUnit: false, isActive: true, source: 'OPERATOR_APPROVED', evidence: OPERATOR_EVIDENCE, approvalStatus: 'APPROVED' },
  ],
  conversions: [
    { fromUnitCode: 'kg', toUnitCode: 'g', factor: '1000', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
    { fromUnitCode: 'g', toUnitCode: 'kg', factor: '0.001', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
    { fromUnitCode: 'g', toUnitCode: 'mg', factor: '1000', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
    { fromUnitCode: 'mg', toUnitCode: 'g', factor: '0.001', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
    { fromUnitCode: 'L', toUnitCode: 'mL', factor: '1000', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
    { fromUnitCode: 'mL', toUnitCode: 'L', factor: '0.001', source: 'ARCHITECTURE_REQUIRED', evidence: ARCHITECTURE_EVIDENCE, approvalStatus: 'APPROVED' },
  ],
};
