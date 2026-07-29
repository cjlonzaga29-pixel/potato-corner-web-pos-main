import { describe, expect, it } from 'vitest';
import { assertPosTransactionTimingSane, posTransactionMaxWaitMsSchema, posTransactionTimeoutMsSchema } from './index.js';

describe('posTransactionMaxWaitMsSchema / posTransactionTimeoutMsSchema', () => {
  it('default to 10000ms / 30000ms when unset', () => {
    expect(posTransactionMaxWaitMsSchema.parse(undefined)).toBe(10_000);
    expect(posTransactionTimeoutMsSchema.parse(undefined)).toBe(30_000);
  });

  it('accepts a positive integer string (env vars are always strings)', () => {
    expect(posTransactionMaxWaitMsSchema.parse('15000')).toBe(15_000);
    expect(posTransactionTimeoutMsSchema.parse('45000')).toBe(45_000);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1000'],
    ['non-numeric', 'not-a-number'],
    ['fractional', '1500.5'],
    ['unreasonably large maxWait', '999999'],
  ])('rejects %s', (_label, value) => {
    expect(posTransactionMaxWaitMsSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1000'],
    ['non-numeric', 'not-a-number'],
    ['fractional', '1500.5'],
    ['unreasonably large timeout', '999999999'],
  ])('rejects %s for timeout', (_label, value) => {
    expect(posTransactionTimeoutMsSchema.safeParse(value).success).toBe(false);
  });
});

describe('assertPosTransactionTimingSane', () => {
  it('accepts the recommended defaults', () => {
    expect(() => assertPosTransactionTimingSane(10_000, 30_000)).not.toThrow();
  });

  it('accepts maxWait equal to timeout', () => {
    expect(() => assertPosTransactionTimingSane(10_000, 10_000)).not.toThrow();
  });

  it('rejects a maxWait greater than the timeout', () => {
    expect(() => assertPosTransactionTimingSane(40_000, 30_000)).toThrow(/must not exceed/);
  });
});
