import { describe, it, expect } from 'vitest';
import { formatInventoryQuantity } from './utils';

describe('formatInventoryQuantity — TASK 209.9 gram/kg display conversion', () => {
  it('keeps sub-1000g quantities in grams', () => {
    expect(formatInventoryQuantity(500, 'g')).toBe('500 g');
    expect(formatInventoryQuantity(999, 'g')).toBe('999 g');
  });

  it('converts >=1000g to kg exactly (kg = grams / 1000)', () => {
    expect(formatInventoryQuantity(1000, 'g')).toBe('1 kg');
    expect(formatInventoryQuantity(1250, 'g')).toBe('1.25 kg');
    expect(formatInventoryQuantity(13620, 'g')).toBe('13.62 kg');
    expect(formatInventoryQuantity(25000, 'g')).toBe('25 kg');
  });

  it('never converts non-gram units', () => {
    expect(formatInventoryQuantity(135, 'pc')).toBe('135 pc');
    expect(formatInventoryQuantity(2.5, 'kg')).toBe('2.5 kg');
    expect(formatInventoryQuantity(750, 'mL')).toBe('750 mL');
  });

  it('renders zero and negative quantities without crashing', () => {
    expect(formatInventoryQuantity(0, 'g')).toBe('0 g');
    expect(formatInventoryQuantity(0, 'pc')).toBe('0 pc');
    expect(formatInventoryQuantity(-5, 'pc')).toBe('-5 pc');
  });
});
