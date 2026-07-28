import { describe, it, expect } from 'vitest';
import { validateManifest, ManifestValidationError } from './manifest.schema.js';
import { PHASE_C0_MANIFEST } from './manifest.js';

function baseManifest() {
  return JSON.parse(JSON.stringify(PHASE_C0_MANIFEST));
}

describe('validateManifest', () => {
  it('accepts the real Phase C0 manifest', () => {
    expect(() => validateManifest(PHASE_C0_MANIFEST)).not.toThrow();
  });

  it('rejects a category entry missing evidence', () => {
    const manifest = baseManifest();
    manifest.categories[0].evidence = '';
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
  });

  it('rejects a multi-word unit name whose code is trivially derived by uppercasing/underscoring it', () => {
    const manifest = baseManifest();
    manifest.units.push({
      code: 'KILO_GRAM', name: 'Kilo Gram', symbol: 'kg2', dimension: 'WEIGHT', isBaseUnit: false, isActive: true,
      source: 'OPERATOR_APPROVED', evidence: 'test', approvalStatus: 'APPROVED',
    });
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
  });

  it('does NOT flag a single-word unit name whose code equals its own lowercased name (e.g. "pack" for "Pack")', () => {
    const manifest = baseManifest();
    manifest.units.push({
      code: 'newpack', name: 'Newpack', symbol: 'np', dimension: 'COUNT', isBaseUnit: false, isActive: true,
      source: 'OPERATOR_APPROVED', evidence: 'test', approvalStatus: 'APPROVED',
    });
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('rejects two categories folding to the same normalized manifestEntryKey', () => {
    const manifest = baseManifest();
    manifest.categories.push({ ...manifest.categories[0], code: 'RAW_MATERIAL_2' });
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
  });

  it('rejects a conversion referencing a unit code not declared in manifest.units (missing dependency)', () => {
    const manifest = baseManifest();
    manifest.conversions.push({ fromUnitCode: 'tbsp', toUnitCode: 'g', factor: '15', source: 'OPERATOR_APPROVED', evidence: 'test', approvalStatus: 'APPROVED' });
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
  });

  it('rejects a scientific-notation factor', () => {
    const manifest = baseManifest();
    manifest.conversions[0].factor = '1e3';
    expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
  });

  it('rejects approvalStatus other than the literal "APPROVED"', () => {
    const manifest = baseManifest();
    manifest.categories[0].approvalStatus = 'UNRESOLVED';
    expect(() => validateManifest(manifest)).toThrow();
  });
});
