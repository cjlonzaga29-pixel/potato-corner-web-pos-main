'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ROLES } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';

const EXEMPT_PATHS = new Set(['/branch/select-employee', '/branch/profile']);

/**
 * Branch Employee Authorization: a `branch` (Branch Account) session that
 * hasn't yet selected an Employee has nothing to operate the branch as —
 * redirect it to the employee picker for every page except the picker
 * itself and its own account profile. Not a security boundary (the API
 * still enforces access per-route, same as BranchGuard elsewhere) — this
 * only steers navigation so the Branch Account doesn't land on POS/
 * inventory/reports pages before selecting who's actually working.
 */
export function BranchSessionGuard() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (user?.role === ROLES.BRANCH && !EXEMPT_PATHS.has(pathname)) {
      router.replace('/branch/select-employee');
    }
  }, [user?.role, pathname, router]);

  return null;
}
