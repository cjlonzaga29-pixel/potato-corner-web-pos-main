'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { AttendanceListResponse, AttendanceResponse, ClockInInput, ClockOutInput, ManualOverrideInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
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

function invalidateAttendance(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['attendance-branch'] });
  void queryClient.invalidateQueries({ queryKey: ['attendance-employee'] });
}

/** Keeps attendance DataTables in sync with clock-ins/outs recorded from any other device, without a manual refresh. */
export function useAttendanceRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.ATTENDANCE_CLOCKED_IN, SOCKET_EVENTS.ATTENDANCE_CLOCKED_OUT],
    [['attendance-branch'], ['attendance-employee']],
  );
}

export function useClockIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ClockInInput) => {
      const response = await apiClient<AttendanceResponse>('/api/attendance/clock-in', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to clock in'));
      return response.data;
    },
    onSuccess: () => {
      invalidateAttendance(queryClient);
      toast.success('Clocked in');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useClockOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ClockOutInput) => {
      const response = await apiClient<AttendanceResponse>('/api/attendance/clock-out', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to clock out'));
      return response.data;
    },
    onSuccess: () => {
      invalidateAttendance(queryClient);
      toast.success('Clocked out');
    },
    onError: (error: Error) => toast.error(error.message),
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
