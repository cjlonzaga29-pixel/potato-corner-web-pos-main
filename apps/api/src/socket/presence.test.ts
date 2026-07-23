import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server } from 'socket.io';

vi.mock('../queues/notification.queue.js', () => ({
  enqueueRawNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../modules/branches/branches.repository.js', () => ({
  branchesRepository: {
    findById: vi.fn().mockResolvedValue({ id: 'branch-1', name: 'Manila' }),
  },
}));

const { enqueueRawNotificationJob } = await import('../queues/notification.queue.js');
const { branchesRepository } = await import('../modules/branches/branches.repository.js');
const { onBranchSocketJoined, onBranchSocketLeft, resetPresenceStateForTests } = await import('./presence.js');

function fakeIo(roomSize: number): Server {
  return {
    sockets: { adapter: { rooms: new Map([[`branch:branch-1`, { size: roomSize }]]) } },
  } as unknown as Server;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1', name: 'Manila' } as never);
  vi.useFakeTimers();
  resetPresenceStateForTests();
});

describe('onBranchSocketLeft', () => {
  it('does nothing if the branch room still has connected sockets', async () => {
    const io = fakeIo(1);

    onBranchSocketLeft(io, 'branch-1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });

  it('fires branch_offline after the debounce window if the room is still empty', async () => {
    const io = fakeIo(0);

    onBranchSocketLeft(io, 'branch-1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(branchesRepository.findById).toHaveBeenCalledWith('branch-1');
    expect(enqueueRawNotificationJob).toHaveBeenCalledWith('branch_offline', {
      type: 'branch_offline',
      branchId: 'branch-1',
      branchName: 'Manila',
      lastSeenAt: expect.any(String),
    });
  });

  it('does not re-fire if the branch is already marked offline', async () => {
    const io = fakeIo(0);

    onBranchSocketLeft(io, 'branch-1');
    await vi.advanceTimersByTimeAsync(30_000);
    onBranchSocketLeft(io, 'branch-1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(enqueueRawNotificationJob).toHaveBeenCalledTimes(1);
  });
});

describe('onBranchSocketJoined', () => {
  it('cancels a pending offline timer so a quick reconnect never fires branch_offline', async () => {
    const io = fakeIo(0);

    onBranchSocketLeft(io, 'branch-1');
    onBranchSocketJoined('branch-1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });

  it('fires branch_online after a branch was already marked offline', async () => {
    const io = fakeIo(0);

    onBranchSocketLeft(io, 'branch-1');
    await vi.advanceTimersByTimeAsync(30_000);
    vi.mocked(enqueueRawNotificationJob).mockClear();

    onBranchSocketJoined('branch-1');
    await vi.waitFor(() => expect(enqueueRawNotificationJob).toHaveBeenCalled());

    expect(enqueueRawNotificationJob).toHaveBeenCalledWith('branch_online', {
      type: 'branch_online',
      branchId: 'branch-1',
      branchName: 'Manila',
    });
  });

  it('does not fire branch_online for a branch that was never marked offline', () => {
    onBranchSocketJoined('branch-1');

    expect(enqueueRawNotificationJob).not.toHaveBeenCalled();
  });
});
