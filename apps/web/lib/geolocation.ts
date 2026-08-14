export interface GpsCoords {
  lat: number;
  lng: number;
}

export type GeolocationErrorCode = 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' | 'UNKNOWN';

/** Cashier-friendly geolocation failure — code lets callers branch (e.g. show the permission-recovery panel only for PERMISSION_DENIED) without re-parsing the message string. */
export class GeolocationError extends Error {
  code: GeolocationErrorCode;
  constructor(code: GeolocationErrorCode, message: string) {
    super(message);
    this.name = 'GeolocationError';
    this.code = code;
  }
}

export type GeolocationPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported';

/**
 * Pre-checks permission state where the Permissions API is available so a
 * known-denied permission can show recovery UI instead of calling
 * getCurrentPosition again (which just re-fires PERMISSION_DENIED — browsers
 * won't re-prompt once denied). Safari/iOS has no `navigator.permissions`
 * support for geolocation, so it falls back to 'prompt' there and lets
 * getCurrentPosition itself be the source of truth.
 */
export async function queryGeolocationPermission(): Promise<GeolocationPermissionState> {
  if (!navigator.geolocation) return 'unsupported';
  if (!('permissions' in navigator) || typeof navigator.permissions?.query !== 'function') return 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state as GeolocationPermissionState;
  } catch {
    return 'prompt';
  }
}

function mapGeolocationError(error: GeolocationPositionError): GeolocationError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return new GeolocationError('PERMISSION_DENIED', 'Location permission is blocked. Allow location access and try again.');
    case error.POSITION_UNAVAILABLE:
      return new GeolocationError(
        'POSITION_UNAVAILABLE',
        'Your location could not be determined. Check GPS/location services and try again.',
      );
    case error.TIMEOUT:
      return new GeolocationError('TIMEOUT', 'Location request timed out. Make sure Location/GPS is enabled and try again.');
    default:
      return new GeolocationError('UNKNOWN', 'Unable to get your location. Try again.');
  }
}

function requestPosition(options: PositionOptions): Promise<GpsCoords> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(mapGeolocationError(error)),
      options,
    );
  });
}

/**
 * GPS is required for clock-in (attendance.schema.ts's clockInSchema never
 * makes it optional) and optional for clock-out — so callers decide how to
 * treat a failure. First attempt asks for a high-accuracy GPS fix; if that
 * times out, one fallback attempt asks for a coarser (network/cell) fix
 * instead of leaving the cashier stuck — never more than that one retry.
 */
export async function getCurrentPosition(): Promise<GpsCoords> {
  if (!navigator.geolocation) {
    throw new GeolocationError('UNSUPPORTED', 'This browser does not support location access.');
  }
  try {
    return await requestPosition({ enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
  } catch (error) {
    if (error instanceof GeolocationError && error.code === 'TIMEOUT') {
      return await requestPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 30_000 });
    }
    throw error;
  }
}
