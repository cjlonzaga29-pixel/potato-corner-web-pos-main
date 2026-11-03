'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateExtraSupplyInput,
  CreateExtraSupplyIssueInput,
  ExtraSupplyConversionPreview,
  ExtraSupplyIssueDetailResponse,
  ExtraSupplyIssueListResponse,
  ExtraSupplyIssueResponse,
  ExtraSupplyListResponse,
  ExtraSupplyOperationResponse,
  ExtraSupplyResponse,
  ExtraSupplySummaryResponse,
  ExtraSupplyTerminalResponse,
  UpdateExtraSupplyInput,
} from '@potato-corner/shared';
import { apiClient, fetchAuthenticated } from '@/lib/api-client';

type ApiError = { code: string; message?: string } | string | null;
type Operator = { token?: string; refresh?: () => Promise<string | null> };

/** The route doesn't exist: this web build reached an API that predates P61. */
export const EXTRA_SUPPLIES_NOT_DEPLOYED = 'EXTRA_SUPPLIES_NOT_DEPLOYED';

export class ExtraSupplyRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ExtraSupplyRequestError';
  }
}

function toError(response: { error: ApiError }, fallback: string): ExtraSupplyRequestError {
  const { error } = response;
  const code = !error || typeof error === 'string' ? 'UNKNOWN' : error.code;
  if (code === 'NOT_FOUND') return new ExtraSupplyRequestError('Extra Supplies is not available on this server yet. Nothing was recorded, and your selection is saved.', EXTRA_SUPPLIES_NOT_DEPLOYED);
  const message = !error ? fallback : typeof error === 'string' ? error : (error.message ?? fallback);
  return new ExtraSupplyRequestError(message, code);
}

/**
 * The answers that prove the server wrote nothing for this request. Anything else, including
 * a lost connection, an unreadable reply or a code added later, may follow a posted issue,
 * so it keeps the operation id. A new id after one of those could issue the stock twice.
 */
const PROVES_NOTHING_POSTED = new Set([
  EXTRA_SUPPLIES_NOT_DEPLOYED,
  'VALIDATION_ERROR',
  'RATE_LIMIT_EXCEEDED',
  'BRANCH_ACCESS_DENIED',
  'BRANCH_ID_REQUIRED',
  'BRANCH_NOT_ASSIGNED',
  'BRANCH_NOT_FOUND',
  'EMPLOYEE_INACTIVE',
  'SUPERVISOR_INACTIVE',
  'NOT_CLOCKED_IN',
  'ON_BREAK',
  'SHIFT_REQUIRED',
  'SHIFT_CLOSED',
  'EXTRA_SUPPLY_UNAVAILABLE',
  'EXTRA_SUPPLY_CONFIG_STALE',
  'EXTRA_SUPPLY_INVENTORY_UNAVAILABLE',
  'EXTRA_SUPPLY_NOT_FOR_SALE',
  'INSUFFICIENT_STOCK',
  'INSUFFICIENT_CASH_TENDERED',
  'PAYMENT_PROOF_INVALID',
]);

export function provesNothingPosted(error: unknown): error is ExtraSupplyRequestError {
  return error instanceof ExtraSupplyRequestError && PROVES_NOTHING_POSTED.has(error.code);
}

export interface ExtraSupplyIssueFilters {
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  extraSupplyId?: string;
  kind?: 'free' | 'paid';
  cashierId?: string;
}

function filterParams(filters: ExtraSupplyIssueFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.branchId) params.set('branch_id', filters.branchId);
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  if (filters.extraSupplyId) params.set('extra_supply_id', filters.extraSupplyId);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.cashierId) params.set('cashier_id', filters.cashierId);
  return params;
}

