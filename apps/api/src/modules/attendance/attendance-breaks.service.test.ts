import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { attendanceResponseSchema, attendanceSummaryResponseSchema } from '@potato-corner/shared';

/**
 * POS-PERF-P51 — break intervals: Start Break / Resume Work, clock-out while
 * on break, the time accounting, the correction guard and the supervisor
 * summary. Same mocking technique as attendance.service.test.ts (repository
 * fully mocked, $transaction just runs the callback with a stand-in tx).
 * Real-database behavior (lock, partial unique index, concurrency) is in
 * attendance-breaks.integration.test.ts.
 */
vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));
vi.mock('../../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./attendance.repository.js', () => ({
  attendanceRepository: {
    findActiveRecord: vi.fn(),
    findById: vi.fn(),
    findBreaks: vi.fn(),
    createBreak: vi.fn(),
    closeBreak: vi.fn(),
    findByIdWithBreaks: vi.fn(),
    clockOut: vi.fn(),
    findBranchAssignment: vi.fn(),
    findSummaryRows: vi.fn(),
    createOverride: vi.fn(),
    softDelete: vi.fn(),
  },
}));
const txClient = vi.hoisted(() => ({ $executeRaw: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(txClient)) },
}));
vi.mock('../cash/cash.repository.js', () => ({ cashRepository: { findActiveShift: vi.fn().mockResolvedValue(null) } }));
vi.mock('../cash/cash.service.js', () => ({ cashService: { autoCloseShift: vi.fn(), autoOpenShift: vi.fn() } }));
vi.mock('../settings/settings.service.js', () => ({ settingsService: { getRegularShiftMinutes: vi.fn().mockResolvedValue(480) } }));
vi.mock('../branches/branches.repository.js', () => ({ branchesRepository: {} }));

const { attendanceRepository } = await import('./attendance.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { notifyBranch } = await import('../../lib/notify.js');
const { attendanceService, computeAttendanceTimes } = await import('./attendance.service.js');

const EMPLOYEE = 'b2aec361-de9d-47f8-afec-21ab5d3d99a3';
const BRANCH = '387522f6-8da8-4bc0-8e94-a993dba8af6d';
const OTHER_BRANCH = '4cad3611-4386-4023-9bad-c73636115d32';
const RECORD = '0e1c9a04-5a7b-4b45-9d0d-0c3c5c2f8a11';
const ACTOR = { id: EMPLOYEE, role: 'staff' };

function at(iso: string): Date {
  return new Date(iso);
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD,
    employeeId: EMPLOYEE,
    branchId: BRANCH,
    clockInServerTime: at('2026-10-30T00:00:00.000Z'), // 08:00 Manila
    clockInDeviceTime: null,
    clockInGpsLat: null,
    clockInGpsLng: null,
    clockInGpsStatus: 'within_radius',
    clockInTimeFlag: false,
    clockOutServerTime: null,
    clockOutDeviceTime: null,
    clockOutGpsLat: null,
    clockOutGpsLng: null,
    breakMinutes: 0,
    actualWorkMinutes: null,
    overtimeMinutes: 0,
    status: 'present',
    correctionReason: null,
    correctedBy: null,
    originalRecordId: null,
    deletedAt: null,
    createdAt: at('2026-10-30T00:00:00.000Z'),
    breaks: [],
    ...overrides,
  };
}

function interval(id: string, startedAt: string, endedAt: string | null, endReason: 'resumed' | 'clock_out' | null = endedAt ? 'resumed' : null) {
  return { id, startedAt: at(startedAt), endedAt: endedAt ? at(endedAt) : null, endReason };
}

