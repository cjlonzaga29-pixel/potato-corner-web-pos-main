'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  PayRateCreateInput,
  PayRateView,
  PayRatesResponse,
  PayrollAdjustmentCreateInput,
  PayrollAdjustmentView,
  PayrollPeriodsResponse,
  PayrollPolicyInput,
  PayrollPolicyView,
  PayrollResolutionCreateInput,
  PayrollRunDetail,
  PayrollRunSummary,
  PayrollSettingsResponse,
} from '@potato-corner/shared';
import { apiClient, fetchAuthenticated } from '@/lib/api-client';
import { parseContentDisposition } from '@/lib/report-export-client';
import { triggerBrowserDownload } from '@/lib/trigger-download';

/**
 * POS-PERF-P52 — payroll data (TanStack Query). Every request is scoped by
 * the branch in the URL; the server re-checks access on each call.
 */

export class PayrollApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PayrollApiError';
  }
}

type Envelope<T> = Awaited<ReturnType<typeof apiClient<T>>>;

function unwrap<T>(response: Envelope<T>, fallback: string): T {
  if (response.data !== null && response.data !== undefined && !response.error) return response.data;
  const error = response.error;
  if (error && typeof error === 'object') {
    const fields = (error as { fields?: Array<{ message: string }> }).fields;
    throw new PayrollApiError(error.message ?? fields?.[0]?.message ?? fallback, error.code, error.details);
  }
  throw new PayrollApiError(typeof error === 'string' ? error : fallback, null);
}

const base = (branchId: string) => `/api/payroll/branches/${encodeURIComponent(branchId)}`;

export const payrollKeys = {
  all: ['payroll'] as const,
  branch: (branchId: string) => ['payroll', branchId] as const,
  settings: (branchId: string) => ['payroll', branchId, 'settings'] as const,
  rates: (branchId: string) => ['payroll', branchId, 'rates'] as const,
  periods: (branchId: string) => ['payroll', branchId, 'periods'] as const,
  run: (branchId: string, runId: string, employeeId: string | null) => ['payroll', branchId, 'run', runId, employeeId] as const,
};

function post<T>(path: string, body: unknown, method = 'POST') {
  return apiClient<T>(path, { method, body: JSON.stringify(body) });
}

export function usePayrollSettings(branchId: string | null) {
  return useQuery({
    queryKey: payrollKeys.settings(branchId ?? ''),
    queryFn: async () => unwrap(await apiClient<PayrollSettingsResponse>(`${base(branchId as string)}/settings`), 'Failed to load payroll settings'),
    enabled: Boolean(branchId),
  });
}

export function usePayRates(branchId: string | null) {
  return useQuery({
    queryKey: payrollKeys.rates(branchId ?? ''),
    queryFn: async () => unwrap(await apiClient<PayRatesResponse>(`${base(branchId as string)}/rates`), 'Failed to load pay rates'),
    enabled: Boolean(branchId),
  });
}

export function usePayrollPeriods(branchId: string | null) {
  return useQuery({
    queryKey: payrollKeys.periods(branchId ?? ''),
    queryFn: async () => unwrap(await apiClient<PayrollPeriodsResponse>(`${base(branchId as string)}/periods`), 'Failed to load pay periods'),
    enabled: Boolean(branchId),
  });
}

export function usePayrollRun(branchId: string | null, runId: string | null, employeeId: string | null) {
  return useQuery({
    queryKey: payrollKeys.run(branchId ?? '', runId ?? '', employeeId),
    queryFn: async () => {
      const qs = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
      return unwrap(await apiClient<PayrollRunDetail>(`${base(branchId as string)}/runs/${encodeURIComponent(runId as string)}${qs}`), 'Failed to load payroll');
    },
    enabled: Boolean(branchId && runId),
    // A draft is a live calculation: refetch on focus so the reviewer sees current figures.
    refetchOnWindowFocus: true,
  });
}

/** Shared mutation wiring: invalidate this branch's payroll queries on success, toast the server's message on failure. */
function usePayrollMutation<TInput, TResult>(branchId: string | null, fn: (input: TInput) => Promise<TResult>, success?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (success) toast.success(success);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: payrollKeys.branch(branchId ?? '') }),
  });
}

