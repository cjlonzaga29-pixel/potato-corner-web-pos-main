import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../socket/socket.server.js', () => ({ getIO: vi.fn() }));

const { getIO } = await import('../socket/socket.server.js');
const { branchRoom } = await import('../socket/rooms.js');
const { queueCatalogChanged, flushCatalogChangedForTests, CATALOG_CHANGE_COALESCE_MS } = await import('./catalog-change-notifier.js');

function fakeIO() {
  const emit = vi.fn();
  const to = vi.fn((_room: string) => ({ emit }));
  return { io: { to }, to, emit };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  flushCatalogChangedForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queueCatalogChanged (POS-PERF-P69R)', () => {
  it('coalesces a burst into one event per branch, to that branch room only, carrying only the branch id', () => {
    const a = randomUUID();
    const b = randomUUID();
    const { io, to, emit } = fakeIO();
    vi.mocked(getIO).mockReturnValue(io as never);

    queueCatalogChanged([a]);
    queueCatalogChanged([a, b]);
    queueCatalogChanged([a, null, undefined, '']);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CATALOG_CHANGE_COALESCE_MS);
    expect(to.mock.calls.map(([room]) => room).sort()).toEqual([branchRoom(a), branchRoom(b)].sort());
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('catalog:changed', { branch_id: a });
    expect(emit).toHaveBeenCalledWith('catalog:changed', { branch_id: b });
  });

  it('a change after a flush is sent in a new window', () => {
    const a = randomUUID();
    const { io, emit } = fakeIO();
    vi.mocked(getIO).mockReturnValue(io as never);

    queueCatalogChanged([a]);
    vi.advanceTimersByTime(CATALOG_CHANGE_COALESCE_MS);
    queueCatalogChanged([a]);
    vi.advanceTimersByTime(CATALOG_CHANGE_COALESCE_MS);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('queues nothing for an empty list and is a no-op without Socket.io', () => {
    vi.mocked(getIO).mockReturnValue(null);
    queueCatalogChanged([]);
    queueCatalogChanged([randomUUID()]);
    expect(() => vi.advanceTimersByTime(CATALOG_CHANGE_COALESCE_MS)).not.toThrow();
  });
});
