import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useClockInLocation } from './use-clock-in-location';

const { mockGetCurrentPosition, mockQueryGeolocationPermission } = vi.hoisted(() => ({
  mockGetCurrentPosition: vi.fn(),
  mockQueryGeolocationPermission: vi.fn(),
}));

vi.mock('@/lib/geolocation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/geolocation')>('@/lib/geolocation');
  return {
    ...actual,
    getCurrentPosition: mockGetCurrentPosition,
    queryGeolocationPermission: mockQueryGeolocationPermission,
  };
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  vi.clearAllMocks();
  setVisibility('visible');
});

describe('useClockInLocation', () => {
  it('requests location and returns coordinates when permission is granted', async () => {
    mockQueryGeolocationPermission.mockResolvedValue('granted');
    mockGetCurrentPosition.mockResolvedValue({ lat: 14.5, lng: 121.0 });

    const { result } = renderHook(() => useClockInLocation());
    let coords;
    await act(async () => {
      coords = await result.current.getLocation();
    });

    expect(coords).toEqual({ lat: 14.5, lng: 121.0 });
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.locationError).toBeNull();
    expect(result.current.isPermissionDenied).toBe(false);
  });

  it('requests location normally when permission is still "prompt"', async () => {
    mockQueryGeolocationPermission.mockResolvedValue('prompt');
    mockGetCurrentPosition.mockResolvedValue({ lat: 1, lng: 2 });

    const { result } = renderHook(() => useClockInLocation());
    await act(async () => {
      await result.current.getLocation();
    });

    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('shows recovery UI without calling getCurrentPosition when permission is already denied', async () => {
    mockQueryGeolocationPermission.mockResolvedValue('denied');

    const { result } = renderHook(() => useClockInLocation());
    let coords;
    await act(async () => {
      coords = await result.current.getLocation();
    });

    expect(coords).toBeNull();
    expect(result.current.isPermissionDenied).toBe(true);
    expect(result.current.locationError).toMatch(/blocked/i);
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('does not loop getCurrentPosition on repeated denied checks', async () => {
    mockQueryGeolocationPermission.mockResolvedValue('denied');
    const { result } = renderHook(() => useClockInLocation());

    await act(async () => {
      await result.current.getLocation();
    });
    await act(async () => {
      await result.current.getLocation();
    });

    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('Try Again (re-invoking getLocation) re-checks permission and proceeds once granted', async () => {
    mockQueryGeolocationPermission.mockResolvedValueOnce('denied').mockResolvedValueOnce('granted');
    mockGetCurrentPosition.mockResolvedValue({ lat: 5, lng: 6 });

    const { result } = renderHook(() => useClockInLocation());
    await act(async () => {
      await result.current.getLocation();
    });
    expect(result.current.isPermissionDenied).toBe(true);

    let coords;
    await act(async () => {
      coords = await result.current.getLocation();
    });

    expect(coords).toEqual({ lat: 5, lng: 6 });
    expect(result.current.isPermissionDenied).toBe(false);
  });

  it('clears the denied state when the tab regains focus and permission is now granted', async () => {
    mockQueryGeolocationPermission.mockResolvedValueOnce('denied');
    const { result } = renderHook(() => useClockInLocation());
    await act(async () => {
      await result.current.getLocation();
    });
    expect(result.current.isPermissionDenied).toBe(true);

    mockQueryGeolocationPermission.mockResolvedValue('granted');
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.isPermissionDenied).toBe(false));
  });

  it('maps a live PERMISSION_DENIED from getCurrentPosition (permission revoked mid-flow) into the denied state', async () => {
    mockQueryGeolocationPermission.mockResolvedValue('prompt');
    const { GeolocationError } = await import('@/lib/geolocation');
    mockGetCurrentPosition.mockRejectedValue(new GeolocationError('PERMISSION_DENIED', 'Location permission is blocked. Allow location access and try again.'));

    const { result } = renderHook(() => useClockInLocation());
    await act(async () => {
      await result.current.getLocation();
    });

    expect(result.current.isPermissionDenied).toBe(true);
    expect(result.current.locationError).toMatch(/blocked/i);
  });
});
