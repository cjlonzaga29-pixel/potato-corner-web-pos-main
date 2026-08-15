import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockUpdateName } = vi.hoisted(() => ({ mockUpdateName: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: { updateName: typeof mockUpdateName }) => unknown) =>
    selector({ updateName: mockUpdateName }),
}));

const { apiClient } = await import('@/lib/api-client');
const { useUpdateProfile } = await import('./use-profile.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useUpdateProfile', () => {
  it('PATCHes /api/auth/profile with the given name', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          role: 'branch',
          email: 'branch@potatocorner.test',
          first_name: 'New',
          last_name: 'Name',
          branch_ids: [],
          must_change_password: false,
        },
      },
      error: null,
      meta: null,
    });
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    result.current.mutate('New Name');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
  });

  it('patches the auth store with the persisted first/last name on success', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          role: 'branch',
          email: 'branch@potatocorner.test',
          first_name: 'CJ',
          last_name: 'Lonzaga',
          branch_ids: [],
          must_change_password: false,
        },
      },
      error: null,
      meta: null,
    });
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    result.current.mutate('CJ Lonzaga');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockUpdateName).toHaveBeenCalledWith('CJ', 'Lonzaga');
  });

  it('rejects and does not touch the auth store when the API returns an error', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'VALIDATION_ERROR', message: 'name: Name is required' },
      meta: null,
    });
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    result.current.mutate('');
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockUpdateName).not.toHaveBeenCalled();
    expect(result.current.error?.message).toBe('name: Name is required');
  });
});