const BREAK_1 = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const BREAK_2 = '7a2e3b4c-5d6e-4f70-9a1b-2c3d4e5f6a7b';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('computeAttendanceTimes (server-side accounting)', () => {
  it('open record with no breaks: working, all elapsed time is work', () => {
    const t = computeAttendanceTimes(record(), at('2026-10-30T02:00:00.000Z'));
    expect(t.state).toBe('working');
    expect(t.breakMs).toBe(0);
    expect(t.workMs).toBe(2 * 3600_000);
  });

  it('open break counts up to now and makes the state on_break', () => {
    const t = computeAttendanceTimes(
      record({ breaks: [interval(BREAK_1, '2026-10-30T01:00:00.000Z', null)] }),
      at('2026-10-30T01:20:00.000Z'),
    );
    expect(t.state).toBe('on_break');
    expect(t.openBreakStartedAt?.toISOString()).toBe('2026-10-30T01:00:00.000Z');
    expect(t.breakMs).toBe(20 * 60_000);
    expect(t.workMs).toBe(60 * 60_000);
  });

  it('closed record: work = elapsed − sum of intervals, measured to the clock-out', () => {
    const t = computeAttendanceTimes(
      record({
        clockOutServerTime: at('2026-10-30T09:00:00.000Z'),
        breaks: [interval(BREAK_1, '2026-10-30T03:00:00.000Z', '2026-10-30T03:45:00.000Z'), interval(BREAK_2, '2026-10-30T06:00:00.000Z', '2026-10-30T06:15:00.000Z')],
      }),
      at('2026-10-31T00:00:00.000Z'),
    );
    expect(t.state).toBe('clocked_out');
    expect(t.breakMs).toBe(60 * 60_000);
    expect(t.workMs).toBe(8 * 3600_000);
  });

  it('overnight shift with a break spanning Manila midnight is measured as plain elapsed time', () => {
    // 22:00 → 07:00 Manila (14:00Z → 23:00Z), break 23:40 → 00:25 Manila.
    const t = computeAttendanceTimes(
      record({
        clockInServerTime: at('2026-10-30T14:00:00.000Z'),
        clockOutServerTime: at('2026-10-30T23:00:00.000Z'),
        breaks: [interval(BREAK_1, '2026-10-30T15:40:00.000Z', '2026-10-30T16:25:00.000Z')],
      }),
      at('2026-10-31T01:00:00.000Z'),
    );
    expect(t.breakMs).toBe(45 * 60_000);
    expect(t.workMs).toBe(9 * 3600_000 - 45 * 60_000);
  });

  it('a record with no intervals (pre-P51 history / correction) uses its stored break_minutes — never a fabricated interval', () => {
    const t = computeAttendanceTimes(
      record({ clockOutServerTime: at('2026-10-30T09:00:00.000Z'), breakMinutes: 60 }),
      at('2026-10-31T00:00:00.000Z'),
    );
    expect(t.breakMs).toBe(60 * 60_000);
    expect(t.workMs).toBe(8 * 3600_000);
  });
});

