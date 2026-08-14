'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { AttendanceListResponse, AttendanceResponse, ClockInInput, ClockOutInput, ManualOverrideInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface AttendanceListFilters {
  from?: string;
  to?: string;
  employee_id?: string;
  page?: number;
  limit?: number;
}

function buildAttendanceQueryString(filters: AttendanceListFilters): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.employee_id) params.set('employee_id', filters.employee_id);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useAttendanceByBranch(branchId: string | null | undefined, filters: AttendanceListFilters = {}) {
  return useQuery({
    queryKey: ['attendance-branch', branchId, filters],
    queryFn: async () => {
      const response = await apiClient<AttendanceListResponse>(`/api/attendance/branch/${branchId}?${buildAttendanceQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load attendance records'));
      return response.data;
    },
    enabled: Boolean(branchId),
    placeholderData: keepPreviousData,
  });
}

export function useAttendanceByEmployee(employeeId: string | null | undefined, filters: AttendanceListFilters = {}) {
  return useQuery({
    queryKey: ['attendance-employee', employeeId, filters],
    queryFn: async () => {
      const response = await apiClient<AttendanceListResponse>(`/api/attendance/employee/${employeeId}?${buildAttendanceQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load attendance records'));
      return response.data;
    },
    enabled: Boolean(employeeId),
    placeholderData: keepPreviousData,
  });
}

/**
 * Canonical "is the current authenticated cashier clocked in right now"
 * check — same derivation clock-in/page.tsx uses for its own status card
 * (latest attendance record with no clock-out yet), reusable by Open Shift
 * and the POS route guard so they never disagree with the Clock In page
 * about attendance state.
 *
 * Task 120: a `branch` session operating the POS Terminal has no attendance
 * record of its own — the caller passes the selected Employee's id as
 * employeeIdOverride so this checks that Employee's status instead of the
 * authenticated (Branch) user's. A genuine `staff` session omits it and
 * falls back to its own id, unchanged from before.
 */
export function useIsClockedIn(employeeIdOverride?: string) {
  const { user } = useAuth();
  const query = useAttendanceByEmployee(employeeIdOverride ?? user?.id, { limit: 1 });
  const latestRecord = query.data?.records[0] ?? null;
  const isClockedIn = latestRecord !== null && latestRecord.clock_out_server_time === null;
  return { isClockedIn, record: isClockedIn ? latestRecord : null, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch };
}

function invalidateAttendance(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['attendance-branch'] });
  void queryClient.invalidateQueries({ queryKey: ['attendance-employee'] });
}

/** Keeps attendance DataTables in sync with clock-ins/outs recorded from any other device, without a manual refresh. */
export function useAttendanceRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.ATTENDANCE_CLOCKED_IN, SOCKET_EVENTS.ATTENDANCE_CLOCKED_OUT],
    [['attendance-branch'], ['attendance-employee'], ['branches']],
  );
}

/**
 * Task 120: accessTokenOverride lets the POS Terminal clock in the selected
 * Employee using that Employee's token (obtained from useAuth().selectEmployee,
 * never written to the global auth store) instead of the authenticated
 * Branch session's — see terminal/page.tsx. Omitted for a genuine `staff`
 * session, unchanged from before.
 */
export function useClockIn(accessTokenOverride?: string, refreshOverrideToken?: () => Promise<string | null>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ClockInInput) => {
      const response = await apiClient<AttendanceResponse>(
        '/api/attendance/clock-in',
        { method: 'POST', body: JSON.stringify(input) },
        accessTokenOverride,
        refreshOverrideToken,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to clock in'));
      return response.data;
    },
    onSuccess: () => {
      invalidateAttendance(queryClient);
      toast.success('Clocked in');
    },
    // A concurrent clock-in from another device (or a stale client read) can
    // fail here after location was already obtained — re-fetch so this
    // device's UI reflects the real server state instead of staying stuck
    // showing "Clock In".
    onError: (error: Error) => {
      invalidateAttendance(queryClient);
      toast.error(error.message);
    },
  });
}

/** Task 120: see useClockIn's accessTokenOverride note above — same reasoning applies to clock-out. */
export function useClockOut(accessTokenOverride?: string, refreshOverrideToken?: () => Promise<string | null>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ClockOutInput) => {
      const response = await apiClient<AttendanceResponse>(
        '/api/attendance/clock-out',
        { method: 'POST', body: JSON.stringify(input) },
        accessTokenOverride,
        refreshOverrideToken,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to clock out'));
      return response.data;
    },
    onSuccess: () => {
      invalidateAttendance(queryClient);
      toast.success('Clocked out');
    },
    onError: (error: Error) => {
      invalidateAttendance(queryClient);
      toast.error(error.message);
    },
  });
}

export function useManualOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualOverrideInput) => {
      const response = await apiClient<AttendanceResponse>('/api/attendance/override', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit correction'));
      return response.data;
    },
    onSuccess: () => {
      invalidateAttendance(queryClient);
      toast.success('Attendance record corrected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
