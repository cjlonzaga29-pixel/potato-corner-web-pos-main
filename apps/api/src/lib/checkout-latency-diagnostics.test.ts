import { describe, expect, it } from 'vitest';
import { createCheckoutLatencyRecorder, timeStage } from './checkout-latency-diagnostics.js';

describe('createCheckoutLatencyRecorder', () => {
  it('disabled: is inert — no correlation id, snapshot stays empty regardless of marks', () => {
    const recorder = createCheckoutLatencyRecorder(false);
    expect(recorder.enabled).toBe(false);
    expect(recorder.correlationId).toBeNull();
    recorder.mark('someStage', 123);
    expect(recorder.snapshot()).toEqual({});
  });

  it('enabled: generates a correlation id and records marked stage durations', () => {
    const recorder = createCheckoutLatencyRecorder(true);
    expect(recorder.enabled).toBe(true);
    expect(typeof recorder.correlationId).toBe('string');
    expect(recorder.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    recorder.mark('branchShiftLookup', 12.6);
    recorder.mark('costLookup', 3.2);
    expect(recorder.snapshot()).toEqual({ branchShiftLookup: 13, costLookup: 3 });
  });

  it('two concurrently created recorders never share state or correlation ids', () => {
    const a = createCheckoutLatencyRecorder(true);
    const b = createCheckoutLatencyRecorder(true);
    expect(a.correlationId).not.toBe(b.correlationId);
    a.mark('saleInsert', 10);
    b.mark('saleInsert', 20);
    expect(a.snapshot()).toEqual({ saleInsert: 10 });
    expect(b.snapshot()).toEqual({ saleInsert: 20 });
  });

  it('snapshot() returns a defensive copy — mutating it does not affect the recorder', () => {
    const recorder = createCheckoutLatencyRecorder(true);
    recorder.mark('stockRead', 5);
    const snap = recorder.snapshot();
    snap.stockRead = 999;
    snap.injected = 1;
    expect(recorder.snapshot()).toEqual({ stockRead: 5 });
  });
});

describe('timeStage', () => {
  it('disabled recorder: resolves fn()\'s value unchanged and records nothing', async () => {
    const recorder = createCheckoutLatencyRecorder(false);
    const result = await timeStage(recorder, 'advisoryLocks', async () => 'ok');
    expect(result).toBe('ok');
    expect(recorder.snapshot()).toEqual({});
  });

  it('enabled recorder: resolves fn()\'s value unchanged and records a duration for the stage', async () => {
    const recorder = createCheckoutLatencyRecorder(true);
    const result = await timeStage(recorder, 'stockUpdates', async () => 42);
    expect(result).toBe(42);
    const snap = recorder.snapshot();
    expect(snap.stockUpdates).toBeTypeOf('number');
    expect(snap.stockUpdates).toBeGreaterThanOrEqual(0);
  });

  it('propagates a rejection from fn() unchanged, and still records the stage duration', async () => {
    const recorder = createCheckoutLatencyRecorder(true);
    const boom = new Error('boom');
    await expect(
      timeStage(recorder, 'ledgerWrites', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(recorder.snapshot()).toHaveProperty('ledgerWrites');
  });
});
