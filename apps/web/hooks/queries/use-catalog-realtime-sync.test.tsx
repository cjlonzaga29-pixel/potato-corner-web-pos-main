import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * POS-PERF-P69R — the terminal's catalog follows supervisor changes: a
 * `catalog:changed` hint for its own branch refetches the authorized catalog,
 * bursts coalesce, other branches' hints are ignored, a reconnect recovers
 * missed hints, and without realtime the fallback interval is bounded.
 */
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const socketState = { isConnected: true };
vi.mock('@/hooks/use-socket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    socket: null,
    on: (event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off: (event: string, handler: (payload: unknown) => void) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
  }),
}));

const apiClientMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClientMock(...args) }));

const { useSocketStore } = await import('@/stores/socket.store');
const { useCatalog, useCatalogRealtimeSync, CATALOG_CHANGE_DEBOUNCE_MS, CATALOG_FALLBACK_REFRESH_MINUTES } = await import('./use-products');
const { PRODUCT_CACHE_REFRESH_MINUTES } = await import('@/lib/constants');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const CATALOG_CHANGED = 'catalog:changed';

function setup(branchId: string | undefined = BRANCH_A) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(({ id }: { id: string | undefined }) => useCatalogRealtimeSync(id), { wrapper, initialProps: { id: branchId } });
  const catalogCalls = () => invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(['catalog', BRANCH_A]));
  return { queryClient, invalidate, hook, catalogCalls };
}

function hint(payload: unknown) {
  act(() => {
    for (const handler of handlers.get(CATALOG_CHANGED) ?? []) handler(payload);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  socketState.isConnected = true;
  apiClientMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCatalogRealtimeSync — catalog:changed (POS-PERF-P69R)', () => {
  it('a burst of hints for this branch is one catalog refetch, never cancelling one in flight', () => {
    const { catalogCalls } = setup();
    for (let i = 0; i < 6; i += 1) hint({ branch_id: BRANCH_A });
    expect(catalogCalls()).toHaveLength(0);

    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS));
    expect(catalogCalls()).toHaveLength(1);
    expect(catalogCalls()[0]?.[1]).toEqual({ cancelRefetch: false });

    // A later hint is a new, separate refetch.
    hint({ branch_id: BRANCH_A });
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS));
    expect(catalogCalls()).toHaveLength(2);
  });

  it('ignores hints for another branch and payloads without this branch id', () => {
    const { invalidate } = setup();
    hint({ branch_id: BRANCH_B });
    hint(null);
    hint({ branchId: BRANCH_A });
    hint('catalog');
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS * 3));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('waits for a fetch already in flight, then refetches once', () => {
    const { queryClient, catalogCalls } = setup();
    const isFetching = vi.spyOn(queryClient, 'isFetching').mockReturnValue(1);
    hint({ branch_id: BRANCH_A });
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS * 2));
    expect(catalogCalls()).toHaveLength(0);

    isFetching.mockReturnValue(0);
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS));
    expect(catalogCalls()).toHaveLength(1);
  });

  it('keeps exactly one handler across reconnects and removes it on unmount', () => {
    const { hook } = setup();
    expect(handlers.get(CATALOG_CHANGED)?.size).toBe(1);
    socketState.isConnected = false;
    hook.rerender({ id: BRANCH_A });
    socketState.isConnected = true;
    hook.rerender({ id: BRANCH_A });
    hook.rerender({ id: BRANCH_A });
    expect(handlers.get(CATALOG_CHANGED)?.size).toBe(1);
    hook.unmount();
    expect(handlers.get(CATALOG_CHANGED)?.size).toBe(0);
  });

  it('refetches once after a reconnect (hints missed while disconnected), not on the first connection', () => {
    socketState.isConnected = false;
    const { hook, catalogCalls } = setup();
    socketState.isConnected = true;
    hook.rerender({ id: BRANCH_A });
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS));
    expect(catalogCalls()).toHaveLength(0);

    socketState.isConnected = false;
    hook.rerender({ id: BRANCH_A });
    socketState.isConnected = true;
    hook.rerender({ id: BRANCH_A });
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS));
    expect(catalogCalls()).toHaveLength(1);
  });

  it('a branch change drops a refetch scheduled for the old branch', () => {
    const { hook, catalogCalls } = setup();
    hint({ branch_id: BRANCH_A });
    hook.rerender({ id: BRANCH_B });
    act(() => vi.advanceTimersByTime(CATALOG_CHANGE_DEBOUNCE_MS * 2));
    expect(catalogCalls()).toHaveLength(0);
  });
});

describe('useCatalog — bounded fallback without realtime (POS-PERF-P69R)', () => {
  function renderCatalog() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    apiClientMock.mockResolvedValue({ data: { products: [], product_types: [] }, error: null, meta: null });
    return renderHook(() => useCatalog(BRANCH_A), { wrapper });
  }

  it(`refreshes every ${CATALOG_FALLBACK_REFRESH_MINUTES} min while the realtime connection is down`, async () => {
    act(() => useSocketStore.getState().setConnected(false));
    const { unmount } = renderCatalog();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiClientMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CATALOG_FALLBACK_REFRESH_MINUTES * 60 * 1000);
    });
    expect(apiClientMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it(`stays on the ${PRODUCT_CACHE_REFRESH_MINUTES} min safety net while realtime is connected`, async () => {
    act(() => useSocketStore.getState().setConnected(true));
    const { unmount } = renderCatalog();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CATALOG_FALLBACK_REFRESH_MINUTES * 60 * 1000);
    });
    expect(apiClientMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRODUCT_CACHE_REFRESH_MINUTES * 60 * 1000);
    });
    expect(apiClientMock).toHaveBeenCalledTimes(2);
    unmount();
  });
});
