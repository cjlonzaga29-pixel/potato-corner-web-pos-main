import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis } from '../lib/redis.js';
import { blacklistKey, type AuthErrorCode } from '../middleware/authenticate.js';
import { config } from '../config/index.js';
import { ROLES, jwtPayloadSchema } from '@potato-corner/shared';
import { SUPER_ADMIN_ROOM, branchRoom } from './rooms.js';

/**
 * Initializes Socket.io with the Redis adapter (required for correct
 * broadcast behavior once the API runs as more than one instance, per
 * Architecture doc §3.5). Users join their branch room(s) on connection;
 * Super Admin joins every branch room plus the dedicated admin room.
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

function unauthorized(code: AuthErrorCode): Error {
  const error = new Error('unauthorized');
  (error as Error & { data: { code: AuthErrorCode } }).data = { code };
  return error;
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000' },
  });

  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  pubClient.on('error', (error) => console.error('Redis pub client error:', error.message));
  subClient.on('error', (error) => console.error('Redis sub client error:', error.message));
  io.adapter(createAdapter(pubClient, subClient));

  // Mirrors apps/api/src/middleware/authenticate.ts's HTTP auth flow exactly:
  // verify RS256 signature -> check Redis blacklist -> validate payload shape.
  // A connection that fails any step never completes its handshake (Socket.io's
  // equivalent of a 401 — there is no already-connected socket to disconnect).
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) {
      next(unauthorized('TOKEN_MISSING'));
      return;
    }

    let decoded: unknown;
    try {
      decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] });
    } catch (error) {
      next(unauthorized(error instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'));
      return;
    }

    const isBlacklisted = await redis.get(blacklistKey(token));
    if (isBlacklisted) {
      next(unauthorized('TOKEN_REVOKED'));
      return;
    }

    const parsed = jwtPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      next(unauthorized('TOKEN_INVALID'));
      return;
    }

    socket.data.user = parsed.data;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    if (user.role === ROLES.SUPER_ADMIN) {
      void socket.join(SUPER_ADMIN_ROOM);
    } else {
      for (const branchId of user.branch_ids) {
        void socket.join(branchRoom(branchId));
      }
    }
  });

  ioInstance = io;
  return io;
}
