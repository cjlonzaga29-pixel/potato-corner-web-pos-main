import type { Server } from 'socket.io';
import { branchRoom } from './rooms.js';
import { branchesRepository } from '../modules/branches/branches.repository.js';
import { enqueueRawNotificationJob } from '../queues/notification.queue.js';

/**
 * Connection-presence based "Branch Offline" detection: no staff socket
 * connected to a branch's room for this long is treated as the branch going
 * offline. Not a hardware/network uptime signal — a branch with no one
 * logged into the dashboard looks identical to one with no internet. The
 * debounce absorbs page refreshes and brief reconnects so those don't fire
 * a false offline notification.
 */
const OFFLINE_DEBOUNCE_MS = 30_000;

const offlineTimers = new Map<string, NodeJS.Timeout>();
const offlineBranches = new Set<string>();

function connectedCount(io: Server, branchId: string): number {
  return io.sockets.adapter.rooms.get(branchRoom(branchId))?.size ?? 0;
}

async function fireBranchOffline(branchId: string): Promise<void> {
  const branch = await branchesRepository.findById(branchId);
  await enqueueRawNotificationJob('branch_offline', {
    type: 'branch_offline',
    branchId,
    branchName: branch?.name ?? branchId,
    lastSeenAt: new Date().toISOString(),
  });
}

async function fireBranchOnline(branchId: string): Promise<void> {
  const branch = await branchesRepository.findById(branchId);
  await enqueueRawNotificationJob('branch_online', {
    type: 'branch_online',
    branchId,
    branchName: branch?.name ?? branchId,
  });
}

/**
 * Call after a socket disconnects. Only meaningful for branch rooms —
 * super_admin sockets never join one (see joinRoomsForUser), so callers
 * should skip super_admin users entirely.
 */
export function onBranchSocketLeft(io: Server, branchId: string): void {
  if (offlineTimers.has(branchId)) return;
  if (connectedCount(io, branchId) > 0) return;

  const timer = setTimeout(() => {
    offlineTimers.delete(branchId);
    if (connectedCount(io, branchId) === 0 && !offlineBranches.has(branchId)) {
      offlineBranches.add(branchId);
      fireBranchOffline(branchId).catch((error) => console.error(`Branch offline detection failed for ${branchId}:`, error));
    }
  }, OFFLINE_DEBOUNCE_MS);
  offlineTimers.set(branchId, timer);
}

/** Call after a socket joins a branch room (on connection). Cancels any pending offline timer and clears/reports recovery. */
export function onBranchSocketJoined(branchId: string): void {
  const timer = offlineTimers.get(branchId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(branchId);
  }
  if (offlineBranches.delete(branchId)) {
    fireBranchOnline(branchId).catch((error) => console.error(`Branch online notification failed for ${branchId}:`, error));
  }
}

/** Test-only: clears module-level presence state between unit tests. Never called from production code. */
export function resetPresenceStateForTests(): void {
  for (const timer of offlineTimers.values()) clearTimeout(timer);
  offlineTimers.clear();
  offlineBranches.clear();
}
