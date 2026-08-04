/**
 * Only a same-origin relative path is a safe post-auth redirect target.
 * Rejects absolute URLs, protocol-relative URLs (`//evil.com`, which
 * browsers resolve as same-protocol absolute), and the backslash variant
 * (`/\evil.com`) some browsers also normalize to protocol-relative — all
 * of which would otherwise let a crafted redirect target send the user
 * off-site after a real login or password change.
 */
export function getSafeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return null;
  return value;
}
