import { randomInt } from 'node:crypto';

// Visually-unambiguous charset (no 0/O, 1/l/I).
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%^&*-_=+';
const ALL = UPPER + LOWER + DIGITS + SPECIAL;

function pick(charset: string): string {
  return charset[randomInt(charset.length)] as string;
}

/**
 * Generates a secure temporary password satisfying strongPasswordSchema
 * (packages/shared/src/schemas/auth.schema.ts: min 8 chars, upper, lower,
 * digit, special char) for admin-triggered "generate" password resets.
 * Never persisted anywhere — the caller must return/display it exactly once.
 */
export function generateTemporaryPassword(length = 12): string {
  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pick(ALL));
  const chars = [...required, ...rest];

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = chars[i] as string;
    const b = chars[j] as string;
    chars[i] = b;
    chars[j] = a;
  }

  return chars.join('');
}
