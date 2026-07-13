import type { JwtPayload } from '@potato-corner/shared';

/**
 * Decodes (does not verify) a JWT payload client-side. Safe here because
 * the token was just issued by our own backend over the current request —
 * this is a display/UX convenience, not an authorization decision. Real
 * verification always happens server-side (middleware/authenticate.ts).
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}
