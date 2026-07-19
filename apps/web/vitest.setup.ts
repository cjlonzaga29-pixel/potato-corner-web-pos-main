import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver — Radix primitives (Select, ScrollArea, etc.)
// call it on mount, which otherwise throws in every test that renders one.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
