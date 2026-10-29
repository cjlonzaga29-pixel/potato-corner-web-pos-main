import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const { mockSync, mockList } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('@/lib/offline/sync-queue', () => ({
  syncOfflineTransactions: mockSync,
  listOfflineSales: mockList,
}));

const { useOffline } = await import('./use-offline');

const EMPTY_OUTCOME = { attempted: 0, synced: [], rejected: [], failed: [] };

beforeEach(() => {
  mockSync.mockReset().mockResolvedValue(EMPTY_OUTCOME);
  mockList.mockReset().mockResolvedValue([]);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useOffline (P46R3)', () => {
  it("syncs the current cashier's rows on mount, under the employee token on a Branch Account", async () => {
    const refresh = vi.fn();
    renderHook(() => useOffline({ branchId: 'branch-1', cashierUserId: 'alice', isBranchAccount: true, accessToken: 'alice-token', refreshAccessToken: refresh }));

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync).toHaveBeenCalledWith({
      branchId: 'branch-1',
      cashierUserId: 'alice',
      accessToken: 'alice-token',
      refreshAccessToken: refresh,
    });
  });

  it('never syncs on a Branch Account with nobody signed in, nor without an employee token', async () => {
    const { rerender } = renderHook((props: { cashierUserId: string | null; accessToken?: string }) => useOffline({ branchId: 'branch-1', isBranchAccount: true, ...props }), {
      initialProps: { cashierUserId: null as string | null },
    });
    rerender({ cashierUserId: 'alice' });
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('on a direct login syncs under the session token (no employee token passed)', async () => {
    renderHook(() => useOffline({ branchId: 'branch-1', cashierUserId: 'user-1', isBranchAccount: false }));
    await waitFor(() => expect(mockSync).toHaveBeenCalledWith({ branchId: 'branch-1', cashierUserId: 'user-1' }));
  });

  it('syncs again on reconnect and when the cashier changes, but not when only the token rotates', async () => {
    const { rerender } = renderHook((props: { cashierUserId: string; accessToken: string }) => useOffline({ branchId: 'branch-1', isBranchAccount: true, ...props }), {
      initialProps: { cashierUserId: 'alice', accessToken: 't1' },
    });
    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));

    rerender({ cashierUserId: 'alice', accessToken: 't2' });
    await act(async () => undefined);
    expect(mockSync).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(2));
    expect(mockSync.mock.calls[1]?.[0]).toMatchObject({ cashierUserId: 'alice', accessToken: 't2' });

    rerender({ cashierUserId: 'bob', accessToken: 't3' });
    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(3));
    expect(mockSync.mock.calls[2]?.[0]).toMatchObject({ cashierUserId: 'bob', accessToken: 't3' });
  });

  it('reports newly refused rows and sends exactly one row on an explicit retry', async () => {
    const onRejected = vi.fn();
    mockSync.mockResolvedValueOnce({ ...EMPTY_OUTCOME, attempted: 1, rejected: ['row-1'] });
    const { result } = renderHook(() => useOffline({ branchId: 'branch-1', cashierUserId: 'user-1', isBranchAccount: false, onRejected }));
    await waitFor(() => expect(onRejected).toHaveBeenCalledWith(['row-1']));

    await act(async () => {
      await result.current.retryOfflineSale('row-1');
    });
    expect(mockSync).toHaveBeenLastCalledWith(expect.objectContaining({ onlyIds: ['row-1'] }));
  });

  it('counts only unsynced rows as pending', async () => {
    mockList.mockResolvedValue([{ id: 'a', syncedAt: null }, { id: 'b', syncedAt: 5 }]);
    const { result } = renderHook(() => useOffline({ branchId: 'branch-1', cashierUserId: null, isBranchAccount: true }));
    await waitFor(() => expect(result.current.offlineSales).toHaveLength(2));
    expect(result.current.pendingSyncCount).toBe(1);
  });
});
