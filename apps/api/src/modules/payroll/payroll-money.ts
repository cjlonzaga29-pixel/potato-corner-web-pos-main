/**
 * POS-PERF-P52 — exact money arithmetic for payroll. Amounts are integer
 * centavos (bigint); time is integer milliseconds. Nothing here ever touches
 * a floating-point number, so summing thousands of shifts cannot drift.
 */

export const MS_PER_HOUR = 3_600_000n;

/** "75" | "75.5" | "75.50" → 7550n. Input must already match /^\d+(\.\d{1,2})?$/ (Zod-validated). */
export function parsePesoToCentavos(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid peso amount: ${value}`);
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + fraction;
}

/** Prisma Decimal / numeric string with ≤ 2 decimals → centavos. Uses the decimal's own string form, never Number(). */
export function decimalToCentavos(value: { toFixed(digits: number): string } | string): bigint {
  const text = typeof value === 'string' ? value : value.toFixed(2);
  const negative = text.startsWith('-');
  const centavos = parsePesoToCentavos(negative ? text.slice(1) : text);
  return negative ? -centavos : centavos;
}

/** -123456n → "-1234.56" */
export function formatCentavos(centavos: bigint): string {
  const negative = centavos < 0n;
  const abs = negative ? -centavos : centavos;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Integer division rounding half away from zero (half-up for the non-negative amounts payroll produces). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -quotient : quotient;
}

/**
 * Exact pay for a stretch of time, in "centavo-milliseconds" (hourly rate in
 * centavos × payable ms). Sum these, then convert once with
 * centavoMsToCentavos — rounding happens exactly once per sum.
 */
export function centavoMs(hourlyCentavos: bigint, payableMs: number): bigint {
  return hourlyCentavos * BigInt(payableMs);
}

export function centavoMsToCentavos(total: bigint): bigint {
  return divRoundHalfUp(total, MS_PER_HOUR);
}

/** Display-only per-minute rate (hourly ÷ 60) with 4 decimals, e.g. 7550n → "1.2583". */
export function perMinuteDisplay(hourlyCentavos: bigint): string {
  const tenThousandths = divRoundHalfUp(hourlyCentavos * 100n, 60n);
  const whole = tenThousandths / 10_000n;
  const fraction = (tenThousandths % 10_000n).toString().padStart(4, '0');
  return `${whole.toString()}.${fraction}`;
}

/** Minutes as a fixed 2-decimal string for display/export ("479.52"), from exact ms. Display only. */
export function msToMinutesText(ms: number): string {
  const hundredths = divRoundHalfUp(BigInt(ms) * 100n, 60_000n);
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** "7h 59m 31s" style duration for people. Display only; never fed back into a calculation. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
}
