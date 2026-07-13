const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;

type DurationUnit = keyof typeof UNIT_MS;

function isDurationUnit(value: string): value is DurationUnit {
  return value in UNIT_MS;
}

/** Parses simple duration strings like "15m", "7d", "1h" into milliseconds. */
export function parseDurationMs(input: string): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${input}"`);
  }
  const [, amount, unit] = match;
  if (!amount || !unit || !isDurationUnit(unit)) {
    throw new Error(`Invalid duration string: "${input}"`);
  }
  return Number(amount) * UNIT_MS[unit];
}
