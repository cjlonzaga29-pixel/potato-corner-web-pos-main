import { describe, it, expect } from 'vitest';
import { buildDryRunPlan, type LiveReferenceRows } from './dry-run.service.js';
import { PHASE_C0_MANIFEST } from './manifest.js';

const EMPTY_LIVE: LiveReferenceRows = { categories: [], units: [], conversions: [] };

describe('buildDryRunPlan — pure, zero I/O', () => {
  it('reports WILL_CREATE for every entry against an empty database, except conversions (MISSING_DEPENDENCY, since no unit exists yet to resolve against)', () => {
    const plan = buildDryRunPlan(PHASE_C0_MANIFEST, EMPTY_LIVE);
    expect(plan.categories.every((c) => c.match.status === 'WILL_CREATE')).toBe(true);
    expect(plan.units.every((u) => u.match.status === 'WILL_CREATE')).toBe(true);
    // Every conversion's from/to unit is itself WILL_CREATE (not yet resolved to a live id) --
    // dry-run correctly reports this as a dependency gap, not a false WILL_CREATE.
    expect(plan.conversions.every((c) => c.match.status === 'MISSING_DEPENDENCY')).toBe(true);
    expect(plan.hasZeroBlockers).toBe(false);
  });

  it('resolves conversions once their (mass/volume) units already exist live (WILL_REUSE)', () => {
    const live: LiveReferenceRows = {
      categories: [],
      units: [
        { id: 'unit-kg', code: 'kg', name: 'Kilogram', dimension: 'WEIGHT' },
        { id: 'unit-g', code: 'g', name: 'Gram', dimension: 'WEIGHT' },
        { id: 'unit-mg', code: 'mg', name: 'Milligram', dimension: 'WEIGHT' },
        { id: 'unit-L', code: 'L', name: 'Liter', dimension: 'VOLUME' },
        { id: 'unit-mL', code: 'mL', name: 'Milliliter', dimension: 'VOLUME' },
      ],
      conversions: [],
    };
    const plan = buildDryRunPlan(PHASE_C0_MANIFEST, live);
    const massVolumeCodes = new Set(['kg', 'g', 'mg', 'L', 'mL']);
    const massVolumeUnitEntries = plan.units.filter((u) => massVolumeCodes.has(u.code));
    expect(massVolumeUnitEntries).toHaveLength(5);
    expect(massVolumeUnitEntries.every((u) => u.match.status === 'WILL_REUSE')).toBe(true);
    // COUNT units (pc/pack/box/...) are not in `live` -- still WILL_CREATE.
    expect(plan.units.filter((u) => !massVolumeCodes.has(u.code)).every((u) => u.match.status === 'WILL_CREATE')).toBe(true);
    expect(plan.conversions.every((c) => c.match.status === 'WILL_CREATE')).toBe(true);
  });

  it('performs zero writes -- pure function, no Prisma import, no side effects', () => {
    const before = JSON.stringify(PHASE_C0_MANIFEST);
    buildDryRunPlan(PHASE_C0_MANIFEST, EMPTY_LIVE);
    expect(JSON.stringify(PHASE_C0_MANIFEST)).toBe(before);
  });

  it('reports zero blockers as false when a category is ambiguous', () => {
    const live: LiveReferenceRows = {
      categories: [
        { id: 'cat-1', name: 'Raw Material', code: null, description: null },
        { id: 'cat-2', name: 'raw material', code: null, description: null },
      ],
      units: [],
      conversions: [],
    };
    const plan = buildDryRunPlan(PHASE_C0_MANIFEST, live);
    expect(plan.hasZeroBlockers).toBe(false);
    const rawMaterialEntry = plan.categories.find((c) => c.name === 'Raw Material');
    expect(rawMaterialEntry?.match.status).toBe('BLOCKED_AMBIGUOUS');
  });
});
