import { describe, it, expect } from 'vitest';
import { strongPasswordSchema } from '@potato-corner/shared';
import { generateTemporaryPassword } from './generate-password.js';

describe('generateTemporaryPassword', () => {
  it('always satisfies strongPasswordSchema', () => {
    for (let i = 0; i < 200; i += 1) {
      const result = strongPasswordSchema.safeParse(generateTemporaryPassword());
      expect(result.success).toBe(true);
    }
  });

  it('respects a custom length', () => {
    expect(generateTemporaryPassword(16)).toHaveLength(16);
  });

  it('never repeats across calls', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
    expect(passwords.size).toBe(50);
  });
});
