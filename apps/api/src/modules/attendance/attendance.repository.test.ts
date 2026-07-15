import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mocks lib/prisma.js directly (same technique as cash.repository.test.ts)
 * so each repository method's exact where/data shape can be asserted —
 * attendance.repository.ts is the only place in this module allowed to
 * touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    attendanceRecord: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    userBranchAssignment: {
      findFirst: vi.fn(),
    },
    branch: {
      findUnique: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { attendanceRepository } = await import('./attendance.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attendanceRepository.clockIn', () => {
  it('creates the attendance record with the exact clock-in fields', async () => {
    vi.mocked(prisma.attendanceRecord.create).mockResolvedValue({ id: 'record-1' } as never);

    const clockInServerTime = new Date('2026-07-15T08:00:00.000Z');
    await attendanceRepository.clockIn({
      employeeId: 'employee-1',
      branchId: 'branch-1',
      clockInServerTime,
      clockInGpsLat: 14.5995,
      clockInGpsLng: 120.9842,
      clockInGpsStatus: 'within_radius',
      clockInTimeFlag: false,
    });

    expect(prisma.attendanceRecord.create).toHaveBeenCalledWith({
      data: {
        employeeId: 'employee-1',
        branchId: 'branch-1',
        clockInServerTime,
        clockInGpsLat: 14.5995,
        clockInGpsLng: 120.9842,
        clockInGpsStatus: 'within_radius',
        clockInTimeFlag: false,
      },
    });
  });
});

describe('attendanceRepository.findActiveRecord', () => {
  it('scopes to an employee with an open (clockOutServerTime null) and non-deleted record', async () => {
    vi.mocked(prisma.attendanceRecord.findFirst).mockResolvedValue({ id: 'record-1' } as never);

    const result = await attendanceRepository.findActiveRecord('employee-1');

    expect(prisma.attendanceRecord.findFirst).toHaveBeenCalledWith({
      where: { employeeId: 'employee-1', clockOutServerTime: null, deletedAt: null },
      orderBy: { clockInServerTime: 'desc' },
    });
    expect(result).toEqual({ id: 'record-1' });
  });

  it('returns null when there is no open record', async () => {
    vi.mocked(prisma.attendanceRecord.findFirst).mockResolvedValue(null);

    const result = await attendanceRepository.findActiveRecord('employee-1');

    expect(result).toBeNull();
  });
});

describe('attendanceRepository.clockOut', () => {
  it('updates clockOutServerTime, coordinates, and computed minutes', async () => {
    vi.mocked(prisma.attendanceRecord.update).mockResolvedValue({ id: 'record-1' } as never);

    const clockOutServerTime = new Date('2026-07-15T17:00:00.000Z');
    await attendanceRepository.clockOut('record-1', {
      clockOutServerTime,
      clockOutGpsLat: 14.6,
      clockOutGpsLng: 120.98,
      breakMinutes: 60,
      actualWorkMinutes: 480,
      overtimeMinutes: 0,
    });

    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'record-1' },
      data: {
        clockOutServerTime,
        clockOutGpsLat: 14.6,
        clockOutGpsLng: 120.98,
        breakMinutes: 60,
        actualWorkMinutes: 480,
        overtimeMinutes: 0,
      },
    });
  });
});

describe('attendanceRepository.createOverride', () => {
  it('creates a correction row with correctedBy, correctionReason, originalRecordId, and status corrected', async () => {
    vi.mocked(prisma.attendanceRecord.create).mockResolvedValue({ id: 'record-2' } as never);

    const clockInServerTime = new Date('2026-07-15T08:00:00.000Z');
    await attendanceRepository.createOverride({
      employeeId: 'employee-1',
      branchId: 'branch-1',
      clockInServerTime,
      clockInDeviceTime: null,
      clockInGpsLat: 14.5995,
      clockInGpsLng: 120.9842,
      clockInGpsStatus: 'within_radius',
      clockInTimeFlag: false,
      clockOutServerTime: null,
      clockOutDeviceTime: null,
      clockOutGpsLat: null,
      clockOutGpsLng: null,
      breakMinutes: 60,
      actualWorkMinutes: null,
      overtimeMinutes: 0,
      correctedBy: 'supervisor-1',
      correctionReason: 'Employee forgot to clock in on time',
      originalRecordId: 'record-1',
    });

    expect(prisma.attendanceRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correctedBy: 'supervisor-1',
        correctionReason: 'Employee forgot to clock in on time',
        originalRecordId: 'record-1',
        status: 'corrected',
      }),
    });
  });
});

describe('attendanceRepository.softDelete', () => {
  it('sets deletedAt on the record', async () => {
    vi.mocked(prisma.attendanceRecord.update).mockResolvedValue({ id: 'record-1' } as never);

    await attendanceRepository.softDelete('record-1');

    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'record-1' },
      data: { deletedAt: expect.any(Date) },
    });
  });
});

describe('attendanceRepository.findByBranch', () => {
  it('excludes soft-deleted records and applies employee/date filters plus pagination', async () => {
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);

    await attendanceRepository.findByBranch('branch-1', {
      employeeId: 'employee-1',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-15T23:59:59.000Z'),
      page: 2,
      limit: 10,
    });

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: {
        branchId: 'branch-1',
        deletedAt: null,
        employeeId: 'employee-1',
        clockInServerTime: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-15T23:59:59.000Z') },
      },
      orderBy: { clockInServerTime: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(prisma.attendanceRecord.count).toHaveBeenCalledWith({
      where: {
        branchId: 'branch-1',
        deletedAt: null,
        employeeId: 'employee-1',
        clockInServerTime: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-15T23:59:59.000Z') },
      },
    });
  });

  it('omits employee/date filters from the where clause when not provided, but always excludes soft-deleted rows', async () => {
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);

    await attendanceRepository.findByBranch('branch-1', { page: 1, limit: 25 });

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: 'branch-1', deletedAt: null } }),
    );
  });
});

describe('attendanceRepository.findByEmployee', () => {
  it('scopes to one employee, excludes soft-deleted records, and applies pagination', async () => {
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);

    await attendanceRepository.findByEmployee('employee-1', { page: 1, limit: 25 });

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { employeeId: 'employee-1', deletedAt: null },
      orderBy: { clockInServerTime: 'desc' },
      skip: 0,
      take: 25,
    });
  });
});
