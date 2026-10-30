import { Prisma } from '@prisma/client';
import type { EmployeePayRate, PayrollPolicy, PayrollRun } from '@prisma/client';
import {
  PAYROLL_EXCLUSIONS,
  PAYROLL_TOTAL_LABEL,
  ROLES,
  type JwtPayload,
  type PayRateCreateInput,
  type PayRateEmployeeView,
  type PayRateView,
  type PayRatesResponse,
  type PayrollAdjustmentCreateInput,
  type PayrollAdjustmentView,
  type PayrollEmployeeResult,
  type PayrollFinalizeInput,
  type PayrollIssue,
  type PayrollPeriodsResponse,
  type PayrollPolicyInput,
  type PayrollPolicyView,
  type PayrollResolutionCreateInput,
  type PayrollRunCreateInput,
  type PayrollRunDetail,
  type PayrollRunSummary,
  type PayrollSettingsResponse,
  type PayrollTotals,
} from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { assertBranchAccess } from '../../lib/branch-access.js';
import { payrollBranchLockId, payrollRateLockId } from '../../lib/pg-lock.js';
import { auditOutboxRepository } from '../audit-outbox/audit-outbox.repository.js';
import type { AuditIntent } from '../audit-outbox/audit-outbox.types.js';
import { settingsService } from '../settings/settings.service.js';
import { payrollRepository as repo, dateKeyOf } from './payroll.repository.js';
import { PayrollError } from './payroll.types.js';
import { calculatePayroll, periodWindow, type CalcAdjustment, type CalcResult } from './payroll-calc.js';
import { decimalToCentavos, formatCentavos, parsePesoToCentavos, perMinuteDisplay } from './payroll-money.js';
import { businessDateKey, isPolicyPeriod, isValidTimeZone, recentPeriods } from './payroll-time.js';

/**
 * POS-PERF-P52 — attendance-based payroll. Rules and examples:
 * docs/runbooks/pos-perf-p52-payroll-settings-and-reports.md
 *
 * Scope: super_admin (every branch) and supervisor (current active branch
 * assignments, read fresh from the DB). Every method re-checks branch access
 * itself — the router's branchGuard is the first line, not the only one —
 * and every run/rate/adjustment id from the request is checked to belong to
 * the branch in the URL, so a submitted id can never reach another branch.
 */

const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const;
const OVERLAP_MARGIN_MS = 7 * 24 * 3_600_000;

function fullName(user: { firstName: string; lastName: string } | null | undefined): string {
  return user ? `${user.firstName} ${user.lastName}`.trim() : 'Unknown';
}

function toPolicyView(row: PayrollPolicy): PayrollPolicyView {
  return {
    version: row.version,
    timezone: row.timezone,
    period_type: row.periodType,
    semi_monthly_first_end_day: row.semiMonthlyFirstEndDay,
    break_treatment: row.breakTreatment,
    paid_break_limit_minutes: row.paidBreakLimitMinutes,
    change_reason: row.changeReason,
    created_by_name: row.createdByName,
    created_at: row.createdAt.toISOString(),
  };
}

function toRateView(row: EmployeePayRate): PayRateView {
  const hourly = row.hourlyRate.toFixed(2);
  return {
    id: row.id,
    effective_from: dateKeyOf(row.effectiveFrom),
    hourly_rate: hourly,
    per_minute_display: perMinuteDisplay(parsePesoToCentavos(hourly)),
    reason: row.reason,
    created_by_name: row.createdByName,
    created_at: row.createdAt.toISOString(),
    voided_at: row.voidedAt?.toISOString() ?? null,
    void_reason: row.voidReason,
  };
}

