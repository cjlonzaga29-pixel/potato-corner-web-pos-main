import { NextResponse, type NextRequest } from 'next/server';
import { ROLE_DASHBOARDS } from '@potato-corner/shared';

const ROLE_PATH_OWNERSHIP: Array<{ prefix: string; roles: string[] }> = [
  { prefix: '/admin', roles: ['super_admin'] },
  { prefix: '/supervisor', roles: ['supervisor'] },
  { prefix: '/terminal', roles: ['staff'] },
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

interface DecodedAuthClaims {
  role: string | null;
  mustChangePassword: boolean;
}

/**
 * Decodes (does not verify) a JWT payload — sufficient here since it comes
 * straight from our own backend's refresh response within this same
 * request; only used to decide which dashboard to redirect to, not to
 * authorize anything. Real verification happens server-side in
 * apps/api/src/middleware/authenticate.ts on every actual API call.
 */
function decodeAuthClaims(accessToken: string): DecodedAuthClaims {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return { role: null, mustChangePassword: false };
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as { role?: string; must_change_password?: boolean };
    return { role: parsed.role ?? null, mustChangePassword: parsed.must_change_password ?? false };
  } catch {
    return { role: null, mustChangePassword: false };
  }
}

interface RefreshResult {
  accessToken: string | null;
  /** Raw Set-Cookie header value(s) from the upstream refresh response — must be relayed onto whatever NextResponse this middleware returns. */
  setCookies: string[];
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
 */
async function resolveAccessToken(request: NextRequest): Promise<RefreshResult> {
  const deviceId = request.cookies.get('pc_device_id')?.value;
  try {
    const response = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: request.headers.get('cookie') ?? '',
      },
      body: JSON.stringify({ device_id: deviceId ?? '' }),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (!response.ok) return { accessToken: null, setCookies };
    const body = (await response.json()) as { data?: { access_token?: string } };
    return { accessToken: body.data?.access_token ?? null, setCookies };
  } catch {
    return { accessToken: null, setCookies: [] };
  }
}

function withRotatedCookies(response: NextResponse, setCookies: string[]): NextResponse {
  for (const cookie of setCookies) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
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
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const { accessToken, setCookies } = await resolveAccessToken(request);
  if (!accessToken) {
    return withRotatedCookies(NextResponse.redirect(new URL('/login', request.url)), setCookies);
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
