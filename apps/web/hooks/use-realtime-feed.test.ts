import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockOn = vi.fn();
const mockOff = vi.fn();
vi.mock('@/hooks/use-socket', () => ({
  useSocket: () => ({ isConnected: true, socket: null, on: mockOn, off: mockOff, emit: vi.fn() }),
}));

const mockUseAuthStore = vi.fn();
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (selector: (s: { accessToken: string | null }) => unknown) => mockUseAuthStore(selector) }));

const { useRealtimeFeed } = await import('./use-realtime-feed.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuthStore.mockImplementation((selector) => selector({ accessToken: 'token-1' }));
});

function emit(event: string, payload: unknown) {
  const call = mockOn.mock.calls.find(([registeredEvent]) => registeredEvent === event);
  const handler = call?.[1] as ((payload: unknown) => void) | undefined;
  act(() => handler?.(payload));
}

describe('useRealtimeFeed', () => {
  it('appends events to feed as they arrive', () => {
    const { result } = renderHook(() => useRealtimeFeed(['transaction:completed'], 20));

    emit('transaction:completed', { id: 'txn-1' });
    emit('transaction:completed', { id: 'txn-2' });

    expect(result.current).toHaveLength(2);
    expect(result.current.map((entry) => entry.payload)).toEqual([{ id: 'txn-1' }, { id: 'txn-2' }]);
  });

  it('trims feed to maxSize when exceeded', () => {
    const { result } = renderHook(() => useRealtimeFeed(['transaction:completed'], 3));

    for (let i = 0; i < 5; i++) emit('transaction:completed', { id: `txn-${i}` });

    expect(result.current).toHaveLength(3);
    expect(result.current.map((entry) => (entry.payload as { id: string }).id)).toEqual(['txn-2', 'txn-3', 'txn-4']);
  });

  it('cleans up listeners on unmount', () => {
    const { unmount } = renderHook(() => useRealtimeFeed(['transaction:completed'], 20));

    expect(mockOn).toHaveBeenCalledWith('transaction:completed', expect.any(Function));
    unmount();

    expect(mockOff).toHaveBeenCalledWith('transaction:completed', expect.any(Function));
  });

  it('returns empty array when socket disconnected', () => {
    mockUseAuthStore.mockImplementation((selector) => selector({ accessToken: null }));

    const { result } = renderHook(() => useRealtimeFeed(['transaction:completed'], 20));

    expect(mockOn).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });
});
