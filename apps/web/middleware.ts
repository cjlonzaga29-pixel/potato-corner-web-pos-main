import { NextResponse, type NextRequest } from 'next/server';
import { ROLE_DASHBOARDS } from '@potato-corner/shared';

const ROLE_PATH_OWNERSHIP: Array<{ prefix: string; roles: string[] }> = [
  { prefix: '/admin', roles: ['super_admin'] },
  { prefix: '/supervisor', roles: ['supervisor'] },
  { prefix: '/terminal', roles: ['staff'] },
  { prefix: '/clock-in', roles: ['staff'] },
  { prefix: '/shift', roles: ['staff'] },
  { prefix: '/receipts', roles: ['staff'] },
];

// '/login' is handled separately above (it redirects an already-authenticated user instead of just passing through).
// '/api/' covers every proxied backend call (see next.config.ts's rewrite) —
// those now share this app's origin, so without this exemption this
// middleware would treat an unauthenticated POST /api/auth/login itself as
// a protected-route request and redirect it to /login before it ever
// reaches the proxy. The backend enforces its own auth on each endpoint;
// this middleware's job is page routing, not gating the API namespace.
const PUBLIC_PATH_PREFIXES = ['/reset-password', '/r/', '/api/'];

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Mirrors auth.router.ts's ACCESS_HINT_COOKIE_NAME — an HttpOnly cookie
// carrying the same signed access token the client already holds in memory,
// parked here purely so this middleware can read role/expiry locally
// instead of paying a full refresh-token rotation (5 sequential Postgres
// queries) on every single navigation. See ACCESS_HINT_SAFETY_BUFFER_MS
// below for how "close enough to expiry" is decided.
const ACCESS_HINT_COOKIE_NAME = 'pc_access_hint';
const ACCESS_HINT_SAFETY_BUFFER_MS = 5000;

interface DecodedAuthClaims {
  role: string | null;
  mustChangePassword: boolean;
  expiresAtMs: number | null;
}

/**
 * Decodes (does not verify) a JWT payload — sufficient here since it comes
 * straight from our own backend's refresh response within this same
 * request (or, for the access-hint cookie, from a Set-Cookie this same
 * server issued earlier); only used to decide which dashboard to redirect
 * to, not to authorize anything. Real verification happens server-side in
 * apps/api/src/middleware/authenticate.ts on every actual API call.
 */
function decodeAuthClaims(accessToken: string): DecodedAuthClaims {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return { role: null, mustChangePassword: false, expiresAtMs: null };
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as { role?: string; must_change_password?: boolean; exp?: number };
    return {
      role: parsed.role ?? null,
      mustChangePassword: parsed.must_change_password ?? false,
      expiresAtMs: typeof parsed.exp === 'number' ? parsed.exp * 1000 : null,
    };
  } catch {
    return { role: null, mustChangePassword: false, expiresAtMs: null };
  }
}

/**
 * Fast path for the common case: a still-fresh access token was already
 * mirrored into the pc_access_hint cookie by a recent login/refresh. If
 * it's not within ACCESS_HINT_SAFETY_BUFFER_MS of expiring, this middleware
 * can make its routing decision from it directly — zero network calls —
 * instead of unconditionally rotating the refresh token on every
 * navigation. Falls back to the full resolveAccessToken() flow (the
 * existing, carefully-raced rotation) whenever the hint is missing, expired,
 * or unparseable.
 */
function readFreshAccessHint(request: NextRequest): DecodedAuthClaims | null {
  const hint = request.cookies.get(ACCESS_HINT_COOKIE_NAME)?.value;
  if (!hint) return null;
  const claims = decodeAuthClaims(hint);
  if (!claims.role || !claims.expiresAtMs) return null;
  if (claims.expiresAtMs <= Date.now() + ACCESS_HINT_SAFETY_BUFFER_MS) return null;
  return claims;
}

interface RefreshResult {
  accessToken: string | null;
  /** Raw Set-Cookie header value(s) from the upstream refresh response — must be relayed onto whatever NextResponse this middleware returns. */
  setCookies: string[];
  /**
   * True when the refresh call failed for a reason other than the token
   * actually being invalid/missing (a non-401 response, or the fetch
   * itself throwing) — e.g. the Session F transaction-pool exhaustion
   * incident, where a healthy refresh token got a transient 500. The
   * caller must not treat this the same as a dead session.
   */
  transientError: boolean;
}

