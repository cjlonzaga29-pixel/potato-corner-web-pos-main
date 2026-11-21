import { redirect } from 'next/navigation';
import { buildAdminExtraSuppliesRedirect, type RedirectSearchParams } from '@/lib/admin-report-redirect';

/**
 * POS-PERF-P64 — Admin's Extra Supplies history moved under Reports
 * (Inventory › Extra Supplies). Old links and bookmarks land there with only
 * the history's own filters carried over. Role protection is unchanged: this
 * route is still inside the (admin) group the middleware guards.
 */
export default async function AdminExtraSuppliesRedirectPage({ searchParams }: { searchParams: Promise<RedirectSearchParams> }): Promise<never> {
  redirect(buildAdminExtraSuppliesRedirect(await searchParams));
}
