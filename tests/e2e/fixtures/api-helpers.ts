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
  // csrf-guard.ts requires X-CSRF-Token on any non-safe request once a
  // refresh_token session cookie exists — including a second login within
  // the same APIRequestContext (e.g. switching from admin to supervisor
  // partway through a test). Attach it if a prior login in this context
  // already set the cookie; there's none to attach on the very first
  // login, which csrf-guard.ts exempts precisely because no session exists yet.
  const state = await request.storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf-token');
  const headers = csrfCookie ? { 'X-CSRF-Token': decodeURIComponent(csrfCookie.value) } : undefined;

  const res = await request.post('/api/auth/login', {
    data: { email, password, device_id: crypto.randomUUID() },
    headers,
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

/**
 * Product Request workflow was removed — Product Management (POST
 * /api/products, adminOnly) is the sole path to a new product. Creates the
 * product branch-exclusive to branchId, then adds each variant.
 */
export async function createProduct(
  request: APIRequestContext,
  baseURL: string,
  params: {
    branchId: string;
    adminAccessToken: string;
    proposedName: string;
    variants: { name: string; size_label: string; base_price: number }[];
  },
): Promise<{ productId: string }> {
  const created = await authedPost<{ id: string }>(request, baseURL, '/api/products', params.adminAccessToken, {
    name: params.proposedName,
    category: 'E2E',
    status: 'active',
    is_seasonal: false,
    branch_exclusive: true,
    exclusive_branch_id: params.branchId,
  });
  if (!created.data?.id) {
    throw new Error(`Failed to create product "${params.proposedName}": ${JSON.stringify(created.error)}`);
  }

  for (const variant of params.variants) {
    const createdVariant = await authedPost<{ id: string }>(
      request,
      baseURL,
      `/api/products/${created.data.id}/variants`,
      params.adminAccessToken,
      { name: variant.name, size_label: variant.size_label, base_price: variant.base_price, is_active: true },
    );
    if (!createdVariant.data?.id) {
      throw new Error(`Failed to create variant "${variant.name}" for "${params.proposedName}": ${JSON.stringify(createdVariant.error)}`);
    }
  }

  return { productId: created.data.id };
}
