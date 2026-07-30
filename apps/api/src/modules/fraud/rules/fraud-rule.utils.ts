/**
 * Re-exported from the canonical shared location (lib/manila-time.ts) so
 * every fraud rule keeps importing `dayBounds` from here unchanged — the
 * implementation itself now lives outside modules/fraud so branches,
 * employees, and reports can reuse the exact same Manila-day math instead of
 * each rolling a naive UTC-midnight window.
 */
export { dayBounds } from '../../../lib/manila-time.js';
