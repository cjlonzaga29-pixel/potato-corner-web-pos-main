'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  CreateEmployeeInput,
  EmployeeActivityResponse,
  EmployeeListResponse,
  EmployeePayrollResponse,
  EmployeeResponse,
  EmployeeStatus,
  EmploymentType,
  Role,
  UpdateEmployeeInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

export interface EmployeeFilters {
  role?: Role;
  employmentType?: EmploymentType;
  isActive?: boolean;
  branchId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/**
 * Carries the API's machine-readable error code alongside the human
 * message — set-employee-status-dialog.tsx needs to distinguish
 * ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED from any other failure, which a
 * plain Error's message string can't reliably do.
 */
export class EmployeeApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'EmployeeApiError';
  }
}

function throwEmployeeApiError(response: ApiErrorShape, fallback: string): never {
  const code = typeof response.error === 'object' && response.error ? response.error.code : 'UNKNOWN';
  throw new EmployeeApiError(errorMessage(response, fallback), code);
}

function buildQueryString(filters: EmployeeFilters): string {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.employmentType) params.set('employment_type', filters.employmentType);
  if (filters.isActive !== undefined) params.set('is_active', String(filters.isActive));
  if (filters.branchId) params.set('branch_id', filters.branchId);
  if (filters.search) params.set('search', filters.search);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

/**
 * Full employee management list — supersedes Phase 4's minimal read-only
 * slice. Also the data source for the assign-supervisor dialog
 * (apps/web/components/admin/branches/assign-supervisor-dialog.tsx), which
 * filters `role: 'supervisor'` and reads `data.employees`.
 */
export function useEmployees(filters: EmployeeFilters = {}) {
  return useQuery({
    queryKey: ['employees', filters],
    queryFn: async () => {
      const response = await apiClient<EmployeeListResponse>(`/api/employees?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load employees'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useEmployee(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ['employee', employeeId],
    queryFn: async () => {
      const response = await apiClient<EmployeeResponse>(`/api/employees/${employeeId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load employee'));
      return response.data;
    },
    enabled: Boolean(employeeId),
    staleTime: 30 * 1000,
  });
}

export function useEmployeeActivity(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ['employee', employeeId, 'activity'],
    queryFn: async () => {
      const response = await apiClient<EmployeeActivityResponse>(`/api/employees/${employeeId}/activity`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load employee activity'));
      return response.data;
    },
    enabled: Boolean(employeeId),
    staleTime: 60 * 1000,
  });
}

/**
 * Decrypted government IDs — deliberately not fetched until the payroll
 * dialog is actually open (`enabled`), and never cached beyond the
 * component's lifetime (staleTime/gcTime 0), so sensitive data doesn't
 * linger in the query cache after the dialog closes.
 */
export function useEmployeePayroll(employeeId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['employee', employeeId, 'payroll'],
    queryFn: async () => {
      const response = await apiClient<EmployeePayrollResponse>(`/api/employees/${employeeId}/payroll`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load payroll data'));
      return response.data;
    },
    enabled: Boolean(employeeId) && enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateEmployeeInput) => {
      const response = await apiClient<EmployeeResponse>('/api/employees', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create employee'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      toast.success('Employee created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateEmployee(employeeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateEmployeeInput) => {
      const response = await apiClient<EmployeeResponse>(`/api/employees/${employeeId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update employee'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['employee', employeeId] });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      toast.success('Employee updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export interface SetEmployeeStatusInput {
  status: EmployeeStatus;
  reason?: string;
  acknowledge_active_shift?: boolean;
}

/**
 * CR-003 (Branch Operating System) full 5-state lifecycle transition.
 * Moving away from 'active' immediately revokes the employee's sessions and
 * blocks future access (enforced server-side in employees.service.ts) —
 * never deletes attendance/transaction/audit history.
 */
export function useSetEmployeeStatus(employeeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetEmployeeStatusInput) => {
      const response = await apiClient<EmployeeResponse>(`/api/employees/${employeeId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throwEmployeeApiError(response, 'Failed to change employee status');
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['employee', employeeId] });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      toast.success('Employee status updated');
    },
    // Deliberately no onError toast here — ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED is an
    // expected first-attempt outcome the dialog handles inline, not a failure to surface as a toast.
  });
}

