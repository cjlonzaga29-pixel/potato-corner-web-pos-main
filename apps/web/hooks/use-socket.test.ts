import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Role } from '@potato-corner/shared';

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

const { useSocket } = await import('./use-socket.js');
const { useAuthStore } = await import('@/stores/auth.store.js');
const { useSocketStore } = await import('@/stores/socket.store.js');

const USER = { id: 'user-1', role: 'staff' as Role, email: null, firstName: 'A', lastName: 'B', branchIds: ['branch-1'] };
const OTHER_USER = { id: 'user-2', role: 'staff' as Role, email: null, firstName: 'C', lastName: 'D', branchIds: ['branch-1'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockIo.mockImplementation((_url: string, opts?: { auth?: Record<string, unknown> }) => {
    const socket = fakeSocket();
    socket.auth = opts?.auth ?? {};
    return socket;
  });
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
  useSocketStore.setState({ isConnected: false, isReconnecting: false, lastConnectedAt: null });
});

describe('useSocket', () => {
  it('connects a fresh socket using the current access token', () => {
    useAuthStore.setState({ user: USER, accessToken: 'token-1', isAuthenticated: true });

    renderHook(() => useSocket());

    expect(mockIo).toHaveBeenCalledTimes(1);
    const [, opts] = mockIo.mock.calls[0] as [string, { auth: { token: string } }];
    expect(opts.auth).toEqual({ token: 'token-1' });
  });

  it('reuses the existing socket and updates its auth when the access token rotates, without creating a second socket', () => {
    useAuthStore.setState({ user: USER, accessToken: 'token-1', isAuthenticated: true });
    const { rerender } = renderHook(() => useSocket());
    expect(mockIo).toHaveBeenCalledTimes(1);

    useAuthStore.setState({ accessToken: 'token-2' });
    rerender();

    expect(mockIo).toHaveBeenCalledTimes(1);
    const createdSocket = mockIo.mock.results[0]?.value as ReturnType<typeof fakeSocket>;
    expect(createdSocket.auth).toEqual({ token: 'token-2' });
  });

  it('disconnects and drops the singleton on logout', () => {
    useAuthStore.setState({ user: USER, accessToken: 'token-1', isAuthenticated: true });
    const { rerender } = renderHook(() => useSocket());
    const createdSocket = mockIo.mock.results[0]?.value as ReturnType<typeof fakeSocket>;

    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
    rerender();

    expect(createdSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(createdSocket.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(useSocketStore.getState().isConnected).toBe(false);
  });

  it("a second user logging in on the same terminal after logout gets a brand-new socket bound to their own token, not the previous user's", () => {
    useAuthStore.setState({ user: USER, accessToken: 'user-a-token', isAuthenticated: true });
    const { rerender } = renderHook(() => useSocket());
    const firstSocket = mockIo.mock.results[0]?.value as ReturnType<typeof fakeSocket>;

    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
    rerender();

    useAuthStore.setState({ user: OTHER_USER, accessToken: 'user-b-token', isAuthenticated: true });
    rerender();

    expect(mockIo).toHaveBeenCalledTimes(2);
    const secondSocket = mockIo.mock.results[1]?.value as ReturnType<typeof fakeSocket>;
    expect(secondSocket).not.toBe(firstSocket);
    const [, secondOpts] = mockIo.mock.calls[1] as [string, { auth: { token: string } }];
    expect(secondOpts.auth).toEqual({ token: 'user-b-token' });
  });
});
