import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { AttendanceSummaryResponse } from '@potato-corner/shared';
import { DashboardAttendanceOverview } from './dashboard-attendance-overview';

afterEach(cleanup);

function summary(overrides: Partial<AttendanceSummaryResponse> = {}): AttendanceSummaryResponse {
  return {
    branch_id: '00000000-0000-4000-8000-000000000001',
    business_date: '2026-10-30',
    clocked_in: [],
    clocked_out_today: [],
    excluded_open_count: 0,
    ...overrides,
  };
}

const IN_JUAN = {
  record_id: '00000000-0000-4000-8000-0000000000a1',
  employee_id: '00000000-0000-4000-8000-0000000000e1',
  employee_name: 'Juan Dela Cruz',
  // 09:00 Manila
  clock_in_server_time: '2026-10-30T01:00:00.000Z',
  clock_in_gps_status: 'within_radius' as const,
};
const OUT_MARIA = {
  record_id: '00000000-0000-4000-8000-0000000000a2',
  employee_id: '00000000-0000-4000-8000-0000000000e2',
  employee_name: 'Maria Santos',
  clock_in_server_time: '2026-10-30T00:00:00.000Z',
  clock_out_server_time: '2026-10-30T04:00:00.000Z',
};

describe('DashboardAttendanceOverview (POS-PERF-P47 — attendance records only)', () => {
  it('renders skeletons while loading', () => {
    const { container } = render(<DashboardAttendanceOverview summary={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows clocked-in and clocked-out counts and names, separately', () => {
    render(<DashboardAttendanceOverview summary={summary({ clocked_in: [IN_JUAN], clocked_out_today: [OUT_MARIA] })} isLoading={false} />);

    const counts = screen.getByText('Clocked in now').closest('div') as HTMLElement;
    expect(within(counts).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByText('Clocked out today', { selector: 'dt' }).closest('div') as HTMLElement).getByText('1')).toBeInTheDocument();

    const inSection = screen.getByRole('region', { name: 'Clocked in now' });
    expect(within(inSection).getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(within(inSection).getByText(/09:00/)).toBeInTheDocument();
    const outSection = screen.getByRole('region', { name: 'Clocked out today' });
    expect(within(outSection).getByText('Maria Santos')).toBeInTheDocument();
    expect(within(outSection).queryByText('Juan Dela Cruz')).not.toBeInTheDocument();
  });

  it('renders a compact empty state when nobody clocked in today', () => {
    render(<DashboardAttendanceOverview summary={summary()} isLoading={false} />);
    expect(screen.getByText('No clock-ins recorded today')).toBeInTheDocument();
  });

  it('explains open records that are excluded from the count', () => {
    render(<DashboardAttendanceOverview summary={summary({ excluded_open_count: 2 })} isLoading={false} />);
    expect(screen.getByText(/2 open clock-ins belong to deactivated or reassigned staff/)).toBeInTheDocument();
  });

  it('links to the attendance page when given an href', () => {
    render(<DashboardAttendanceOverview summary={summary()} isLoading={false} href="/supervisor/attendance" />);
    expect(screen.getByRole('link', { name: /View attendance/ })).toHaveAttribute('href', '/supervisor/attendance');
  });

  it('shows an error message instead of stale or empty data when the summary fails', () => {
    render(<DashboardAttendanceOverview summary={undefined} isLoading={false} isError />);
    expect(screen.getByText(/Couldn.t load attendance/)).toBeInTheDocument();
  });
});

describe('DashboardAttendanceOverview — POS-PERF-P51 On Break', () => {
  it('keeps on-break staff in Clocked in now, and shows the On break count and badge separately', () => {
    render(
      <DashboardAttendanceOverview
        summary={summary({
          clocked_in: [
            { ...IN_JUAN, attendance_state: 'on_break', break_started_at: '2026-10-30T05:05:00.000Z' },
            { ...IN_JUAN, record_id: '00000000-0000-4000-8000-0000000000a3', employee_name: 'Ana Reyes', attendance_state: 'working', break_started_at: null },
          ],
          on_break_count: 1,
        })}
        isLoading={false}
      />,
    );

    expect(within(screen.getByText('Clocked in now').closest('div') as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByText('On break').closest('div') as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/On break since 01:05 PM/)).toBeInTheDocument();
  });

  it('a pre-P51 API (no attendance_state / on_break_count) shows nobody on break', () => {
    render(<DashboardAttendanceOverview summary={summary({ clocked_in: [IN_JUAN] })} isLoading={false} />);
    expect(within(screen.getByText('On break').closest('div') as HTMLElement).getByText('0')).toBeInTheDocument();
  });
});
