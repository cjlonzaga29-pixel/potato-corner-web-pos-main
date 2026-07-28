import { describe, it, expect } from 'vitest';
import { PHASE_C0_MANIFEST } from './manifest.js';
import { validateManifest } from './manifest.schema.js';
import { computeManifestFingerprint } from './manifest-fingerprint.js';

const CATEGORY_CODES = ['RAW_MATERIAL', 'FLAVORING', 'PACKAGING', 'BEVERAGE', 'CONSUMABLE', 'CLEANING_SUPPLY', 'EQUIPMENT', 'OTHER'];
const UNIT_CODES = ['mg', 'g', 'kg', 'mL', 'L', 'pc', 'pack', 'box', 'case', 'sachet', 'bottle', 'cup', 'bag'];

describe('PHASE_C0_MANIFEST — exact canonical definitions', () => {
  it('is schema-valid', () => {
    expect(() => validateManifest(PHASE_C0_MANIFEST)).not.toThrow();
  });

  it('declares exactly the required category codes, in order, all active and APPROVED', () => {
    expect(PHASE_C0_MANIFEST.categories.map((c) => c.code)).toEqual(CATEGORY_CODES);
    for (const category of PHASE_C0_MANIFEST.categories) {
      expect(category.isActive).toBe(true);
      expect(category.approvalStatus).toBe('APPROVED');
      expect(category.evidence.length).toBeGreaterThan(0);
    }
  });

  it('declares exactly the required unit codes, in order, all active and APPROVED', () => {
    expect(PHASE_C0_MANIFEST.units.map((u) => u.code)).toEqual(UNIT_CODES);
    for (const unit of PHASE_C0_MANIFEST.units) {
      expect(unit.isActive).toBe(true);
      expect(unit.approvalStatus).toBe('APPROVED');
    }
  });

  it('assigns dimensions correctly: mass units WEIGHT, volume units VOLUME, count units COUNT', () => {
    const byCode = new Map(PHASE_C0_MANIFEST.units.map((u) => [u.code, u]));
    expect(byCode.get('mg')?.dimension).toBe('WEIGHT');
    expect(byCode.get('g')?.dimension).toBe('WEIGHT');
    expect(byCode.get('kg')?.dimension).toBe('WEIGHT');
    expect(byCode.get('mL')?.dimension).toBe('VOLUME');
    expect(byCode.get('L')?.dimension).toBe('VOLUME');
    for (const code of ['pc', 'pack', 'box', 'case', 'sachet', 'bottle', 'cup', 'bag']) {
      expect(byCode.get(code)?.dimension).toBe('COUNT');
    }
  });

  it('declares exactly the six required universal conversions and no packaging conversions', () => {
    const pairs = PHASE_C0_MANIFEST.conversions.map((c) => `${c.fromUnitCode}->${c.toUnitCode}`);
    expect(pairs.sort()).toEqual(['g->kg', 'g->mg', 'kg->g', 'L->mL', 'mg->g', 'mL->L'].sort());

    const forbidden = ['box->pc', 'case->box', 'pack->sachet', 'bag->kg', 'bottle->mL', 'cup->mL'];
    for (const pair of forbidden) {
      expect(pairs).not.toContain(pair);
    }
  });

  it('uses exact, arithmetically-correct factors', () => {
    const byPair = new Map(PHASE_C0_MANIFEST.conversions.map((c) => [`${c.fromUnitCode}->${c.toUnitCode}`, c.factor]));
    expect(byPair.get('kg->g')).toBe('1000');
    expect(byPair.get('g->mg')).toBe('1000');
    expect(byPair.get('L->mL')).toBe('1000');
    expect(byPair.get('g->kg')).toBe('0.001');
    expect(byPair.get('mg->g')).toBe('0.001');
    expect(byPair.get('mL->L')).toBe('0.001');
  });
});

describe('computeManifestFingerprint — deterministic', () => {
  it('is stable across repeated calls on the same manifest', () => {
    expect(computeManifestFingerprint(PHASE_C0_MANIFEST)).toBe(computeManifestFingerprint(PHASE_C0_MANIFEST));
  });

  it('is stable regardless of object key declaration order', () => {
    const reordered = {
      manifestVersion: PHASE_C0_MANIFEST.manifestVersion,
      manifestKey: PHASE_C0_MANIFEST.manifestKey,
      conversions: PHASE_C0_MANIFEST.conversions,
      units: PHASE_C0_MANIFEST.units,
      categories: PHASE_C0_MANIFEST.categories,
    };
    expect(computeManifestFingerprint(reordered as never)).toBe(computeManifestFingerprint(PHASE_C0_MANIFEST));
  });

  it('changes if any manifest field changes', () => {
    const mutated = { ...PHASE_C0_MANIFEST, manifestVersion: 2 };
    expect(computeManifestFingerprint(mutated)).not.toBe(computeManifestFingerprint(PHASE_C0_MANIFEST));
  });
});
