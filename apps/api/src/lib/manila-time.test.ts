import { describe, it, expect } from 'vitest';
import { dayBounds, monthBounds, manilaDateKey, manilaDateStringToUtc, resolveDateRangeBoundary } from './manila-time.js';

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

describe('manilaDateStringToUtc', () => {
  it('resolves a Manila business date to the UTC instant of that date\'s Manila midnight', () => {
    // 2026-07-30 00:00 Manila == 2026-07-29 16:00 UTC
    expect(manilaDateStringToUtc('2026-07-30').toISOString()).toBe('2026-07-29T16:00:00.000Z');
  });

  it('round-trips through manilaDateKey back to the original date string', () => {
    expect(manilaDateKey(manilaDateStringToUtc('2026-07-30'))).toBe('2026-07-30');
    expect(manilaDateKey(manilaDateStringToUtc('2026-01-01'))).toBe('2026-01-01');
    expect(manilaDateKey(manilaDateStringToUtc('2026-12-31'))).toBe('2026-12-31');
  });

  it('falls inside dayBounds() for the same calendar date, so an expense and a same-day transaction agree', () => {
    const incurredAt = manilaDateStringToUtc('2026-07-30');
    const { dayStart, dayEnd } = dayBounds(incurredAt);
    expect(incurredAt.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
    expect(incurredAt.getTime()).toBeLessThanOrEqual(dayEnd.getTime());
  });

  it('handles a month boundary correctly (July 31 -> August 1, not off by a day)', () => {
    expect(manilaDateStringToUtc('2026-07-31').toISOString()).toBe('2026-07-30T16:00:00.000Z');
    expect(manilaDateStringToUtc('2026-08-01').toISOString()).toBe('2026-07-31T16:00:00.000Z');
  });

  it('handles a leap day (2028-02-29)', () => {
    expect(manilaDateStringToUtc('2028-02-29').toISOString()).toBe('2028-02-28T16:00:00.000Z');
    expect(manilaDateKey(manilaDateStringToUtc('2028-02-29'))).toBe('2028-02-29');
  });
});

describe('resolveDateRangeBoundary', () => {
  it('widens a bare start-of-range date to Manila midnight, not UTC midnight', () => {
    // Manila 2026-07-30 00:00 == UTC 2026-07-29T16:00:00.000Z
    expect(resolveDateRangeBoundary('2026-07-30', 'start').toISOString()).toBe('2026-07-29T16:00:00.000Z');
  });

  it('widens a bare end-of-range date to the last instant of the Manila day', () => {
    // Manila 2026-07-30 23:59:59.999 == UTC 2026-07-30T15:59:59.999Z
    expect(resolveDateRangeBoundary('2026-07-30', 'end').toISOString()).toBe('2026-07-30T15:59:59.999Z');
  });

  it('keeps an early-morning Manila instant (e.g. a 1am clock-in) inside the widened start boundary for its own date', () => {
    const clockInAt1amManila = new Date('2026-07-29T17:00:00.000Z'); // 2026-07-30T01:00+08:00
    const start = resolveDateRangeBoundary('2026-07-30', 'start');
    expect(clockInAt1amManila.getTime()).toBeGreaterThanOrEqual(start.getTime());
  });

  it('passes an already-precise ISO datetime through unchanged, for callers that already know the exact instant they want', () => {
    expect(resolveDateRangeBoundary('2026-07-30T03:15:00.000Z', 'start').toISOString()).toBe('2026-07-30T03:15:00.000Z');
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
