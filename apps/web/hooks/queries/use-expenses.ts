'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

export type ExpenseCategory = 'utilities' | 'supplies' | 'staff_meals' | 'miscellaneous';

export interface ExpenseRow {
  id: string;
  branch_id: string;
  branch_name: string;
  category: ExpenseCategory;
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
  category?: ExpenseCategory;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

export interface CreateExpenseInput {
  branch_id: string;
  category: ExpenseCategory;
  amount: number;
  vendor_name?: string;
  description?: string;
  incurred_at: string;
}

export type UpdateExpenseInput = Partial<CreateExpenseInput>;

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: ExpenseFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.category) params.set('category', filters.category);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
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
    placeholderData: keepPreviousData,
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

export function useCreateExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateExpenseInput) => {
      const response = await apiClient<ExpenseRow>('/api/expenses', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create expense'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
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
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'detail', expenseId] });
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
