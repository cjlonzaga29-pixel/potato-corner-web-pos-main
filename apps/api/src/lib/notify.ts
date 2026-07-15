import { getIO } from '../socket/socket.server.js';
import { SUPER_ADMIN_ROOM, branchRoom } from '../socket/rooms.js';

/**
 * Lightweight real-time "notification" for CR-001's approval workflows.
 * There is no persisted Notification table in this codebase (the
 * notifications module is still an unimplemented Phase-1+ stub) — this
 * reuses the Socket.io room infrastructure already wired up in Phase 4
 * instead of inventing a new persistence layer for this refactor. A no-op
 * when Socket.io hasn't been initialized (e.g. in unit tests).
 */
export function notifySuperAdmin(event: string, payload: unknown): void {
  getIO()?.to(SUPER_ADMIN_ROOM).emit(event, payload);
}

export function notifyBranch(branchId: string, event: string, payload: unknown): void {
  getIO()?.to(branchRoom(branchId)).emit(event, payload);
}
