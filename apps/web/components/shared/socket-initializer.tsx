'use client';

import { useEffect } from 'react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { useSocket } from '@/hooks/use-socket';
import { useAuthStore } from '@/stores/auth.store';
import { useBranchRealtimeSync } from '@/hooks/queries/use-branches';
import { refreshAuthSession } from '@/hooks/use-auth';
import { broadcastLogout } from '@/lib/auth-broadcast';

/**
 * Mounts once per role layout to establish the Socket.io connection and
 * join the correct room(s) for the current user. Renders nothing — this
 * exists so the role layouts (Server Components) can trigger a client
 * hook without themselves becoming Client Components.
 *
 * Also keeps every branch list/selector/filter in sync in real time
 * (useBranchRealtimeSync) and, when this session is the one just
 * (un)assigned to a branch, forces an immediate token refresh — branch_ids
 * lives in the JWT (auth.service.ts), so without this the change wouldn't
 * take effect client-side until the token's natural expiry.
 */
export function SocketInitializer() {
  const { on, off } = useSocket();
  useBranchRealtimeSync();
  const userId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (!userId) return;

    function handleAssignmentChange(...args: unknown[]) {
      const payload = args[0] as { userId?: string } | undefined;
      if (payload?.userId === userId) void refreshAuthSession();
    }

    // SESSION CONTROL (CR-003): the server already force-drops this
    // session's socket connection the moment an Employee's status leaves
    // ACTIVE (employees.service.ts's revokeEmployeeSession) — this handler
    // is what turns that into an actual client-side logout + redirect
    // before the disconnect fires. clearAuth + broadcastLogout mirrors
    // api-client.ts's own dead-session handling: the tab's subscribeToLogout
    // listener (registered by useAuth) does the router.replace('/login').
    function handleSessionRevoked(...args: unknown[]) {
      const payload = args[0] as { employeeId?: string } | undefined;
      if (payload?.employeeId !== userId) return;
      useAuthStore.getState().clearAuth();
      broadcastLogout();
    }

    on(SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, handleAssignmentChange);
    on(SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED, handleAssignmentChange);
    on(SOCKET_EVENTS.EMPLOYEE_SESSION_REVOKED, handleSessionRevoked);
    return () => {
      off(SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, handleAssignmentChange);
      off(SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED, handleAssignmentChange);
      off(SOCKET_EVENTS.EMPLOYEE_SESSION_REVOKED, handleSessionRevoked);
    };
  }, [on, off, userId]);

  return null;
}
