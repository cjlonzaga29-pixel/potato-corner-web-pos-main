import type { Prisma, PayrollAdjustmentKind, PayrollBreakTreatment, PayrollPeriodType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * POS-PERF-P52 — every Prisma call for payroll. Payroll tables are written
 * append-only: the only updates are narrow, conditional status transitions
 * (`updateMany` with the expected current status in the WHERE clause, so a
 * concurrent change makes the update match zero rows instead of
 * overwriting), plus void stamps on rates/adjustments and claim releases.
 * Nothing here deletes a payroll row.
 */

type Client = Prisma.TransactionClient | typeof prisma;

function dateOnly(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function dateKeyOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export const payrollRepository = {
  dateOnly,

  async lock(tx: Prisma.TransactionClient, lockId: bigint): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
  },

  findBranch(branchId: string, client: Client = prisma) {
    return client.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true, status: true } });
  },

  findUserName(userId: string, client: Client = prisma) {
    return client.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  },

  // ---------- policy ----------

  findCurrentPolicy(branchId: string, client: Client = prisma) {
    return client.payrollPolicy.findFirst({ where: { branchId }, orderBy: { version: 'desc' } });
  },

  listPolicies(branchId: string, client: Client = prisma) {
    return client.payrollPolicy.findMany({ where: { branchId }, orderBy: { version: 'desc' } });
  },

  createPolicy(
    data: {
      branchId: string;
      version: number;
      timezone: string;
      periodType: PayrollPeriodType;
      semiMonthlyFirstEndDay: number | null;
      breakTreatment: PayrollBreakTreatment;
      paidBreakLimitMinutes: number | null;
      changeReason: string | null;
      createdBy: string;
      createdByName: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.payrollPolicy.create({ data });
  },

  // ---------- employees / rates ----------

  /** Staff with any assignment (current or past) at the branch, with that branch's assignment history. */
  findStaffWithBranchHistory(branchId: string, client: Client = prisma) {
    return client.user.findMany({
      where: { role: 'staff', branchAssignments: { some: { branchId } } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeId: true,
        role: true,
        isActive: true,
        branchAssignments: { where: { branchId }, select: { assignedAt: true, removedAt: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  },

  findEmployeesForCalc(employeeIds: string[], branchId: string, client: Client = prisma) {
    return client.user.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeId: true,
        role: true,
        branchAssignments: { where: { branchId }, select: { assignedAt: true, removedAt: true } },
      },
    });
  },

  listRates(branchId: string, client: Client = prisma) {
    return client.employeePayRate.findMany({
      where: { branchId },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
  },

  listLiveRates(branchId: string, employeeIds: string[], client: Client = prisma) {
    return client.employeePayRate.findMany({
      where: { branchId, employeeId: { in: employeeIds }, voidedAt: null },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });
  },

  findLatestLiveRate(employeeId: string, branchId: string, client: Client = prisma) {
    return client.employeePayRate.findFirst({
      where: { employeeId, branchId, voidedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  findRatesByIds(ids: string[], client: Client = prisma) {
    return ids.length > 0 ? client.employeePayRate.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }) : Promise.resolve([]);
  },

  findRate(rateId: string, client: Client = prisma) {
    return client.employeePayRate.findUnique({ where: { id: rateId } });
  },

  createRate(
    data: { employeeId: string; branchId: string; effectiveFrom: Date; hourlyRate: string; reason: string; createdBy: string; createdByName: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.employeePayRate.create({ data });
  },

  voidRate(rateId: string, data: { voidedBy: string; voidReason: string }, tx: Prisma.TransactionClient) {
    return tx.employeePayRate.updateMany({ where: { id: rateId, voidedAt: null }, data: { voidedAt: new Date(), ...data } });
  },

  // ---------- attendance (read-only) ----------

  /** Non-deleted records at the branch whose clock-in falls in [from, to). */
  findBranchRecords(branchId: string, from: Date, to: Date, client: Client = prisma) {
    return client.attendanceRecord.findMany({
      where: { branchId, deletedAt: null, clockInServerTime: { gte: from, lt: to } },
      select: {
        id: true,
        employeeId: true,
        branchId: true,
        clockInServerTime: true,
        clockOutServerTime: true,
        breakMinutes: true,
        originalRecordId: true,
        correctionReason: true,
        updatedAt: true,
        corrector: { select: { firstName: true, lastName: true } },
        breaks: { select: { id: true, startedAt: true, endedAt: true }, orderBy: { startedAt: 'asc' } },
      },
      orderBy: { clockInServerTime: 'asc' },
    });
  },

  /** Every non-deleted record (any branch) of these employees near the window — overlap detection only; branch is never exposed. */
  findEmployeeRecordsNear(employeeIds: string[], from: Date, to: Date, client: Client = prisma) {
    return client.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        deletedAt: null,
        clockInServerTime: { lt: to },
        OR: [{ clockOutServerTime: null }, { clockOutServerTime: { gt: from } }],
      },
      select: { id: true, employeeId: true, clockInServerTime: true, clockOutServerTime: true },
    });
  },

  findRecordsByIds(ids: string[], client: Client = prisma) {
    return client.attendanceRecord.findMany({
      where: { id: { in: ids } },
      select: { id: true, employeeId: true, deletedAt: true, updatedAt: true },
    });
  },

  findCorrectionsOf(ids: string[], client: Client = prisma) {
    return client.attendanceRecord.findMany({
      where: { originalRecordId: { in: ids } },
      select: { id: true, employeeId: true, originalRecordId: true },
    });
  },

  // ---------- runs ----------

  findRun(runId: string, client: Client = prisma) {
    return client.payrollRun.findUnique({ where: { id: runId } });
  },

  listRuns(branchId: string, client: Client = prisma) {
    return client.payrollRun.findMany({
      where: { branchId },
      orderBy: [{ periodStart: 'desc' }, { revisionNumber: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  },

  findDraftForPeriod(branchId: string, start: Date, end: Date, client: Client = prisma) {
    return client.payrollRun.findFirst({ where: { branchId, periodStart: start, periodEnd: end, status: 'draft' } });
  },

  /** Finalized runs at the branch whose period overlaps [start, end]. */
  findOverlappingFinalized(branchId: string, start: Date, end: Date, client: Client = prisma) {
    return client.payrollRun.findMany({
      where: { branchId, status: 'finalized', periodStart: { lte: end }, periodEnd: { gte: start } },
    });
  },

  createRun(
    data: {
      branchId: string;
      periodStart: Date;
      periodEnd: Date;
      createdBy: string;
      revisionOfId?: string;
      revisionNumber?: number;
      revisionReason?: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.payrollRun.create({ data });
  },

  finalizeRun(runId: string, data: Prisma.PayrollRunUpdateManyMutationInput, tx: Prisma.TransactionClient) {
    return tx.payrollRun.updateMany({ where: { id: runId, status: 'draft' }, data: { ...data, status: 'finalized' } });
  },

  supersedeRun(runId: string, supersededById: string, tx: Prisma.TransactionClient) {
    return tx.payrollRun.updateMany({
      where: { id: runId, status: 'finalized' },
      data: { status: 'superseded', supersededAt: new Date(), supersededById },
    });
  },

  discardRun(runId: string, data: { discardedBy: string; discardReason: string }, tx: Prisma.TransactionClient) {
    return tx.payrollRun.updateMany({ where: { id: runId, status: 'draft' }, data: { status: 'discarded', discardedAt: new Date(), ...data } });
  },

  markPaid(runId: string, data: { paidBy: string; paidByName: string; paidReference: string | null }, tx: Prisma.TransactionClient) {
    return tx.payrollRun.updateMany({ where: { id: runId, status: 'finalized', paidAt: null }, data: { paidAt: new Date(), ...data } });
  },

  /** Bumps updated_at so a list view can see a draft changed (adjustment/resolution added). */
  touchRun(runId: string, tx: Prisma.TransactionClient) {
    return tx.payrollRun.updateMany({ where: { id: runId, status: 'draft' }, data: { updatedAt: new Date() } });
  },

  // ---------- lines / claims ----------

  createLines(data: Prisma.PayrollRunLineCreateManyInput[], tx: Prisma.TransactionClient) {
    return tx.payrollRunLine.createMany({ data });
  },

  listLines(runId: string, client: Client = prisma) {
    return client.payrollRunLine.findMany({ where: { runId }, orderBy: [{ employeeName: 'asc' }, { employeeId: 'asc' }] });
  },

  createClaims(data: Array<{ attendanceRecordId: string; runId: string; employeeId: string }>, tx: Prisma.TransactionClient) {
    return tx.payrollAttendanceClaim.createMany({ data });
  },

  releaseClaims(runId: string, tx: Prisma.TransactionClient) {
    return tx.payrollAttendanceClaim.updateMany({ where: { runId, releasedAt: null }, data: { releasedAt: new Date() } });
  },

  listClaims(runId: string, client: Client = prisma) {
    return client.payrollAttendanceClaim.findMany({ where: { runId } });
  },

  findActiveClaims(recordIds: string[], client: Client = prisma) {
    return client.payrollAttendanceClaim.findMany({ where: { attendanceRecordId: { in: recordIds }, releasedAt: null } });
  },

  // ---------- adjustments / resolutions ----------

  listAdjustments(runId: string, client: Client = prisma) {
    return client.payrollAdjustment.findMany({ where: { runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  },

  findAdjustment(adjustmentId: string, client: Client = prisma) {
    return client.payrollAdjustment.findUnique({ where: { id: adjustmentId } });
  },

  createAdjustment(
    data: {
      runId: string;
      employeeId: string;
      kind: PayrollAdjustmentKind;
      category: string;
      amount: string;
      reason: string;
      documentationRef: string | null;
      copiedFromId?: string | null;
      createdBy: string;
      createdByName: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.payrollAdjustment.create({ data });
  },

  voidAdjustment(adjustmentId: string, data: { voidedBy: string; voidReason: string }, tx: Prisma.TransactionClient) {
    return tx.payrollAdjustment.updateMany({ where: { id: adjustmentId, voidedAt: null }, data: { voidedAt: new Date(), ...data } });
  },

  listResolutions(runId: string, client: Client = prisma) {
    return client.payrollIssueResolution.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  },

  createResolution(
    data: { runId: string; issueKey: string; note: string; createdBy: string; createdByName: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.payrollIssueResolution.create({ data });
  },
};
