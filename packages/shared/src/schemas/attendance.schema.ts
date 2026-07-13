import { z } from 'zod';
import { GPS_STATUS, type GpsStatus } from '../constants/status.js';

const gpsStatusValues = Object.values(GPS_STATUS) as [GpsStatus, ...GpsStatus[]];

export const clockInSchema = z.object({
  employeeId: z.uuid(),
  branchId: z.uuid(),
  deviceTime: z.iso.datetime(),
  gpsLat: z.number().min(-90).max(90).optional(),
  gpsLng: z.number().min(-180).max(180).optional(),
});

export const clockOutSchema = z.object({
  attendanceRecordId: z.uuid(),
  deviceTime: z.iso.datetime(),
  gpsLat: z.number().min(-90).max(90).optional(),
  gpsLng: z.number().min(-180).max(180).optional(),
});

export const attendanceCorrectionSchema = z.object({
  attendanceRecordId: z.uuid(),
  correctionReason: z.string().min(10),
  clockInServerTime: z.iso.datetime().optional(),
  clockOutServerTime: z.iso.datetime().optional(),
});

export const attendanceResponseSchema = z.object({
  id: z.uuid(),
  employeeId: z.uuid(),
  branchId: z.uuid(),
  clockInServerTime: z.iso.datetime(),
  clockInGpsStatus: z.enum(gpsStatusValues),
  clockInTimeFlag: z.boolean(),
  clockOutServerTime: z.iso.datetime().nullable(),
  breakMinutes: z.number().int(),
  actualWorkMinutes: z.number().int().nullable(),
  overtimeMinutes: z.number().int(),
});
