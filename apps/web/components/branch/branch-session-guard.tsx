'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ROLES } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';

const EMPLOYEE_REQUIRED_PREFIX = '/branch/terminal';
const EXEMPT_PATHS = new Set(['/branch/select-employee', '/branch/profile']);

/**
 * CR-010 R5 — Branch Employee Authorization: only the POS Terminal needs an
 * active Employee selected (it's the one surface where "who rang this up"
 * matters). Every other branch page (Dashboard, Inventory, Receiving,
 * Transfers, Waste, Adjustments, Stock Count, Products, Sales, Reports,
 * etc.) must open immediately for a `branch` session with no employee
 * chosen yet. Not a security boundary (the API still enforces access
 * per-route, same as BranchGuard elsewhere) — this only steers navigation.
 */
export function BranchSessionGuard() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const requiresEmployee = pathname === EMPLOYEE_REQUIRED_PREFIX || pathname.startsWith(`${EMPLOYEE_REQUIRED_PREFIX}/`);
    if (user?.role === ROLES.BRANCH && requiresEmployee && !EXEMPT_PATHS.has(pathname)) {
      router.replace('/branch/select-employee');
    }
  }, [user?.role, pathname, router]);

  return null;
}
