import { describe, it, expect } from 'vitest';
import { dayBounds } from './fraud-rule.utils.js';

describe('dayBounds', () => {
  it('returns the Manila-calendar-day window in UTC instants for a run that fires at 23:00 Manila', () => {
    // 2026-07-17T15:00:00.000Z == 2026-07-17T23:00:00+08:00 (the nightly job's fire time)
    const evaluationDate = new Date('2026-07-17T15:00:00.000Z');

    const { dayStart, dayEnd } = dayBounds(evaluationDate);

    // 2026-07-17T00:00:00+08:00 == 2026-07-16T16:00:00.000Z
    expect(dayStart.toISOString()).toBe('2026-07-16T16:00:00.000Z');
    // 2026-07-17T23:59:59.999+08:00 == 2026-07-17T15:59:59.999Z
    expect(dayEnd.toISOString()).toBe('2026-07-17T15:59:59.999Z');
  });

  it('produces a window exactly 24 hours (minus 1ms) wide', () => {
    const { dayStart, dayEnd } = dayBounds(new Date('2026-01-01T00:00:00.000Z'));
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