const REFRESH_RETRY_DELAY_MS = 300;

async function callRefreshEndpoint(
  cookie: string,
  deviceId: string | undefined,
): Promise<{ response: Response | null; setCookies: string[] }> {
  try {
    const response = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ device_id: deviceId ?? '' }),
    });
    return { response, setCookies: response.headers.getSetCookie?.() ?? [] };
  } catch {
    return { response: null, setCookies: [] };
  }
}

/**
 * The access token itself is memory-only and doesn't survive a
 * server-side request, so the only session signal available here is the
 * HttpOnly refresh cookie — this calls the refresh endpoint to check it's
 * still valid and to learn the user's role for role-route redirects.
 *
 * The refresh token is opaque and rotated on every use (locked rule) —
 * every call here revokes the incoming token and issues a new one. The
 * caller MUST write `setCookies` back onto its response, or the browser
 * keeps the now-revoked cookie and the very next navigation fails with
 * REFRESH_INVALID, bouncing the user back to /login after exactly one
 * successful page load.
 *
 * A single retry absorbs short transient failures (DB pool contention,
 * etc.) before falling back to `transientError: true` — a real 401 never
 * retries, since that's a genuine invalid/missing token, not a hiccup.
 */
async function resolveAccessToken(request: NextRequest): Promise<RefreshResult> {
  const deviceId = request.cookies.get('pc_device_id')?.value;
  const cookie = request.headers.get('cookie') ?? '';

  let { response, setCookies } = await callRefreshEndpoint(cookie, deviceId);

  if (!response || (!response.ok && response.status !== 401)) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
    ({ response, setCookies } = await callRefreshEndpoint(cookie, deviceId));
  }

  if (!response) {
    return { accessToken: null, setCookies: [], transientError: true };
  }
  if (response.status === 401) {
    return { accessToken: null, setCookies, transientError: false };
  }
  if (!response.ok) {
    return { accessToken: null, setCookies: [], transientError: true };
  }

  const body = (await response.json()) as { data?: { access_token?: string } };
  return { accessToken: body.data?.access_token ?? null, setCookies, transientError: false };
}

