import fs from 'node:fs';
import path from 'node:path';
import { chromium, request as playwrightRequest, test as base, type APIRequestContext } from '@playwright/test';

export const PROD_AUTH_STATE_PATH = path.join(__dirname, '..', 'fixtures', 'prod-super-admin.auth.json');

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — copy tests/e2e/.env.e2e.example to tests/e2e/.env.e2e and fill it in`);
  }
  return value;
}

export const SUPER_ADMIN = {
  get email() {
    return requireEnv('E2E_SUPER_ADMIN_EMAIL');
  },
  get password() {
    return requireEnv('E2E_SUPER_ADMIN_PASSWORD');
  },
};

/**
 * Performs exactly ONE real form-based login against production and saves the
 * resulting storageState (refresh_token + pc_access_hint + csrf-token cookies).
 * loginLimiter caps POST /api/auth/login at 10/15min per IP — every test in
 * this suite reuses this single saved session via storageState instead of
 * logging in again. Session restoration on each test's first page load goes
 * through POST /api/auth/refresh (see apps/web/hooks/use-auth.ts), which has
 * no rate limiter, so this scales to any number of tests without spending
 * additional login-budget.
 */
export async function bootstrapProdSession(baseURL: string): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(SUPER_ADMIN.email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(SUPER_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/admin/dashboard**');

  // Wipe the password field's DOM value before any snapshot/trace can capture it.
  await page.evaluate(() => {
    document.querySelectorAll('input[type="password"]').forEach((el) => {
      (el as HTMLInputElement).value = '';
    });
  });

  await context.storageState({ path: PROD_AUTH_STATE_PATH });
  await context.close();
  await browser.close();
}

/**
 * The refresh_token cookie is bound server-side to the exact device_id used
 * at login (see apps/api/src/modules/auth/auth.service.ts) — a mismatched
 * device_id on /api/auth/refresh comes back REFRESH_INVALID even with a
 * valid cookie. bootstrapProdSession's real login flow generates this via
 * getOrCreateDeviceId() and persists it to localStorage, which Playwright's
 * storageState snapshot already captures; read it back out rather than
 * generating a new one.
 */
function readDeviceIdFromStorageState(baseURL: string): string {
  const state = JSON.parse(fs.readFileSync(PROD_AUTH_STATE_PATH, 'utf-8')) as {
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  const origin = state.origins.find((o) => o.origin === new URL(baseURL).origin);
  const entry = origin?.localStorage.find((item) => item.name === 'pc_device_id');
  if (!entry) throw new Error('pc_device_id not found in saved storageState — was bootstrapProdSession run against this baseURL?');
  return entry.value;
}

/**
 * Fresh API request context carrying the shared session's cookies (refresh_token,
 * csrf-token), then rotates a live access token via /api/auth/refresh — never
 * calls /api/auth/login, so it never touches loginLimiter's budget.
 */
export async function createAuthedApiContext(baseURL: string): Promise<{ request: APIRequestContext; accessToken: string }> {
  const request = await playwrightRequest.newContext({ baseURL, storageState: PROD_AUTH_STATE_PATH });
  const deviceId = readDeviceIdFromStorageState(baseURL);
  // /api/auth/refresh is CSRF-exempt (see csrf-guard.ts EXEMPT_PATHS) and unrated-limited —
  // rotates the shared session's refresh_token cookie into a fresh access token.
  const res = await request.post('/api/auth/refresh', { data: { device_id: deviceId } });
  const body = (await res.json()) as { data: { access_token: string } | null; error: unknown };
  if (!res.ok() || !body.data?.access_token) {
    throw new Error(`Failed to refresh access token from shared session: ${JSON.stringify(body.error)}`);
  }
  // Refresh tokens are single-use (rotated on every call, ~10s reuse-cache
  // window — see auth.service.ts's refreshToken()). Persist the rotated
  // cookie back to the shared file immediately so the next consumer (a page
  // fixture's silent refresh, or another spec file's createAuthedApiContext)
  // reads the CURRENT token, not the one this call just consumed.
  await request.storageState({ path: PROD_AUTH_STATE_PATH });
  return { request, accessToken: body.data.access_token };
}

/**
 * Playwright `test` with the `page` fixture overridden to (a) build its
 * browser context from the CURRENT contents of the shared storageState file
 * rather than a fixed snapshot, and (b) write the context's cookies back to
 * that same file after the test — capturing whatever refresh_token rotation
 * the app's own silent-refresh-on-mount just performed. Without this, every
 * test after the first would present an already-consumed refresh token and
 * get bounced to /login. Every spec file in this production suite must
 * import `test`/`expect` from here instead of directly from '@playwright/test'.
 */
export const test = base.extend<Record<string, never>>({
  page: async ({ browser }, use, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string;
    const context = await browser.newContext({ baseURL, storageState: PROD_AUTH_STATE_PATH });
    const page = await context.newPage();
    await use(page);
    await context.storageState({ path: PROD_AUTH_STATE_PATH });
    await context.close();
  },
});

export async function authedDelete(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  accessToken: string,
): Promise<{ status: number }> {
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === 'csrf-token' && new URL(baseURL).hostname === c.domain);
  if (!cookie) throw new Error('csrf-token cookie not found on shared session');
  const res = await request.delete(path, {
    headers: { Authorization: `Bearer ${accessToken}`, 'X-CSRF-Token': decodeURIComponent(cookie.value) },
  });
  return { status: res.status() };
}
