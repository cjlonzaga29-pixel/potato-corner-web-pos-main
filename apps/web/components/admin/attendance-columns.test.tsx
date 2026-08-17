import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AttendanceResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { manilaToday } from '@/lib/manila-date';
import { createAttendanceColumns } from './attendance-columns';

afterEach(cleanup);

function attendanceRecord(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    id: 'record-1',
    employee_id: 'employee-1',
    employee_name: null,
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
    ...overrides,
  };
}

const employeeNames = new Map([['employee-1', 'Juan Dela Cruz']]);
const branchNames = new Map([['branch-1', 'Manila Branch']]);

function renderRecord(record: AttendanceResponse) {
  const columns = createAttendanceColumns({ employeeNames, branchNames });
  render(<DataTable columns={columns} data={[record]} />);
}

describe('createAttendanceColumns', () => {
  it('renders a present record with GPS within radius', () => {
    renderRecord(attendanceRecord());

    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Manila Branch')).toBeInTheDocument();
    expect(screen.getByText('Within Radius')).toBeInTheDocument();
    expect(screen.getByText('Present')).toBeInTheDocument();
  });

  it('renders a corrected record with its correction reason', () => {
    renderRecord(attendanceRecord({ status: 'corrected', correction_reason: 'Employee forgot to clock out' }));

    expect(screen.getByText('Corrected')).toBeInTheDocument();
    expect(screen.getByText('Employee forgot to clock out')).toBeInTheDocument();
  });

  it('shows "Still clocked in" when clock_out_server_time is null and the shift started today', () => {
    renderRecord(attendanceRecord({ clock_in_server_time: `${manilaToday()}T08:00:00.000Z`, clock_out_server_time: null, actual_work_minutes: null }));

    expect(screen.getByText('Still clocked in')).toBeInTheDocument();
  });

  it('shows "—" when actual_work_minutes is null', () => {
    renderRecord(attendanceRecord({ clock_in_server_time: `${manilaToday()}T08:00:00.000Z`, actual_work_minutes: null, clock_out_server_time: null }));

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('flags a still-open record from a prior day as a stale open shift needing review, without rewriting its status', () => {
    // Default clock_in_server_time (2026-07-15) is deliberately a prior day.
    renderRecord(attendanceRecord({ clock_out_server_time: null, actual_work_minutes: null, status: 'present' }));

    expect(screen.getByText('Stale open shift')).toBeInTheDocument();
    expect(screen.getByText('Needs Review')).toBeInTheDocument();
    expect(screen.queryByText('Present')).not.toBeInTheDocument();
  });
});