function withRotatedCookies(response: NextResponse, setCookies: string[]): NextResponse {
  for (const cookie of setCookies) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

/**
 * Builds the /login redirect target with the originally-requested URL
 * preserved as ?returnTo=, so login-form.tsx can send the user back where
 * they meant to go instead of always landing on their role's default
 * dashboard. The value is the raw request path/query — it comes from this
 * server's own routing, not user input, so no sanitization is needed here;
 * login-form.tsx re-validates it before use since URL query params are
 * attacker-controllable once they're echoed into a shareable login link.
 */
function loginRedirectUrl(request: NextRequest): URL {
  const url = new URL('/login', request.url);
  url.searchParams.set('returnTo', request.nextUrl.pathname + request.nextUrl.search);
  return url;
}

/**
 * Protects every route under (admin), (supervisor), and (pos), redirects
 * an already-authenticated user away from /login, and redirects a
 * wrong-role user from a route it doesn't own to its own dashboard. The
 * client-side useAuth hook performs its own silent refresh on mount to
 * actually populate the in-memory access token for API calls — this
 * middleware only decides where the browser should land.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const refreshCookie = request.cookies.get('refresh_token');

  if (pathname.startsWith('/login')) {
    // Already-authenticated users shouldn't see the login page — bounce
    // them to their dashboard instead.
    if (refreshCookie) {
      const freshHint = readFreshAccessHint(request);
      if (freshHint?.role) {
        return NextResponse.redirect(
          new URL(ROLE_DASHBOARDS[freshHint.role as keyof typeof ROLE_DASHBOARDS] ?? '/', request.url),
        );
      }

      const { accessToken, setCookies } = await resolveAccessToken(request);
      const { role } = accessToken ? decodeAuthClaims(accessToken) : { role: null };
      if (role) {
        return withRotatedCookies(
          NextResponse.redirect(new URL(ROLE_DASHBOARDS[role as keyof typeof ROLE_DASHBOARDS] ?? '/', request.url)),
          setCookies,
        );
      }
      return withRotatedCookies(NextResponse.next(), setCookies);
    }
    return NextResponse.next();
  }

  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (!refreshCookie) {
    return NextResponse.redirect(loginRedirectUrl(request));
  }

  // Skip refresh-token rotation for prefetch requests. Next.js Link
  // prefetches trigger this middleware, but the browser doesn't reliably
  // process a prefetch response's Set-Cookie (prefetches are cancellable)
  // — rotating the single-use refresh token here revokes it before the
  // real navigation happens, so the next click fails with
  // REFRESH_INVALID and bounces to /login. Let an authenticated prefetch
  // through on the existing cookies without rotating; the real
  // navigation re-runs this middleware and rotates then. See
  // docs/architecture/phase-19-debt.md and DevTools evidence 2026-07-19.
  const isPrefetch =
    request.headers.get('next-router-prefetch') === '1' || request.headers.get('purpose') === 'prefetch';
  if (isPrefetch && refreshCookie) {
    return NextResponse.next();
  }

  // Fast path: a still-fresh access token was mirrored into pc_access_hint
  // by a recent login/refresh. Route straight from it, skipping the
  // refresh-token rotation (and its Postgres round trips) entirely — that
  // rotation only actually needs to happen once per access-token lifetime
  // (15m), not on every navigation.
  const freshHint = readFreshAccessHint(request);
  if (freshHint) {
    if (freshHint.mustChangePassword && pathname !== '/change-password') {
      return NextResponse.redirect(new URL('/change-password', request.url));
    }
    const ownership = ROLE_PATH_OWNERSHIP.find((entry) => pathname.startsWith(entry.prefix));
    if (freshHint.role && ownership && !ownership.roles.includes(freshHint.role)) {
      const correctPrefix = ROLE_DASHBOARDS[freshHint.role as keyof typeof ROLE_DASHBOARDS];
      if (correctPrefix) {
        return NextResponse.redirect(new URL(correctPrefix, request.url));
      }
    }
    return NextResponse.next();
  }

  const { accessToken, setCookies, transientError } = await resolveAccessToken(request);
  if (!accessToken) {
    if (transientError) {
      // Don't force a logout over a refresh-endpoint hiccup — the session
      // cookie is still there and may well be valid. This request skips
      // the role/must-change-password checks below, but those are routing
      // conveniences, not the security boundary: every actual API call
      // this page makes is still authorized server-side in
      // apps/api/src/middleware/authenticate.ts. The next navigation
      // re-runs this middleware and gets a fresh chance to refresh.
      return NextResponse.next();
    }
    return withRotatedCookies(NextResponse.redirect(loginRedirectUrl(request)), setCookies);
  }

  const { role, mustChangePassword } = decodeAuthClaims(accessToken);

  // Locked rule: a must-change-password account cannot use any feature
  // until it sets its own password — this is the one page it's allowed to
  // reach, and it can't be skipped by navigating straight to another URL.
  if (mustChangePassword && pathname !== '/change-password') {
    return withRotatedCookies(NextResponse.redirect(new URL('/change-password', request.url)), setCookies);
  }

  const ownership = ROLE_PATH_OWNERSHIP.find((entry) => pathname.startsWith(entry.prefix));
  if (role && ownership && !ownership.roles.includes(role)) {
    const correctPrefix = ROLE_DASHBOARDS[role as keyof typeof ROLE_DASHBOARDS];
    if (correctPrefix) {
      return withRotatedCookies(NextResponse.redirect(new URL(correctPrefix, request.url)), setCookies);
    }
  }

  return withRotatedCookies(NextResponse.next(), setCookies);
}

export const config = {
  // sw.js and workbox-*.js must stay excluded too — next-pwa's service
  // worker fetches these unauthenticated (before any login), and without
  // this exclusion this middleware 307-redirects them to /login, so the
  // service worker can never register at all (Phase 20 Task 6 finding).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|icons|sw\\.js|workbox-).*)'],
};
