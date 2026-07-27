import { Prisma } from '@prisma/client';

/**
 * CR-009.1 — Decimal fingerprint canonicalization (resolved).
 * decimalCanonicalizationVersion: 1.
 *
 * Rules, applied in order, NEVER through JavaScript `Number` at any step:
 *  1. Parse using `Prisma.Decimal`, never `Number`.
 *  2. Reject invalid decimal strings (throw).
 *  3. Reject `NaN` and `Infinity` (throw).
 *  4. Normalize negative zero (`-0`, `-0.000`) to `0`.
 *  5. Convert to a non-exponent, base-10 string.
 *  6. Strip insignificant trailing fractional zeros.
 *  7. Strip the decimal point when no fractional digits remain.
 *  8. Preserve all significant digits — no precision loss.
 *  9. Never round-trip through JavaScript `Number` at any step.
 *  10. Scientific-notation manifest input (e.g. "1e3") is rejected (throw),
 *      not expanded — a manifest-validation-time rejection, not a
 *      canonicalization step.
 *
 * Worked examples: "1000" -> "1000"; "1000.0" -> "1000";
 * "1000.000000" -> "1000"; "0.001000" -> "0.001"; "-0.000" -> "0";
 * "1.2300400" -> "1.23004". `1` and `1.0001` remain distinct.
 */

// Strict base-10 decimal string: optional leading "-", one or more digits,
// optional "." followed by one or more digits. No exponent, no leading "+",
// no thousands separators, no whitespace.
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

export function canonicalizeDecimal(value: string | Prisma.Decimal): string {
  let decimal: Prisma.Decimal;

  if (typeof value === 'string') {
    if (!DECIMAL_STRING_PATTERN.test(value)) {
      throw new Error(`canonicalizeDecimal: invalid decimal string "${value}"`);
    }
    decimal = new Prisma.Decimal(value);
  } else if (value instanceof Prisma.Decimal) {
    decimal = value;
  } else {
    throw new Error('canonicalizeDecimal: value must be a string or Prisma.Decimal');
  }

  if (decimal.isNaN()) {
    throw new Error('canonicalizeDecimal: NaN is not a valid decimal value');
  }
  if (!decimal.isFinite()) {
    throw new Error('canonicalizeDecimal: Infinity is not a valid decimal value');
  }

  if (decimal.isZero()) {
    return '0';
  }

  // .toFixed() with no argument renders the Decimal in normal (non-exponent)
  // notation, at full precision, without rounding — decimal.js-native, never
  // touches JS `Number`.
  let canonical = decimal.toFixed();

  if (canonical.includes('.')) {
    canonical = canonical.replace(/0+$/, '');
    canonical = canonical.replace(/\.$/, '');
  }

  return canonical;
}
