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

// jsdom has no createObjectURL/revokeObjectURL — needed by file-preview
// components (e.g. GcashQrUploader) that build an <img> preview from a
// locally-selected File.
if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = () => 'blob:mock-url';
}
if (typeof URL.revokeObjectURL === 'undefined') {
  URL.revokeObjectURL = () => {};
}
