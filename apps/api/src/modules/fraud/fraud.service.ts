import { FRAUD_ALERT_STATUS, ROLES, type FraudAlertListResponse, type FraudAlertResponse } from '@potato-corner/shared';
import { fraudRepository } from './fraud.repository.js';
import {
  FraudError,
  type DismissAlertData,
  type EscalateAlertData,
  type FraudAlertFilters,
  type InvestigateAlertData,
} from './fraud.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { enqueueManualFraudScan } from '../../queues/fraud.queue.js';

interface FraudAlertRow {
  id: string;
  alertType: string;
  severity: string;
  employeeId: string | null;
  branchId: string | null;
  evidence: unknown;
  status: string;
  investigatedBy: string | null;
  dismissalReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  branch?: { id: string; name: string } | null;
}

/**
 * Every route on this router is gated to super_admin only (see
 * fraud.router.ts), so the actor writing the audit trail is always a Super
 * Admin — there's no other role that can reach these service methods.
 */
const ACTOR_ROLE = ROLES.SUPER_ADMIN;

function toFraudAlertResponse(row: FraudAlertRow, employeeName: string | null): FraudAlertResponse {
  return {
    id: row.id,
    alert_type: row.alertType,
    severity: row.severity as FraudAlertResponse['severity'],
    employee_id: row.employeeId,
    employee_name: employeeName,
    branch_id: row.branchId,
    branch_name: row.branch?.name ?? null,
    evidence: row.evidence,
    status: row.status as FraudAlertResponse['status'],
    investigated_by: row.investigatedBy,
    dismissal_reason: row.dismissalReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Batches the employee_name lookup across every row instead of querying once per alert. */
async function mapAlertsToResponses(rows: FraudAlertRow[]): Promise<FraudAlertResponse[]> {
  const employeeIds = [...new Set(rows.map((row) => row.employeeId).filter((id): id is string => id !== null))];
  const employees = await fraudRepository.findEmployeeNamesByIds(employeeIds);
  const nameById = new Map(employees.map((employee) => [employee.id, `${employee.firstName} ${employee.lastName}`]));
  return rows.map((row) => toFraudAlertResponse(row, row.employeeId ? (nameById.get(row.employeeId) ?? null) : null));
}

async function mapAlertToResponse(row: FraudAlertRow): Promise<FraudAlertResponse> {
  const [response] = await mapAlertsToResponses([row]);
  return response as FraudAlertResponse;
}

/**
 * Fraud alert review workflow — Phase 17 groundwork. Called by the router
 * after Zod validation; never calls Prisma directly — always goes through
 * fraudRepository. This module only reviews alerts a future detection
 * engine will create; it never emits FRAUD_ALERT_CREATED or any other
 * socket event itself.
 */
export const fraudService = {
  async listAlerts(filters: FraudAlertFilters): Promise<FraudAlertListResponse> {
    const { alerts, total } = await fraudRepository.findAll(filters);
    const mapped = await mapAlertsToResponses(alerts as FraudAlertRow[]);
    return { alerts: mapped, total, page: filters.page, limit: filters.limit };
  },

  async getAlertById(id: string): Promise<FraudAlertResponse> {
    const alert = await fraudRepository.findById(id);
    if (!alert) throw new FraudError('FRAUD_ALERT_NOT_FOUND', 'Fraud alert not found', 404);
    return mapAlertToResponse(alert as FraudAlertRow);
  },

  async investigateAlert(id: string, actorId: string, data: InvestigateAlertData): Promise<FraudAlertResponse> {
    const alert = await fraudRepository.findById(id);
    if (!alert) throw new FraudError('FRAUD_ALERT_NOT_FOUND', 'Fraud alert not found', 404);
    if (alert.status !== FRAUD_ALERT_STATUS.OPEN) {
      throw new FraudError('FRAUD_ALERT_NOT_OPEN', 'Only an open fraud alert can be moved to investigating', 400);
    }

    const updated = await fraudRepository.updateStatus(id, {
      status: FRAUD_ALERT_STATUS.INVESTIGATING,
      investigatedBy: actorId,
    });

    await recordAuditLog({
      action: 'FRAUD_ALERT_INVESTIGATED',
      entityType: 'fraud_alert',
      entityId: alert.id,
      actorId,
      actorRole: ACTOR_ROLE,
      branchId: alert.branchId,
      beforeState: { status: FRAUD_ALERT_STATUS.OPEN },
      afterState: { status: FRAUD_ALERT_STATUS.INVESTIGATING, notes: data.notes ?? null },
    });

    return mapAlertToResponse(updated as FraudAlertRow);
  },

  async dismissAlert(id: string, actorId: string, data: DismissAlertData): Promise<FraudAlertResponse> {
    const alert = await fraudRepository.findById(id);
    if (!alert) throw new FraudError('FRAUD_ALERT_NOT_FOUND', 'Fraud alert not found', 404);
    if (alert.status === FRAUD_ALERT_STATUS.DISMISSED) {
      throw new FraudError('FRAUD_ALERT_ALREADY_DISMISSED', 'This fraud alert has already been dismissed', 400);
    }
    // Belt-and-suspenders beyond dismissFraudAlertSchema's Zod min(10) — the
    // service must never trust that every caller went through the router's
    // validate() middleware.
    if (data.dismissalReason.trim().length < 10) {
      throw new FraudError('DISMISSAL_REASON_TOO_SHORT', 'dismissalReason must be at least 10 characters', 400);
    }

    const updated = await fraudRepository.updateStatus(id, {
      status: FRAUD_ALERT_STATUS.DISMISSED,
      dismissalReason: data.dismissalReason,
    });

    await recordAuditLog({
      action: 'FRAUD_ALERT_DISMISSED',
      entityType: 'fraud_alert',
      entityId: alert.id,
      actorId,
      actorRole: ACTOR_ROLE,
      branchId: alert.branchId,
      beforeState: { status: alert.status },
      afterState: { status: FRAUD_ALERT_STATUS.DISMISSED, dismissalReason: data.dismissalReason },
    });

    return mapAlertToResponse(updated as FraudAlertRow);
  },

  async escalateAlert(id: string, actorId: string, data: EscalateAlertData): Promise<FraudAlertResponse> {
    const alert = await fraudRepository.findById(id);
    if (!alert) throw new FraudError('FRAUD_ALERT_NOT_FOUND', 'Fraud alert not found', 404);
    if (alert.status === FRAUD_ALERT_STATUS.DISMISSED) {
      throw new FraudError('FRAUD_ALERT_DISMISSED', 'A dismissed fraud alert cannot be escalated', 400);
    }
    if (alert.status === FRAUD_ALERT_STATUS.ESCALATED) {
      throw new FraudError('FRAUD_ALERT_ALREADY_ESCALATED', 'This fraud alert has already been escalated', 400);
    }

    const updated = await fraudRepository.updateStatus(id, {
      status: FRAUD_ALERT_STATUS.ESCALATED,
      investigatedBy: actorId,
    });

    await recordAuditLog({
      action: 'FRAUD_ALERT_ESCALATED',
      entityType: 'fraud_alert',
      entityId: alert.id,
      actorId,
      actorRole: ACTOR_ROLE,
      branchId: alert.branchId,
      beforeState: { status: alert.status },
      afterState: { status: FRAUD_ALERT_STATUS.ESCALATED, notes: data.notes ?? null },
    });

    return mapAlertToResponse(updated as FraudAlertRow);
  },

  async triggerManualScan(actorId: string): Promise<{ jobId: string | null }> {
    const evaluationDate = new Date().toISOString();
    const job = await enqueueManualFraudScan({ evaluationDate, requestedBy: actorId });

    await recordAuditLog({
      action: 'FRAUD_MANUAL_SCAN_TRIGGERED',
      entityType: 'fraud_scan',
      entityId: job.id ?? null,
      actorId,
      actorRole: ACTOR_ROLE,
      branchId: null,
      afterState: { evaluation_date: evaluationDate, job_id: job.id ?? null },
    });

    return { jobId: job.id ?? null };
  },
};
