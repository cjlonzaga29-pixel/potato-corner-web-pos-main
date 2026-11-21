'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateExpenseTypeInput, ExpenseTypeListResponse, ExpenseTypeResponse, UpdateExpenseTypeInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ExpenseTypeFilters {
  /** Only types usable at this branch. */
  branchId?: string;
  includeInactive?: boolean;
}

function apiError(response: { error: { code: string; message?: string } | string | null }, fallback: string): Error {
  if (!response.error) return new Error(fallback);
  return new Error(typeof response.error === 'string' ? response.error : (response.error.message ?? fallback));
}

/** POS-PERF-P60 — the caller's expense types, scoped by the server to their live branches. */
export function useExpenseTypes(filters: ExpenseTypeFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['expense-types', filters],
    queryFn: async () => {
      const params = new URLSearchParams({ include_inactive: String(filters.includeInactive ?? true) });
      if (filters.branchId) params.set('branch_id', filters.branchId);
      const response = await apiClient<ExpenseTypeListResponse>(`/api/expense-types?${params.toString()}`);
      if (!response.data) throw apiError(response, 'Failed to load expense types');
      return response.data.types;
    },
    staleTime: 30 * 1000,
    enabled: options.enabled ?? true,
  });
}

function useExpenseTypeWrite<TInput>(request: (input: TInput) => Promise<{ data: ExpenseTypeResponse | null; error: { code: string; message?: string } | string | null }>, fallback: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => {
      const response = await request(input);
      if (!response.data) throw apiError(response, fallback);
      return response.data;
    },
    // Awaited so a closing dialog's caller sees the new type and its new version.
    onSuccess: async () => {
      // Ledger rows and breakdowns carry the type's current name and active state.
      // Cancelled first: a first load still in flight read the old state, and an
      // invalidate alone would reuse that request rather than start a new one.
      await queryClient.cancelQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      await queryClient.invalidateQueries({ queryKey: ['expense-types'] });
    },
  });
}

export function useCreateExpenseType() {
  return useExpenseTypeWrite(
    (input: CreateExpenseTypeInput) => apiClient<ExpenseTypeResponse>('/api/expense-types', { method: 'POST', body: JSON.stringify(input) }),
    'Failed to create this expense type',
  );
}

export function useUpdateExpenseType(expenseTypeId: string) {
  return useExpenseTypeWrite(
    (input: UpdateExpenseTypeInput) => apiClient<ExpenseTypeResponse>(`/api/expense-types/${expenseTypeId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    'Failed to save this expense type',
  );
}

export function useSetExpenseTypeActive(expenseTypeId: string) {
  return useExpenseTypeWrite(
    ({ isActive, expectedVersion }: { isActive: boolean; expectedVersion: number }) =>
      apiClient<ExpenseTypeResponse>(`/api/expense-types/${expenseTypeId}/${isActive ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: JSON.stringify({ expected_version: expectedVersion }),
      }),
    'Failed to change this expense type',
  );
}
