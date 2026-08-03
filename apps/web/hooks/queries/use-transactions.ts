'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  CreateTransactionInput,
  PaymentProofResponse,
  PaymentProofUploadResponse,
  RefundTransactionRequest,
  TransactionListQuery,
  TransactionListResponse,
  TransactionResponse,
  VoidTransactionRequest,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export type TransactionFilters = Partial<TransactionListQuery>;

function buildQueryString(filters: TransactionFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.shift_id) params.set('shift_id', filters.shift_id);
  if (filters.status) params.set('status', filters.status);
  if (filters.payment_method) params.set('payment_method', filters.payment_method);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useTransactions(filters: TransactionFilters = {}) {
  return useQuery({
    queryKey: ['transactions', filters],
    queryFn: async () => {
      const response = await apiClient<TransactionListResponse>(`/api/transactions?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load transactions'));
      return response.data;
    },
    enabled: Boolean(filters.branch_id),
    placeholderData: keepPreviousData,
  });
}

/**
 * Same endpoint and query key as useTransactions, without its branch_id
 * requirement — GET /api/transactions already lists org-wide when branch_id
 * is omitted (branchGuard skips the check entirely for super_admin, and
 * buildListWhere in transactions.repository.ts only filters on branchId when
 * it's present). Used by the Admin Dashboard's Recent Activity preview,
 * mirroring the useDashboardXxxReport override pattern in use-reports.ts.
 */
export function useDashboardRecentTransactions(filters: TransactionFilters = {}) {
  return useQuery({
    queryKey: ['transactions', filters],
    queryFn: async () => {
      const response = await apiClient<TransactionListResponse>(`/api/transactions?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load transactions'));
      return response.data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useTransaction(transactionId: string | null | undefined) {
  return useQuery({
    queryKey: ['transaction', transactionId],
    queryFn: async () => {
      const response = await apiClient<TransactionResponse>(`/api/transactions/${transactionId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load transaction'));
      return response.data;
    },
    enabled: Boolean(transactionId),
  });
}

/**
 * Task 120: accessTokenOverride lets the POS Terminal check out using the
 * selected Employee's token (obtained from useAuth().selectEmployee, never
 * written to the global auth store) instead of the authenticated Branch
 * session's — checkout attributes cashier_id from the request's bearer
 * token server-side, so this is what makes a sale record the actual
 * Employee instead of the Branch account. See terminal/page.tsx. Omitted
 * for a genuine `staff` session, unchanged from before.
 */
export function useCreateTransaction(accessTokenOverride?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTransactionInput) => {
      const response = await apiClient<TransactionResponse>(
        '/api/transactions',
        { method: 'POST', body: JSON.stringify(input) },
        accessTokenOverride,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record transaction'));
      return response.data;
    },
    onSuccess: (transaction) => {
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      // cash_sales_total/gcash_sales_total are computed live from Transaction
      // rows (Phase 9's withLiveSalesTotals overlay) — refetching the shift
      // is the only "invalidation" a new sale needs.
      void queryClient.invalidateQueries({ queryKey: ['current-shift'] });
      if (transaction.shift_id) {
        void queryClient.invalidateQueries({ queryKey: ['shift', transaction.shift_id] });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

interface UploadPaymentProofInput {
  branchId: string;
  /** Optional — the API resolves (and auto-opens) the cashier's own active shift server-side; this is only a fallback for shiftGuard-exempt roles. */
  shiftId?: string;
  type: 'live_capture' | 'gallery_upload';
  file: File;
}

/**
 * Uploads a proof photo ahead of checkout — the returned key/type are held
 * in terminal component state and included in the transaction-create
 * payload, not persisted here. Task 120: see useCreateTransaction's
 * accessTokenOverride note above — same reasoning applies here.
 */
export function useUploadPaymentProof(accessTokenOverride?: string) {
  return useMutation({
    mutationFn: async ({ branchId, shiftId, type, file }: UploadPaymentProofInput) => {
      const formData = new FormData();
      formData.set('branch_id', branchId);
      if (shiftId) formData.set('shift_id', shiftId);
      formData.set('type', type);
      formData.set('proof', file);
      const response = await apiClient<PaymentProofUploadResponse>(
        '/api/transactions/payment-proof',
        { method: 'POST', body: formData },
        accessTokenOverride,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload payment proof'));
      return response.data;
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Fetches a freshly-signed proof-photo URL — only enabled while the admin viewer dialog is open, never eagerly on the transaction list. */
export function usePaymentProof(transactionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['transaction-payment-proof', transactionId],
    queryFn: async () => {
      const response = await apiClient<PaymentProofResponse>(`/api/transactions/${transactionId}/payment-proof`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load payment proof'));
      return response.data;
    },
    enabled: Boolean(transactionId) && enabled,
  });
}

/** Keeps a shift's transaction list (and its live sales total) in sync with sales recorded from any other terminal, without a manual refresh. */
export function useTransactionsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.TRANSACTION_COMPLETED, SOCKET_EVENTS.VOID_REQUESTED, SOCKET_EVENTS.TRANSACTION_REFUNDED],
    [['transactions'], ['current-shift'], ['branches']],
  );
}

export function useVoidTransaction(transactionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VoidTransactionRequest) => {
      const response = await apiClient<TransactionResponse>(`/api/transactions/${transactionId}/void`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to void transaction'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      toast.success('Transaction voided');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useRefundTransaction(transactionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RefundTransactionRequest) => {
      const response = await apiClient<TransactionResponse>(`/api/transactions/${transactionId}/refund`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to refund transaction'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      toast.success('Transaction refunded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useMarkReceiptPrinted(transactionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<{ success: boolean }>(`/api/transactions/${transactionId}/receipt-printed`, {
        method: 'POST',
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to mark receipt as printed'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
    },
  });
}
