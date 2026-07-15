const DEVICE_ID_KEY = 'pc_device_id';

/**
 * Mirrors the device id into a regular (non-HttpOnly, non-secret — it's
 * just a correlation id, not a credential) cookie so Next.js middleware
 * (which runs server-side and has no access to localStorage) can read it
 * when calling the refresh endpoint to check session validity.
 */
function syncDeviceCookie(deviceId: string): void {
  const maxAgeSeconds = 60 * 60 * 24 * 365;
  document.cookie = `${DEVICE_ID_KEY}=${deviceId}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

/**
 * Device registration (Architecture doc §5.3): a UUID device token is
 * generated on first login and persisted to localStorage, then sent with
 * every request. Reused across sessions on the same browser/device.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return '';

  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    syncDeviceCookie(existing);
    return existing;
  }

  const generated = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_KEY, generated);
  syncDeviceCookie(generated);
  return generated;
}

export function hasRegisteredDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.localStorage.getItem(DEVICE_ID_KEY));
}
