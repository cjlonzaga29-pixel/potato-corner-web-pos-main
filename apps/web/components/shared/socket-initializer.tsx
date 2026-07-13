'use client';

import { useSocket } from '@/hooks/use-socket';

/**
 * Mounts once per role layout to establish the Socket.io connection and
 * join the correct room(s) for the current user. Renders nothing — this
 * exists so the role layouts (Server Components) can trigger a client
 * hook without themselves becoming Client Components.
 */
export function SocketInitializer() {
  useSocket();
  return null;
}
