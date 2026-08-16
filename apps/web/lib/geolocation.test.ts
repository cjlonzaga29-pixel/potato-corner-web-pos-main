import { describe, it, expect, vi, afterEach } from 'vitest';
import { getCurrentPosition, queryGeolocationPermission, GeolocationError } from './geolocation';

function mockGeolocation(handler: (success: PositionCallback, error?: PositionErrorCallback, options?: PositionOptions) => void) {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: handler },
  });
}

function mockPermissions(state: 'granted' | 'prompt' | 'denied' | (() => Promise<'granted' | 'prompt' | 'denied'>)) {
  Object.defineProperty(globalThis.navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue(typeof state === 'string' ? { state } : state) },
  });
}

function positionError(code: number, message = ''): GeolocationPositionError {
  return { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis.navigator, 'permissions');
});

describe('queryGeolocationPermission', () => {
  it('returns "unsupported" when navigator.geolocation is unavailable', async () => {
    Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, value: undefined });
    await expect(queryGeolocationPermission()).resolves.toBe('unsupported');
  });

  it('returns "prompt" when the Permissions API is unavailable (e.g. iOS Safari)', async () => {
    mockGeolocation(() => undefined as never);
    Reflect.deleteProperty(globalThis.navigator, 'permissions');
    await expect(queryGeolocationPermission()).resolves.toBe('prompt');
  });

  it('reflects the Permissions API state (granted/prompt/denied)', async () => {
    mockGeolocation(() => undefined as never);
    mockPermissions('denied');
    await expect(queryGeolocationPermission()).resolves.toBe('denied');
  });
});

describe('getCurrentPosition', () => {
  it('resolves with coordinates on success', async () => {
    mockGeolocation((success) => success({ coords: { latitude: 14.5, longitude: 121.0 } } as GeolocationPosition));
    await expect(getCurrentPosition()).resolves.toEqual({ lat: 14.5, lng: 121.0 });
  });

  it('maps PERMISSION_DENIED to a cashier-friendly message and code, never the raw browser text', async () => {
    mockGeolocation((_success, error) => error?.(positionError(1, 'User denied Geolocation')));
    await expect(getCurrentPosition()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.not.stringContaining('User denied Geolocation'),
    });
  });

  it('maps POSITION_UNAVAILABLE to a GPS/location-services message', async () => {
    mockGeolocation((_success, error) => error?.(positionError(2)));
    await expect(getCurrentPosition()).rejects.toMatchObject({ code: 'POSITION_UNAVAILABLE' });
  });

  it('retries once with low accuracy after a TIMEOUT, and resolves if the fallback succeeds', async () => {
    let calls = 0;
    mockGeolocation((success, error, options) => {
      calls += 1;
      if (calls === 1) {
        expect(options?.enableHighAccuracy).toBe(true);
        error?.(positionError(3));
        return;
      }
      expect(options?.enableHighAccuracy).toBe(false);
      success({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition);
    });
    await expect(getCurrentPosition()).resolves.toEqual({ lat: 1, lng: 2 });
    expect(calls).toBe(2);
  });

  it('does not retry a second time if the low-accuracy fallback also times out', async () => {
    let calls = 0;
    mockGeolocation((_success, error) => {
      calls += 1;
      error?.(positionError(3));
    });
    await expect(getCurrentPosition()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toBe(2);
  });

  it('rejects immediately with UNSUPPORTED when the browser has no geolocation API', async () => {
    Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, value: undefined });
    await expect(getCurrentPosition()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('exposes GeolocationError as a real Error subclass', async () => {
    mockGeolocation((_success, error) => error?.(positionError(2)));
    await expect(getCurrentPosition()).rejects.toBeInstanceOf(GeolocationError);
  });

  it('rejects with INSECURE_CONTEXT without ever calling getCurrentPosition when the page is not HTTPS', async () => {
    const calls: unknown[] = [];
    mockGeolocation((success) => {
      calls.push(success);
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    try {
      await expect(getCurrentPosition()).rejects.toMatchObject({ code: 'INSECURE_CONTEXT' });
      expect(calls).toHaveLength(0);
    } finally {
      if (originalDescriptor) Object.defineProperty(window, 'isSecureContext', originalDescriptor);
    }
  });
});
