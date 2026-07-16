import { SOCKET_EVENTS } from '@potato-corner/shared';
import { fraudRepository } from './fraud.repository.js';
import { FRAUD_RULES } from './rules/index.js';
import type { DetectionResult } from './rules/fraud-rule.types.js';
import { notifySuperAdmin } from '../../lib/notify.js';

export interface RunResult {
  branchesEvaluated: number;
  rulesEvaluated: number;
  alertsCreated: number;
  alertsSkippedDupe: number;
}

function extractCustomerIdHash(evidence: unknown): string | null {
  if (evidence && typeof evidence === 'object' && 'customer_id_hash' in evidence) {
    const value = (evidence as { customer_id_hash: unknown }).customer_id_hash;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * discount_id_reuse has no natural employeeId/single branchId to dedup on
 * (Corrections #4) — every other rule uses the standard (branchId,
 * employeeId, alertType) key from the locked decisions.
 */
async function isDuplicate(result: DetectionResult): Promise<boolean> {
  if (result.alertType === 'discount_id_reuse') {
    const hash = extractCustomerIdHash(result.evidence);
    if (!hash) return false;
    const openAlerts = await fraudRepository.findOpenAlertsByType('discount_id_reuse');
    return openAlerts.some((alert) => extractCustomerIdHash(alert.evidence) === hash);
  }
  const existing = await fraudRepository.findRecentOpenAlert(result.branchId, result.employeeId, result.alertType);
  return existing !== null;
}

async function processResult(result: DetectionResult): Promise<boolean> {
  if (await isDuplicate(result)) return false;

  const alert = await fraudRepository.createAlert(result);
  notifySuperAdmin(SOCKET_EVENTS.FRAUD_ALERT_CREATED, {
    id: alert.id,
    alert_type: alert.alertType,
    severity: alert.severity,
    branch_id: alert.branchId,
    employee_id: alert.employeeId,
    status: alert.status,
    created_at: alert.createdAt.toISOString(),
  });
  return true;
}

/**
 * Runs every rule in FRAUD_RULES: branch-scoped rules once per active
 * branch (or the caller-provided branchIds, for the manual-trigger
 * endpoint's testing/recovery use case), global-scoped rules exactly once.
 * Owns dedup and FRAUD_ALERT_CREATED broadcast — rule modules never write
 * or emit anything themselves.
 */
export async function runDetection(evaluationDate: Date, branchIds?: string[]): Promise<RunResult> {
  const branches = branchIds ?? (await fraudRepository.findActiveBranchIds()).map((branch) => branch.id);

  let alertsCreated = 0;
  let alertsSkippedDupe = 0;

  for (const rule of FRAUD_RULES) {
    const targets = rule.scope === 'global' ? [null] : branches;
    for (const branchId of targets) {
      const results = await rule.evaluate({ branchId, evaluationDate });
      for (const result of results) {
        const created = await processResult(result);
        if (created) alertsCreated += 1;
        else alertsSkippedDupe += 1;
      }
    }
  }

  return { branchesEvaluated: branches.length, rulesEvaluated: FRAUD_RULES.length, alertsCreated, alertsSkippedDupe };
}
