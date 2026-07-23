import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'socket.io';
import { Server } from 'socket.io';
import { verifyAccessToken, AccessTokenError, type AccessTokenErrorCode } from '../lib/verify-access-token.js';
import { ROLES, type JwtPayload } from '@potato-corner/shared';
import { SUPER_ADMIN_ROOM, branchRoom, userRoom } from './rooms.js';
import { onBranchSocketJoined, onBranchSocketLeft } from './presence.js';

/**
 * Initializes Socket.io with its default in-memory adapter. Phase 21
 * removed the Redis adapter (Architecture doc §3.5 called for it to support
 * correct broadcast behavior once the API runs as more than one instance —
 * the in-memory adapter only broadcasts within a single process, so a
 * multi-instance deployment will silently miss events delivered to a
 * socket connected to a different instance than the one that emitted).
 * Users join their branch room(s) on connection; Super Admin joins every
 * branch room plus the dedicated admin room.
 */
let ioInstance: Server | null = null;

/**
 * Lets services broadcast events (e.g. branch status changes) without
 * threading the io instance through every function call. Full real-time
 * infrastructure (room management helpers, the activity feed) is Phase
 * 13's job — this is only the minimal accessor Phase 4 needs for its
 * three explicitly-required broadcasts.
 */
export function getIO(): Server | null {
  return ioInstance;
}

const ERROR_MESSAGES: Record<AccessTokenErrorCode, string> = {
  TOKEN_MALFORMED: 'Invalid token format',
  TOKEN_INVALID_SIGNATURE: 'Invalid token signature',
  TOKEN_EXPIRED: 'Token expired',
  TOKEN_REVOKED: 'Token revoked',
  TOKEN_INVALID_PAYLOAD: 'Invalid token format',
};

/**
 * Reads the access token from the handshake, preferring `auth.token` (what
 * the web client sends — see apps/web/lib/socket.ts) with an `Authorization:
 * Bearer <token>` header as a fallback for non-browser clients.
 */
function extractToken(socket: Socket): string | undefined {
  const authToken = socket.handshake.auth?.token as string | undefined;
  if (authToken) return authToken;

  const header = socket.handshake.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

  return undefined;
}

/**
 * Socket.io handshake authentication. Shares verification logic with the
 * HTTP `authenticate` middleware (lib/verify-access-token.ts): verify RS256
 * signature -> check Redis blacklist -> validate payload shape. A connection
 * that fails any step never completes its handshake (Socket.io's equivalent
 * of a 401 — there is no already-connected socket to disconnect). Exported
 * standalone so it can be unit-tested without spinning up a real server.
 */
export async function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = extractToken(socket);
  if (!token) {
    next(new Error('Authentication required'));
    return;
  }

  try {
    socket.data.user = await verifyAccessToken(token);
    next();
  } catch (error) {
    if (error instanceof AccessTokenError) {
      next(new Error(ERROR_MESSAGES[error.code]));
      return;
    }
    console.error('Socket authentication failed:', error);
    next(new Error('Authentication failed'));
  }
}

/**
 * Room assignment per the architecture doc's §3.5 room model: Super Admin
 * joins the one dedicated admin room and sees every branch's events (via
 * notifyBranch + notifySuperAdmin's dual-emit); everyone else joins one
 * room per branch in their JWT's `branch_ids` claim — never a room outside
 * that list, which is what keeps one branch's events from reaching another
 * branch's staff/supervisor. Exported standalone (like socketAuthMiddleware
 * above) so it can be unit-tested against a fake socket without spinning up
 * a real server.
 */
export function joinRoomsForUser(socket: Pick<Socket, 'join'>, user: JwtPayload): void {
  void socket.join(userRoom(user.user_id));
  if (user.role === ROLES.SUPER_ADMIN) {
    void socket.join(SUPER_ADMIN_ROOM);
  } else {
    for (const branchId of user.branch_ids) {
      void socket.join(branchRoom(branchId));
    }
  }
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000' },
  });

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const user = socket.data.user as JwtPayload;
    joinRoomsForUser(socket, user);

    if (user.role !== ROLES.SUPER_ADMIN) {
      for (const branchId of user.branch_ids) {
        onBranchSocketJoined(branchId);
      }
    }

    socket.on('disconnect', () => {
      if (user.role === ROLES.SUPER_ADMIN) return;
      for (const branchId of user.branch_ids) {
        onBranchSocketLeft(io, branchId);
      }
    });
  });

  ioInstance = io;
  return io;
}
