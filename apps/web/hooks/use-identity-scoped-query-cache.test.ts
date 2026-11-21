import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ROLES } from '@potato-corner/shared';
import { bindIdentityScopedQueryCache } from './use-identity-scoped-query-cache';
import { useAuthStore } from '@/stores/auth.store';

/**
 * POS-PERF-P62 — user A's query data must be gone when A signs out or B signs
 * in, and a fetch A started must not put A's answer back afterwards. Driven
 * with a real QueryClient and the real auth store; nothing is rendered.
 */
const userA = { id: 'user-a', role: ROLES.SUPERVISOR, email: 'a@t.test', firstName: 'A', lastName: 'A', branchIds: ['b1'] };
const userB = { id: 'user-b', role: ROLES.SUPERVISOR, email: 'b@t.test', firstName: 'B', lastName: 'B', branchIds: ['b2'] };

let client: QueryClient;
let unbind: () => void;

beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: false, identityEpoch: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unbind = bindIdentityScopedQueryCache(client);
});

afterEach(() => {
  unbind();
  client.clear();
});

describe('bindIdentityScopedQueryCache (P62)', () => {
  it('empties the query cache when the user signs out', async () => {
    useAuthStore.getState().setAuth(userA, 'token-a');
    await client.fetchQuery({ queryKey: ['dashboard'], queryFn: async () => ({ owner: 'a' }) });
    expect(client.getQueryData(['dashboard'])).toEqual({ owner: 'a' });

    useAuthStore.getState().clearAuth();

    expect(client.getQueryData(['dashboard'])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('cancels A’s in-flight fetch and keeps its late answer out of the cache after B signs in', async () => {
    useAuthStore.getState().setAuth(userA, 'token-a');
    let answer!: (value: { owner: string }) => void;
    let aborted = false;
    const inFlight = client
      .fetchQuery({
        queryKey: ['dashboard'],
        queryFn: ({ signal }) =>
          new Promise<{ owner: string }>((resolve) => {
            answer = resolve;
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      })
      .catch(() => undefined);

    useAuthStore.getState().clearAuth();
    useAuthStore.getState().setAuth(userB, 'token-b');
    answer({ owner: 'a' });
    await inFlight;

    expect(aborted).toBe(true);
    expect(client.getQueryData(['dashboard'])).toBeUndefined();
  });

  it('does not clear anything when a session is restored or the same user refreshes', async () => {
    useAuthStore.getState().setAuth(userA, 'token-a');
    await client.fetchQuery({ queryKey: ['dashboard'], queryFn: async () => ({ owner: 'a' }) });
    useAuthStore.getState().setAuth(userA, 'token-a2');
    expect(client.getQueryData(['dashboard'])).toEqual({ owner: 'a' });
    expect(useAuthStore.getState().identityEpoch).toBe(0);
    useAuthStore.getState().setAuth(userB, 'token-b');
    expect(useAuthStore.getState().identityEpoch).toBe(1);
    expect(client.getQueryData(['dashboard'])).toBeUndefined();
  });
});

describe('purgeApiResponseCache (P62)', () => {
  it('deletes the legacy "apis" cache and any stored /api/ response, and nothing else', async () => {
    const { purgeApiResponseCache } = await import('@/lib/offline/purge-api-response-cache');
    const stores = new Map<string, Map<string, unknown>>([
      ['apis', new Map([['https://pos.test/api/reports/summary?branch_id=1', {}]])],
      ['others', new Map([['https://pos.test/api/products?page=1', {}], ['https://pos.test/branch/dashboard', {}]])],
      ['workbox-precache-v2', new Map([['https://pos.test/_next/static/app.js', {}]])],
    ]);
    vi.stubGlobal('caches', {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map();
        return {
          keys: async () => [...store.keys()].map((url) => ({ url })),
          delete: async (request: { url: string }) => store.delete(request.url),
        };
      },
    });

    await purgeApiResponseCache();

    expect(stores.has('apis')).toBe(false);
    expect([...(stores.get('others')?.keys() ?? [])]).toEqual(['https://pos.test/branch/dashboard']);
    expect([...(stores.get('workbox-precache-v2')?.keys() ?? [])]).toEqual(['https://pos.test/_next/static/app.js']);
    vi.unstubAllGlobals();
  });

  it('purges again when a new service worker takes control, and once more after, until unbound', async () => {
    // P62 browser run: after an upgrade the old worker kept caching API responses
    // after the start-up purge, until the new worker claimed the page.
    vi.useFakeTimers();
    let purges = 0;
    vi.stubGlobal('caches', { keys: async () => [], open: async () => ({ keys: async () => [] }), delete: async () => { purges += 1; return true; } });
    const sw = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    const { CONTROLLER_CHANGE_REPURGE_MS } = await import('./use-identity-scoped-query-cache');
    const stop = bindIdentityScopedQueryCache(new QueryClient());
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toBe(1); // start-up

    sw.dispatchEvent(new Event('controllerchange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toBe(2);
    await vi.advanceTimersByTimeAsync(CONTROLLER_CHANGE_REPURGE_MS);
    expect(purges).toBe(3);

    stop();
    sw.dispatchEvent(new Event('controllerchange'));
    await vi.advanceTimersByTimeAsync(CONTROLLER_CHANGE_REPURGE_MS);
    expect(purges).toBe(3);

    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
