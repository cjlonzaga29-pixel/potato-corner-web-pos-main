import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { attendanceResponseSchema } from '@potato-corner/shared';

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./attendance.repository.js', () => ({
  attendanceRepository: {
    findBranchAssignment: vi.fn(),
    findActiveRecord: vi.fn(),
    findBranchById: vi.fn(),
    findById: vi.fn(),
    clockIn: vi.fn(),
    clockOut: vi.fn(),
    createOverride: vi.fn(),
    softDelete: vi.fn(),
    findByBranch: vi.fn(),
    findByEmployee: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { attendanceRepository } = await import('./attendance.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { attendanceService } = await import('./attendance.service.js');

const STAFF = { id: 'employee-1', role: 'staff' };
const SUPERVISOR = { id: 'supervisor-1', role: 'supervisor' };

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

function attendanceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'record-1',
    employeeId: 'employee-1',
    branchId: 'branch-1',
    clockInServerTime: new Date('2026-07-15T08:00:00.000Z'),
    clockInDeviceTime: null,
    clockInGpsLat: decimal(14.5995),
    clockInGpsLng: decimal(120.9842),
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
    createdAt: new Date('2026-07-15T08:00:00.000Z'),
    ...overrides,
  };
}

function branchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'branch-1',
    gpsLatitude: decimal(14.5995),
    gpsLongitude: decimal(120.9842),
    gpsRadiusMeters: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attendanceService.clockIn', () => {
  it('creates the record when the employee is assigned to the branch and has no open record', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow() as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow() as never);

    const result = await attendanceService.clockIn(
      { employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 },
      STAFF,
    );

    expect(result.id).toBe('record-1');
    expect(result.clock_in_gps_status).toBe('within_radius');
    expect(attendanceRepository.clockIn).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'employee-1', branchId: 'branch-1', clockInGpsStatus: 'within_radius' }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CLOCKED_IN', entityId: 'record-1' }));
  });

  it('broadcasts ATTENDANCE_CLOCKED_IN to the branch room and Super Admin with a payload matching attendanceResponseSchema', async () => {
    const recordId = randomUUID();
    const employeeId = randomUUID();
    const branchId = randomUUID();
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow({ id: branchId }) as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow({ id: recordId, employeeId, branchId }) as never);

    const result = await attendanceService.clockIn({ employeeId, branchId, gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF);

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'attendance:clocked_in', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('attendance:clocked_in', result);
    expect(attendanceResponseSchema.safeParse(result).success).toBe(true);
  });

  it('marks the clock-in outside_radius when the GPS coordinates are outside the branch geofence', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(branchRow({ gpsRadiusMeters: 100 }) as never);
    vi.mocked(attendanceRepository.clockIn).mockResolvedValue(attendanceRow({ clockInGpsStatus: 'outside_radius' }) as never);

    await attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 15.5, gpsLng: 121.5 }, STAFF);

    expect(attendanceRepository.clockIn).toHaveBeenCalledWith(expect.objectContaining({ clockInGpsStatus: 'outside_radius' }));
  });

  it('rejects with 403 EMPLOYEE_NOT_ASSIGNED_TO_BRANCH when the employee has no assignment at the branch', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue(null);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_ASSIGNED_TO_BRANCH', statusCode: 403 });
    expect(attendanceRepository.clockIn).not.toHaveBeenCalled();
  });

  it('rejects with 409 ALREADY_CLOCKED_IN when the employee already has an open record', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(attendanceRow() as never);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN', statusCode: 409 });
    expect(attendanceRepository.clockIn).not.toHaveBeenCalled();
  });

  it('rejects with 404 BRANCH_NOT_FOUND when the branch does not exist', async () => {
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findBranchById).mockResolvedValue(null);

    await expect(
      attendanceService.clockIn({ employeeId: 'employee-1', branchId: 'branch-1', gpsLat: 14.5995, gpsLng: 120.9842 }, STAFF),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', statusCode: 404 });
  });
});

