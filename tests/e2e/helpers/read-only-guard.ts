import { test as base, expect, type BrowserContext } from '@playwright/test';

// POS-PERF-P44 — network-level enforcement for the production-safe smoke
// suites. Every request the browser makes goes through this route handler;
// a write (anything but GET/HEAD/OPTIONS) is aborted before it leaves the
// browser unless it is one of the session calls below, and the test then
// fails listing what was blocked. Signing in and out still writes a session
// row, a LOGIN_SUCCESS audit row and last_login_at — that is the documented,
// accepted footprint of production monitoring; nothing else is.
//
// Realtime (Socket.io) is blocked by default, for every method and for the
// WebSocket upgrade. The server exposes no write handlers over the socket,
// but joining a branch room has a side effect: when the last socket in a
// branch room disconnects, apps/api/src/socket/presence.ts queues a real
// `branch_offline` notification 30 s later (and `branch_online` on the next
// join). A supervisor or branch smoke login right after a deploy restart
// would otherwise notify admins that a real branch went offline. Super Admin
// sockets never join branch rooms, so the Super Admin-only production config
// passes realtime: 'allow' to keep its live-activity checks.
//
// The guard only sees browser traffic: APIRequestContext calls bypass it, so
// production-safe specs must not use APIRequestContext for anything but GETs
// (and createAuthedApiContext's token refresh).
const ALLOWED_WRITE_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SOCKET_PATH_PREFIX = '/socket.io/';

export type RealtimePolicy = 'allow' | 'block';

export function isAllowedRequest(method: string, rawUrl: string, realtime: RealtimePolicy = 'block'): boolean {
  const { pathname } = new URL(rawUrl);
  if (pathname.startsWith(SOCKET_PATH_PREFIX)) return realtime === 'allow';
  if (READ_METHODS.has(method.toUpperCase())) return true;
  return ALLOWED_WRITE_PATHS.has(pathname);
}

/** Installs the guard; returns the live list of blocked writes ("METHOD path"). Blocked realtime is not listed — it is expected. */
export async function installReadOnlyGuard(context: BrowserContext, realtime: RealtimePolicy = 'block'): Promise<string[]> {
  const blocked: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (isAllowedRequest(request.method(), request.url(), realtime)) {
      await route.fallback();
      return;
    }
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith(SOCKET_PATH_PREFIX)) blocked.push(`${request.method()} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  if (realtime === 'block') {
    await context.routeWebSocket(/\/socket\.io\//, async (ws) => {
      await ws.close({ code: 1008, reason: 'realtime blocked by production-safe smoke' });
    });
  }
  return blocked;
}

export function expectNoBlockedWrites(blocked: readonly string[]): void {
  expect(blocked, `Production-safe smoke attempted non-session writes (aborted): ${blocked.join(', ')}`).toEqual([]);
}

/**
 * `test` whose default context is read-only-guarded, realtime blocked unless
 * a Super Admin-only spec opts in with test.use({ realtime: 'allow' }).
 * Contexts a spec creates itself (browser.newContext()) must call
 * installReadOnlyGuard explicitly.
 */
export const test = base.extend<{ realtime: RealtimePolicy }>({
  realtime: ['block', { option: true }],
  context: async ({ context, realtime }, use) => {
    const blocked = await installReadOnlyGuard(context, realtime);
    await use(context);
    expectNoBlockedWrites(blocked);
  },
});

export { expect };
