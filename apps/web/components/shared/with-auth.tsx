'use client';

import { useEffect, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_DASHBOARDS, type Role } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';

/**
 * Fallback client-side guard for a page component, in addition to (not
 * instead of) apps/web/middleware.ts — the middleware is the primary gate
 * and runs before any page code executes; this catches the edge case
 * where a client-side navigation renders a page without a full
 * middleware round-trip.
 */
export function withAuth<P extends object>(Component: ComponentType<P>, allowedRoles?: Role[]) {
  function Guarded(props: P) {
    const { user, isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const isRoleAllowed = !allowedRoles || (user && allowedRoles.includes(user.role));

    useEffect(() => {
      if (isLoading) return;
      if (!isAuthenticated || !user) {
        router.replace('/login');
        return;
      }
      if (!isRoleAllowed) {
        router.replace(ROLE_DASHBOARDS[user.role]);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoading, isAuthenticated, user, router]);

    if (isLoading || !isAuthenticated || !user || !isRoleAllowed) {
      return null;
    }

    return <Component {...props} />;
  }

  Guarded.displayName = `withAuth(${Component.displayName ?? Component.name ?? 'Component'})`;
  return Guarded;
}
