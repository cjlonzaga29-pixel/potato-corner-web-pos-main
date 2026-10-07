import { describe, it, expect, beforeEach } from 'vitest';
import { nextOrderRef, formatOrderRef } from './order-reference';

beforeEach(() => {
  localStorage.clear();
});

describe('nextOrderRef', () => {
  it('increments per branch, starting at 1', () => {
    expect(nextOrderRef('branch-a')).toBe(1);
    expect(nextOrderRef('branch-a')).toBe(2);
    expect(nextOrderRef('branch-a')).toBe(3);
  });

  it('is independent per branch', () => {
    expect(nextOrderRef('branch-a')).toBe(1);
    expect(nextOrderRef('branch-b')).toBe(1);
    expect(nextOrderRef('branch-a')).toBe(2);
  });

  it('stays stable/distinct across a reload (persisted, not re-derived from in-memory state)', () => {
    nextOrderRef('branch-a');
    nextOrderRef('branch-a');
    // Simulates a fresh module/page load: nothing but localStorage carries over.
    expect(nextOrderRef('branch-a')).toBe(3);
  });
});

describe('formatOrderRef', () => {
  it('zero-pads to at least 2 digits', () => {
    expect(formatOrderRef(1)).toBe('#01');
    expect(formatOrderRef(9)).toBe('#09');
  });

  it('never truncates a value already past 2 digits', () => {
    expect(formatOrderRef(123)).toBe('#123');
  });
});
