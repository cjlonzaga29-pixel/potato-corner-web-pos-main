import { buildAdminExtraSuppliesRedirect } from '@/lib/admin-report-redirect';
/** POS-PERF-P61 — one honest name per cost source, so a stated figure never reads as an accounting cost. */
export function costSourceLabel(source: 'inventory' | 'configured' | 'unknown'): string {
  if (source === 'inventory') return 'inventory cost';
  if (source === 'configured') return 'stated cost';
  return 'cost not known';
}

/** The role's own history page, read from the URL it's on: /admin/..., /supervisor/... or /branch/.... */
export function extraSuppliesHistoryPath(pathname: string | null): string {
  const role = pathname?.split('/')[1];
  return `/${role === 'admin' || role === 'supervisor' ? role : 'branch'}/extra-supplies`;
}

/**
 * POS-PERF-P64 — link to one issue in the viewer's history. Admin's history
 * lives under Reports (the old /admin/extra-supplies only redirects there).
 */
export function extraSupplyIssueHref(pathname: string | null, issueId: string): string {
  if (pathname?.split('/')[1] === 'admin') return buildAdminExtraSuppliesRedirect({ issue: issueId });
  return `${extraSuppliesHistoryPath(pathname)}?issue=${encodeURIComponent(issueId)}`;
}