export function useExtraSupplies(filters: { branchId?: string; includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: ['extra-supplies', filters],
    queryFn: async () => {
      const params = new URLSearchParams({ include_inactive: String(filters.includeInactive ?? true) });
      if (filters.branchId) params.set('branch_id', filters.branchId);
      const response = await apiClient<ExtraSupplyListResponse>(`/api/extra-supplies?${params.toString()}`);
      if (!response.data) throw toError(response, 'Failed to load supplies');
      return response.data.supplies;
    },
    staleTime: 30 * 1000,
    retry: (count, error) => (error as ExtraSupplyRequestError).code !== EXTRA_SUPPLIES_NOT_DEPLOYED && count < 2,
  });
}

/** What a save would store, checked by the server before the supervisor commits to it. */
export function useExtraSupplyConversionPreview(input: { itemId: string; quantity: number; unitId: string } | null) {
  return useQuery({
    queryKey: ['extra-supply-conversion', input],
    queryFn: async () => {
      if (!input) return null;
      const params = new URLSearchParams({ inventory_item_id: input.itemId, entered_quantity: String(input.quantity), entered_unit_id: input.unitId });
      const response = await apiClient<ExtraSupplyConversionPreview>(`/api/extra-supplies/conversion-preview?${params.toString()}`);
      if (!response.data) throw toError(response, 'That conversion could not be checked');
      return response.data;
    },
    enabled: input !== null,
    retry: false,
    staleTime: 0,
  });
}

function useSupplyWrite<TInput>(request: (input: TInput) => Promise<{ data: ExtraSupplyResponse | null; error: ApiError }>, fallback: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => {
      const response = await request(input);
      if (!response.data) throw toError(response, fallback);
      return response.data;
    },
    onSuccess: async () => {
      void queryClient.invalidateQueries({ queryKey: ['extra-supply-cards'] });
      await queryClient.invalidateQueries({ queryKey: ['extra-supplies'] });
    },
  });
}

export function useCreateExtraSupply() {
  return useSupplyWrite((input: CreateExtraSupplyInput) => apiClient<ExtraSupplyResponse>('/api/extra-supplies', { method: 'POST', body: JSON.stringify(input) }), 'Failed to create this supply');
}

