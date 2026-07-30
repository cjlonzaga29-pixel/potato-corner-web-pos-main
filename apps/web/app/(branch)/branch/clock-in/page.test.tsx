import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ClockInPage from './page';

const { mockPush, mockUseAuth, mockUseAttendanceByEmployee, mockUseClockIn, mockUseClockOut, mockClockInMutateAsync, mockClockOutMutateAsync } =
  vi.hoisted(() => ({
    mockPush: vi.fn(),
    mockUseAuth: vi.fn(),
    mockUseAttendanceByEmployee: vi.fn(),
    mockUseClockIn: vi.fn(),
    mockUseClockOut: vi.fn(),
    mockClockInMutateAsync: vi.fn(),
    mockClockOutMutateAsync: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByEmployee: mockUseAttendanceByEmployee,
  useClockIn: mockUseClockIn,
  useClockOut: mockUseClockOut,
}));

function mockGeolocationSuccess() {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (success: PositionCallback) =>
        success({ coords: { latitude: 14.5, longitude: 121.0 } } as GeolocationPosition),
    },
  });
}

beforeEach(() => {
  mockUseAuth.mockReturnValue({ user: { id: 'employee-1', branchIds: ['branch-1'] } });
  mockClockInMutateAsync.mockResolvedValue({ id: 'attendance-1' });
  mockClockOutMutateAsync.mockResolvedValue({ id: 'attendance-1' });
  mockUseClockIn.mockReturnValue({ mutateAsync: mockClockInMutateAsync, isPending: false });
  mockUseClockOut.mockReturnValue({ mutateAsync: mockClockOutMutateAsync, isPending: false });
  mockGeolocationSuccess();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ClockInPage', () => {
  it('shows "Not clocked in" and a Clock In action when there is no open attendance record', () => {
    mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<ClockInPage />);

    expect(screen.getByText('Not clocked in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clock in/i })).toBeInTheDocument();
  });

  it('shows "Currently clocked in" and a Clock Out action when the latest record has no clock-out time', () => {
    mockUseAttendanceByEmployee.mockReturnValue({
      data: { records: [{ id: 'a1', clock_in_server_time: new Date().toISOString(), clock_out_server_time: null }] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ClockInPage />);

    expect(screen.getByText('Currently clocked in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clock out/i })).toBeInTheDocument();
  });

  it('clocks in via the attendance API and redirects to the Shift page so the flow continues to Open Shift/POS', async () => {
    mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<ClockInPage />);
    fireEvent.click(screen.getByRole('button', { name: /clock in/i }));

    await waitFor(() =>
      expect(mockClockInMutateAsync).toHaveBeenCalledWith({
        employee_id: 'employee-1',
        branch_id: 'branch-1',
        gps_lat: 14.5,
        gps_lng: 121.0,
      }),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/shift'));
  });

  it('does not redirect when clock-in fails', async () => {
    mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] }, isLoading: false, isError: false, refetch: vi.fn() });
    mockClockInMutateAsync.mockRejectedValue(new Error('Time in before opening a POS shift.'));

    render(<ClockInPage />);
    fireEvent.click(screen.getByRole('button', { name: /clock in/i }));

    await waitFor(() => expect(mockClockInMutateAsync).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });
});
