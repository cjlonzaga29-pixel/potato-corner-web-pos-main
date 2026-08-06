import { describe, it, expect } from 'vitest';
import { shouldShowInlineCart } from './cart-layout';
import type { DensityMode } from '@/hooks/use-density-mode';

describe('shouldShowInlineCart — POS terminal inline-cart-vs-Sheet decision (Task 200)', () => {
  it('mobile always uses the Sheet, regardless of "room"', () => {
    expect(shouldShowInlineCart('mobile', true)).toBe(false);
    expect(shouldShowInlineCart('mobile', false)).toBe(false);
  });

  it('comfortable, standard, and compact always render the cart inline', () => {
    const alwaysInline: DensityMode[] = ['comfortable', 'standard', 'compact'];
    for (const mode of alwaysInline) {
      expect(shouldShowInlineCart(mode, true)).toBe(true);
      expect(shouldShowInlineCart(mode, false)).toBe(true);
    }
  });

  it('compact-touch renders inline only when there is room for the panel', () => {
    expect(shouldShowInlineCart('compact-touch', true)).toBe(true);
    expect(shouldShowInlineCart('compact-touch', false)).toBe(false);
  });
});
