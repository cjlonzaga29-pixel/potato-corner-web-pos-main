import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';
import type { BranchListResponse, BranchResponse, EmployeeListResponse, EmployeeResponse } from '@potato-corner/shared';
import type { AdminAttendanceRecord, AdminAttendanceResponse } from '@/hooks/queries/use-attendance';
import AdminAttendancePage from './page';

const { mockUseAdminAttendance, mockUseAttendanceRealtimeSync, mockUseBranches, mockUseAllBranchStats, mockUseEmployees, mockUseAllSupervisors } = vi.hoisted(
  () => ({
    mockUseAdminAttendance: vi.fn(),
    mockUseAttendanceRealtimeSync: vi.fn(),
    mockUseBranches: vi.fn(),
    mockUseAllBranchStats: vi.fn(),
    mockUseEmployees: vi.fn(),
    mockUseAllSupervisors: vi.fn(),
  }),
);

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAdminAttendance: mockUseAdminAttendance,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
  useAllBranchStats: mockUseAllBranchStats,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
  useAllSupervisors: mockUseAllSupervisors,
}));

/**
 * The real Select is Radix-based (portals, pointer-capture) and has no
 * jsdom-friendly interaction path without @testing-library/user-event, which
 * isn't a project dependency. Standing it up as a flat, always-rendered
 * button list keeps the branch/employee pickers testable via plain
 * fireEvent.click while leaving the real component untouched.
 */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});

  function Select({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Main Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal St',
    city: 'Manila',
    gpsLatitude: 14.5995,
    gpsLongitude: 120.9842,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 1,
    activeStaffCount: 5,
    currentStatusLabel: 'Open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function employee(overrides: Partial<EmployeeResponse> = {}): EmployeeResponse {
  return {
    id: 'employee-1',
    email: 'juan@potatocorner.test',
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    phone: null,
    role: 'staff',
    employment_type: 'regular',
    employee_id: 'PC-EMP-000001',
    position: 'Cashier',
    notes: null,
    is_active: true,
    status: 'active',
    must_change_password: false,
    branch_assignments: [],
    last_login_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attendanceRecord(overrides: Partial<AdminAttendanceRecord> = {}): AdminAttendanceRecord {
  return {
    id: 'record-1',
    employee_id: 'employee-1',
    employee_name: 'Juan Dela Cruz',
    employee_code: null,
    employee_status: null,
    branch_id: 'branch-1',
    clock_in_server_time: '2026-07-15T08:00:00.000Z',
    clock_in_gps_lat: 14.5995,
    clock_in_gps_lng: 120.9842,
    clock_in_gps_status: 'within_radius',
    clock_in_time_flag: false,
    clock_out_server_time: '2026-07-15T17:00:00.000Z',
    clock_out_gps_lat: 14.6,
    clock_out_gps_lng: 120.98,
    break_minutes: 60,
    actual_work_minutes: 480,
    overtime_minutes: 0,
    status: 'present',
    correction_reason: null,
    corrected_by: null,
    original_record_id: null,
    created_at: '2026-07-15T08:00:00.000Z',
    branch_name: 'Main Branch',
    counts_toward_clocked_in: null,
    ...overrides,
  };
}

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [branch()], total: 1, page: 1, limit: 100, ...overrides };
}

function employeeListResponse(overrides: Partial<EmployeeListResponse> = {}): EmployeeListResponse {
  return { employees: [employee()], total: 1, page: 1, limit: 100, ...overrides };
}

function attendanceListResponse(overrides: Partial<AdminAttendanceResponse> = {}): AdminAttendanceResponse {
  return {
    records: [attendanceRecord()],
    total: 1,
    page: 1,
    limit: 25,
    scope: { branch_ids: null, supervisor: null, open_only: false },
    ...overrides,
  };
}

function attendanceQuery(data: AdminAttendanceResponse | undefined, extra: { isLoading?: boolean; isError?: boolean } = {}) {
  return { data, isLoading: false, isError: false, refetch: vi.fn(), ...extra };
}

/** The filters the page last asked useAdminAttendance for. */
function lastFilters() {
  const calls = mockUseAdminAttendance.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

// NumberTicker (inside KpiCard) calls Framer Motion's useInView, which
// requires IntersectionObserver — not implemented in jsdom.
beforeEach(() => {
  // @ts-expect-error jsdom has no IntersectionObserver; stub it so KpiCard's NumberTicker doesn't throw on mount.
  window.IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = () => [];
  };

  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockUseBranches.mockReturnValue({ data: branchListResponse(), isLoading: false });
  mockUseEmployees.mockReturnValue({ data: employeeListResponse() });
  mockUseAllSupervisors.mockReturnValue({
    data: [employee({ id: 'sup-1', first_name: 'Sara', last_name: 'Santos', role: 'supervisor' })],
    isLoading: false,
  });
  mockUseAllBranchStats.mockReturnValue({ data: [{ branchId: 'branch-1', staffTimedInCount: 2 }] });
  mockUseAdminAttendance.mockReturnValue(attendanceQuery(attendanceListResponse()));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminAttendancePage', () => {
  it('shows every branch by default (no branch has to be picked first)', () => {
    render(<AdminAttendancePage />);

    expect(lastFilters()).toMatchObject({ branch_id: undefined, supervisor_id: undefined, open_only: false });
    expect(screen.getByText(/All branches · .* \(by clock-in, Manila time\)/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(within(table).getByText('Main Branch')).toBeInTheDocument();
  });

  it('renders the KPI cards and the employee role once a branch is chosen', () => {
    render(<AdminAttendancePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    expect(lastFilters()).toMatchObject({ branch_id: 'branch-1' });
    for (const title of ['Records This Page', 'Currently Clocked In', 'Corrections', 'Worked Hours', 'Regular Hours', 'Overtime Hours']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(within(screen.getByRole('table')).getByText('staff')).toBeInTheDocument();
  });

  it("filters by supervisor and states that supervisor's current branches as the scope", () => {
    mockUseAdminAttendance.mockReturnValue(
      attendanceQuery(
        attendanceListResponse({ scope: { branch_ids: ['branch-1'], supervisor: { id: 'sup-1', name: 'Sara Santos', branch_ids: ['branch-1'] }, open_only: false } }),
      ),
    );

    render(<AdminAttendancePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Sara Santos' }));

    expect(lastFilters()).toMatchObject({ supervisor_id: 'sup-1' });
    expect(screen.getByText(/Sara Santos's current branches \(Main Branch\)/)).toBeInTheDocument();
  });

  it('"Clocked in now" asks for open records of any start date and reconciles with the dashboard figure', () => {
    mockUseAdminAttendance.mockReturnValue(
      attendanceQuery(
        attendanceListResponse({
          records: [
            attendanceRecord({ id: 'open-1', clock_out_server_time: null, counts_toward_clocked_in: true }),
            attendanceRecord({ id: 'open-2', clock_out_server_time: null, counts_toward_clocked_in: false }),
          ],
          total: 2,
          scope: { branch_ids: null, supervisor: null, open_only: true },
        }),
      ),
    );

    render(<AdminAttendancePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Clocked in now' }));

    expect(lastFilters()).toMatchObject({ open_only: true });
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.getByText(/everyone still clocked in, any start date/)).toBeInTheDocument();
    const note = screen.getByText(/Staff Clocked In" for this scope/);
    expect(note).toHaveTextContent('for this scope: 2.');
    expect(note).toHaveTextContent('1 count toward it and 1 do not');
  });

  it('renders loading skeletons while attendance is loading', () => {
    mockUseAdminAttendance.mockReturnValue(attendanceQuery(undefined, { isLoading: true }));

    const { container } = render(<AdminAttendancePage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders a "no records" empty state for the scope', () => {
    mockUseAdminAttendance.mockReturnValue(attendanceQuery(attendanceListResponse({ records: [], total: 0 })));

    render(<AdminAttendancePage />);

    expect(screen.getByText('No attendance records found for this scope and period.')).toBeInTheDocument();
  });

  it('never renders any override button or dialog', () => {
    mockUseAdminAttendance.mockReturnValue(
      attendanceQuery(attendanceListResponse({ records: [attendanceRecord({ status: 'corrected', correction_reason: 'Forgot to clock out' })] })),
    );

    render(<AdminAttendancePage />);

    expect(screen.queryByRole('button', { name: /correct/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
  });
});
