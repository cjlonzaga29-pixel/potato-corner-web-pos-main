'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS, type ExpenseSummaryResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export type ExpenseCategory = 'utilities' | 'supplies' | 'staff_meals' | 'miscellaneous';

export interface ExpenseRow {
  id: string;
  branch_id: string;
  branch_name: string;
  category: ExpenseCategory;
  /** POS-PERF-P60 — null on a legacy expense. An older API omits all four. */
  expense_type_id?: string | null;
  /** The name recorded on this expense. */
  expense_type_name?: string | null;
  expense_type_current_name?: string | null;
  expense_type_is_active?: boolean | null;
  amount: number;
  vendor_name: string | null;
  description: string | null;
  receipt_url: string | null;
  incurred_at: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

export interface ExpenseListResponse {
  expenses: ExpenseRow[];
  total: number;
  total_amount: number;
  page: number;
  limit: number;
}

export interface ExpenseFilters {
  branch_id?: string;
  expense_type_id?: string;
  category?: ExpenseCategory;
  unassigned?: boolean;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

export type ExpenseSummaryFilters = Omit<ExpenseFilters, 'page' | 'limit'>;

export interface CreateExpenseInput {
  branch_id: string;
  /** Only ever legacy: a new expense names a type. */
  category?: ExpenseCategory;
  expense_type_id?: string;
  amount: number;
  vendor_name?: string;
  description?: string;
  incurred_at: string;
}

export type UpdateExpenseInput = Partial<CreateExpenseInput>;

interface ApiErrorShape {
  error: { code: string; message?: string; fields?: Array<{ message?: string }> } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  if (typeof response.error === 'string') return response.error;
  return response.error.message ?? response.error.fields?.[0]?.message ?? response.error.code;
}

function buildFilterParams(filters: ExpenseSummaryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.expense_type_id) params.set('expense_type_id', filters.expense_type_id);
  if (filters.category) params.set('category', filters.category);
  if (filters.unassigned) params.set('unassigned', 'true');
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  return params;
}

function buildQueryString(filters: ExpenseFilters): string {
  const params = buildFilterParams(filters);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

/** GET /api/expenses — branch expense ledger, scoped server-side to the caller's accessible branches. */
export function useExpenses(filters: ExpenseFilters = {}) {
  return useQuery({
    queryKey: ['expenses', 'list', filters],
    queryFn: async () => {
      const response = await apiClient<ExpenseListResponse>(`/api/expenses?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load expenses'));
      return response.data;
    },
    staleTime: 30 * 1000,
    // Only another page of the same filters may stand in while loading: another
    // branch's or type's rows must never show under this one.
    placeholderData: (previous, previousQuery) => {
      const previousFilters = (previousQuery?.queryKey[2] ?? {}) as ExpenseFilters;
      return JSON.stringify({ ...previousFilters, page: undefined }) === JSON.stringify({ ...filters, page: undefined }) ? previous : undefined;
    },
  });
}

/** GET /api/expenses/summary — totals and the breakdown by type, over the same filters as the list. */
export function useExpenseSummary(filters: ExpenseSummaryFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['expenses', 'summary', filters],
    queryFn: async () => {
      const response = await apiClient<ExpenseSummaryResponse>(`/api/expenses/summary?${buildFilterParams(filters).toString()}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load expense totals'));
      return response.data;
    },
    staleTime: 30 * 1000,
    enabled: options.enabled ?? true,
  });
}

export function useExpense(expenseId: string | null | undefined) {
  return useQuery({
    queryKey: ['expenses', 'detail', expenseId],
    queryFn: async () => {
      const response = await apiClient<ExpenseRow>(`/api/expenses/${expenseId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load expense'));
      return response.data;
    },
    enabled: Boolean(expenseId),
    staleTime: 30 * 1000,
  });
}

/** Keeps the expense ledger in sync with entries created/edited/deleted from any other session, without a manual refresh. */
export function useExpensesRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.EXPENSE_CREATED, SOCKET_EVENTS.EXPENSE_UPDATED, SOCKET_EVENTS.EXPENSE_DELETED],
    [['expenses'], ['branches']],
  );
}

export function useCreateExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    // A form passes one key for all its attempts, so a retry can't add a second expense.
    mutationFn: async ({ idempotencyKey, ...input }: CreateExpenseInput & { idempotencyKey?: string }) => {
      const response = await apiClient<ExpenseRow>('/api/expenses', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': idempotencyKey ?? crypto.randomUUID() },
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create expense'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['expense-types'] });
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Expense created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateExpense(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateExpenseInput) => {
      const response = await apiClient<ExpenseRow>(`/api/expenses/${expenseId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update expense'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      toast.success('Expense updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteExpense(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<null>(`/api/expenses/${expenseId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete expense'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'summary'] });
      toast.success('Expense deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUploadExpenseReceipt(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.set('receipt', file);
      const response = await apiClient<ExpenseRow>(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the receipt'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'detail', expenseId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
      toast.success('Receipt uploaded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/**
 * Same expenseId-as-mutation-variable shape as useUploadProductImage (Task 209.6) —
 * the Supervisor create flow doesn't have an expense id until the create
 * mutation resolves, so the id can't be bound at hook-instantiation time the
 * way useUploadExpenseReceipt above is. Kept separate from that hook (used by
 * the Admin edit page) rather than changing its signature.
 */
export function useUploadExpenseReceiptForExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ expenseId, file }: { expenseId: string; file: File }) => {
      const formData = new FormData();
      formData.set('receipt', file);
      const response = await apiClient<ExpenseRow>(`/api/expenses/${expenseId}/receipt`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the receipt'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'detail', variables.expenseId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
      toast.success('Receipt uploaded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteExpenseReceipt(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<ExpenseRow>(`/api/expenses/${expenseId}/receipt`, { method: 'DELETE' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to delete the receipt'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'detail', expenseId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
      toast.success('Receipt deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
