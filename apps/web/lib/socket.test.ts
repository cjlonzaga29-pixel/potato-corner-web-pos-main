import { describe, it, expect, vi, beforeEach } from 'vitest';

function fakeSocket() {
  return {
    auth: {} as Record<string, unknown>,
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    io: { on: vi.fn(), off: vi.fn() },
  };
}

const mockIo = vi.fn();
vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => mockIo(...args),
}));

const { getSocket, resetSocket } = await import('./socket.js');

beforeEach(() => {
  vi.clearAllMocks();
  resetSocket();
  mockIo.mockImplementation((_url: string, opts?: { auth?: Record<string, unknown> }) => {
    const socket = fakeSocket();
    socket.auth = opts?.auth ?? {};
    return socket;
  });
});

describe('getSocket', () => {
  it('creates a socket with the current access token on first call', () => {
    getSocket('token-1');

    expect(mockIo).toHaveBeenCalledTimes(1);
    const [, opts] = mockIo.mock.calls[0] as [string, { auth: { token: string } }];
    expect(opts.auth).toEqual({ token: 'token-1' });
  });

  it('reuses the same socket instance across calls — never a second concurrent socket', () => {
    const first = getSocket('token-1');
    const second = getSocket('token-1');

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("updates the existing socket's auth to a rotated token instead of creating a new one", () => {
    const socket = getSocket('token-1');
    expect(socket.auth).toEqual({ token: 'token-1' });

    const same = getSocket('token-2');

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(same).toBe(socket);
    expect(same.auth).toEqual({ token: 'token-2' });
  });
});

describe('resetSocket', () => {
  it('disconnects and clears listeners on the existing socket', () => {
    const socket = getSocket('token-1');

    resetSocket();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.removeAllListeners).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no socket has been created yet', () => {
    expect(() => resetSocket()).not.toThrow();
  });

  it('a subsequent getSocket call after reset creates a brand-new socket (e.g. a different user logging in on a shared terminal)', () => {
    const first = getSocket('user-a-token');
    resetSocket();
    const second = getSocket('user-b-token');

    expect(mockIo).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    const [, secondOpts] = mockIo.mock.calls[1] as [string, { auth: { token: string } }];
    expect(secondOpts.auth).toEqual({ token: 'user-b-token' });
  });
});