export function useUpdateExtraSupply() {
  return useSupplyWrite(
    ({ id, input }: { id: string; input: UpdateExtraSupplyInput }) => apiClient<ExtraSupplyResponse>(`/api/extra-supplies/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    'Failed to save this supply',
  );
}

export function useSetExtraSupplyActive() {
  return useSupplyWrite(
    ({ id, isActive, expectedVersion }: { id: string; isActive: boolean; expectedVersion: number }) =>
      apiClient<ExtraSupplyResponse>(`/api/extra-supplies/${id}/${isActive ? 'reactivate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({ expected_version: expectedVersion }) }),
    'Failed to change this supply',
  );
}

export function useUploadExtraSupplyImage() {
  return useSupplyWrite(
    ({ id, file, expectedVersion }: { id: string; file: File; expectedVersion: number }) => {
      const form = new FormData();
      form.set('expected_version', String(expectedVersion));
      form.set('image', file);
      return apiClient<ExtraSupplyResponse>(`/api/extra-supplies/${id}/image`, { method: 'POST', body: form });
    },
    'The image could not be saved',
  );
}

export function useRemoveExtraSupplyImage() {
  return useSupplyWrite(
    ({ id, expectedVersion }: { id: string; expectedVersion: number }) => apiClient<ExtraSupplyResponse>(`/api/extra-supplies/${id}/image`, { method: 'DELETE', body: JSON.stringify({ expected_version: expectedVersion }) }),
    'The image could not be removed',
  );
}

export function useExtraSupplyCards(branchId: string | undefined, operator: Operator) {
  return useQuery({
    queryKey: ['extra-supply-cards', branchId],
    queryFn: async () => {
      const response = await apiClient<ExtraSupplyTerminalResponse>(`/api/extra-supplies/terminal?branch_id=${branchId}`, undefined, operator.token, operator.refresh);
      if (!response.data) throw toError(response, 'Failed to load supplies');
      return response.data.cards;
    },
    enabled: Boolean(branchId),
    refetchOnWindowFocus: true,
    retry: (count, error) => (error as ExtraSupplyRequestError).code !== EXTRA_SUPPLIES_NOT_DEPLOYED && count < 2,
  });
}

/** Called by the panel, not a mutation hook: the outcome handling depends on knowing the request itself failed. */
export async function submitExtraSupplyIssue(input: CreateExtraSupplyIssueInput, operator: Operator): Promise<ExtraSupplyIssueResponse> {
  const response = await apiClient<ExtraSupplyIssueResponse>('/api/extra-supplies/issues', { method: 'POST', body: JSON.stringify(input) }, operator.token, operator.refresh);
  if (!response.data) throw toError(response, 'The issue could not be confirmed');
  return response.data;
}

/** The time stamp keeps this out of the service worker's API cache: an old "not found" must never answer this. */
export async function fetchExtraSupplyOperation(operationId: string, operator: Operator): Promise<ExtraSupplyOperationResponse> {
  const response = await apiClient<ExtraSupplyOperationResponse>(`/api/extra-supplies/operations/${operationId}?t=${Date.now()}`, undefined, operator.token, operator.refresh);
  if (!response.data) throw toError(response, 'The outcome could not be checked');
  return response.data;
}

export async function abandonExtraSupplyOperation(operationId: string, branchId: string, operator: Operator): Promise<ExtraSupplyOperationResponse> {
  const response = await apiClient<ExtraSupplyOperationResponse>(`/api/extra-supplies/operations/${operationId}/abandon`, { method: 'POST', body: JSON.stringify({ branch_id: branchId }) }, operator.token, operator.refresh);
  if (!response.data) throw toError(response, 'That attempt could not be cancelled');
  return response.data;
}

export function useExtraSupplyIssues(filters: ExtraSupplyIssueFilters, page: number, limit: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['extra-supply-issues', filters, page, limit],
    queryFn: async () => {
      const params = filterParams(filters);
      params.set('page', String(page));
      params.set('limit', String(limit));
      const response = await apiClient<ExtraSupplyIssueListResponse>(`/api/extra-supplies/issues?${params.toString()}`);
      if (!response.data) throw toError(response, 'Failed to load history');
      return response.data;
    },
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
    retry: (count, error) => (error as ExtraSupplyRequestError).code !== EXTRA_SUPPLIES_NOT_DEPLOYED && count < 2,
  });
}

export function useExtraSupplySummary(filters: ExtraSupplyIssueFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['extra-supply-summary', filters],
    queryFn: async () => {
      const params = filterParams(filters);
      const response = await apiClient<ExtraSupplySummaryResponse>(`/api/extra-supplies/issues/summary?${params.toString()}`);
      if (!response.data) throw toError(response, 'Failed to load totals');
      return response.data;
    },
    enabled: options.enabled ?? true,
    retry: (count, error) => (error as ExtraSupplyRequestError).code !== EXTRA_SUPPLIES_NOT_DEPLOYED && count < 2,
  });
}

export function useExtraSupplyIssue(issueId: string | null) {
  return useQuery({
    queryKey: ['extra-supply-issue', issueId],
    queryFn: async () => {
      const response = await apiClient<ExtraSupplyIssueDetailResponse>(`/api/extra-supplies/issues/${issueId}`);
      if (!response.data) throw toError(response, 'Failed to load this issue');
      return response.data;
    },
    enabled: Boolean(issueId),
  });
}

/** The server builds the file, so it holds every matching line up to its limit rather than the page on screen. */
export async function downloadExtraSupplyCsv(filters: ExtraSupplyIssueFilters): Promise<void> {
  const response = await fetchAuthenticated(`/api/extra-supplies/issues/export?${filterParams(filters).toString()}`);
  if (!response.ok) throw new Error('The export could not be created. Try again.');
  const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'extra-supplies.csv';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
