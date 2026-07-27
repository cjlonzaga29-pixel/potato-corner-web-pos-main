
const BATCH_PREFIX = 'CR006-INGREDIENT';
const BATCH_ID_PATTERN = /^CR006-INGREDIENT-\d{8}-\d{6}$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Formats a batch ID from a Date, in UTC, so the ID is stable regardless of server timezone. */
export function formatMigrationBatchId(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  const h = pad(date.getUTCHours(), 2);
  const mi = pad(date.getUTCMinutes(), 2);
  const s = pad(date.getUTCSeconds(), 2);
  return `${BATCH_PREFIX}-${y}${mo}${d}-${h}${mi}${s}`;
}

export function generateMigrationBatchId(now: Date = new Date()): string {
  return formatMigrationBatchId(now);
}

export function isValidMigrationBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value);
}
