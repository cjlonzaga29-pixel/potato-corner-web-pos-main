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

/**
 * POS-PERF-P51 — Start Break / Resume Work. No employee_id: the server acts
 * only on the authenticated employee's own session (their PIN-minted token),
 * so one employee can never start or end another's break. branch_id is what
 * branchGuard checks against that token's branch.
 */
export const breakActionSchema = z.object({
  branch_id: z.uuid(),
});

/** correction_reason is required and non-trivial — matches deactivateEmployeeSchema's reason length floor. */
export const manualOverrideSchema = z.object({
  original_record_id: z.uuid(),
  correction_reason: z.string().min(10),
  clock_in_server_time: z.iso.datetime().optional(),
  clock_out_server_time: z.iso.datetime().nullable().optional(),
  break_minutes: z.number().int().nonnegative().optional(),
});

/**
 * from/to accept either a bare Manila business date (YYYY-MM-DD, from a
 * date-only filter input — widened to that day's Manila start/end server-
 * side) or an already-precise ISO datetime (e.g. a dashboard widget's "since
 * browser-local start of day to now" window). Same union as
 * reports.schema.ts's ReportFiltersSchema — see resolveDateRangeBoundary in
 * apps/api/src/lib/manila-time.ts for how the API resolves either shape.
 */
export const attendanceQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  employee_id: z.uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * POS-PERF-P40 — Admin attendance monitoring across branches. supervisor_id
 * narrows to the branches that supervisor is CURRENTLY assigned to (the real
 * UserBranchAssignment model — there is no personal staff-ownership
 * relationship). open_only lists records with no clock-out yet regardless
 * of clock-in date, so overnight shifts started on an earlier day are
 * visible; from/to are ignored in that mode.
 */
export const adminAttendanceQuerySchema = attendanceQuerySchema.extend({
  branch_id: z.uuid().optional(),
  supervisor_id: z.uuid().optional(),
  open_only: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/**
 * POS-PERF-P51 — attendance state, distinct from browser login, socket
 * presence and terminal lock: `working` = clocked in with no open break,
 * `on_break` = clocked in with an open break, `clocked_out` = record closed.
 */
export const attendanceStateSchema = z.enum(['working', 'on_break', 'clocked_out']);

export const attendanceBreakIntervalSchema = z.object({
  id: z.uuid(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  end_reason: z.enum(['resumed', 'clock_out']).nullable(),
});

export const attendanceResponseSchema = z.object({
  id: z.uuid(),
  employee_id: z.uuid(),
  // Present when the read query joined the employee relation (branch-scoped
  // list reads); null on write/correction responses that return the raw
  // record. Frontend must never fall back to rendering employee_id as the
  // visible name.
  employee_name: z.string().nullable(),
  employee_code: z.string().nullable(),
  employee_status: z.string().nullable(),
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
  // POS-PERF-P51 — optional only because a pre-P51 API omits them; every
  // P51 response sends all five. elapsed_* are server-computed at response
  // time (an open record counts up to "now", a closed one to its clock-out):
  // work = (end − clock-in) − break. Break time comes from the recorded
  // intervals, or — for a record with none (pre-P51 history or a manual
  // correction) — from the stored break_minutes. No paid/unpaid policy is
  // applied here.
  attendance_state: attendanceStateSchema.optional(),
  current_break_started_at: z.iso.datetime().nullable().optional(),
  breaks: z.array(attendanceBreakIntervalSchema).optional(),
  elapsed_break_seconds: z.number().int().nonnegative().optional(),
  elapsed_work_seconds: z.number().int().nonnegative().optional(),
});

export const attendanceListResponseSchema = z.object({
  records: z.array(attendanceResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

/**
 * POS-PERF-P47 — Supervisor dashboard Attendance Overview, computed from
 * attendance records only (never from logins or socket presence).
 * clocked_in follows the same "currently working" rule as the Staff Clocked
 * In KPI; open rows it excludes (deactivated / reassigned staff) are only
 * counted in excluded_open_count. clocked_out_today lists each employee who
 * clocked out during the Manila business day and is not clocked in again.
 */
export const attendanceSummaryResponseSchema = z.object({
  branch_id: z.uuid(),
  business_date: z.string(),
  clocked_in: z.array(
    z.object({
      record_id: z.uuid(),
      employee_id: z.uuid(),
      employee_name: z.string(),
      clock_in_server_time: z.iso.datetime(),
      clock_in_gps_status: z.enum(gpsStatusValues),
      // POS-PERF-P51 — clocked_in still lists everyone with an open record
      // (so it keeps reconciling with the Staff Clocked In KPI); this says
      // which of them are on break right now. Optional: absent from a
      // pre-P51 API.
      attendance_state: z.enum(['working', 'on_break']).optional(),
      break_started_at: z.iso.datetime().nullable().optional(),
    }),
  ),
  clocked_out_today: z.array(
    z.object({
      record_id: z.uuid(),
      employee_id: z.uuid(),
      employee_name: z.string(),
      clock_in_server_time: z.iso.datetime(),
      clock_out_server_time: z.iso.datetime(),
    }),
  ),
  excluded_open_count: z.number().int(),
  /** POS-PERF-P51 — how many clocked_in rows are on break. Optional: absent from a pre-P51 API. */
  on_break_count: z.number().int().optional(),
});
