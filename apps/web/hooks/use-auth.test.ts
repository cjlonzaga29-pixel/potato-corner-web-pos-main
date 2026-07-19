import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));

const mockBroadcastLogout = vi.fn();
const mockUnsubscribeFromLogout = vi.fn();
let capturedLogoutHandler: (() => void) | null = null;
vi.mock('@/lib/auth-broadcast', () => ({
  broadcastLogout: (...args: unknown[]) => mockBroadcastLogout(...args),
  subscribeToLogout: vi.fn((onLogout: () => void) => {
    capturedLogoutHandler = onLogout;
    return mockUnsubscribeFromLogout;
  }),
}));

const { apiClient } = await import('@/lib/api-client');
const { useAuthStore } = await import('@/stores/auth.store');
const { useAuth } = await import('./use-auth.js');

/** Builds a decodable (unsigned) JWT-shaped string — decodeJwtPayload only reads the payload segment. */
function fakeToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  return `header.${base64}.signature`;
}

const VALID_TOKEN = fakeToken({ user_id: 'u1', role: 'staff', email: 'staff@potatocorner.test', branch_ids: ['b1'] });

beforeEach(() => {
  vi.clearAllMocks();
  capturedLogoutHandler = null;
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: true });
});

const STAFF_USER = {
  id: 'u1',
  role: 'staff' as const,
  email: 'staff@potatocorner.test',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  branchIds: ['b1'],
};

describe('useAuth restoreSession', () => {
  it('restores the session immediately on a successful refresh', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { access_token: VALID_TOKEN }, error: null, meta: null });

    renderHook(() => useAuth());

    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(useAuthStore.getState().accessToken).toBe(VALID_TOKEN);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('releases isLoading and does not redirect when the refresh call throws on every attempt (network failure)', async () => {
    vi.mocked(apiClient).mockRejectedValue(new Error('network down'));

    renderHook(() => useAuth());

    await waitFor(() => expect(useAuthStore.getState().isLoading).toBe(false), { timeout: 2000 });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(apiClient).toHaveBeenCalledTimes(2); // one retry for a transient failure
  });

  it('retries once on a transient error response and recovers on the retry', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce({ data: null, error: { code: 'INTERNAL_ERROR', message: 'boom' }, meta: null })
      .mockResolvedValueOnce({ data: { access_token: VALID_TOKEN }, error: null, meta: null });

    renderHook(() => useAuth());

    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true), { timeout: 2000 });
    expect(useAuthStore.getState().accessToken).toBe(VALID_TOKEN);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(apiClient).toHaveBeenCalledTimes(2);
  });

  it('keeps the session alone (no clear, no redirect) when a transient error persists through the retry', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'boom' }, meta: null });

    renderHook(() => useAuth());

    await waitFor(() => expect(useAuthStore.getState().isLoading).toBe(false), { timeout: 2000 });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(apiClient).toHaveBeenCalledTimes(2);
  });

  it('clears auth and redirects to /login immediately on REFRESH_INVALID, without retrying', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'REFRESH_INVALID' }, meta: null });

    renderHook(() => useAuth());

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(apiClient).toHaveBeenCalledTimes(1); // a genuinely invalid token never retries
  });

  it('clears auth and redirects to /login immediately on REFRESH_MISSING, without retrying', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'REFRESH_MISSING' }, meta: null });

    renderHook(() => useAuth());

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(apiClient).toHaveBeenCalledTimes(1);
  });
});

describe('useAuth cross-tab logout sync', () => {
  it('logout() clears local auth and broadcasts to other tabs', async () => {
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'tok', isAuthenticated: true, isLoading: false });
    vi.mocked(apiClient).mockResolvedValue({ data: { success: true }, error: null, meta: null });

    const { result } = renderHook(() => useAuth());
    await result.current.logout();

    expect(apiClient).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('logout() still clears auth and redirects when the apiClient call throws (network failure)', async () => {
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'tok', isAuthenticated: true, isLoading: false });
    vi.mocked(apiClient).mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAuth());
    await result.current.logout();

    expect(apiClient).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('logoutAll() clears local auth and broadcasts to other tabs', async () => {
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'tok', isAuthenticated: true, isLoading: false });
    vi.mocked(apiClient).mockResolvedValue({ data: { success: true }, error: null, meta: null });

    const { result } = renderHook(() => useAuth());
    await result.current.logoutAll();

    expect(apiClient).toHaveBeenCalledWith('/api/auth/logout-all', { method: 'POST' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('logoutAll() still clears auth and redirects when the apiClient call throws (network failure)', async () => {
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'tok', isAuthenticated: true, isLoading: false });
    vi.mocked(apiClient).mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAuth());
    await result.current.logoutAll();

    expect(apiClient).toHaveBeenCalledWith('/api/auth/logout-all', { method: 'POST' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('subscribes to cross-tab logout signals on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useAuth());
    expect(capturedLogoutHandler).toBeInstanceOf(Function);

    unmount();
    expect(mockUnsubscribeFromLogout).toHaveBeenCalledTimes(1);
  });

  it('clears auth and redirects to /login when another tab broadcasts a logout', () => {
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'tok', isAuthenticated: true, isLoading: false });

    renderHook(() => useAuth());
    expect(capturedLogoutHandler).toBeInstanceOf(Function);

    capturedLogoutHandler?.();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });
});
