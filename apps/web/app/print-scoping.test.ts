import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Task 209.2 — a normal completed transaction was printing as two sheets
 * with a mostly blank first page. Root cause (confirmed by rendering the
 * real DOM/CSS shape to PDF via Chromium print emulation, before/after this
 * fix): `visibility: hidden` (used to scope printing to #receipt-print-area)
 * keeps hidden ancestors' layout boxes in the flow. The (branch)/(admin)/
 * (supervisor) app shells are `h-screen` (100vh) and the public receipt
 * page's wrapper is `min-h-screen` — their full-viewport invisible boxes
 * were still being paginated, producing a blank leading page (ReceiptModal
 * path) or an unnecessary trailing page (/r/[txn] path). 2 pages -> 1 after
 * hiding/resetting them.
 *
 * These tests pin the mechanism (a print-reset rule/class exists), not
 * exact values, so screen-only styling stays free to retune.
 */

const css = readFileSync(path.resolve(__dirname, './globals.css'), 'utf-8');

describe('globals.css receipt print scoping', () => {
  it('keeps the receipt print scoping rule intact (#receipt-print-area under @media print)', () => {
    expect(css).toMatch(/@media print[\s\S]*#receipt-print-area/);
  });

  it('resets #receipt-print-area to a normal, unclipped flow box in print', () => {
    const printBlock = css.match(/@media print\s*\{[\s\S]*?#receipt-print-area\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(printBlock).toMatch(/position:\s*static/);
    expect(printBlock).toMatch(/transform:\s*none/);
    expect(printBlock).toMatch(/overflow:\s*visible/);
    expect(printBlock).toMatch(/max-height:\s*none/);
  });

  it('caps the printed receipt to a thermal-friendly width', () => {
    const printBlock = css.match(/@media print\s*\{[\s\S]*?#receipt-print-area\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(printBlock).toMatch(/max-width:\s*80mm/);
  });

  it('declares a thermal-friendly @page margin without forcing a paper size', () => {
    const pageRule = css.match(/@page\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(pageRule).toMatch(/margin:/);
    expect(css).not.toMatch(/@page\s*\{[^}]*size:/);
  });

  it('does not force a page break before the receipt content', () => {
    expect(css).not.toMatch(/#receipt-print-area[\s\S]{0,80}page-break-before/);
  });
});

const appShellFiles = ['./(branch)/layout.tsx', './(admin)/layout.tsx', './(supervisor)/layout.tsx'];

describe('app shell hidden during print', () => {
  it.each(appShellFiles)('%s root element is hidden in print', (relativePath) => {
    const source = readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
    const rootDiv = source.match(/<div className="flex h-screen overflow-hidden bg-background[^"]*"/)?.[0] ?? '';
    expect(rootDiv).toMatch(/print:hidden/);
  });
});

describe('dialog chrome hidden during print', () => {
  const dialogSource = readFileSync(path.resolve(__dirname, '../components/ui/dialog.tsx'), 'utf-8');

  it('DialogOverlay is hidden in print', () => {
    const overlay = dialogSource.match(/DialogOverlay[\s\S]*?className=\{cn\(\s*'([^']*)'/)?.[1] ?? '';
    expect(overlay).toMatch(/print:hidden/);
  });

  it('DialogClose button is hidden in print', () => {
    const closeButton = dialogSource.match(/DialogPrimitive\.Close className="([^"]*)"/)?.[1] ?? '';
    expect(closeButton).toMatch(/print:hidden/);
  });

  it('DialogContent resets its fixed/transformed/clipped box for print', () => {
    const content = dialogSource.match(/'app-dialog-padding fixed left-\[50%\][^']*'/)?.[0] ?? '';
    expect(content).toMatch(/print:static/);
    expect(content).toMatch(/print:translate-x-0/);
    expect(content).toMatch(/print:translate-y-0/);
    expect(content).toMatch(/print:overflow-visible/);
    expect(content).toMatch(/print:max-h-none/);
  });
});

describe('public receipt route (/r/[txn]) print scoping', () => {
  const pageSource = readFileSync(path.resolve(__dirname, './r/[txn]/page.tsx'), 'utf-8');

  it('exposes #receipt-print-area', () => {
    expect(pageSource).toContain('id="receipt-print-area"');
  });

  it('collapses the min-h-screen wrapper to natural content height in print', () => {
    const wrapper = pageSource.match(/<div className="flex min-h-screen justify-center[^"]*"/)?.[0] ?? '';
    expect(wrapper).toMatch(/print:min-h-0/);
  });

  it('strips card chrome (border/shadow) for print', () => {
    const card = pageSource.match(/<Card className="([^"]*)"/)?.[1] ?? '';
    expect(card).toMatch(/print:border-none/);
    expect(card).toMatch(/print:shadow-none/);
  });
});
