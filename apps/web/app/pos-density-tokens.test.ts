import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Task 209.20 — the POS cart/checkout footer used to hardcode its own
 * spacing with a single `lg:` (width-only) Tailwind breakpoint, so a
 * 1920x1080 monitor and a 1366x768 laptop (both >=1024px wide) rendered
 * identical padding/gaps despite very different vertical room. These tests
 * pin the mechanism — that the new `--app-pos-*` vertical-density tokens
 * exist, vary across the height-aware media query and the `comfortable`/
 * `compact-touch`/`mobile` data-density tiers, and that the utility classes
 * consuming them exist — not exact pixel values, so retuning stays free.
 */

const css = readFileSync(path.resolve(__dirname, './globals.css'), 'utf-8');

const POS_VERTICAL_TOKENS = [
  '--app-pos-panel-gap',
  '--app-pos-footer-gap',
  '--app-pos-section-padding',
  '--app-pos-proof-padding',
  '--app-pos-proof-preview-height',
  '--app-pos-helper-font-size',
  '--app-pos-cart-header-height',
  '--app-pos-total-row-height',
] as const;

function rootBlock(): string {
  return css.match(/@layer base \{\s*:root \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
}

function heightAwareBlock(): string {
  return css.match(/@media \(min-width: 1024px\) and \(max-height: 820px\) \{\s*:root \{([\s\S]*?)\}\s*\}/)?.[1] ?? '';
}

function densityBlock(mode: string): string {
  const re = new RegExp(`:root\\[data-density='${mode}'\\] \\{([\\s\\S]*?)\\n {2}\\}`);
  return css.match(re)?.[1] ?? '';
}

describe('globals.css — POS vertical-density tokens (Task 209.20)', () => {
  it.each(POS_VERTICAL_TOKENS)('%s is defined in the :root default block', (token) => {
    expect(rootBlock()).toContain(token);
  });

  it('the height-aware compact tier (1024px+ wide, <=820px tall) overrides every POS vertical token', () => {
    const block = heightAwareBlock();
    for (const token of POS_VERTICAL_TOKENS) {
      expect(block).toContain(token);
    }
  });

  it('the comfortable tier overrides every POS vertical token with roomier values', () => {
    const block = densityBlock('comfortable');
    for (const token of POS_VERTICAL_TOKENS) {
      expect(block).toContain(token);
    }
  });

  it('compact-touch and mobile override every POS vertical token, staying touch-safe', () => {
    for (const mode of ['compact-touch', 'mobile']) {
      const block = densityBlock(mode);
      for (const token of POS_VERTICAL_TOKENS) {
        expect(block).toContain(token);
      }
    }
  });

  it('compact cart header height is shorter than comfortable/touch cart header height', () => {
    const compactHeight = heightAwareBlock().match(/--app-pos-cart-header-height:\s*([\d.]+)rem/)?.[1];
    const comfortableHeight = densityBlock('comfortable').match(/--app-pos-cart-header-height:\s*([\d.]+)rem/)?.[1];
    expect(Number(compactHeight)).toBeLessThan(Number(comfortableHeight));
  });

  it('every POS vertical utility class references its token', () => {
    const utilities: [string, string][] = [
      ['.app-pos-panel-gap', '--app-pos-panel-gap'],
      ['.app-pos-footer', '--app-pos-footer-gap'],
      ['.app-pos-footer', '--app-pos-section-padding'],
      ['.app-pos-proof-padding', '--app-pos-proof-padding'],
      ['.app-pos-proof-preview-height', '--app-pos-proof-preview-height'],
      ['.app-pos-helper-text', '--app-pos-helper-font-size'],
      ['.app-pos-cart-header', '--app-pos-cart-header-height'],
      ['.app-pos-total-row', '--app-pos-total-row-height'],
    ];
    for (const [className, token] of utilities) {
      const escaped = className.replace('.', '\\.');
      const rule = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
      expect(rule?.[1] ?? '').toContain(token);
    }
  });
});

describe('globals.css — POS cart width narrowed toward the 27-29% fine-pointer target (Task 209.20)', () => {
  it('fine-pointer tiers (root default, height-aware compact, comfortable) use 28%, not 30-32%', () => {
    expect(rootBlock()).toMatch(/--app-pos-cart-width:\s*28%/);
    expect(heightAwareBlock()).toMatch(/--app-pos-cart-width:\s*28%/);
    expect(densityBlock('comfortable')).toMatch(/--app-pos-cart-width:\s*28%/);
  });

  it('compact-touch keeps its own wider 32% touch-safe override', () => {
    expect(densityBlock('compact-touch')).toMatch(/--app-pos-cart-width:\s*32%/);
  });
});
