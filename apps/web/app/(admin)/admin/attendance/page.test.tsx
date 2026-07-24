import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';
import type { AttendanceListResponse, AttendanceResponse, BranchListResponse, BranchResponse, EmployeeListResponse, EmployeeResponse } from '@potato-corner/shared';
import AdminAttendancePage from './page';

const { mockUseAttendanceByBranch, mockUseAttendanceRealtimeSync, mockUseBranches, mockUseEmployees } = vi.hoisted(() => ({
  mockUseAttendanceByBranch: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseEmployees: vi.fn(),
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByBranch: mockUseAttendanceByBranch,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
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
    is_active: true,
    status: 'active',
    must_change_password: false,
    branch_assignments: [],
    last_login_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attendanceRecord(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    id: 'record-1',
    employee_id: 'employee-1',
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
    ...overrides,
  };
}

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [branch()], total: 1, page: 1, limit: 100, ...overrides };
}

function employeeListResponse(overrides: Partial<EmployeeListResponse> = {}): EmployeeListResponse {
  return { employees: [employee()], total: 1, page: 1, limit: 100, ...overrides };
}

function attendanceListResponse(overrides: Partial<AttendanceListResponse> = {}): AttendanceListResponse {
  return { records: [attendanceRecord()], total: 1, page: 1, limit: 25, ...overrides };
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
  mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function selectBranch(name = 'Main Branch') {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('AdminAttendancePage', () => {
  it('renders a select-a-branch empty state when no branch is selected', () => {
    render(<AdminAttendancePage />);

    expect(screen.getByText('Select a branch')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the DataTable and KPI cards once a branch is selected and data is returned', () => {
    mockUseAttendanceByBranch.mockReturnValue({ data: attendanceListResponse(), isLoading: false, isError: false, refetch: vi.fn() });

    render(<AdminAttendancePage />);
    selectBranch();

    expect(screen.getByText('Records This Page')).toBeInTheDocument();
    expect(screen.getByText('Currently Clocked In')).toBeInTheDocument();
    expect(screen.getByText('Corrections')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(within(table).getByText('Juan Dela Cruz')).toBeInTheDocument();
  });

  it('renders loading skeletons while attendance is loading', () => {
    mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });

    const { container } = render(<AdminAttendancePage />);
    selectBranch();

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders a "no records" empty state when the branch has no attendance records', () => {
    mockUseAttendanceByBranch.mockReturnValue({
      data: attendanceListResponse({ records: [], total: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<AdminAttendancePage />);
    selectBranch();

    expect(screen.getByText('No attendance records found for this period.')).toBeInTheDocument();
  });

  it('never renders any override button or dialog', () => {
    mockUseAttendanceByBranch.mockReturnValue({
      data: attendanceListResponse({ records: [attendanceRecord({ status: 'corrected', correction_reason: 'Forgot to clock out' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<AdminAttendancePage />);
    selectBranch();

    expect(screen.queryByRole('button', { name: /correct/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
  });
});