describe('attendanceService.clockOut', () => {
  it('updates the open record with computed work/overtime minutes', async () => {
    const active = attendanceRow({ clockInServerTime: new Date('2026-07-15T08:00:00.000Z'), breakMinutes: 60 });
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(active as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(
      attendanceRow({ clockOutServerTime: new Date('2026-07-15T17:00:00.000Z'), actualWorkMinutes: 480, breakMinutes: 60 }) as never,
    );

    const result = await attendanceService.clockOut('employee-1', {}, STAFF);

    expect(attendanceRepository.clockOut).toHaveBeenCalledWith(
      'record-1',
      expect.objectContaining({ breakMinutes: 60, clockOutServerTime: expect.any(Date) }),
    );
    expect(result.clock_out_server_time).not.toBeNull();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CLOCKED_OUT' }));
  });

  it('broadcasts ATTENDANCE_CLOCKED_OUT to the branch room and Super Admin with a payload matching attendanceResponseSchema', async () => {
    const recordId = randomUUID();
    const employeeId = randomUUID();
    const branchId = randomUUID();
    const active = attendanceRow({ id: recordId, employeeId, branchId, clockInServerTime: new Date('2026-07-15T08:00:00.000Z'), breakMinutes: 60 });
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(active as never);
    vi.mocked(attendanceRepository.clockOut).mockResolvedValue(
      attendanceRow({
        id: recordId,
        employeeId,
        branchId,
        clockOutServerTime: new Date('2026-07-15T17:00:00.000Z'),
        actualWorkMinutes: 480,
        breakMinutes: 60,
      }) as never,
    );

    const result = await attendanceService.clockOut(employeeId, {}, STAFF);

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'attendance:clocked_out', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('attendance:clocked_out', result);
    expect(attendanceResponseSchema.safeParse(result).success).toBe(true);
  });

  it('rejects with 404 RECORD_NOT_FOUND when there is no open record', async () => {
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);

    await expect(attendanceService.clockOut('employee-1', {}, STAFF)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
      statusCode: 404,
    });
    expect(attendanceRepository.clockOut).not.toHaveBeenCalled();
  });
});

describe('attendanceService.manualOverride', () => {
  it('creates a correction record and soft-deletes the original', async () => {
    const original = attendanceRow();
    vi.mocked(attendanceRepository.findById).mockResolvedValue(original as never);
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue({ id: 'assignment-1' } as never);
    vi.mocked(attendanceRepository.createOverride).mockResolvedValue(
      attendanceRow({ id: 'record-2', status: 'corrected', correctedBy: 'supervisor-1', originalRecordId: 'record-1' }) as never,
    );
    vi.mocked(attendanceRepository.softDelete).mockResolvedValue(attendanceRow({ deletedAt: new Date() }) as never);

    const result = await attendanceService.manualOverride(
      'record-1',
      { correctionReason: 'Employee clocked in on the wrong device' },
      SUPERVISOR,
    );

    expect(result.id).toBe('record-2');
    expect(result.status).toBe('corrected');
    expect(attendanceRepository.createOverride).toHaveBeenCalledWith(
      expect.objectContaining({ correctedBy: 'supervisor-1', correctionReason: 'Employee clocked in on the wrong device', originalRecordId: 'record-1' }),
    );
    expect(attendanceRepository.softDelete).toHaveBeenCalledWith('record-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_CORRECTED' }));
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTENDANCE_ORIGINAL_SOFT_DELETED' }));
  });

  it('rejects with 404 RECORD_NOT_FOUND for an unknown originalRecordId', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(null);

    await expect(
      attendanceService.manualOverride('missing-record', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND', statusCode: 404 });
    expect(attendanceRepository.createOverride).not.toHaveBeenCalled();
  });

  it('rejects with 404 RECORD_NOT_FOUND when the original record is already soft-deleted', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(attendanceRow({ deletedAt: new Date() }) as never);

    await expect(
      attendanceService.manualOverride('record-1', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND', statusCode: 404 });
  });

  it('rejects with 403 BRANCH_ACCESS_DENIED when the supervisor is not assigned to the branch', async () => {
    vi.mocked(attendanceRepository.findById).mockResolvedValue(attendanceRow() as never);
    vi.mocked(attendanceRepository.findBranchAssignment).mockResolvedValue(null);

    await expect(
      attendanceService.manualOverride('record-1', { correctionReason: 'Some correction reason' }, SUPERVISOR),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
    expect(attendanceRepository.createOverride).not.toHaveBeenCalled();
  });
});