describe('attendanceService.startBreak', () => {
  it('records the break with a server timestamp under the per-employee lock, then audits and notifies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-30T04:00:00.000Z'));
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([]);
    vi.mocked(attendanceRepository.createBreak).mockResolvedValue({ id: BREAK_1 } as never);
    vi.mocked(attendanceRepository.findByIdWithBreaks).mockResolvedValue(
      record({ breaks: [interval(BREAK_1, '2026-10-30T04:00:00.000Z', null)] }) as never,
    );

    const result = await attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR);

    expect(txClient.$executeRaw).toHaveBeenCalled();
    expect(attendanceRepository.createBreak).toHaveBeenCalledWith(
      { attendanceRecordId: RECORD, startedAt: at('2026-10-30T04:00:00.000Z'), startedBy: EMPLOYEE },
      txClient,
    );
    expect(result.attendance_state).toBe('on_break');
    expect(result.current_break_started_at).toBe('2026-10-30T04:00:00.000Z');
    expect(result.clock_out_server_time).toBeNull();
    expect(attendanceResponseSchema.safeParse(result).success).toBe(true);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_BREAK_STARTED', entityId: BREAK_1 }));
    expect(notifyBranch).toHaveBeenCalledWith(BRANCH, 'attendance:break_started', result);
  });

  it('a repeated Start Break finds the open break and returns 409 ALREADY_ON_BREAK without creating a second interval', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T04:00:00.000Z', null)] as never);

    await expect(attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({
      code: 'ALREADY_ON_BREAK',
      statusCode: 409,
      details: { break_id: BREAK_1, started_at: '2026-10-30T04:00:00.000Z' },
    });
    expect(attendanceRepository.createBreak).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('the database partial unique index (P2002) is also reported as ALREADY_ON_BREAK', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([]);
    vi.mocked(attendanceRepository.createBreak).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({ code: 'ALREADY_ON_BREAK' });
  });

  it('refuses when not clocked in, or clocked in at a different branch (409 NOT_CLOCKED_IN)', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    await expect(attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({ code: 'NOT_CLOCKED_IN' });

    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record({ branchId: OTHER_BRANCH }) as never);
    await expect(attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({ code: 'NOT_CLOCKED_IN' });
    expect(attendanceRepository.createBreak).not.toHaveBeenCalled();
  });

  it('never starts a new break before the previous one ended (no overlap even with clock differences between API instances)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-30T04:59:59.000Z'));
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T04:00:00.000Z', '2026-10-30T05:00:00.000Z')] as never);
    vi.mocked(attendanceRepository.createBreak).mockResolvedValue({ id: BREAK_2 } as never);
    vi.mocked(attendanceRepository.findByIdWithBreaks).mockResolvedValue(record() as never);

    await attendanceService.startBreak(EMPLOYEE, BRANCH, ACTOR);

    expect(vi.mocked(attendanceRepository.createBreak).mock.calls[0]?.[0].startedAt).toEqual(at('2026-10-30T05:00:00.000Z'));
  });
});