function toRunSummary(run: PayrollRun): PayrollRunSummary {
  return {
    id: run.id,
    branch_id: run.branchId,
    period_start: dateKeyOf(run.periodStart),
    period_end: dateKeyOf(run.periodEnd),
    status: run.status,
    revision_number: run.revisionNumber,
    revision_of_id: run.revisionOfId,
    revision_reason: run.revisionReason,
    superseded_by_id: run.supersededById,
    created_at: run.createdAt.toISOString(),
    finalized_at: run.finalizedAt?.toISOString() ?? null,
    finalized_by_name: run.finalizedByName,
    paid_at: run.paidAt?.toISOString() ?? null,
    paid_by_name: run.paidByName,
    paid_reference: run.paidReference,
    calculated_total: run.calculatedTotal?.toFixed(2) ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function sumTotals(employees: PayrollEmployeeResult[]): PayrollTotals {
  let basic = 0n;
  let earn = 0n;
  let ded = 0n;
  let ms = 0;
  for (const e of employees) {
    basic += decimalToCentavos(e.basic_pay);
    earn += decimalToCentavos(e.earnings_adjustments);
    ded += decimalToCentavos(e.deductions);
    ms += e.payable_ms;
  }
  return {
    basic_pay: formatCentavos(basic),
    earnings_adjustments: formatCentavos(earn),
    deductions: formatCentavos(ded),
    calculated_total: formatCentavos(basic + earn - ded),
    payable_ms: ms,
  };
}

async function assertPayrollScope(actor: JwtPayload, branchId: string) {
  if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPERVISOR) {
    throw new PayrollError('INSUFFICIENT_PERMISSIONS', 'Payroll is available to supervisors and administrators only', 403);
  }
  await assertBranchAccess(actor, branchId, PayrollError);
  const branch = await repo.findBranch(branchId);
  if (!branch) throw new PayrollError('BRANCH_NOT_FOUND', 'Branch not found', 404);
  return branch;
}

async function actorName(actor: JwtPayload, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
  return fullName(await repo.findUserName(actor.user_id, client));
}

function intent(actor: JwtPayload, branchId: string, action: string, entityType: string, entityId: string, afterState: unknown, beforeState?: unknown): AuditIntent {
  return { action, entityType, entityId, actorId: actor.user_id, actorRole: actor.role, branchId, beforeState, afterState };
}

async function loadRunInBranch(branchId: string, runId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<PayrollRun> {
  const run = await repo.findRun(runId, client);
  // Same 404 for "missing" and "another branch's run" — never confirm another branch's ids exist.
  if (!run || run.branchId !== branchId) throw new PayrollError('RUN_NOT_FOUND', 'Payroll run not found', 404);
  return run;
}

/** Live calculation for a draft from current attendance, rates, policy, adjustments and resolutions. */
/**
 * POS-PERF-P54 — `regularShiftMinutes` is resolved by the caller. The locked
 * write paths (finalize, adjustments, resolutions) read it BEFORE opening
 * their transaction: settingsService has no tx client, and a second pooled
 * connection taken while holding the branch lock starves the pool when
 * several reviewers act at once (the waiters each hold a connection), so the
 * lock holder timed out (P2024) instead of the others getting 409.
 */
async function computeRun(
  run: PayrollRun,
  regularShiftMinutes: number,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ calc: CalcResult; policy: PayrollPolicy | null }> {
  const policy = await repo.findCurrentPolicy(run.branchId, client);
  const periodStart = dateKeyOf(run.periodStart);
  const periodEnd = dateKeyOf(run.periodEnd);
  const records = policy ? await repo.findBranchRecords(run.branchId, ...windowArgs(periodStart, periodEnd, policy.timezone), client) : [];
  const adjustmentRows = await repo.listAdjustments(run.id, client);
  const employeeIds = [...new Set([...records.map((r) => r.employeeId), ...adjustmentRows.map((a) => a.employeeId)])];
  const window = policy ? periodWindow(periodStart, periodEnd, policy.timezone) : null;
  const [employees, others, rates, resolutions, previousLines] = await Promise.all([
    repo.findEmployeesForCalc(employeeIds, run.branchId, client),
    window
      ? repo.findEmployeeRecordsNear(employeeIds, new Date(window.from.getTime() - OVERLAP_MARGIN_MS), new Date(window.to.getTime() + OVERLAP_MARGIN_MS), client)
      : Promise.resolve([]),
    repo.listLiveRates(run.branchId, employeeIds, client),
    repo.listResolutions(run.id, client),
    run.revisionOfId ? repo.listLines(run.revisionOfId, client) : Promise.resolve(null),
  ]);

  const adjustments: CalcAdjustment[] = adjustmentRows.map((a) => ({
    id: a.id,
    employee_id: a.employeeId,
    kind: a.kind,
    category: a.category,
    amount: a.amount.toFixed(2),
    reason: a.reason,
    documentation_ref: a.documentationRef,
    copied_from_id: a.copiedFromId,
    created_by_name: a.createdByName,
    created_at: a.createdAt.toISOString(),
    voided_at: a.voidedAt?.toISOString() ?? null,
    void_reason: a.voidReason,
  }));

  const calc = calculatePayroll({
    policy: policy
      ? { version: policy.version, timezone: policy.timezone, breakTreatment: policy.breakTreatment, paidBreakLimitMinutes: policy.paidBreakLimitMinutes }
      : null,
    periodStart,
    periodEnd,
    regularShiftMinutes,
    records: records.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      branchId: r.branchId,
      clockIn: r.clockInServerTime,
      clockOut: r.clockOutServerTime,
      breakMinutes: r.breakMinutes,
      breaks: r.breaks,
      originalRecordId: r.originalRecordId,
      correctedByName: r.corrector ? fullName(r.corrector) : null,
      correctionReason: r.correctionReason,
    })),
    otherRecords: others.map((o) => ({ id: o.id, employeeId: o.employeeId, clockIn: o.clockInServerTime, clockOut: o.clockOutServerTime })),
    employees: new Map(
      employees.map((e) => [e.id, { id: e.id, name: fullName(e), employeeCode: e.employeeId, role: e.role, assignments: e.branchAssignments }]),
    ),
    rates: rates.map((r) => ({ id: r.id, employeeId: r.employeeId, effectiveFrom: dateKeyOf(r.effectiveFrom), hourlyRate: r.hourlyRate.toFixed(2) })),
    adjustments,
    resolutions: resolutions.map((r) => ({ issueKey: r.issueKey, note: r.note, byName: r.createdByName, at: r.createdAt })),
    previousTotals: previousLines ? new Map(previousLines.map((l) => [l.employeeId, l.calculatedTotal.toFixed(2)])) : null,
    periodMatchesPolicy: policy ? isPolicyPeriod({ start: periodStart, end: periodEnd }, { periodType: policy.periodType, semiMonthlyFirstEndDay: policy.semiMonthlyFirstEndDay }) : true,
  });
  return { calc, policy };
}

