/**
 * POS-PERF-P64 — Admin's Extra Supplies history and Attendance records live under
 * Reports. Their old standalone URLs redirect here, carrying over only the query
 * params the destination view actually reads.
 */
export const ADMIN_REPORTS_PATH = '/admin/reports';
export const EXTRA_SUPPLIES_REPORT_TAB = 'EXTRA_SUPPLIES';
export const ATTENDANCE_RECORDS_REPORT_TAB = 'ATTENDANCE_RECORDS';

/** Exactly the params ExtraSupplyHistory reads (components/extra-supplies/extra-supply-history.tsx). */
export const EXTRA_SUPPLY_HISTORY_PARAMS = ['branch_id', 'date_from', 'date_to', 'extra_supply_id', 'kind', 'cashier_id', 'issue'] as const;

/** AdminAttendanceReport keeps its filters in local state and reads none from the URL, so nothing is carried over. */
export const ATTENDANCE_RECORDS_PARAMS = [] as const;

/** Longer than any id or date these views accept; a bigger value is not a real filter. */
const MAX_PARAM_LENGTH = 100;

export type RedirectSearchParams = Record<string, string | string[] | undefined>;

/**
 * `/admin/reports?tab=<tab>` plus the allowlisted params. A repeated param (an array),
 * an empty or oversized value, an inherited property and anything off the list are
 * dropped rather than guessed at, and `tab` itself can never be overridden.
 * URLSearchParams does the encoding.
 */
export function buildAdminReportRedirect(tab: string, allowed: ReadonlyArray<string>, searchParams: RedirectSearchParams = {}): string {
  const params = new URLSearchParams({ tab });
  for (const key of allowed) {
    if (key === 'tab' || !Object.prototype.hasOwnProperty.call(searchParams, key)) continue;
    const value = searchParams[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_PARAM_LENGTH) continue;
    params.set(key, trimmed);
  }
  return `${ADMIN_REPORTS_PATH}?${params.toString()}`;
}

export function buildAdminExtraSuppliesRedirect(searchParams: RedirectSearchParams = {}): string {
  return buildAdminReportRedirect(EXTRA_SUPPLIES_REPORT_TAB, EXTRA_SUPPLY_HISTORY_PARAMS, searchParams);
}

export function buildAdminAttendanceRedirect(searchParams: RedirectSearchParams = {}): string {
  return buildAdminReportRedirect(ATTENDANCE_RECORDS_REPORT_TAB, ATTENDANCE_RECORDS_PARAMS, searchParams);
}
