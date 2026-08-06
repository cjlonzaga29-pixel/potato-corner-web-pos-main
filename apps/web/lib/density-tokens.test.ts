import { describe, it, expect } from 'vitest';
import {
  DENSITY_CHART_HEIGHT,
  DENSITY_CONTROL_HEIGHT_PX,
  DENSITY_TABLE_ROW_HEIGHT_PX,
  DENSITY_POS_GRID_COLUMNS,
  TOUCH_SAFE_MIN_PX,
} from './density-tokens';
import type { DensityMode } from '@/hooks/use-density-mode';

const ALL_MODES: DensityMode[] = ['comfortable', 'standard', 'compact', 'compact-touch', 'mobile'];
const TOUCH_MODES: DensityMode[] = ['compact-touch', 'mobile'];

describe('density-tokens — every map covers all 5 modes', () => {
  it.each([
    ['DENSITY_CHART_HEIGHT', DENSITY_CHART_HEIGHT],
    ['DENSITY_CONTROL_HEIGHT_PX', DENSITY_CONTROL_HEIGHT_PX],
    ['DENSITY_TABLE_ROW_HEIGHT_PX', DENSITY_TABLE_ROW_HEIGHT_PX],
    ['DENSITY_POS_GRID_COLUMNS', DENSITY_POS_GRID_COLUMNS],
  ])('%s has an entry for every DensityMode', (_name, map) => {
    for (const mode of ALL_MODES) {
      expect(map[mode]).toBeDefined();
    }
  });
});

describe('table/control density stays touch-safe (>=44px) for coarse-pointer modes', () => {
  it.each(TOUCH_MODES)('%s control height meets the 44px touch-target floor', (mode) => {
    expect(DENSITY_CONTROL_HEIGHT_PX[mode]).toBeGreaterThanOrEqual(TOUCH_SAFE_MIN_PX);
  });

  it.each(TOUCH_MODES)('%s table row height meets the 44px touch-target floor', (mode) => {
    expect(DENSITY_TABLE_ROW_HEIGHT_PX[mode]).toBeGreaterThanOrEqual(TOUCH_SAFE_MIN_PX);
  });

  it('fine-pointer compact mode is allowed to go below the touch floor (34-38px range)', () => {
    expect(DENSITY_CONTROL_HEIGHT_PX.compact).toBeLessThan(TOUCH_SAFE_MIN_PX);
    expect(DENSITY_TABLE_ROW_HEIGHT_PX.compact).toBeGreaterThanOrEqual(34);
    expect(DENSITY_TABLE_ROW_HEIGHT_PX.compact).toBeLessThanOrEqual(38);
  });
});

describe('POS grid column counts step down as density tightens', () => {
  it('comfortable has the most columns and mobile has the fewest', () => {
    const columnCount = (mode: DensityMode) => Number(DENSITY_POS_GRID_COLUMNS[mode].replace('grid-cols-', ''));
    expect(columnCount('comfortable')).toBeGreaterThanOrEqual(columnCount('standard'));
    expect(columnCount('standard')).toBeGreaterThanOrEqual(columnCount('compact-touch'));
    expect(columnCount('compact-touch')).toBeGreaterThanOrEqual(columnCount('mobile'));
  });
});
