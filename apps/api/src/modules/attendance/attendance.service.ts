import { SOCKET_EVENTS } from '@potato-corner/shared';
import { attendanceRepository } from './attendance.repository.js';
import { AttendanceError, type AttendanceListFilters, type ClockInData, type ClockOutData, type ManualOverrideData } from './attendance.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };
type GpsStatus = 'within_radius' | 'outside_radius' | 'no_gps_data';

/** See the architecture doc's "time-delta flagging" — a device clock more than 5 minutes off from the server is flagged for supervisor review, not rejected outright. */
const TIME_DELTA_FLAG_THRESHOLD_MS = 5 * 60 * 1000;
/** Standard 8-hour shift; minutes worked beyond this count toward overtimeMinutes. No per-employee shift-length model exists yet, so this is a single flat constant. */
const STANDARD_SHIFT_MINUTES = 8 * 60;
const EARTH_RADIUS_METERS = 6371000;

interface DecimalLike {
  toNumber(): number;
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

function toResponse(record: AttendanceRow) {
  return {
    id: record.id,
    employee_id: record.employeeId,
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
  };
}

function toListResponse(records: AttendanceRow[], total: number, page: number, limit: number) {
  return { records: records.map(toResponse), total, page, limit };
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
    const record = (await attendanceRepository.clockIn({
      employeeId: data.employeeId,
      branchId: data.branchId,
      clockInServerTime,
      clockInDeviceTime: data.deviceTime,
      clockInGpsLat: data.gpsLat,
      clockInGpsLng: data.gpsLng,
      clockInGpsStatus: resolveGpsStatus(branch, data.gpsLat, data.gpsLng),
      clockInTimeFlag: resolveTimeFlag(clockInServerTime, data.deviceTime),
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

    return response;
  },

  async clockOut(employeeId: string, data: ClockOutData, requester: ActorContext) {
    const active = (await attendanceRepository.findActiveRecord(employeeId)) as AttendanceRow | null;
    if (!active) {
      throw new AttendanceError('RECORD_NOT_FOUND', 'No open attendance record found for this employee', 404);
    }

    const clockOutServerTime = new Date();
    const breakMinutes = data.breakMinutes ?? active.breakMinutes;
    const totalMinutes = Math.max(0, Math.round((clockOutServerTime.getTime() - active.clockInServerTime.getTime()) / 60000));
    const actualWorkMinutes = Math.max(0, totalMinutes - breakMinutes);
    const overtimeMinutes = Math.max(0, actualWorkMinutes - STANDARD_SHIFT_MINUTES);

    const updated = (await attendanceRepository.clockOut(active.id, {
      clockOutServerTime,
      clockOutDeviceTime: data.deviceTime,
      clockOutGpsLat: data.gpsLat,
      clockOutGpsLng: data.gpsLng,
      breakMinutes,
      actualWorkMinutes,
      overtimeMinutes,
    })) as AttendanceRow;

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

  async manualOverride(originalRecordId: string, overrideData: ManualOverrideData, requester: ActorContext) {
    const original = (await attendanceRepository.findById(originalRecordId)) as AttendanceRow | null;
    if (!original || original.deletedAt) {
      throw new AttendanceError('RECORD_NOT_FOUND', 'Attendance record not found', 404);
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
    const overtimeMinutes = actualWorkMinutes !== null ? Math.max(0, actualWorkMinutes - STANDARD_SHIFT_MINUTES) : 0;

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

  async getByBranch(branchId: string, filters: AttendanceListFilters) {
    const { records, total } = await attendanceRepository.findByBranch(branchId, filters);
    return toListResponse(records as AttendanceRow[], total, filters.page, filters.limit);
  },

  async getByEmployee(employeeId: string, filters: AttendanceListFilters) {
    const { records, total } = await attendanceRepository.findByEmployee(employeeId, filters);
    return toListResponse(records as AttendanceRow[], total, filters.page, filters.limit);
  },
};
