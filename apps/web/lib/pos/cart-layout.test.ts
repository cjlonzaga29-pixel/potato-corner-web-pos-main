import { describe, it, expect } from 'vitest';
import { shouldShowInlineCart } from './cart-layout';
import type { DensityMode } from '@/hooks/use-density-mode';

describe('shouldShowInlineCart — POS terminal inline-cart-vs-Sheet decision (Task 200)', () => {
  it('mobile always uses the Sheet, regardless of "room"', () => {
    expect(shouldShowInlineCart('mobile', true)).toBe(false);
    expect(shouldShowInlineCart('mobile', false)).toBe(false);
  });

  it('comfortable, standard, and compact render the cart inline when there is room for the panel', () => {
    const fineTiers: DensityMode[] = ['comfortable', 'standard', 'compact'];
    for (const mode of fineTiers) {
      expect(shouldShowInlineCart(mode, true)).toBe(true);
    }
  });

  it('compact-touch renders inline only when there is room for the panel', () => {
    expect(shouldShowInlineCart('compact-touch', true)).toBe(true);
    expect(shouldShowInlineCart('compact-touch', false)).toBe(false);
  });

  /**
   * Task 209.54 — the confirmed real-world defect this guards against: a
   * fine-pointer (mouse) viewport narrower than the 1024px `lg` breakpoint
   * classifies as 'standard' (classifyDensity has no minimum width for it
   * beyond the mobile cutoff), which used to force `isDesktop: true`
   * regardless of actual width — hiding the inline panel (CSS gates it at
   * 1024px) while also skipping the mobile Sheet fallback, leaving no cart
   * UI in the DOM at all at e.g. 768px width. Every non-mobile tier must now
   * fall back to the Sheet when the panel genuinely doesn't have room, the
   * same as compact-touch always did.
   */
  it('falls back to the Sheet for any non-mobile tier when there is no room for the panel — the "neither cart UI renders" regression', () => {
    const nonMobileTiers: DensityMode[] = ['comfortable', 'standard', 'compact', 'compact-touch'];
    for (const mode of nonMobileTiers) {
      expect(shouldShowInlineCart(mode, false)).toBe(false);
    }
  });
});
