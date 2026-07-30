import { describe, it, expect } from 'vitest';
import { dayBounds, monthBounds, manilaDateKey } from './manila-time.js';

describe('dayBounds', () => {
  it('returns the Manila-calendar-day window in UTC instants for a run that fires at 23:00 Manila', () => {
    // 2026-07-17T15:00:00.000Z == 2026-07-17T23:00:00+08:00
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

  it('assigns a transaction at 1:00 AM Manila to that Manila calendar day, not the prior UTC day', () => {
    // 2026-07-17T01:00:00+08:00 == 2026-07-16T17:00:00.000Z (still July 16 in UTC)
    const txnAt1am = new Date('2026-07-16T17:00:00.000Z');
    const { dayStart, dayEnd } = dayBounds(txnAt1am);
    // Manila day is July 17: 00:00 Manila -> 2026-07-16T16:00:00.000Z
    expect(dayStart.toISOString()).toBe('2026-07-16T16:00:00.000Z');
    expect(txnAt1am.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
    expect(txnAt1am.getTime()).toBeLessThanOrEqual(dayEnd.getTime());
  });

  it('keeps a transaction at 7:59 AM Manila within the same dashboard day, not the previous one', () => {
    // 2026-07-17T07:59:00+08:00 == 2026-07-16T23:59:00.000Z
    const txnAt759am = new Date('2026-07-16T23:59:00.000Z');
    const sameDayEvaluation = new Date('2026-07-17T04:00:00.000Z'); // any instant later that Manila day
    const { dayStart, dayEnd } = dayBounds(sameDayEvaluation);
    expect(txnAt759am.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
    expect(txnAt759am.getTime()).toBeLessThanOrEqual(dayEnd.getTime());

    // And it must NOT fall inside the *previous* Manila day's window.
    const previousDayEvaluation = new Date('2026-07-16T04:00:00.000Z');
    const previousDay = dayBounds(previousDayEvaluation);
    expect(txnAt759am.getTime()).toBeGreaterThan(previousDay.dayEnd.getTime());
  });
});

describe('manilaDateKey', () => {
  it('keys a transaction just after UTC midnight to the Manila calendar day already in progress, not the new UTC day', () => {
    // 2026-07-17T00:30:00.000Z == 2026-07-17T08:30:00+08:00 -> still July 17 in Manila
    expect(manilaDateKey(new Date('2026-07-17T00:30:00.000Z'))).toBe('2026-07-17');
  });

  it('keys a transaction just before UTC midnight to the next Manila calendar day', () => {
    // 2026-07-16T23:30:00.000Z == 2026-07-17T07:30:00+08:00 -> already July 17 in Manila
    expect(manilaDateKey(new Date('2026-07-16T23:30:00.000Z'))).toBe('2026-07-17');
  });

  it('agrees with dayBounds on which calendar day a near-midnight-Manila instant belongs to', () => {
    // 2026-07-16T15:59:59.999Z == 2026-07-16T23:59:59.999+08:00 -> last instant of July 16 in Manila
    const lastInstantOfDay = new Date('2026-07-16T15:59:59.999Z');
    const { dayStart, dayEnd } = dayBounds(lastInstantOfDay);
    expect(manilaDateKey(dayStart)).toBe('2026-07-16');
    expect(manilaDateKey(dayEnd)).toBe('2026-07-16');
    expect(manilaDateKey(lastInstantOfDay)).toBe('2026-07-16');
  });
});

describe('monthBounds', () => {
  it('returns the Manila-calendar-month window in UTC instants', () => {
    // 2026-07-15T04:00:00+08:00 -> July in Manila
    const evaluationDate = new Date('2026-07-14T20:00:00.000Z');
    const { monthStart, monthEnd } = monthBounds(evaluationDate);
    // July 1 00:00 Manila == June 30 16:00 UTC
    expect(monthStart.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    // Aug 1 00:00 Manila minus 1ms == July 31 15:59:59.999 UTC
    expect(monthEnd.toISOString()).toBe('2026-07-31T15:59:59.999Z');
  });
});
