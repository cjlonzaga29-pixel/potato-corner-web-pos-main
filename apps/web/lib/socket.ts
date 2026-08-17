import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL } from './constants';

let socket: Socket | null = null;

/**
 * Singleton Socket.io client. Connect lazily, once, after authentication.
 *
 * Every call refreshes `.auth` to the latest access token, even when
 * returning the existing socket — socket.io-client reads `socket.auth`
 * fresh on every (re)connection attempt, so without this an access-token
 * rotation left the socket holding the token it was created with forever.
 * A reconnect triggered later (network blip, server restart) would then
 * replay that stale, likely-expired token and the server would keep
 * rejecting it, leaving the client stuck "reconnecting" indefinitely even
 * though the rest of the session is healthy on a fresh token.
 */
export function getSocket(accessToken: string): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      auth: { token: accessToken },
      autoConnect: false,
    });
  } else {
    socket.auth = { token: accessToken };
  }
  return socket;
}

/**
 * Logout: disconnect and drop the singleton entirely, not just its
 * listeners. Without this, the next login on the same (shared) terminal
 * would reuse the previous user's socket instance — getSocket's `!socket`
 * check would be false, so the new session's first getSocket() call would
 * only update `.auth` on an already-connected socket rather than forcing a
 * clean reconnect under the new identity's rooms.
 */
export function resetSocket(): void {
  if (socket) {
    socket.disconnect();
    socket.removeAllListeners();
  }
  socket = null;
}
