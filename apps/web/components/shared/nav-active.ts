import type { NavItem } from '@/components/shared/nav-types';

function matchesPrefix(pathname: string, href: string): boolean {
  const base = href.split('?')[0] ?? href;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** True when the path sits under one of the item's `activePrefixes` (old URLs it replaced). */
export function matchesActivePrefix(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  return (item.activePrefixes ?? []).some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * POS-PERF-P40R — a top-level item is active on its own href and on any of
 * its `activePrefixes`, e.g. Supervisors on /admin/employees/:id (person
 * pages kept their old URL) and on the redirecting /admin/employees.
 */
export function isNavItemActive(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  return (item.href !== undefined && matchesPrefix(pathname, item.href)) || matchesActivePrefix(pathname, item);
}
