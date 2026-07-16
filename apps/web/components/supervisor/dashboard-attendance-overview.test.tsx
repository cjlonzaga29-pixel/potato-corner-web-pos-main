import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AttendanceResponse } from '@potato-corner/shared';
import { DashboardAttendanceOverview } from './dashboard-attendance-overview';

afterEach(cleanup);

function record(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    id: 'record-1',
    employee_id: 'employee-1234-5678',
    branch_id: 'branch-1',
    clock_in_server_time: '2026-07-16T01:00:00.000Z',
    clock_in_gps_lat: 14.5995,
    clock_in_gps_lng: 120.9842,
    clock_in_gps_status: 'within_radius',
    clock_in_time_flag: false,
    clock_out_server_time: null,
    clock_out_gps_lat: null,
    clock_out_gps_lng: null,
    break_minutes: 0,
    actual_work_minutes: null,
    overtime_minutes: 0,
    status: 'present',
    correction_reason: null,
    corrected_by: null,
    original_record_id: null,
    created_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardAttendanceOverview', () => {
  it('renders a stat row skeleton and list skeleton rows while loading', () => {
    const { container } = render(<DashboardAttendanceOverview records={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the no-one-clocked-in empty state when every record has clocked out', () => {
    render(<DashboardAttendanceOverview records={[record({ clock_out_server_time: '2026-07-16T09:00:00.000Z' })]} isLoading={false} />);
    expect(screen.getByText('No staff currently clocked in')).toBeInTheDocument();
  });

  it('counts clocked-in vs clocked-out records correctly', () => {
    render(
      <DashboardAttendanceOverview
        records={[
          record({ id: 'record-a', employee_id: 'emp-a', clock_out_server_time: null }),
          record({ id: 'record-b', employee_id: 'emp-b', clock_out_server_time: '2026-07-16T09:00:00.000Z' }),
          record({ id: 'record-c', employee_id: 'emp-c', clock_out_server_time: null }),
        ]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('2 clocked in')).toBeInTheDocument();
    expect(screen.getByText('1 clocked out')).toBeInTheDocument();
    expect(screen.getByText('3 total today')).toBeInTheDocument();
  });

  it('renders the clocked-in staff list with a GPS status badge', () => {
    render(<DashboardAttendanceOverview records={[record({ employee_id: 'employee-1234-5678', clock_in_gps_status: 'outside_radius' })]} isLoading={false} />);
    expect(screen.getByText(/employee-123/)).toBeInTheDocument();
    expect(screen.getByText('Outside Radius').className).toContain('bg-red-100');
  });
});
