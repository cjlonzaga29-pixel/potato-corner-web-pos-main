/**
 * Attendance module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */

export interface ClockInData {
  employeeId: string;
  branchId: string;
  deviceTime?: Date;
  gpsLat: number;
  gpsLng: number;
}

export interface ClockOutData {
  deviceTime?: Date;
  gpsLat?: number;
  gpsLng?: number;
  breakMinutes?: number;
}

export interface ManualOverrideData {
  correctionReason: string;
  clockInServerTime?: Date;
  clockOutServerTime?: Date | null;
  breakMinutes?: number;
}

export interface AttendanceListFilters {
  employeeId?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

/** Mirrors CashError/EmployeeError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class AttendanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AttendanceError';
  }
}
