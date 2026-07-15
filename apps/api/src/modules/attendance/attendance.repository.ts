import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { AttendanceListFilters } from './attendance.types.js';

type GpsStatus = 'within_radius' | 'outside_radius' | 'no_gps_data';

interface ClockInRow {
  employeeId: string;
  branchId: string;
  clockInServerTime: Date;
  clockInDeviceTime?: Date;
  clockInGpsLat: number;
  clockInGpsLng: number;
  clockInGpsStatus: GpsStatus;
  clockInTimeFlag: boolean;
}

interface ClockOutRow {
  clockOutServerTime: Date;
  clockOutDeviceTime?: Date;
  clockOutGpsLat?: number;
  clockOutGpsLng?: number;
  breakMinutes: number;
  actualWorkMinutes: number;
  overtimeMinutes: number;
}

interface CreateOverrideRow {
  employeeId: string;
  branchId: string;
  clockInServerTime: Date;
  clockInDeviceTime: Date | null;
  clockInGpsLat: number | null;
  clockInGpsLng: number | null;
  clockInGpsStatus: GpsStatus;
  clockInTimeFlag: boolean;
  clockOutServerTime: Date | null;
  clockOutDeviceTime: Date | null;
  clockOutGpsLat: number | null;
  clockOutGpsLng: number | null;
  breakMinutes: number;
  actualWorkMinutes: number | null;
  overtimeMinutes: number;
  correctedBy: string;
  correctionReason: string;
  originalRecordId: string;
}

function dateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from && { gte: from }), ...(to && { lte: to }) };
}

/**
 * Attendance repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const attendanceRepository = {
  /** The one open (not clocked out, not soft-deleted) record for an employee — enforces "one open record per employee" at the service layer. */
  findActiveRecord(employeeId: string) {
    return prisma.attendanceRecord.findFirst({
      where: { employeeId, clockOutServerTime: null, deletedAt: null },
      orderBy: { clockInServerTime: 'desc' },
    });
  },

  findById(id: string) {
    return prisma.attendanceRecord.findUnique({ where: { id } });
  },

  findBranchAssignment(employeeId: string, branchId: string) {
    return prisma.userBranchAssignment.findFirst({
      where: { userId: employeeId, branchId, removedAt: null },
    });
  },

  /** Used to read the branch's configured GPS center + radius for clock-in geofence validation. */
  findBranchById(branchId: string) {
    return prisma.branch.findUnique({ where: { id: branchId } });
  },

  clockIn(data: ClockInRow) {
    return prisma.attendanceRecord.create({ data });
  },

  clockOut(id: string, data: ClockOutRow) {
    return prisma.attendanceRecord.update({ where: { id }, data });
  },

  /** Creates the correction row. The original row it supersedes is soft-deleted separately via softDelete — never in the same call, so the service can audit-log both steps distinctly. */
  createOverride(data: CreateOverrideRow) {
    return prisma.attendanceRecord.create({ data: { ...data, status: 'corrected' } });
  },

  softDelete(id: string) {
    return prisma.attendanceRecord.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  async findByBranch(branchId: string, filters: AttendanceListFilters) {
    const where: Prisma.AttendanceRecordWhereInput = {
      branchId,
      deletedAt: null,
      ...(filters.employeeId && { employeeId: filters.employeeId }),
      ...(dateRangeWhere(filters.from, filters.to) && {
        clockInServerTime: dateRangeWhere(filters.from, filters.to),
      }),
    };

    const [records, total] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        orderBy: { clockInServerTime: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.attendanceRecord.count({ where }),
    ]);

    return { records, total };
  },

  async findByEmployee(employeeId: string, filters: AttendanceListFilters) {
    const where: Prisma.AttendanceRecordWhereInput = {
      employeeId,
      deletedAt: null,
      ...(dateRangeWhere(filters.from, filters.to) && {
        clockInServerTime: dateRangeWhere(filters.from, filters.to),
      }),
    };

    const [records, total] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        orderBy: { clockInServerTime: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.attendanceRecord.count({ where }),
    ]);

    return { records, total };
  },
};