function windowArgs(start: string, end: string, timeZone: string): [Date, Date] {
  const w = periodWindow(start, end, timeZone);
  return [w.from, w.to];
}

function filterIssues(issues: PayrollIssue[], employeeId: string | null): PayrollIssue[] {
  return employeeId ? issues.filter((i) => i.employee_id === null || i.employee_id === employeeId) : issues;
}

export const payrollService = {
  // ------------------------------------------------------------------ settings

  async getSettings(actor: JwtPayload, branchId: string): Promise<PayrollSettingsResponse> {
    const branch = await assertPayrollScope(actor, branchId);
    const [history, regularShiftMinutes] = await Promise.all([repo.listPolicies(branchId), settingsService.getRegularShiftMinutes(branchId)]);
    return {
      branch: { id: branch.id, name: branch.name },
      policy: history[0] ? toPolicyView(history[0]) : null,
      history: history.map(toPolicyView),
      regular_shift_minutes: regularShiftMinutes,
      exclusions: PAYROLL_EXCLUSIONS,
    };
  },

  async savePolicy(actor: JwtPayload, branchId: string, input: PayrollPolicyInput): Promise<PayrollPolicyView> {
    await assertPayrollScope(actor, branchId);
    if (!isValidTimeZone(input.timezone)) {
      throw new PayrollError('INVALID_TIMEZONE', `"${input.timezone}" is not a recognised timezone`, 422);
    }
    const name = await actorName(actor);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      const current = await repo.findCurrentPolicy(branchId, tx);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expected_version) {
        throw new PayrollError('STALE_POLICY', 'The payroll policy was changed by someone else. Reload to see the current settings.', 409, {
          current_version: currentVersion,
        });
      }
      const created = await repo.createPolicy(
        {
          branchId,
          version: currentVersion + 1,
          timezone: input.timezone,
          periodType: input.period_type,
          semiMonthlyFirstEndDay: input.period_type === 'semi_monthly' ? (input.semi_monthly_first_end_day ?? null) : null,
          breakTreatment: input.break_treatment,
          paidBreakLimitMinutes: input.break_treatment === 'paid_up_to_limit' ? (input.paid_break_limit_minutes ?? null) : null,
          changeReason: input.change_reason?.trim() || null,
          createdBy: actor.user_id,
          createdByName: name,
        },
        tx,
      );
      const view = toPolicyView(created);
      await auditOutboxRepository.enqueue(tx, [
        intent(actor, branchId, 'PAYROLL_POLICY_SAVED', 'payroll_policy', created.id, view, current ? toPolicyView(current) : null),
      ]);
      return view;
    }, TX_OPTIONS);
  },

  async listRates(actor: JwtPayload, branchId: string): Promise<PayRatesResponse> {
    const branch = await assertPayrollScope(actor, branchId);
    const [staff, rates, policy] = await Promise.all([repo.findStaffWithBranchHistory(branchId), repo.listRates(branchId), repo.findCurrentPolicy(branchId)]);
    const today = policy ? businessDateKey(new Date(), policy.timezone) : null;
    const employees: PayRateEmployeeView[] = staff.map((s) => {
      const own = rates.filter((r) => r.employeeId === s.id);
      const live = own.filter((r) => r.voidedAt === null);
      const effectiveToday = today ? live.filter((r) => dateKeyOf(r.effectiveFrom) <= today).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] : undefined;
      const latest = live.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
      return {
        employee_id: s.id,
        name: fullName(s),
        employee_code: s.employeeId,
        assignment: s.branchAssignments.some((a) => a.removedAt === null) ? 'current' : 'former',
        employee_active: s.isActive,
        current_rate: effectiveToday ? toRateView(effectiveToday) : null,
        latest_rate_id: latest?.id ?? null,
        rates: own.map(toRateView),
      };
    });
    return { branch: { id: branch.id, name: branch.name }, today, employees };
  },

  async createRate(actor: JwtPayload, branchId: string, input: PayRateCreateInput): Promise<PayRateView> {
    await assertPayrollScope(actor, branchId);
    const staff = await repo.findStaffWithBranchHistory(branchId);
    // Only staff who are or were assigned to THIS branch; the submitted id is never trusted on its own.
    if (!staff.some((s) => s.id === input.employee_id)) {
      throw new PayrollError('EMPLOYEE_NOT_IN_BRANCH', 'This employee has never been assigned to this branch', 404);
    }
    const hourlyCentavos = parsePesoToCentavos(input.hourly_rate);
    if (hourlyCentavos <= 0n) throw new PayrollError('INVALID_RATE', 'The hourly rate must be more than zero', 422);
    const name = await actorName(actor);
    try {
      return await prisma.$transaction(async (tx) => {
        await repo.lock(tx, payrollRateLockId(input.employee_id, branchId));
        const latest = await repo.findLatestLiveRate(input.employee_id, branchId, tx);
        if ((latest?.id ?? null) !== input.expected_latest_rate_id) {
          throw new PayrollError('STALE_RATES', "This employee's rates were changed by someone else. Reload and try again.", 409, {
            latest_rate_id: latest?.id ?? null,
          });
        }
        const created = await repo.createRate(
          {
            employeeId: input.employee_id,
            branchId,
            effectiveFrom: repo.dateOnly(input.effective_from),
            hourlyRate: formatCentavos(hourlyCentavos),
            reason: input.reason.trim(),
            createdBy: actor.user_id,
            createdByName: name,
          },
          tx,
        );
        const view = toRateView(created);
        await auditOutboxRepository.enqueue(tx, [
          intent(actor, branchId, 'PAYROLL_RATE_ADDED', 'employee_pay_rate', created.id, { ...view, employee_id: input.employee_id }),
        ]);
        return view;
      }, TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PayrollError('RATE_DATE_TAKEN', 'A rate already starts on this date. Void it first to replace it.', 409);
      }
      throw error;
    }
  },

  async voidRate(actor: JwtPayload, branchId: string, rateId: string, input: { reason: string; expected_latest_rate_id: string | null }): Promise<PayRateView> {
    await assertPayrollScope(actor, branchId);
    const rate = await repo.findRate(rateId);
    if (!rate || rate.branchId !== branchId) throw new PayrollError('RATE_NOT_FOUND', 'Rate not found', 404);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollRateLockId(rate.employeeId, branchId));
      const latest = await repo.findLatestLiveRate(rate.employeeId, branchId, tx);
      if ((latest?.id ?? null) !== input.expected_latest_rate_id) {
        throw new PayrollError('STALE_RATES', "This employee's rates were changed by someone else. Reload and try again.", 409, {
          latest_rate_id: latest?.id ?? null,
        });
      }
      const result = await repo.voidRate(rateId, { voidedBy: actor.user_id, voidReason: input.reason.trim() }, tx);
      if (result.count !== 1) throw new PayrollError('RATE_ALREADY_VOIDED', 'This rate was already voided', 409);
      const after = await repo.findRate(rateId, tx);
      if (!after) throw new PayrollError('RATE_NOT_FOUND', 'Rate not found', 404);
      const view = toRateView(after);
      await auditOutboxRepository.enqueue(tx, [
        intent(actor, branchId, 'PAYROLL_RATE_VOIDED', 'employee_pay_rate', rateId, { ...view, employee_id: rate.employeeId }, toRateView(rate)),
      ]);
      return view;
    }, TX_OPTIONS);
  },

  // ------------------------------------------------------------------ runs

  async listPeriods(actor: JwtPayload, branchId: string): Promise<PayrollPeriodsResponse> {
    await assertPayrollScope(actor, branchId);
    const [policy, runs] = await Promise.all([repo.findCurrentPolicy(branchId), repo.listRuns(branchId)]);
    const summaries = runs.map(toRunSummary);
    if (!policy) return { configured: false, periods: [], runs: summaries };
    const today = businessDateKey(new Date(), policy.timezone);
    const periods = recentPeriods(today, { periodType: policy.periodType, semiMonthlyFirstEndDay: policy.semiMonthlyFirstEndDay }, 12).map((p) => ({
      period_start: p.start,
      period_end: p.end,
      label: `${p.start} to ${p.end}`,
      runs: summaries.filter((r) => r.period_start === p.start && r.period_end === p.end),
    }));
    return { configured: true, periods, runs: summaries };
  },

  async createRun(actor: JwtPayload, branchId: string, input: PayrollRunCreateInput): Promise<{ run: PayrollRunSummary; created: boolean }> {
    await assertPayrollScope(actor, branchId);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      const policy = await repo.findCurrentPolicy(branchId, tx);
      if (!policy) throw new PayrollError('POLICY_MISSING', 'Set up this branch\'s payroll policy first (Pay settings).', 409);
      const rule = { periodType: policy.periodType, semiMonthlyFirstEndDay: policy.semiMonthlyFirstEndDay };
      if (!isPolicyPeriod({ start: input.period_start, end: input.period_end }, rule)) {
        throw new PayrollError('INVALID_PERIOD', 'That date range is not a pay period under this branch\'s settings', 422);
      }
      const start = repo.dateOnly(input.period_start);
      const end = repo.dateOnly(input.period_end);
      const finalized = await repo.findOverlappingFinalized(branchId, start, end, tx);
      if (finalized.length > 0) {
        throw new PayrollError('PERIOD_ALREADY_FINALIZED', 'Payroll for this period is already finalized. Open it and use Revise to correct it.', 409, {
          run_ids: finalized.map((r) => r.id),
        });
      }
      const existing = await repo.findDraftForPeriod(branchId, start, end, tx);
      if (existing) return { run: toRunSummary(existing), created: false };
      const run = await repo.createRun({ branchId, periodStart: start, periodEnd: end, createdBy: actor.user_id }, tx);
      await auditOutboxRepository.enqueue(tx, [intent(actor, branchId, 'PAYROLL_DRAFT_CREATED', 'payroll_run', run.id, toRunSummary(run))]);
      return { run: toRunSummary(run), created: true };
    }, TX_OPTIONS);
  },

  async getRun(actor: JwtPayload, branchId: string, runId: string, employeeId?: string): Promise<PayrollRunDetail> {
    const branch = await assertPayrollScope(actor, branchId);
    const run = await loadRunInBranch(branchId, runId);
    return payrollService.buildDetail(run, branch.name, employeeId ?? null);
  },

  /** Draft → live recalculation; finalized/superseded → the stored snapshot, never recalculated. */
  async buildDetail(run: PayrollRun, branchName: string, employeeFilter: string | null): Promise<PayrollRunDetail> {
    const summary = toRunSummary(run);
    if (run.status === 'draft' || run.status === 'discarded') {
      const { calc, policy } = await computeRun(run, await settingsService.getRegularShiftMinutes(run.branchId));
      const employees = employeeFilter ? calc.employees.filter((e) => e.employee_id === employeeFilter) : calc.employees;
      return {
        ...summary,
        branch_name: branchName,
        basis: 'live',
        calculated_at: new Date().toISOString(),
        fingerprint: run.status === 'draft' ? calc.fingerprint : null,
        policy: policy ? toPolicyView(policy) : null,
        totals: employeeFilter ? sumTotals(employees) : calc.totals,
        employees,
        issues: filterIssues(calc.issues, employeeFilter),
        blocking_count: calc.blockingCount,
        can_finalize: run.status === 'draft' && calc.canFinalize,
        exclusions: PAYROLL_EXCLUSIONS,
        total_label: PAYROLL_TOTAL_LABEL,
        source_changes: [],
        employee_filter: employeeFilter,
      };
    }

    const lines = await repo.listLines(run.id);
    const allEmployees = lines.map((l) => l.details as unknown as PayrollEmployeeResult);
    const employees = employeeFilter ? allEmployees.filter((e) => e.employee_id === employeeFilter) : allEmployees;
    const issues = (run.issueSnapshot as unknown as PayrollIssue[] | null) ?? [];
    const totals: PayrollTotals = employeeFilter
      ? sumTotals(employees)
      : {
          basic_pay: run.basicPayTotal?.toFixed(2) ?? '0.00',
          earnings_adjustments: run.earningsTotal?.toFixed(2) ?? '0.00',
          deductions: run.deductionsTotal?.toFixed(2) ?? '0.00',
          calculated_total: run.calculatedTotal?.toFixed(2) ?? '0.00',
          payable_ms: lines.reduce((sum, l) => sum + Number(l.payableMs), 0),
        };
    return {
      ...summary,
      branch_name: branchName,
      basis: 'finalized_snapshot',
      calculated_at: run.finalizedAt?.toISOString() ?? run.updatedAt.toISOString(),
      fingerprint: run.fingerprint,
      policy: (run.policySnapshot as unknown as PayrollPolicyView | null) ?? null,
      totals,
      employees,
      issues: filterIssues(issues, employeeFilter),
      blocking_count: 0,
      can_finalize: false,
      exclusions: PAYROLL_EXCLUSIONS,
      total_label: PAYROLL_TOTAL_LABEL,
      source_changes: run.status === 'finalized' ? await payrollService.sourceChanges(run, employeeFilter) : [],
      employee_filter: employeeFilter,
    };
  },

  /** Attendance that changed after this run was finalized. Informational: the snapshot itself never changes. */
  async sourceChanges(run: PayrollRun, employeeFilter: string | null): Promise<PayrollRunDetail['source_changes']> {
    const claims = await repo.listClaims(run.id);
    const ids = claims.map((c) => c.attendanceRecordId);
    const changes: PayrollRunDetail['source_changes'] = [];
    if (ids.length > 0 && run.finalizedAt) {
      const finalizedAt = run.finalizedAt.getTime();
      const records = await repo.findRecordsByIds(ids);
      for (const r of records) {
        if (r.deletedAt) changes.push({ attendance_record_id: r.id, employee_id: r.employeeId, change: 'Corrected or removed after finalization' });
        else if (r.updatedAt.getTime() > finalizedAt) changes.push({ attendance_record_id: r.id, employee_id: r.employeeId, change: 'Changed after finalization' });
      }
    }
    const policy = (run.policySnapshot as unknown as PayrollPolicyView | null) ?? null;
    if (policy && run.finalizedAt) {
      const finalizedAt = run.finalizedAt.getTime();
      const [from, to] = windowArgs(dateKeyOf(run.periodStart), dateKeyOf(run.periodEnd), policy.timezone);
      const claimed = new Set(ids);
      const current = await repo.findBranchRecords(run.branchId, from, to);
      // Only rows written after finalization: unclaimed rows that already existed (e.g. non-staff attendance) are not changes.
      for (const r of current) {
        if (!claimed.has(r.id) && r.updatedAt.getTime() > finalizedAt) {
          changes.push({ attendance_record_id: r.id, employee_id: r.employeeId, change: 'Attendance added or corrected after finalization (not in this payroll)' });
        }
      }
    }
    return employeeFilter ? changes.filter((c) => c.employee_id === employeeFilter) : changes;
  },

  async addAdjustment(actor: JwtPayload, branchId: string, runId: string, input: PayrollAdjustmentCreateInput): Promise<PayrollAdjustmentView> {
    await assertPayrollScope(actor, branchId);
    const name = await actorName(actor);
    const regularShiftMinutes = await settingsService.getRegularShiftMinutes(branchId);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      const run = await loadRunInBranch(branchId, runId, tx);
      if (run.status !== 'draft') throw new PayrollError('RUN_NOT_DRAFT', 'Adjustments can only be added to a draft', 409);
      const { calc } = await computeRun(run, regularShiftMinutes, tx);
      if (!calc.employees.some((e) => e.employee_id === input.employee_id)) {
        throw new PayrollError('EMPLOYEE_NOT_IN_RUN', 'This employee has no attendance at this branch in this period', 404);
      }
      const amount = parsePesoToCentavos(input.amount);
      if (amount <= 0n) throw new PayrollError('INVALID_AMOUNT', 'The amount must be more than zero', 422);
      const created = await repo.createAdjustment(
        {
          runId,
          employeeId: input.employee_id,
          kind: input.kind,
          category: input.category,
          amount: formatCentavos(amount),
          reason: input.reason.trim(),
          documentationRef: input.documentation_ref?.trim() || null,
          createdBy: actor.user_id,
          createdByName: name,
        },
        tx,
      );
      await repo.touchRun(runId, tx);
      const view: PayrollAdjustmentView = {
        id: created.id,
        kind: created.kind,
        category: created.category,
        amount: created.amount.toFixed(2),
        reason: created.reason,
        documentation_ref: created.documentationRef,
        copied_from_id: null,
        created_by_name: created.createdByName,
        created_at: created.createdAt.toISOString(),
        voided_at: null,
        void_reason: null,
      };
      await auditOutboxRepository.enqueue(tx, [
        intent(actor, branchId, 'PAYROLL_ADJUSTMENT_ADDED', 'payroll_adjustment', created.id, { ...view, run_id: runId, employee_id: input.employee_id }),
      ]);
      return view;
    }, TX_OPTIONS);
  },

  async voidAdjustment(actor: JwtPayload, branchId: string, runId: string, adjustmentId: string, reason: string): Promise<{ id: string; voided: true }> {
    await assertPayrollScope(actor, branchId);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      const run = await loadRunInBranch(branchId, runId, tx);
      if (run.status !== 'draft') throw new PayrollError('RUN_NOT_DRAFT', 'Adjustments can only be changed on a draft', 409);
      const adjustment = await repo.findAdjustment(adjustmentId, tx);
      if (!adjustment || adjustment.runId !== runId) throw new PayrollError('ADJUSTMENT_NOT_FOUND', 'Adjustment not found', 404);
      const result = await repo.voidAdjustment(adjustmentId, { voidedBy: actor.user_id, voidReason: reason.trim() }, tx);
      if (result.count !== 1) throw new PayrollError('ADJUSTMENT_ALREADY_VOIDED', 'This adjustment was already voided', 409);
      await repo.touchRun(runId, tx);
      await auditOutboxRepository.enqueue(tx, [
        intent(actor, branchId, 'PAYROLL_ADJUSTMENT_VOIDED', 'payroll_adjustment', adjustmentId, { run_id: runId, reason: reason.trim() }, {
          kind: adjustment.kind,
          amount: adjustment.amount.toFixed(2),
          employee_id: adjustment.employeeId,
        }),
      ]);
      return { id: adjustmentId, voided: true as const };
    }, TX_OPTIONS);
  },

  async addResolution(actor: JwtPayload, branchId: string, runId: string, input: PayrollResolutionCreateInput): Promise<{ issue_key: string }> {
    await assertPayrollScope(actor, branchId);
    const name = await actorName(actor);
    const regularShiftMinutes = await settingsService.getRegularShiftMinutes(branchId);
    try {
      return await prisma.$transaction(async (tx) => {
        await repo.lock(tx, payrollBranchLockId(branchId));
        const run = await loadRunInBranch(branchId, runId, tx);
        if (run.status !== 'draft') throw new PayrollError('RUN_NOT_DRAFT', 'Issues can only be resolved on a draft', 409);
        const { calc } = await computeRun(run, regularShiftMinutes, tx);
        const issue = calc.issues.find((i) => i.key === input.issue_key);
        if (!issue || issue.severity !== 'special_pay') {
          throw new PayrollError('ISSUE_NOT_RESOLVABLE', 'Only an open special-pay issue on this draft can be resolved with a note', 422);
        }
        await repo.createResolution({ runId, issueKey: input.issue_key, note: input.note.trim(), createdBy: actor.user_id, createdByName: name }, tx);
        await repo.touchRun(runId, tx);
        await auditOutboxRepository.enqueue(tx, [
          intent(actor, branchId, 'PAYROLL_ISSUE_RESOLVED', 'payroll_run', runId, { issue_key: input.issue_key, code: issue.code, note: input.note.trim() }),
        ]);
        return { issue_key: input.issue_key };
      }, TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PayrollError('ISSUE_ALREADY_RESOLVED', 'This issue already has a resolution note', 409);
      throw error;
    }
  },

  /**
   * Atomic finalization. Under the per-branch lock and inside one
   * transaction: re-read the run, recalculate from current inputs, refuse
   * if the reviewer's fingerprint no longer matches (stale preview), if
   * anything blocks, or if a finalized run already covers an overlapping
   * period; otherwise write the immutable lines, snapshots and attendance
   * claims, supersede the original (for a revision) and mark finalized.
   */
  async finalize(actor: JwtPayload, branchId: string, runId: string, input: PayrollFinalizeInput): Promise<PayrollRunSummary> {
    await assertPayrollScope(actor, branchId);
    const name = await actorName(actor);
    const regularShiftMinutes = await settingsService.getRegularShiftMinutes(branchId);
    try {
      return await prisma.$transaction(async (tx) => {
        await repo.lock(tx, payrollBranchLockId(branchId));
        const run = await loadRunInBranch(branchId, runId, tx);
        if (run.status !== 'draft') throw new PayrollError('RUN_NOT_DRAFT', `This payroll is already ${run.status}`, 409, { status: run.status });

        const { calc, policy } = await computeRun(run, regularShiftMinutes, tx);
        if (calc.fingerprint !== input.expected_fingerprint) {
          throw new PayrollError('STALE_PREVIEW', 'Attendance, rates, settings or adjustments changed since you reviewed this draft. Review the updated figures, then finalize again.', 409, {
            current_fingerprint: calc.fingerprint,
          });
        }
        if (!calc.canFinalize || !policy) {
          throw new PayrollError('BLOCKING_ISSUES', 'Resolve the blocking issues before finalizing', 409, { blocking_count: calc.blockingCount });
        }

        const overlapping = (await repo.findOverlappingFinalized(branchId, run.periodStart, run.periodEnd, tx)).filter((r) => r.id !== run.revisionOfId);
        if (overlapping.length > 0) {
          throw new PayrollError('PERIOD_ALREADY_FINALIZED', 'A finalized payroll already covers part of this period', 409, { run_ids: overlapping.map((r) => r.id) });
        }

        const intents: AuditIntent[] = [];
        if (run.revisionOfId) {
          const superseded = await repo.supersedeRun(run.revisionOfId, run.id, tx);
          if (superseded.count !== 1) throw new PayrollError('ORIGINAL_NOT_FINALIZED', 'The payroll this revision corrects is no longer finalized', 409);
          await repo.releaseClaims(run.revisionOfId, tx);
          intents.push(intent(actor, branchId, 'PAYROLL_SUPERSEDED', 'payroll_run', run.revisionOfId, { superseded_by_id: run.id }));
        }

        await repo.createLines(
          calc.employees.map((e) => ({
            runId: run.id,
            employeeId: e.employee_id,
            employeeName: e.name,
            employeeCode: e.employee_code,
            payableMs: BigInt(e.payable_ms),
            basicPay: e.basic_pay,
            earningsAdjustments: e.earnings_adjustments,
            deductions: e.deductions,
            calculatedTotal: e.calculated_total,
            details: e as unknown as Prisma.InputJsonValue,
          })),
          tx,
        );
        await repo.createClaims(calc.attendanceRecordIds.map((r) => ({ attendanceRecordId: r.id, runId: run.id, employeeId: r.employeeId })), tx);

        const rateRows = await repo.findRatesByIds(calc.usedRateIds, tx);
        const now = new Date();
        const updated = await repo.finalizeRun(
          run.id,
          {
            finalizedAt: now,
            finalizedBy: actor.user_id,
            finalizedByName: name,
            fingerprint: calc.fingerprint,
            policySnapshot: toPolicyView(policy) as unknown as Prisma.InputJsonValue,
            rateSnapshot: rateRows.map((r) => ({ ...toRateView(r), employee_id: r.employeeId })) as unknown as Prisma.InputJsonValue,
            issueSnapshot: calc.issues as unknown as Prisma.InputJsonValue,
            scopeAcknowledgedAt: now,
            basicPayTotal: calc.totals.basic_pay,
            earningsTotal: calc.totals.earnings_adjustments,
            deductionsTotal: calc.totals.deductions,
            calculatedTotal: calc.totals.calculated_total,
          },
          tx,
        );
        if (updated.count !== 1) throw new PayrollError('RUN_NOT_DRAFT', 'This payroll was finalized or discarded by someone else', 409);
        const finalized = await loadRunInBranch(branchId, runId, tx);
        intents.push(
          intent(actor, branchId, 'PAYROLL_FINALIZED', 'payroll_run', run.id, {
            period_start: dateKeyOf(run.periodStart),
            period_end: dateKeyOf(run.periodEnd),
            fingerprint: calc.fingerprint,
            totals: calc.totals,
            employee_count: calc.employees.length,
            revision_of_id: run.revisionOfId,
            scope_acknowledged: true,
            exclusions: PAYROLL_EXCLUSIONS,
          }),
        );
        await auditOutboxRepository.enqueue(tx, intents);
        return toRunSummary(finalized);
      }, TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PayrollError('ATTENDANCE_ALREADY_PAID', 'Some of this attendance is already in another finalized payroll', 409);
      }
      throw error;
    }
  },

  async discard(actor: JwtPayload, branchId: string, runId: string, reason: string): Promise<PayrollRunSummary> {
    await assertPayrollScope(actor, branchId);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      await loadRunInBranch(branchId, runId, tx);
      const result = await repo.discardRun(runId, { discardedBy: actor.user_id, discardReason: reason.trim() }, tx);
      if (result.count !== 1) throw new PayrollError('RUN_NOT_DRAFT', 'Only a draft can be discarded', 409);
      const run = await loadRunInBranch(branchId, runId, tx);
      await auditOutboxRepository.enqueue(tx, [intent(actor, branchId, 'PAYROLL_DRAFT_DISCARDED', 'payroll_run', runId, { reason: reason.trim() })]);
      return toRunSummary(run);
    }, TX_OPTIONS);
  },

  /** Correction path for a finalized run: a new draft (adjustments copied). The original stays finalized until the revision is finalized. */
  async revise(actor: JwtPayload, branchId: string, runId: string, reason: string): Promise<PayrollRunSummary> {
    await assertPayrollScope(actor, branchId);
    const name = await actorName(actor);
    try {
      return await prisma.$transaction(async (tx) => {
        await repo.lock(tx, payrollBranchLockId(branchId));
        const original = await loadRunInBranch(branchId, runId, tx);
        if (original.status !== 'finalized') throw new PayrollError('RUN_NOT_FINALIZED', 'Only the current finalized payroll can be revised', 409);
        const draft = await repo.createRun(
          {
            branchId,
            periodStart: original.periodStart,
            periodEnd: original.periodEnd,
            createdBy: actor.user_id,
            revisionOfId: original.id,
            revisionNumber: original.revisionNumber + 1,
            revisionReason: reason.trim(),
          },
          tx,
        );
        const adjustments = (await repo.listAdjustments(original.id, tx)).filter((a) => a.voidedAt === null);
        for (const a of adjustments) {
          await repo.createAdjustment(
            {
              runId: draft.id,
              employeeId: a.employeeId,
              kind: a.kind,
              category: a.category,
              amount: a.amount.toFixed(2),
              reason: a.reason,
              documentationRef: a.documentationRef,
              copiedFromId: a.id,
              createdBy: actor.user_id,
              createdByName: name,
            },
            tx,
          );
        }
        await auditOutboxRepository.enqueue(tx, [
          intent(actor, branchId, 'PAYROLL_REVISION_STARTED', 'payroll_run', draft.id, { revision_of_id: original.id, reason: reason.trim(), copied_adjustments: adjustments.length }),
        ]);
        return toRunSummary(draft);
      }, TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PayrollError('REVISION_EXISTS', 'A revision draft for this payroll is already open', 409);
      throw error;
    }
  },

  async markPaid(actor: JwtPayload, branchId: string, runId: string, paidReference: string | undefined): Promise<PayrollRunSummary> {
    await assertPayrollScope(actor, branchId);
    const name = await actorName(actor);
    return prisma.$transaction(async (tx) => {
      await repo.lock(tx, payrollBranchLockId(branchId));
      await loadRunInBranch(branchId, runId, tx);
      const result = await repo.markPaid(runId, { paidBy: actor.user_id, paidByName: name, paidReference: paidReference?.trim() || null }, tx);
      if (result.count !== 1) throw new PayrollError('NOT_PAYABLE', 'Only a finalized payroll that is not yet marked paid can be marked paid', 409);
      const run = await loadRunInBranch(branchId, runId, tx);
      await auditOutboxRepository.enqueue(tx, [
        intent(actor, branchId, 'PAYROLL_MARKED_PAID', 'payroll_run', runId, { paid_reference: run.paidReference, calculated_total: run.calculatedTotal?.toFixed(2) ?? null }),
      ]);
      return toRunSummary(run);
    }, TX_OPTIONS);
  },
};
