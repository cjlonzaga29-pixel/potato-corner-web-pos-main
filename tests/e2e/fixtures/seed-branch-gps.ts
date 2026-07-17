import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';
import { apiLogin, authedPatch } from './api-helpers';

/** Quezon City coordinates, matching the seeded branch's city (apps/api/prisma/seed.ts). */
export const BRANCH_GPS = { lat: 14.676, lng: 121.0437, radiusMeters: 100 };

/** Far enough from BRANCH_GPS (~570km, Cebu City) to be outside any realistic radius. */
export const OUTSIDE_RADIUS_GPS = { lat: 10.3157, lng: 123.8854 };

/**
 * apps/api/prisma/seed.ts creates the branch with no GPS config
 * (gpsLatitude/gpsLongitude are nullable and unset) — attendance.service.ts's
 * resolveGpsStatus returns 'no_gps_data' in that state, which would make a
 * within-radius vs. outside-radius test meaningless. Sets real coordinates
 * via the real admin API. Note: branch.schema.ts's updateBranchSchema is
 * the one schema in this codebase using camelCase field names rather than
 * snake_case — gpsLatitude/gpsLongitude/gpsRadiusMeters, not gps_latitude.
 */
export async function seedBranchGps(request: APIRequestContext, baseURL: string, branchId: string): Promise<void> {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const result = await authedPatch(request, baseURL, `/api/branches/${branchId}`, admin.accessToken, {
    gpsLatitude: BRANCH_GPS.lat,
    gpsLongitude: BRANCH_GPS.lng,
    gpsRadiusMeters: BRANCH_GPS.radiusMeters,
  });
  if (result.status !== 200) {
    throw new Error(`Failed to set branch GPS config (${result.status}): ${JSON.stringify(result.error)}`);
  }
}
