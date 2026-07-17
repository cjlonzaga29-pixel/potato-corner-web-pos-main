import type { APIRequestContext } from '@playwright/test';

interface ApiResponse<T> {
  data: T | null;
  error: unknown;
  meta: unknown;
}

/** Direct email/password login via the API — returns a bearer token independent of any browser session. */
export async function apiLogin(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<{ accessToken: string; userId: string; branchIds: string[] }> {
  const res = await request.post('/api/auth/login', {
    data: { email, password, device_id: crypto.randomUUID() },
  });
  const body = (await res.json()) as ApiResponse<{ access_token: string; user: { id: string; branch_ids: string[] } }>;
  if (!res.ok() || !body.data) {
    throw new Error(`Login failed for ${email} (${res.status()}): ${JSON.stringify(body.error)}`);
  }
  return { accessToken: body.data.access_token, userId: body.data.user.id, branchIds: body.data.user.branch_ids };
}

async function readCsrfToken(request: APIRequestContext, baseURL: string): Promise<string> {
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === 'csrf-token' && new URL(baseURL).hostname === c.domain);
  if (!cookie) throw new Error('csrf-token cookie not found — csrf-guard.ts should have issued one after login');
  return decodeURIComponent(cookie.value);
}

/** Authenticated POST helper: attaches the bearer token and the double-submit CSRF header csrf-guard.ts requires once a session cookie exists. */
export async function authedPost<T>(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  accessToken: string,
  body: unknown,
): Promise<{ status: number; data: T | null; error: unknown }> {
  const csrfToken = await readCsrfToken(request, baseURL);
  const res = await request.post(path, {
    data: body,
    headers: { Authorization: `Bearer ${accessToken}`, 'X-CSRF-Token': csrfToken },
  });
  const parsed = (await res.json()) as ApiResponse<T>;
  return { status: res.status(), data: parsed.data, error: parsed.error };
}

export async function authedPatch<T>(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  accessToken: string,
  body: unknown,
): Promise<{ status: number; data: T | null; error: unknown }> {
  const csrfToken = await readCsrfToken(request, baseURL);
  const res = await request.patch(path, {
    data: body,
    headers: { Authorization: `Bearer ${accessToken}`, 'X-CSRF-Token': csrfToken },
  });
  const parsed = (await res.json()) as ApiResponse<T>;
  return { status: res.status(), data: parsed.data, error: parsed.error };
}

export async function authedGet<T>(
  request: APIRequestContext,
  path: string,
  accessToken: string,
): Promise<{ status: number; data: T | null; error: unknown }> {
  const res = await request.get(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  const parsed = (await res.json()) as ApiResponse<T>;
  return { status: res.status(), data: parsed.data, error: parsed.error };
}
