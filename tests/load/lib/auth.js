import http from 'k6/http';
import { check } from 'k6';

/**
 * k6's Goja runtime has no Web Crypto API (no crypto.randomUUID()) — only
 * k6/crypto's hashing functions. device_id just needs to satisfy Zod's
 * z.uuid() format check, not real cryptographic randomness, so a
 * Math.random()-based v4-shaped string is enough here.
 */
function fakeUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Mirrors apps/web/lib/api-client.ts's CSRF handling: csrf-guard.ts issues a
 * non-HttpOnly csrf-token cookie on every response (login included) and
 * requires it echoed back as X-CSRF-Token on mutation requests once a
 * session (refresh_token) cookie exists. k6's http module keeps a per-VU
 * cookie jar automatically, so the cookie set on login is available here —
 * this just reads it back out to build the header.
 */
export function login(baseUrl, email, password) {
  const res = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({ email, password, device_id: fakeUuidV4() }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(res, { 'login succeeded (200)': (r) => r.status === 200 });

  const body = res.json();
  const csrfToken = res.cookies['csrf-token'] ? res.cookies['csrf-token'][0].value : null;

  return {
    accessToken: body && body.data ? body.data.access_token : null,
    userId: body && body.data ? body.data.user.id : null,
    csrfToken,
  };
}

export function authedHeaders(session, extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
      'X-CSRF-Token': session.csrfToken,
    },
    extra || {},
  );
}
