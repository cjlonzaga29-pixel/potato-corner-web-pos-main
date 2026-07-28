const BATCH_PREFIX = 'PHASEC0-REFINIT';
const BATCH_ID_PATTERN = /^PHASEC0-REFINIT-\d{8}-\d{6}$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Same UTC-stable format convention as `inventory-migration/migration-batch.ts`, distinct prefix. */
export function generateReferenceInitBatchId(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1, 2);
  const d = pad(now.getUTCDate(), 2);
  const h = pad(now.getUTCHours(), 2);
  const mi = pad(now.getUTCMinutes(), 2);
  const s = pad(now.getUTCSeconds(), 2);
  return `${BATCH_PREFIX}-${y}${mo}${d}-${h}${mi}${s}`;
}

export function isValidReferenceInitBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value);
}
