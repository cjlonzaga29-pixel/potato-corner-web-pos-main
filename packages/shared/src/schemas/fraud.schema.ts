import { z } from 'zod';
import {
  FRAUD_ALERT_SEVERITY,
  type FraudAlertSeverity,
  FRAUD_ALERT_STATUS,
  type FraudAlertStatus,
} from '../constants/status.js';

const fraudAlertSeverityValues = Object.values(FRAUD_ALERT_SEVERITY) as [
  FraudAlertSeverity,
  ...FraudAlertSeverity[],
];
const fraudAlertStatusValues = Object.values(FRAUD_ALERT_STATUS) as [FraudAlertStatus, ...FraudAlertStatus[]];

/** GET /api/fraud query filters — same page/limit pagination shape as every other list endpoint. */
export const fraudAlertListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  status: z.enum(fraudAlertStatusValues).optional(),
  severity: z.enum(fraudAlertSeverityValues).optional(),
  alert_type: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const investigateFraudAlertSchema = z.object({
  notes: z.string().optional(),
});

/** dismissal_reason is mandatory and must be a real explanation, not a one-word brush-off. */
export const dismissFraudAlertSchema = z.object({
  dismissal_reason: z.string().min(10, 'dismissal_reason must be at least 10 characters'),
});

export const escalateFraudAlertSchema = z.object({
  notes: z.string().optional(),
});

/**
 * employee_name/branch_name are enriched fields, not columns on fraud_alerts
 * itself — employee_name comes from a batch User lookup (fraud_alerts has no
 * FK relation to users, only a bare employee_id column) and branch_name from
 * the Branch relation. evidence is untyped JSON — its shape is owned by
 * whichever future detection engine populates it, not this workflow module.
 */
export const fraudAlertResponseSchema = z.object({
  id: z.uuid(),
  alert_type: z.string(),
  severity: z.enum(fraudAlertSeverityValues),
  employee_id: z.uuid().nullable(),
  employee_name: z.string().nullable(),
  branch_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  evidence: z.unknown(),
  status: z.enum(fraudAlertStatusValues),
  investigated_by: z.uuid().nullable(),
  dismissal_reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const fraudAlertListResponseSchema = z.object({
  alerts: z.array(fraudAlertResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
