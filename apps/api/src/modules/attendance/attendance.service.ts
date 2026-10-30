import { Prisma } from '@prisma/client';
import { ROLES, SOCKET_EVENTS, type AttendanceState, type AttendanceSummaryResponse, type JwtPayload } from '@potato-corner/shared';
import { attendanceRepository } from './attendance.repository.js';
import { AttendanceError, type AttendanceListFilters, type ClockInData, type ClockOutData, type ManualOverrideData } from './attendance.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';
import { cashRepository } from '../cash/cash.repository.js';
import { cashService } from '../cash/cash.service.js';
import { getAccessibleBranchIds } from '../../lib/branch-access.js';
import { prisma } from '../../lib/prisma.js';
import { attendanceOpenSessionLockId } from '../../lib/pg-lock.js';
import { settingsService } from '../settings/settings.service.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { dayBounds, manilaDateKey } from '../../lib/manila-time.js';

type ActorContext = { id: string; role: string };
type GpsStatus = 'within_radius' | 'outside_radius' | 'no_gps_data';

/** See the architecture doc's "time-delta flagging" — a device clock more than 5 minutes off from the server is flagged for supervisor review, not rejected outright. */
const TIME_DELTA_FLAG_THRESHOLD_MS = 5 * 60 * 1000;
const EARTH_RADIUS_METERS = 6371000;

interface DecimalLike {
  toNumber(): number;
}

/** POS-PERF-P51 — one break interval as read back from attendance_breaks. */
export interface BreakIntervalRow {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: 'resumed' | 'clock_out' | null;
}

interface AttendanceRow {
  id: string;
  employeeId: string;
  branchId: string;
  clockInServerTime: Date;
  clockInDeviceTime: Date | null;
  clockInGpsLat: DecimalLike | null;
  clockInGpsLng: DecimalLike | null;
  clockInGpsStatus: string;
  clockInTimeFlag: boolean;
  clockOutServerTime: Date | null;
  clockOutDeviceTime: Date | null;
  clockOutGpsLat: DecimalLike | null;
  clockOutGpsLng: DecimalLike | null;
  breakMinutes: number;
  actualWorkMinutes: number | null;
  overtimeMinutes: number;
  status: string;
  correctionReason: string | null;
  correctedBy: string | null;
  originalRecordId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  /** Present only when the query included the relation (branch-scoped list reads) — see attendance.repository.ts findByBranch. */
  employee?: { firstName: string; lastName: string; employeeId: string | null; status: string } | null;
  /** POS-PERF-P51 — present when the query included the breaks relation; a write that returns the bare row has none to show. */
  breaks?: BreakIntervalRow[];
}

