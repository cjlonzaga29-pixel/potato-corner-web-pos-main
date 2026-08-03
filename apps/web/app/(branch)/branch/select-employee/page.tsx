'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES } from '@potato-corner/shared';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useAuth } from '@/hooks/use-auth';

/**
 * Task 120: this route is no longer where ROLE_DASHBOARDS sends a `branch`
 * login (that's /branch/dashboard now) or where the POS Terminal's own
 * "Who's working?" picker lives (that's inline STATE 1 of
 * terminal/page.tsx). Kept only as a redirect for any stale bookmark/link,
 * so a direct hit on this URL still lands somewhere useful instead of
 * 404ing or — the old bug this task fixed — authenticating as a different
 * user just by visiting a page.
 */
export default function SelectEmployeePage() {
  const router = useRouter();
  const { user } = useAuth();

  useEffect(() => {
    if (user?.role === ROLES.BRANCH || user?.role === ROLES.STAFF) {
      router.replace('/branch/terminal');
    }
  }, [user?.role, router]);

  return (
    <div className="flex justify-center py-16">
      <LoadingSpinner size="lg" />
    </div>
  );
}
