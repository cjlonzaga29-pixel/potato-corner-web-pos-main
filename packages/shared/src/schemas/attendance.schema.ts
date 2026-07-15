import { z } from 'zod';
import { GPS_STATUS, ATTENDANCE_STATUS, type GpsStatus, type AttendanceStatus } from '../constants/status.js';

const gpsStatusValues = Object.values(GPS_STATUS) as [GpsStatus, ...GpsStatus[]];
const attendanceStatusValues = Object.values(ATTENDANCE_STATUS) as [AttendanceStatus, ...AttendanceStatus[]];

/**
 * employee_id is deliberately separate from the authenticated caller — a
 * supervisor may clock a staff member in on their behalf, same allowance as
 * cash.schema.ts's openShiftSchema (cashier_id vs. the opener's own id).
 * GPS is required here (never optional) — the one hard rule Phase 12 must
 * never relax, unlike clock-out where it's optional.
 */
export const clockInSchema = z.object({
  employee_id: z.uuid(),
  branch_id: z.uuid(),
  device_time: z.iso.datetime().optional(),
  gps_lat: z.number().min(-90).max(90),
  gps_lng: z.number().min(-180).max(180),
});

export const clockOutSchema = z.object({
  employee_id: z.uuid(),
  branch_id: z.uuid(),
  device_time: z.iso.datetime().optional(),
  gps_lat: z.number().min(-90).max(90).optional(),
  gps_lng: z.number().min(-180).max(180).optional(),
  break_minutes: z.number().int().nonnegative().optional(),
});

/** correction_reason is required and non-trivial — matches deactivateEmployeeSchema's reason length floor. */
export const manualOverrideSchema = z.object({
  original_record_id: z.uuid(),
  correction_reason: z.string().min(10),
  clock_in_server_time: z.iso.datetime().optional(),
  clock_out_server_time: z.iso.datetime().nullable().optional(),
  break_minutes: z.number().int().nonnegative().optional(),
});

export const attendanceQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  employee_id: z.uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const attendanceResponseSchema = z.object({
  id: z.uuid(),
  employee_id: z.uuid(),
  branch_id: z.uuid(),
  clock_in_server_time: z.iso.datetime(),
  clock_in_gps_lat: z.number().nullable(),
  clock_in_gps_lng: z.number().nullable(),
  clock_in_gps_status: z.enum(gpsStatusValues),
  clock_in_time_flag: z.boolean(),
  clock_out_server_time: z.iso.datetime().nullable(),
  clock_out_gps_lat: z.number().nullable(),
  clock_out_gps_lng: z.number().nullable(),
  break_minutes: z.number().int(),
  actual_work_minutes: z.number().int().nullable(),
  overtime_minutes: z.number().int(),
  status: z.enum(attendanceStatusValues),
  correction_reason: z.string().nullable(),
  corrected_by: z.uuid().nullable(),
  original_record_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});

export const attendanceListResponseSchema = z.object({
  records: z.array(attendanceResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
