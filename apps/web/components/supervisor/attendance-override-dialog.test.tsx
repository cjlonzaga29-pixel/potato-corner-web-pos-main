import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AttendanceResponse } from '@potato-corner/shared';
import { AttendanceOverrideDialog } from './attendance-override-dialog';

const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/queries/use-attendance', () => ({
  useManualOverride: () => ({ mutateAsync, isPending: false }),
}));

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

beforeEach(() => {
  mutateAsync.mockClear();
});

// This suite renders Radix Dialog portals into document.body — without an
// explicit cleanup, a later test's queries can match DOM left over from an
// earlier render (vitest here doesn't run with `globals: true`, so
// Testing Library's automatic afterEach(cleanup) detection doesn't kick in).
afterEach(() => {
  cleanup();
});

describe('AttendanceOverrideDialog', () => {
  it('renders a full record with both clock-in and clock-out times', () => {
    render(<AttendanceOverrideDialog open onOpenChange={vi.fn()} record={attendanceRecord()} />);

    expect(screen.getByText('Correct Attendance Record')).toBeInTheDocument();
    expect(screen.getByText(/Original clock-in/)).toHaveTextContent('clock-out');
  });

  it('renders an open record (no clock-out) as still clocked in', () => {
    render(<AttendanceOverrideDialog open onOpenChange={vi.fn()} record={attendanceRecord({ clock_out_server_time: null, actual_work_minutes: null })} />);

    expect(screen.getByText(/still clocked in/)).toBeInTheDocument();
  });

  it('renders a corrected record with the Corrected status badge', () => {
    render(<AttendanceOverrideDialog open onOpenChange={vi.fn()} record={attendanceRecord({ status: 'corrected' })} />);

    expect(screen.getByText('Corrected')).toBeInTheDocument();
  });

  it('disables submit until the reason reaches the minimum length, and rejects an empty reason', () => {
    render(<AttendanceOverrideDialog open onOpenChange={vi.fn()} record={attendanceRecord()} />);

    const submitButton = screen.getByRole('button', { name: /submit correction/i });
    const reasonInput = screen.getByLabelText(/reason/i);

    expect(submitButton).toBeDisabled();

    fireEvent.click(submitButton);
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(reasonInput, { target: { value: 'short' } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(reasonInput, { target: { value: 'Employee forgot to clock out on time' } });
    expect(submitButton).not.toBeDisabled();
  });
});