export function useSavePayrollPolicy(branchId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: PayrollPolicyInput) => unwrap(await post<PayrollPolicyView>(`${base(branchId as string)}/policy`, input, 'PUT'), 'Failed to save the payroll policy'),
    'Payroll policy saved',
  );
}

export function useCreatePayRate(branchId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: PayRateCreateInput) => unwrap(await post<PayRateView>(`${base(branchId as string)}/rates`, input), 'Failed to add the rate'),
    'Rate added',
  );
}

export function useVoidPayRate(branchId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: { rateId: string; reason: string; expected_latest_rate_id: string | null }) =>
      unwrap(await post<PayRateView>(`${base(branchId as string)}/rates/${input.rateId}/void`, { reason: input.reason, expected_latest_rate_id: input.expected_latest_rate_id }), 'Failed to void the rate'),
    'Rate voided',
  );
}

export function useCreatePayrollRun(branchId: string | null) {
  return usePayrollMutation(branchId, async (input: { period_start: string; period_end: string }) =>
    unwrap(await post<PayrollRunSummary>(`${base(branchId as string)}/runs`, input), 'Failed to generate the draft'),
  );
}

export function useAddPayrollAdjustment(branchId: string | null, runId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: PayrollAdjustmentCreateInput) => unwrap(await post<PayrollAdjustmentView>(`${base(branchId as string)}/runs/${runId}/adjustments`, input), 'Failed to add the adjustment'),
    'Adjustment added',
  );
}

export function useVoidPayrollAdjustment(branchId: string | null, runId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: { adjustmentId: string; reason: string }) =>
      unwrap(await post<{ id: string }>(`${base(branchId as string)}/runs/${runId}/adjustments/${input.adjustmentId}/void`, { reason: input.reason }), 'Failed to void the adjustment'),
    'Adjustment voided',
  );
}

export function useResolvePayrollIssue(branchId: string | null, runId: string | null) {
  return usePayrollMutation(
    branchId,
    async (input: PayrollResolutionCreateInput) => unwrap(await post<{ issue_key: string }>(`${base(branchId as string)}/runs/${runId}/resolutions`, input), 'Failed to record the resolution'),
    'Resolution recorded',
  );
}

export function useFinalizePayroll(branchId: string | null, runId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expected_fingerprint: string }) =>
      unwrap(await post<PayrollRunSummary>(`${base(branchId as string)}/runs/${runId}/finalize`, { ...input, acknowledge_scope: true }), 'Failed to finalize'),
    onSuccess: () => toast.success('Payroll finalized'),
    // STALE_PREVIEW / BLOCKING_ISSUES are shown inside the finalize dialog, not as a toast.
    onSettled: () => queryClient.invalidateQueries({ queryKey: payrollKeys.branch(branchId ?? '') }),
  });
}

export function usePayrollRunAction(branchId: string | null, runId: string | null, action: 'discard' | 'revise' | 'mark-paid', success: string) {
  return usePayrollMutation(
    branchId,
    async (body: { reason?: string; paid_reference?: string }) => unwrap(await post<PayrollRunSummary>(`${base(branchId as string)}/runs/${runId}/${action}`, body), 'The action failed'),
    success,
  );
}

/** Downloads the server-rendered CSV/PDF (same permissions as viewing the run). */
export function usePayrollExport(branchId: string | null, runId: string | null) {
  return useMutation({
    mutationFn: async (input: { format: 'csv' | 'pdf'; employeeId: string | null }) => {
      const qs = new URLSearchParams({ format: input.format });
      if (input.employeeId) qs.set('employee_id', input.employeeId);
      const response = await fetchAuthenticated(`${base(branchId as string)}/runs/${runId}/export?${qs.toString()}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const filename = parseContentDisposition(response.headers.get('content-disposition'), `payroll.${input.format}`);
      triggerBrowserDownload(blob, filename);
      return filename;
    },
    onSuccess: (filename) => toast.success(`Downloaded ${filename}`),
    onError: (error: Error) => toast.error(error.message),
  });
}
