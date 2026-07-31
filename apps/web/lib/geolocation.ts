export interface GpsCoords {
  lat: number;
  lng: number;
}

/** GPS is required for clock-in (attendance.schema.ts's clockInSchema never makes it optional) and optional for clock-out — so callers decide how to treat a failure. */
export function getCurrentPosition(): Promise<GpsCoords> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This device does not support location services.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(new Error(error.message || 'Unable to read your location.')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}