interface BranchRow {
  id: string;
  gpsLatitude: DecimalLike | null;
  gpsLongitude: DecimalLike | null;
  gpsRadiusMeters: number;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine great-circle distance in meters between two lat/lng points. */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * GPS is mandatory on every clock-in, so "no_gps_data" here is never about
 * the employee's coordinates — it means the branch itself has no configured
 * gpsLatitude/gpsLongitude to validate against, so no radius comparison is
 * possible.
 */
function resolveGpsStatus(branch: BranchRow, gpsLat: number, gpsLng: number): GpsStatus {
  if (branch.gpsLatitude === null || branch.gpsLongitude === null) return 'no_gps_data';
  const distance = distanceMeters(gpsLat, gpsLng, branch.gpsLatitude.toNumber(), branch.gpsLongitude.toNumber());
  return distance <= branch.gpsRadiusMeters ? 'within_radius' : 'outside_radius';
}

function resolveTimeFlag(serverTime: Date, deviceTime?: Date): boolean {
  if (!deviceTime) return false;
  return Math.abs(serverTime.getTime() - deviceTime.getTime()) > TIME_DELTA_FLAG_THRESHOLD_MS;
}

/**
 * POS-PERF-P51 — server-side time accounting for one attendance record.
 * Every input is a server timestamp; nothing here reads a device clock.
 * Durations are differences of absolute instants, so an overnight shift (or
 * a break that spans midnight) needs no special casing — the Manila business
 * timezone only matters for "which day" grouping, never for elapsed time.
 *
 * - Open record: counts up to `now`; an open break counts up to `now` too.
 * - Closed record: counts up to its clock-out.
 * - Break time = the sum of recorded intervals. A record with no intervals
 *   (pre-P51 history, a manual correction, or a legacy client that sent
 *   break_minutes at clock-out) falls back to its stored break_minutes —
 *   never a fabricated interval.
 * - Work = elapsed − break, floored at 0. No paid/unpaid break policy.
 */
export function computeAttendanceTimes(
  record: Pick<AttendanceRow, 'clockInServerTime' | 'clockOutServerTime' | 'breakMinutes' | 'breaks'>,
  now: Date,
): { state: AttendanceState; openBreakStartedAt: Date | null; breakMs: number; workMs: number } {
  const end = record.clockOutServerTime ?? now;
  const breaks = record.breaks ?? [];
  const totalMs = Math.max(0, end.getTime() - record.clockInServerTime.getTime());
  let breakMs: number;
  if (breaks.length > 0) {
    breakMs = breaks.reduce((sum, b) => {
      const breakEnd = Math.min((b.endedAt ?? end).getTime(), end.getTime());
      return sum + Math.max(0, breakEnd - b.startedAt.getTime());
    }, 0);
  } else {
    breakMs = record.breakMinutes * 60_000;
  }
  const openBreak = record.clockOutServerTime === null ? (breaks.find((b) => b.endedAt === null) ?? null) : null;
  const state: AttendanceState = record.clockOutServerTime !== null ? 'clocked_out' : openBreak ? 'on_break' : 'working';
  return { state, openBreakStartedAt: openBreak?.startedAt ?? null, breakMs, workMs: Math.max(0, totalMs - breakMs) };
}

/** Whichever is later — keeps a new timestamp from ever landing before one already recorded for this record (guards against clock differences between API instances). */
function notBefore(candidate: Date, floor: Date | null | undefined): Date {
  return floor && floor.getTime() > candidate.getTime() ? floor : candidate;
}

function toResponse(record: AttendanceRow, now: Date = new Date()) {
  const times = computeAttendanceTimes(record, now);
  return {
    id: record.id,
    employee_id: record.employeeId,
    // Only populated when the query joined the employee relation (see
    // attendance.repository.ts findByBranch) — null on writes/corrections,
    // which return the raw record without that include.
    employee_name: record.employee ? `${record.employee.firstName} ${record.employee.lastName}` : null,
    employee_code: record.employee?.employeeId ?? null,
    employee_status: record.employee?.status ?? null,
    branch_id: record.branchId,
    clock_in_server_time: record.clockInServerTime.toISOString(),
    clock_in_gps_lat: record.clockInGpsLat?.toNumber() ?? null,
    clock_in_gps_lng: record.clockInGpsLng?.toNumber() ?? null,
    clock_in_gps_status: record.clockInGpsStatus,
    clock_in_time_flag: record.clockInTimeFlag,
    clock_out_server_time: record.clockOutServerTime?.toISOString() ?? null,
    clock_out_gps_lat: record.clockOutGpsLat?.toNumber() ?? null,
    clock_out_gps_lng: record.clockOutGpsLng?.toNumber() ?? null,
    break_minutes: record.breakMinutes,
    actual_work_minutes: record.actualWorkMinutes,
    overtime_minutes: record.overtimeMinutes,
    status: record.status,
    correction_reason: record.correctionReason,
    corrected_by: record.correctedBy,
    original_record_id: record.originalRecordId,
    created_at: record.createdAt.toISOString(),
    attendance_state: times.state,
    current_break_started_at: times.openBreakStartedAt?.toISOString() ?? null,
    breaks: (record.breaks ?? []).map((b) => ({
      id: b.id,
      started_at: b.startedAt.toISOString(),
      ended_at: b.endedAt?.toISOString() ?? null,
      end_reason: b.endReason,
    })),
    elapsed_break_seconds: Math.floor(times.breakMs / 1000),
    elapsed_work_seconds: Math.floor(times.workMs / 1000),
  };
}

function toListResponse(records: AttendanceRow[], total: number, page: number, limit: number) {
  const now = new Date();
  return { records: records.map((record) => toResponse(record, now)), total, page, limit };
}

/**
 * Resource-level scoping for GET /employee/:employeeId (and any future
 * per-employee attendance read): the route itself is open to every role
 * (allRoles — see attendance.router.ts's staff self-status fix), so the
 * requested employeeId must be checked against the requester's own scope on
 * every call, same as branchGuard does for the /branch/:branchId route.
 * - staff: only its own employeeId (its JWT user_id IS the employee id —
 *   see auth.service.ts's selectEmployee).
 * - branch / supervisor: the employee must have an active
 *   UserBranchAssignment in one of the requester's accessible branches,
 *   resolved via lib/branch-access.ts (never duplicated here) — supervisor's
 *   own branch-assignment scope stays defined in one place.
 * - super_admin: unrestricted.
 */
async function assertEmployeeAccess(requestingUser: JwtPayload, employeeId: string): Promise<void> {
  if (requestingUser.role === ROLES.SUPER_ADMIN) return;

  if (requestingUser.role === ROLES.STAFF) {
    if (requestingUser.user_id !== employeeId) {
      throw new AttendanceError('EMPLOYEE_ACCESS_DENIED', 'You may only view your own attendance', 403);
    }
    return;
  }

  const accessibleBranchIds = await getAccessibleBranchIds(requestingUser);
  if (accessibleBranchIds === 'all') return;

  const assignment = await attendanceRepository.findBranchAssignmentInBranches(employeeId, accessibleBranchIds);
  if (!assignment) {
    throw new AttendanceError('BRANCH_ACCESS_DENIED', "You do not have access to this employee's attendance", 403);
  }
}

/**
 * Attendance business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through attendanceRepository.
 */
export const attendanceService = {
  async clockIn(data: ClockInData, requester: ActorContext) {
    const assignment = await attendanceRepository.findBranchAssignment(data.employeeId, data.branchId);
    if (!assignment) {
      throw new AttendanceError('EMPLOYEE_NOT_ASSIGNED_TO_BRANCH', 'Employee is not assigned to this branch', 403);
    }

    const active = await attendanceRepository.findActiveRecord(data.employeeId);
    if (active) {
      throw new AttendanceError('ALREADY_CLOCKED_IN', 'Employee already has an open attendance record', 409);
    }

    const branch = (await attendanceRepository.findBranchById(data.branchId)) as BranchRow | null;
    if (!branch) {
      throw new AttendanceError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    }

    const clockInServerTime = new Date();

    // Phase 8: the pre-checks above are optimistic (no lock held yet), so
    // two simultaneous clock-in requests for the same employee (desktop +
    // mobile, or a retried request) can both pass the ALREADY_CLOCKED_IN
    // check before either has written its row. The advisory lock plus a
    // re-check through the SAME tx client, right before the create, closes
    // that window — the loser blocks on the lock, then sees the winner's
    // just-committed row and throws instead of creating a second open
    // record. Same pattern as cash.service.ts's closeShift/branchShiftLockId.
    const record = (await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${attendanceOpenSessionLockId(data.employeeId)})`;

      const lockedActive = await attendanceRepository.findActiveRecord(data.employeeId, tx);
      if (lockedActive) {
        throw new AttendanceError('ALREADY_CLOCKED_IN', 'Employee already has an open attendance record', 409);
      }

      return attendanceRepository.clockIn(
        {
          employeeId: data.employeeId,
          branchId: data.branchId,
          clockInServerTime,
          clockInDeviceTime: data.deviceTime,
          clockInGpsLat: data.gpsLat,
          clockInGpsLng: data.gpsLng,
          clockInGpsStatus: resolveGpsStatus(branch, data.gpsLat, data.gpsLng),
          clockInTimeFlag: resolveTimeFlag(clockInServerTime, data.deviceTime),
        },
        tx,
      );
    })) as AttendanceRow;

    const response = toResponse(record);

    await recordAuditLog({
      action: 'ATTENDANCE_CLOCKED_IN',
      entityType: 'attendance_record',
      entityId: record.id,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: data.branchId,
      afterState: response,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.ATTENDANCE_CLOCKED_IN, response);
    notifySuperAdmin(SOCKET_EVENTS.ATTENDANCE_CLOCKED_IN, response);

    // Phase 4-9 shift removal: the cashier workflow is now Clock In -> Ready
    // to Sell, with no manual "Open Shift" step. A Shift row is still opened
    // transparently here so HoldOrder.shiftId's non-nullable FK stays
    // satisfied without a migration — the cashier never sees it. shiftGuard
    // also lazily creates the shift on first checkout/hold-order attempt as
    // a safety net, in case this call is ever skipped (e.g. a legacy client).
    await cashService.autoOpenShift({ branchId: data.branchId, cashierId: data.employeeId }, null);

    return response;
  },

  async clockOut(employeeId: string, data: ClockOutData, requester: ActorContext) {
    const active = (await attendanceRepository.findActiveRecord(employeeId)) as AttendanceRow | null;
    if (!active) {
      throw new AttendanceError('RECORD_NOT_FOUND', 'No open attendance record found for this employee', 404);
    }

    // Phase 4-9 shift removal: clocking out no longer requires closing a POS
    // shift first (that was the old manual drawer-count workflow). The
    // auto-managed shift opened at clock-in is closed transparently here
    // instead — same "no dangling active Shift row" guarantee, no cashier
    // action required.
    const openShift = await cashRepository.findActiveShift(employeeId, active.branchId);
    if (openShift) {
      await cashService.autoCloseShift(openShift.id, requester, null);
    }

    // POS-PERF-P40 — the branch's own Work Hours override when it has one, else the global policy.
    const regularShiftMinutes = await settingsService.getRegularShiftMinutes(active.branchId);

    // POS-PERF-P51 — clock-out now runs under the same per-employee advisory
    // lock as clock-in and Start Break / Resume Work, re-reading the open
    // record through the tx: a concurrent second clock-out finds nothing open
    // and gets 404 instead of overwriting the first one's clock-out time, and
    // a break can never be started or ended halfway through this. An open
    // break is closed at exactly the clock-out timestamp, in the same
    // transaction, so the break and the attendance record can't disagree.
    let closedBreakId: string | null = null;
    const updated = (await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${attendanceOpenSessionLockId(employeeId)})`;
      const locked = (await attendanceRepository.findActiveRecord(employeeId, tx)) as AttendanceRow | null;
      if (!locked) {
        throw new AttendanceError('RECORD_NOT_FOUND', 'No open attendance record found for this employee', 404);
      }

      const breaks = (await attendanceRepository.findBreaks(locked.id, tx)) as BreakIntervalRow[];
      const latestBreakTime = breaks.reduce<Date | null>((latest, b) => {
        const t = b.endedAt ?? b.startedAt;
        return latest && latest.getTime() >= t.getTime() ? latest : t;
      }, null);
      const clockOutServerTime = notBefore(new Date(), latestBreakTime);

      const openBreak = breaks.find((b) => b.endedAt === null);
      if (openBreak) {
        await attendanceRepository.closeBreak(openBreak.id, { endedAt: clockOutServerTime, endedBy: requester.id, endReason: 'clock_out' }, tx);
        openBreak.endedAt = clockOutServerTime;
        openBreak.endReason = 'clock_out';
        closedBreakId = openBreak.id;
      }

      let breakMinutes: number;
      let actualWorkMinutes: number;
      if (breaks.length > 0) {
        // Recorded intervals are authoritative — a client-sent break_minutes
        // is ignored once the server has real intervals for this record.
        const times = computeAttendanceTimes({ ...locked, clockOutServerTime, breaks }, clockOutServerTime);
        breakMinutes = Math.round(times.breakMs / 60000);
        actualWorkMinutes = Math.round(times.workMs / 60000);
      } else {
        // Unchanged pre-P51 behavior for a record with no intervals.
        breakMinutes = data.breakMinutes ?? locked.breakMinutes;
        const totalMinutes = Math.max(0, Math.round((clockOutServerTime.getTime() - locked.clockInServerTime.getTime()) / 60000));
        actualWorkMinutes = Math.max(0, totalMinutes - breakMinutes);
      }
      const overtimeMinutes = Math.max(0, actualWorkMinutes - regularShiftMinutes);

      return attendanceRepository.clockOut(
        locked.id,
        {
          clockOutServerTime,
          clockOutDeviceTime: data.deviceTime,
          clockOutGpsLat: data.gpsLat,
          clockOutGpsLng: data.gpsLng,
          breakMinutes,
          actualWorkMinutes,
          overtimeMinutes,
        },
        tx,
      );
    })) as AttendanceRow;

    if (closedBreakId) {
      await recordAuditLog({
        action: 'ATTENDANCE_BREAK_ENDED',
        entityType: 'attendance_break',
        entityId: closedBreakId,
        actorId: requester.id,
        actorRole: requester.role,
        branchId: updated.branchId,
        afterState: { attendance_record_id: updated.id, ended_at: updated.clockOutServerTime?.toISOString() ?? null, end_reason: 'clock_out' },
      });
    }

    const response = toResponse(updated);

    await recordAuditLog({
      action: 'ATTENDANCE_CLOCKED_OUT',
      entityType: 'attendance_record',
      entityId: updated.id,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: updated.branchId,
      beforeState: toResponse(active),
      afterState: response,
    });

    notifyBranch(updated.branchId, SOCKET_EVENTS.ATTENDANCE_CLOCKED_OUT, response);
    notifySuperAdmin(SOCKET_EVENTS.ATTENDANCE_CLOCKED_OUT, response);

    return response;
  },

  /**
   * POS-PERF-P51 — Start Break for the authenticated employee themselves
   * (the router passes req.user — never a client-supplied employee id).
   * Recorded on the server before the terminal locks; the shift stays open
   * and no clock-out is recorded. Safe to repeat: under the per-employee
   * advisory lock a second request finds the open break and gets 409
   * ALREADY_ON_BREAK (with the existing break in details) instead of a
   * second interval, and the partial unique index refuses a second open
   * row even if the lock were ever bypassed.
   */
  async startBreak(employeeId: string, branchId: string, requester: ActorContext) {
    const { record, breakId } = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${attendanceOpenSessionLockId(employeeId)})`;
        const active = (await attendanceRepository.findActiveRecord(employeeId, tx)) as AttendanceRow | null;
        if (!active || active.branchId !== branchId) {
          throw new AttendanceError('NOT_CLOCKED_IN', 'You must be clocked in at this branch to start a break', 409);
        }
        const breaks = (await attendanceRepository.findBreaks(active.id, tx)) as BreakIntervalRow[];
        const open = breaks.find((b) => b.endedAt === null);
        if (open) {
          throw new AttendanceError('ALREADY_ON_BREAK', 'A break is already in progress', 409, {
            break_id: open.id,
            started_at: open.startedAt.toISOString(),
          });
        }
        const lastEnded = breaks.at(-1)?.endedAt ?? null;
        const startedAt = notBefore(new Date(), notBefore(active.clockInServerTime, lastEnded));
        const created = await attendanceRepository.createBreak({ attendanceRecordId: active.id, startedAt, startedBy: requester.id }, tx);
        const withBreaks = (await attendanceRepository.findByIdWithBreaks(active.id, tx)) as AttendanceRow | null;
        return { record: withBreaks ?? active, breakId: created.id };
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AttendanceError('ALREADY_ON_BREAK', 'A break is already in progress', 409);
        }
        throw error;
      });

    const response = toResponse(record);
    await recordAuditLog({
      action: 'ATTENDANCE_BREAK_STARTED',
      entityType: 'attendance_break',
      entityId: breakId,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: record.branchId,
      afterState: { attendance_record_id: record.id, started_at: response.current_break_started_at },
    });
    notifyBranch(record.branchId, SOCKET_EVENTS.ATTENDANCE_BREAK_STARTED, response);
    notifySuperAdmin(SOCKET_EVENTS.ATTENDANCE_BREAK_STARTED, response);
    return response;
  },

  /**
   * POS-PERF-P51 — Resume Work: closes the authenticated employee's own open
   * break. The same open record (and auto-managed shift) continues; no new
   * clock-in. 409 NOT_ON_BREAK when there is nothing open — the expected
   * answer to a retry whose first attempt already committed, so the caller
   * reads attendance state rather than treating it as a failure.
   */
  async endBreak(employeeId: string, branchId: string, requester: ActorContext) {
    const { record, breakId } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${attendanceOpenSessionLockId(employeeId)})`;
      const active = (await attendanceRepository.findActiveRecord(employeeId, tx)) as AttendanceRow | null;
      if (!active || active.branchId !== branchId) {
        throw new AttendanceError('NOT_CLOCKED_IN', 'You are not clocked in at this branch', 409);
      }
      const breaks = (await attendanceRepository.findBreaks(active.id, tx)) as BreakIntervalRow[];
      const open = breaks.find((b) => b.endedAt === null);
      if (!open) {
        throw new AttendanceError('NOT_ON_BREAK', 'No break is in progress', 409);
      }
      const endedAt = notBefore(new Date(), open.startedAt);
      const changed = await attendanceRepository.closeBreak(open.id, { endedAt, endedBy: requester.id, endReason: 'resumed' }, tx);
      if (changed === 0) {
        throw new AttendanceError('NOT_ON_BREAK', 'No break is in progress', 409);
      }
      const withBreaks = (await attendanceRepository.findByIdWithBreaks(active.id, tx)) as AttendanceRow | null;
      return { record: withBreaks ?? active, breakId: open.id };
    });

    const response = toResponse(record);
    const ended = response.breaks.find((b) => b.id === breakId);
    await recordAuditLog({
      action: 'ATTENDANCE_BREAK_ENDED',
      entityType: 'attendance_break',
      entityId: breakId,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: record.branchId,
      afterState: { attendance_record_id: record.id, started_at: ended?.started_at ?? null, ended_at: ended?.ended_at ?? null, end_reason: 'resumed' },
    });
    notifyBranch(record.branchId, SOCKET_EVENTS.ATTENDANCE_BREAK_ENDED, response);
    notifySuperAdmin(SOCKET_EVENTS.ATTENDANCE_BREAK_ENDED, response);
    return response;
  },

  async manualOverride(originalRecordId: string, overrideData: ManualOverrideData, requester: ActorContext) {
    const original = (await attendanceRepository.findById(originalRecordId)) as AttendanceRow | null;
    if (!original || original.deletedAt) {
      throw new AttendanceError('RECORD_NOT_FOUND', 'Attendance record not found', 404);
    }

    // POS-PERF-P51 — a correction copies the record into a new row; the break
    // intervals stay with the original. Correcting while a break is still
    // open would leave that break dangling on a soft-deleted row and silently
    // put the employee back to "working", so the break must be ended (Resume
    // Work, or Clock Out) first. Corrections of closed records carry the
    // computed break_minutes over as before.
    if (original.clockOutServerTime === null && (original.breaks ?? []).some((b) => b.endedAt === null)) {
      throw new AttendanceError('BREAK_IN_PROGRESS', 'This employee is on break — end the break or clock out before correcting this record', 409);
    }

    const assignment = await attendanceRepository.findBranchAssignment(requester.id, original.branchId);
    if (!assignment) {
      throw new AttendanceError('BRANCH_ACCESS_DENIED', "You are not assigned to this record's branch", 403);
    }

    const clockInServerTime = overrideData.clockInServerTime ?? original.clockInServerTime;
    const clockOutServerTime =
      overrideData.clockOutServerTime !== undefined ? overrideData.clockOutServerTime : original.clockOutServerTime;
    const breakMinutes = overrideData.breakMinutes ?? original.breakMinutes;
    const actualWorkMinutes = clockOutServerTime
      ? Math.max(0, Math.round((clockOutServerTime.getTime() - clockInServerTime.getTime()) / 60000) - breakMinutes)
      : null;
    const regularShiftMinutes = await settingsService.getRegularShiftMinutes(original.branchId);
    const overtimeMinutes = actualWorkMinutes !== null ? Math.max(0, actualWorkMinutes - regularShiftMinutes) : 0;

    const correction = (await attendanceRepository.createOverride({
      employeeId: original.employeeId,
      branchId: original.branchId,
      clockInServerTime,
      clockInDeviceTime: original.clockInDeviceTime,
      clockInGpsLat: original.clockInGpsLat?.toNumber() ?? null,
      clockInGpsLng: original.clockInGpsLng?.toNumber() ?? null,
      clockInGpsStatus: original.clockInGpsStatus as GpsStatus,
      clockInTimeFlag: original.clockInTimeFlag,
      clockOutServerTime,
      clockOutDeviceTime: original.clockOutDeviceTime,
      clockOutGpsLat: original.clockOutGpsLat?.toNumber() ?? null,
      clockOutGpsLng: original.clockOutGpsLng?.toNumber() ?? null,
      breakMinutes,
      actualWorkMinutes,
      overtimeMinutes,
      correctedBy: requester.id,
      correctionReason: overrideData.correctionReason,
      originalRecordId: original.id,
    })) as AttendanceRow;

    await attendanceRepository.softDelete(original.id);

    const response = toResponse(correction);
    const originalResponse = toResponse(original);

    await recordAuditLog({
      action: 'ATTENDANCE_CORRECTED',
      entityType: 'attendance_record',
      entityId: correction.id,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: original.branchId,
      beforeState: originalResponse,
      afterState: response,
    });

    await recordAuditLog({
      action: 'ATTENDANCE_ORIGINAL_SOFT_DELETED',
      entityType: 'attendance_record',
      entityId: original.id,
      actorId: requester.id,
      actorRole: requester.role,
      branchId: original.branchId,
      beforeState: originalResponse,
      afterState: { ...originalResponse, deleted: true },
    });

    return response;
  },

  /**
   * POS-PERF-P40 — Admin monitoring list. A supervisor filter resolves to
   * that supervisor's CURRENT active branch assignments (not historical
   * ones); combined with a branch filter it is the intersection, which may
   * be empty. counts_toward_clocked_in mirrors countStaffTimedInByBranch
   * plus findAllStatsGrouped's active-branch restriction, so
   * the open-now view reconciles with the dashboard's "Staff Clocked In"
   * figure record by record; it is null for closed records.
   */
  async getForAdmin(
    filters: AttendanceListFilters & { branchId?: string; supervisorId?: string; openOnly?: boolean },
    requestingUser: JwtPayload,
  ) {
    if (requestingUser.role !== ROLES.SUPER_ADMIN) {
      throw new AttendanceError('INSUFFICIENT_PERMISSIONS', 'Only Super Admin may view cross-branch attendance', 403);
    }

    let branchIds: string[] | undefined = filters.branchId ? [filters.branchId] : undefined;
    let supervisor: { id: string; name: string; branch_ids: string[] } | null = null;
    if (filters.supervisorId) {
      const user = await branchesRepository.findUserById(filters.supervisorId);
      if (!user || user.role !== ROLES.SUPERVISOR) {
        throw new AttendanceError('SUPERVISOR_NOT_FOUND', 'Supervisor not found', 404);
      }
      const assigned = (await branchesRepository.getUserActiveBranches(user.id)).map((a) => a.branchId);
      supervisor = { id: user.id, name: `${user.firstName} ${user.lastName}`.trim(), branch_ids: assigned };
      branchIds = branchIds ? branchIds.filter((id) => assigned.includes(id)) : assigned;
    }

    const scope = {
      branch_ids: branchIds ?? null,
      supervisor,
      open_only: Boolean(filters.openOnly),
    };
    if (branchIds && branchIds.length === 0) {
      return { records: [], total: 0, page: filters.page, limit: filters.limit, scope };
    }

    const { records, total } = await attendanceRepository.findForAdmin({ ...filters, branchIds });
    return {
      records: records.map((record) => ({
        ...toResponse(record as unknown as AttendanceRow),
        branch_name: record.branch.name,
        counts_toward_clocked_in:
          record.clockOutServerTime === null
            ? record.branch.status === 'active' &&
              record.employee.isActive &&
              record.employee.status === 'active' &&
              record.employee.branchAssignments.some((a) => a.branchId === record.branchId)
            : null,
      })),
      total,
      page: filters.page,
      limit: filters.limit,
      scope,
    };
  },

  async getByBranch(branchId: string, filters: AttendanceListFilters) {
    const { records, total } = await attendanceRepository.findByBranch(branchId, filters);
    return toListResponse(records as AttendanceRow[], total, filters.page, filters.limit);
  },

  /**
   * POS-PERF-P47 — Supervisor dashboard Attendance Overview. Branch access
   * is enforced by the route's branchGuard. "Clocked in" uses the same rule
   * as branches.repository.ts's countStaffTimedIn (open row + employee still
   * active + still assigned to this branch) so the panel and the Staff
   * Clocked In KPI can never disagree.
   */
  async getBranchSummary(branchId: string, now: Date = new Date()): Promise<AttendanceSummaryResponse> {
    const { dayStart, dayEnd } = dayBounds(now);
    const { open, closedToday } = await attendanceRepository.findSummaryRows(branchId, dayStart, dayEnd);

    const working = open.filter(
      (row) => row.employee.isActive && row.employee.status === 'active' && row.employee.branchAssignments.length > 0,
    );
    const workingEmployeeIds = new Set(working.map((row) => row.employeeId));

    // closedToday is ordered newest clock-out first, so the first row seen
    // per employee is their latest clock-out of the day.
    const seen = new Set<string>();
    const clockedOut: AttendanceSummaryResponse['clocked_out_today'] = [];
    for (const row of closedToday) {
      if (!row.clockOutServerTime || seen.has(row.employeeId) || workingEmployeeIds.has(row.employeeId)) continue;
      seen.add(row.employeeId);
      clockedOut.push({
        record_id: row.id,
        employee_id: row.employeeId,
        employee_name: `${row.employee.firstName} ${row.employee.lastName}`,
        clock_in_server_time: row.clockInServerTime.toISOString(),
        clock_out_server_time: row.clockOutServerTime.toISOString(),
      });
    }

    return {
      branch_id: branchId,
      business_date: manilaDateKey(now),
      clocked_in: working.map((row) => {
        const openBreak = row.breaks[0] ?? null;
        return {
          record_id: row.id,
          employee_id: row.employeeId,
          employee_name: `${row.employee.firstName} ${row.employee.lastName}`,
          clock_in_server_time: row.clockInServerTime.toISOString(),
          clock_in_gps_status: row.clockInGpsStatus,
          attendance_state: openBreak ? ('on_break' as const) : ('working' as const),
          break_started_at: openBreak?.startedAt.toISOString() ?? null,
        };
      }),
      clocked_out_today: clockedOut,
      excluded_open_count: open.length - working.length,
      on_break_count: working.filter((row) => row.breaks.length > 0).length,
    };
  },

  async getByEmployee(employeeId: string, filters: AttendanceListFilters, requestingUser: JwtPayload) {
    await assertEmployeeAccess(requestingUser, employeeId);
    const { records, total } = await attendanceRepository.findByEmployee(employeeId, filters);
    return toListResponse(records as AttendanceRow[], total, filters.page, filters.limit);
  },
};
