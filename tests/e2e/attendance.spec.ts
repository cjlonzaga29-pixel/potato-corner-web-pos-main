// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app. Payload shapes taken from reading the real schema
// (packages/shared/src/schemas/attendance.schema.ts) and service
// (attendance.service.ts), not guessed.
//
// New file — "attendance clock-in with GPS" is named explicitly in
// master-execution-plan.md's Testing Strategy section but had no spec file
// at all (the original four stubs were auth/cash-management/inventory/
// pos-workflow only).
//
// API-only, not UI-driven: grepped the whole frontend for clock-in UI
// (clock-in/clock_in/clockIn/useClockIn) and found none — only admin/
// supervisor read-only attendance views and a supervisor override dialog
// exist. There is currently no page where a staff member can actually
// clock in or out. That's a real product gap worth flagging for Phase 20,
// not something this hardening task should silently build a page for.
import { test, expect } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';
import { seedBranchGps, BRANCH_GPS, OUTSIDE_RADIUS_GPS } from './fixtures/seed-branch-gps';

interface AttendanceRecordApi {
  id: string;
  clock_in_gps_status: 'within_radius' | 'outside_radius' | 'no_gps_data';
  clock_in_time_flag: boolean;
  status: string;
}

let branchId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  await seedBranchGps(request, url, branchId);
});

test('clock-in within the branch GPS radius is recorded as within_radius, and clock-out completes the record', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);

  const clockIn = await authedPost<AttendanceRecordApi>(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
    gps_lat: BRANCH_GPS.lat,
    gps_lng: BRANCH_GPS.lng,
  });

  expect(clockIn.status).toBe(201);
  expect(clockIn.data?.clock_in_gps_status).toBe('within_radius');
  // No device_time was sent, so resolveTimeFlag compares server time against
  // itself (deviceTime undefined) — attendance.service.ts's actual
  // no-device-time behavior wasn't traced further than the schema allowing
  // it as optional; not asserting on clock_in_time_flag's value here.

  const clockOut = await authedPost<AttendanceRecordApi>(request, url, '/api/attendance/clock-out', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
    gps_lat: BRANCH_GPS.lat,
    gps_lng: BRANCH_GPS.lng,
  });

  expect(clockOut.status).toBe(200);
});

test('clock-in far outside the branch GPS radius is still recorded, flagged as outside_radius — soft flag, not a hard rejection', async ({
  request,
  baseURL,
}) => {
  const url = baseURL ?? 'http://localhost:3000';
  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);

  // attendance.service.ts's clockIn rejects with ALREADY_CLOCKED_IN if the
  // employee has an open record — the previous test already clocked this
  // same staff account out, so this is a fresh clock-in.
  const clockIn = await authedPost<AttendanceRecordApi>(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
    gps_lat: OUTSIDE_RADIUS_GPS.lat,
    gps_lng: OUTSIDE_RADIUS_GPS.lng,
  });

  // Matches the "no freeze mechanism" architecture principle also seen in
  // physical inventory counts — GPS mismatch is recorded for supervisor
  // review, not blocked outright.
  expect(clockIn.status).toBe(201);
  expect(clockIn.data?.clock_in_gps_status).toBe('outside_radius');

  // Cleanup — clock back out so this spec doesn't leave a dangling open
  // attendance record for other spec files/re-runs.
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
  });
});

test('a second clock-in while already clocked in is rejected', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);

  const first = await authedPost<AttendanceRecordApi>(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
    gps_lat: BRANCH_GPS.lat,
    gps_lng: BRANCH_GPS.lng,
  });
  expect(first.status).toBe(201);

  const second = await authedPost(request, url, '/api/attendance/clock-in', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
    gps_lat: BRANCH_GPS.lat,
    gps_lng: BRANCH_GPS.lng,
  });
  expect(second.status).toBe(409);
  expect(second.error).toMatchObject({ code: 'ALREADY_CLOCKED_IN' });

  // Cleanup.
  await authedPost(request, url, '/api/attendance/clock-out', staff.accessToken, {
    employee_id: staff.userId,
    branch_id: branchId,
  });
});