describe('attendanceService.endBreak (Resume Work)', () => {
  it('closes the open break as resumed on the same record — no new clock-in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-30T04:30:00.000Z'));
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T04:00:00.000Z', null)] as never);
    vi.mocked(attendanceRepository.closeBreak).mockResolvedValue(1);
    vi.mocked(attendanceRepository.findByIdWithBreaks).mockResolvedValue(
      record({ breaks: [interval(BREAK_1, '2026-10-30T04:00:00.000Z', '2026-10-30T04:30:00.000Z')] }) as never,
    );

    const result = await attendanceService.endBreak(EMPLOYEE, BRANCH, ACTOR);

    expect(attendanceRepository.closeBreak).toHaveBeenCalledWith(
      BREAK_1,
      { endedAt: at('2026-10-30T04:30:00.000Z'), endedBy: EMPLOYEE, endReason: 'resumed' },
      txClient,
    );
    expect(result.id).toBe(RECORD);
    expect(result.attendance_state).toBe('working');
    expect(result.elapsed_break_seconds).toBe(30 * 60);
    expect(result.elapsed_work_seconds).toBe(4 * 3600);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_BREAK_ENDED', entityId: BREAK_1 }));
  });

  it('a repeated Resume (first one already committed) gets 409 NOT_ON_BREAK and writes nothing', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T04:00:00.000Z', '2026-10-30T04:30:00.000Z')] as never);

    await expect(attendanceService.endBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({ code: 'NOT_ON_BREAK', statusCode: 409 });
    expect(attendanceRepository.closeBreak).not.toHaveBeenCalled();
  });

  it('a concurrent close that already won (0 rows changed) is NOT_ON_BREAK, not a second end', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T04:00:00.000Z', null)] as never);
    vi.mocked(attendanceRepository.closeBreak).mockResolvedValue(0);

    await expect(attendanceService.endBreak(EMPLOYEE, BRANCH, ACTOR)).rejects.toMatchObject({ code: 'NOT_ON_BREAK' });
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

describe('attendanceService.clockOut while on break', () => {
  it('closes the open break and the attendance record at the same server timestamp, break minutes from the intervals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-30T09:00:00.000Z'));
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record() as never);
    const breaks = [interval(BREAK_1, '2026-10-30T03:00:00.000Z', '2026-10-30T03:30:00.000Z'), interval(BREAK_2, '2026-10-30T08:30:00.000Z', null)];
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue(breaks as never);
    vi.mocked(attendanceRepository.closeBreak).mockResolvedValue(1);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(record({ clockOutServerTime: at('2026-10-30T09:00:00.000Z') }) as never);

    // A legacy client-sent break_minutes is ignored once real intervals exist.
    await attendanceService.clockOut(EMPLOYEE, { breakMinutes: 5 }, ACTOR);

    expect(attendanceRepository.closeBreak).toHaveBeenCalledWith(
      BREAK_2,
      { endedAt: at('2026-10-30T09:00:00.000Z'), endedBy: EMPLOYEE, endReason: 'clock_out' },
      txClient,
    );
    expect(attendanceRepository.clockOut).toHaveBeenCalledWith(
      RECORD,
      expect.objectContaining({
        clockOutServerTime: at('2026-10-30T09:00:00.000Z'),
        breakMinutes: 60,
        actualWorkMinutes: 480,
        overtimeMinutes: 0,
      }),
      txClient,
    );
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_BREAK_ENDED', entityId: BREAK_2 }));
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CLOCKED_OUT' }));
  });

  it('a second, concurrent clock-out finds nothing open under the lock and gets 404 instead of overwriting the first', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValueOnce(record() as never).mockResolvedValueOnce(null);

    await expect(attendanceService.clockOut(EMPLOYEE, {}, ACTOR)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND', statusCode: 404 });
    expect(attendanceRepository.clockOut).not.toHaveBeenCalled();
  });

  it('overnight clock-out with an earlier break: durations across midnight are exact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-30T23:00:00.000Z')); // 07:00 Manila next day
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(record({ clockInServerTime: at('2026-10-30T14:00:00.000Z') }) as never);
    vi.mocked(attendanceRepository.findBreaks).mockResolvedValue([interval(BREAK_1, '2026-10-30T15:40:00.000Z', '2026-10-30T16:25:00.000Z')] as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(record({ clockOutServerTime: at('2026-10-30T23:00:00.000Z') }) as never);

    await attendanceService.clockOut(EMPLOYEE, {}, ACTOR);

    expect(attendanceRepository.closeBreak).not.toHaveBeenCalled();
    expect(vi.mocked(attendanceRepository.clockOut).mock.calls[0]?.[1]).toMatchObject({ breakMinutes: 45, actualWorkMinutes: 495, overtimeMinutes: 15 });
  });
});

describe('attendanceService.manualOverride with an open break', () => {
  it('refuses to correct a record whose break is still open (409 BREAK_IN_PROGRESS), writing nothing', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(record({ breaks: [interval(BREAK_1, '2026-10-30T04:00:00.000Z', null)] }) as never);

    await expect(
      attendanceService.manualOverride(RECORD, { correctionReason: 'Fix the clock-in time please' }, { id: 'sup', role: 'supervisor' }),
    ).rejects.toMatchObject({ code: 'BREAK_IN_PROGRESS', statusCode: 409 });
    expect(attendanceRepository.createOverride).not.toHaveBeenCalled();
    expect(attendanceRepository.softDelete).not.toHaveBeenCalled();
  });
});

