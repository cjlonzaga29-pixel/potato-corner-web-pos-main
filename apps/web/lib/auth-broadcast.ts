const CHANNEL_NAME = 'pc_auth_logout';
const STORAGE_KEY = 'pc_auth_logout_at';

/**
 * Notifies every other tab that the session has ended. Without this, a
 * logout in one tab only revokes the shared HttpOnly refresh cookie —
 * other tabs keep their own in-memory (Zustand) auth state and still-valid
 * access token, and keep looking and acting authenticated until that
 * token's natural TTL expires.
 */
export function broadcastLogout(): void {
  if (typeof window === 'undefined') return;

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: 'logout' });
    channel.close();
    return;
  }

  // Fallback for browsers without BroadcastChannel: writing a fresh value
  // fires a 'storage' event in every OTHER tab (never the tab that wrote
  // it), which is exactly the cross-tab signal needed here.
  window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
}

/** Subscribes to logout signals broadcast by other tabs. Returns an unsubscribe function. */
export function subscribeToLogout(onLogout: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => onLogout();
    return () => channel.close();
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) onLogout();
  }
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}
