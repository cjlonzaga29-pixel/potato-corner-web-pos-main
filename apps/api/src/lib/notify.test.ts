import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../socket/socket.server.js', () => ({
  getIO: vi.fn(),
}));

const { getIO } = await import('../socket/socket.server.js');
const { SUPER_ADMIN_ROOM, branchRoom, userRoom } = await import('../socket/rooms.js');
const { notifyBranch, notifySuperAdmin, notifyUser } = await import('./notify.js');

/**
 * CR-004 realtime room isolation — complements socket.server.test.ts's proof
 * that a connecting socket only ever joins its own scoped room(s)
 * (joinRoomsForUser). Together the two prove the full guarantee end to end:
 * sockets only ever sit in their own branch/admin/user room, and every
 * broadcast helper only ever targets exactly one such room — never a
 * wildcard, never every room, never a second branch's room by accident.
 */
function fakeIO() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to }, to, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyBranch', () => {
  it('emits only to the target branch\'s own room, never a different branch\'s room or the admin room', () => {
    const branchA = randomUUID();
    const branchB = randomUUID();
    const { io, to } = fakeIO();
    vi.mocked(getIO).mockReturnValue(io as never);

    notifyBranch(branchA, 'inventory:movement_recorded', { ok: true });

    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(branchRoom(branchA));
    expect(to).not.toHaveBeenCalledWith(branchRoom(branchB));
    expect(to).not.toHaveBeenCalledWith(SUPER_ADMIN_ROOM);
  });

  it('is a no-op when Socket.io has not been initialized (e.g. under test)', () => {
    vi.mocked(getIO).mockReturnValue(null);

    expect(() => notifyBranch('branch-a', 'inventory:movement_recorded', {})).not.toThrow();
  });
});

describe('notifySuperAdmin', () => {
  it('emits only to the dedicated Super Admin room, never a branch room', () => {
    const { io, to } = fakeIO();
    vi.mocked(getIO).mockReturnValue(io as never);

    notifySuperAdmin('transaction:completed', { ok: true });

    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(SUPER_ADMIN_ROOM);
  });
});

describe('notifyUser', () => {
  it('emits only to that user\'s own room, never their branch room or the admin room', () => {
    const userId = randomUUID();
    const { io, to } = fakeIO();
    vi.mocked(getIO).mockReturnValue(io as never);

    notifyUser(userId, 'export:ready', { url: 'https://signed.example/export.csv' });

    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(userRoom(userId));
  });
});