// POS-PERF-P54 — the correction row has no intervals, so payroll falls back to
// its break_minutes; it must carry the recorded break time, not the 0 an
// open record holds before clock-out.
describe('attendanceService.manualOverride carries recorded break time', () => {
  const SUPERVISOR = { id: 'sup', role: 'supervisor' };
  beforeEach(() => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment' } as never);
    // Only the arguments are asserted; the returned row just has to be a valid record.
    vi.mocked(attendanceRepository.createOverride).mockResolvedValue(record({ originalRecordId: RECORD }) as never);
  });

  it('a forgotten clock-out with resumed breaks keeps their total (open record stores 0 until clock-out)', async () => {
    const breaks = [interval(BREAK_1, '2026-10-30T03:00:00.000Z', '2026-10-30T03:45:00.000Z'), interval(BREAK_2, '2026-10-30T06:00:00.000Z', '2026-10-30T06:15:00.000Z')];
    vi.mocked(attendanceRepository.findById).mockResolvedValue(record({ breaks }) as never);

    await attendanceService.manualOverride(RECORD, { correctionReason: 'forgot to clock out', clockOutServerTime: at('2026-10-30T09:00:00.000Z') }, SUPERVISOR);

    expect(vi.mocked(attendanceRepository.createOverride).mock.calls[0]?.[0]).toMatchObject({ breakMinutes: 60, actualWorkMinutes: 480 });
  });

  it('only the part of a break inside the corrected shift counts; an explicit break_minutes still wins', async () => {
    const breaks = [interval(BREAK_1, '2026-10-30T07:30:00.000Z', '2026-10-30T08:30:00.000Z')];
    vi.mocked(attendanceRepository.findById).mockResolvedValue(record({ clockOutServerTime: at('2026-10-30T09:00:00.000Z'), breakMinutes: 60, breaks }) as never);

    await attendanceService.manualOverride(RECORD, { correctionReason: 'left at 16:00', clockOutServerTime: at('2026-10-30T08:00:00.000Z') }, SUPERVISOR);
    expect(vi.mocked(attendanceRepository.createOverride).mock.calls[0]?.[0]).toMatchObject({ breakMinutes: 30 });

    await attendanceService.manualOverride(RECORD, { correctionReason: 'break was 10 min', breakMinutes: 10 }, SUPERVISOR);
    expect(vi.mocked(attendanceRepository.createOverride).mock.calls[1]?.[0]).toMatchObject({ breakMinutes: 10 });
  });

  it('a record without intervals keeps its stored legacy break_minutes', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(record({ clockOutServerTime: at('2026-10-30T09:00:00.000Z'), breakMinutes: 45 }) as never);

    await attendanceService.manualOverride(RECORD, { correctionReason: 'fix clock-in', clockInServerTime: at('2026-10-30T00:30:00.000Z') }, SUPERVISOR);

    expect(vi.mocked(attendanceRepository.createOverride).mock.calls[0]?.[0]).toMatchObject({ breakMinutes: 45 });
  });
});

describe('attendanceService.getBranchSummary — On Break shown separately', () => {
  it('keeps on-break staff in clocked_in (KPI reconciliation) but marks them and counts them', async () => {
    const employee = { firstName: 'Ana', lastName: 'Reyes', isActive: true, status: 'active', branchAssignments: [{ id: 'a' }] };
    vi.mocked(attendanceRepository.findSummaryRows).mockResolvedValue({
      open: [
        { id: RECORD, employeeId: EMPLOYEE, clockInServerTime: at('2026-10-30T00:00:00.000Z'), clockInGpsStatus: 'within_radius', employee, breaks: [{ startedAt: at('2026-10-30T04:00:00.000Z') }] },
        {
          id: '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b',
          employeeId: '29071825-11f1-4ebe-b0fc-c58c091a320e',
          clockInServerTime: at('2026-10-30T01:00:00.000Z'),
          clockInGpsStatus: 'within_radius',
          employee: { ...employee, firstName: 'Ben', lastName: 'Cruz' },
          breaks: [],
        },
      ],
      closedToday: [],
    } as never);

    const summary = await attendanceService.getBranchSummary(BRANCH, at('2026-10-30T05:00:00.000Z'));

    expect(summary.clocked_in).toHaveLength(2);
    expect(summary.on_break_count).toBe(1);
    expect(summary.clocked_in.find((r) => r.employee_name === 'Ana Reyes')).toMatchObject({ attendance_state: 'on_break', break_started_at: '2026-10-30T04:00:00.000Z' });
    expect(summary.clocked_in.find((r) => r.employee_name === 'Ben Cruz')).toMatchObject({ attendance_state: 'working', break_started_at: null });
    expect(attendanceSummaryResponseSchema.safeParse(summary).success).toBe(true);
  });
});
