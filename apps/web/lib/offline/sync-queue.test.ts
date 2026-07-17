import { describe, it, expect } from 'vitest';
import { manilaDateString } from './sync-queue';

describe('manilaDateString', () => {
  it('uses Asia/Manila local date, not UTC — the bug this locks in a regression test for', () => {
    // 2026-01-15T23:30:00Z is 2026-01-16T07:30:00+08:00 in Manila —
    // already the next day locally, even though the UTC date is still the
    // 15th. The old Date.prototype.toISOString().slice(0, 10) approach
    // would have returned "2026-01-15" here, violating CLAUDE.md's Offline
    // Receipt Numbers rule ("resets to 1 at midnight") by rolling the date
    // over 8 hours late relative to actual Manila midnight.
    const utcLateNight = new Date('2026-01-15T23:30:00Z');
    expect(manilaDateString(utcLateNight)).toBe('2026-01-16');
  });

  it('matches the UTC date for times well inside the Manila business day', () => {
    // 2026-01-15T04:00:00Z is 2026-01-15T12:00:00+08:00 — same calendar
    // date in both zones, so this should NOT falsely appear broken either
    // way (guards against a fix that's UTC-blind in the other direction).
    const midday = new Date('2026-01-15T04:00:00Z');
    expect(manilaDateString(midday)).toBe('2026-01-15');
  });

  it('rolls over exactly at Manila local midnight (UTC 16:00 the previous day)', () => {
    const oneMinuteBeforeManilaMidnight = new Date('2026-01-15T15:59:00Z'); // 2026-01-15 23:59 +08:00
    const exactlyManilaMidnight = new Date('2026-01-15T16:00:00Z'); // 2026-01-16 00:00 +08:00

    expect(manilaDateString(oneMinuteBeforeManilaMidnight)).toBe('2026-01-15');
    expect(manilaDateString(exactlyManilaMidnight)).toBe('2026-01-16');
  });
});
