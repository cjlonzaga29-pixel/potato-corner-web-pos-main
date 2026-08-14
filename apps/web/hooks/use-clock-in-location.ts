'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCurrentPosition, queryGeolocationPermission, GeolocationError, type GpsCoords } from '@/lib/geolocation';

export interface UseClockInLocationResult {
  isLocating: boolean;
  locationError: string | null;
  /** True only for a confirmed-blocked permission — drives the recovery panel (Try Again / How to Enable Location) instead of the raw error text. */
  isPermissionDenied: boolean;
  /** Resolves to coordinates on success, or null after setting locationError/isPermissionDenied. Never throws. */
  getLocation: () => Promise<GpsCoords | null>;
}

/**
 * Centralizes Clock In's geolocation permission handling. Pre-checks
 * navigator.permissions so an already-blocked permission shows the recovery
 * message immediately instead of calling getCurrentPosition again (browsers
 * don't re-prompt once denied — that call would just re-fire the same
 * PERMISSION_DENIED). While denied, listens for the tab/app regaining focus
 * and re-checks permission, so a grant made in browser/OS settings clears
 * the recovery panel without the user reloading the POS.
 */
export function useClockInLocation(): UseClockInLocationResult {
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isPermissionDenied, setIsPermissionDenied] = useState(false);

  useEffect(() => {
    if (!isPermissionDenied) return;
    function recheck() {
      if (document.visibilityState !== 'visible') return;
      void queryGeolocationPermission().then((state) => {
        if (state === 'granted' || state === 'prompt') {
          setIsPermissionDenied(false);
          setLocationError(null);
        }
      });
    }
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [isPermissionDenied]);

  const getLocation = useCallback(async (): Promise<GpsCoords | null> => {
    setLocationError(null);
    setIsLocating(true);
    try {
      const permission = await queryGeolocationPermission();
      if (permission === 'denied') {
        setIsPermissionDenied(true);
        setLocationError('Location permission is blocked. Allow location access for this website, then tap Try Again.');
        return null;
      }
      const coords = await getCurrentPosition();
      setIsPermissionDenied(false);
      return coords;
    } catch (error) {
      if (error instanceof GeolocationError) {
        setLocationError(error.message);
        if (error.code === 'PERMISSION_DENIED') setIsPermissionDenied(true);
      } else {
        setLocationError('Unable to get your location. Try again.');
      }
      return null;
    } finally {
      setIsLocating(false);
    }
  }, []);

  return { isLocating, locationError, isPermissionDenied, getLocation };
}
