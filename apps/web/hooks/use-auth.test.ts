import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));

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
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: true });
});

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
