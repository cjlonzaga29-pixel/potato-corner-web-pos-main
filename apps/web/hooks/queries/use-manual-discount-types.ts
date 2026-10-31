'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  CreateManualDiscountTypeInput,
  ManualDiscountTypeResponse,
  PosManualDiscountType,
  UpdateManualDiscountTypeInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

interface ApiErrorShape {
  error: { code: string; message?: string; details?: unknown } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** POS-PERF-P55 — a refused discount-type save; `code` is the server's (e.g. MANUAL_DISCOUNT_TYPE_CONFLICT, STATUTORY_DISCOUNT_NAME_RESERVED). */
export class ManualDiscountTypeSaveError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = 'ManualDiscountTypeSaveError';
  }
}

const KEY = ['manual-discount-types'] as const;

/** Supervisor/admin list for one branch (the server re-checks live branch authority on every read). */
export function useManualDiscountTypes(branchId: string | null, includeInactive = true) {
  const { accessToken, isLoading } = useAuth();
  return useQuery({
    queryKey: [...KEY, 'branch', branchId, includeInactive],
    queryFn: async () => {
      const params = new URLSearchParams({ branch_id: branchId as string, include_inactive: String(includeInactive) });
      const response = await apiClient<ManualDiscountTypeResponse[]>(`/api/discounts/manual-types?${params.toString()}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load discount types'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading && !!branchId,
  });
}

/**
 * The terminal's offer list: active, Apply-to-POS types of its own branch
 * (a staff/Branch Account session is always scoped to its branch by the
 * server). A pre-P55 API answers 404, which the terminal treats as "no
 * manual discount types" rather than an error that blocks selling.
 */
export function usePosManualDiscountTypes(branchId: string | null | undefined) {
  const { accessToken, isLoading } = useAuth();
  return useQuery({
    queryKey: [...KEY, 'pos', branchId],
    queryFn: async () => {
      const response = await apiClient<PosManualDiscountType[]>(`/api/discounts/manual-types/pos?branch_id=${encodeURIComponent(branchId as string)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load discount types'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading && !!branchId,
    retry: 1,
  });
}

function useManualTypeMutation<TInput>(request: (input: TInput) => Promise<ManualDiscountTypeResponse>, successMessage: (data: ManualDiscountTypeResponse) => string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      toast.success(successMessage(data));
    },
    onError: (error: Error) => {
      // Someone else saved first: reload so the editor shows what is in effect now.
      if (error instanceof ManualDiscountTypeSaveError && error.code === 'MANUAL_DISCOUNT_TYPE_CONFLICT') void queryClient.invalidateQueries({ queryKey: KEY });
      toast.error(error.message);
    },
  });
}

async function send(path: string, method: 'POST' | 'PATCH', body: unknown, fallback: string): Promise<ManualDiscountTypeResponse> {
  const response = await apiClient<ManualDiscountTypeResponse>(path, { method, body: JSON.stringify(body) });
  if (!response.data) {
    const code = response.error && typeof response.error !== 'string' ? response.error.code : null;
    throw new ManualDiscountTypeSaveError(errorMessage(response, fallback), code);
  }
  return response.data;
}

export function useCreateManualDiscountType() {
  return useManualTypeMutation(
    (input: CreateManualDiscountTypeInput) => send('/api/discounts/manual-types', 'POST', input, 'Failed to create the discount type'),
    (data) => `Discount type "${data.name}" created`,
  );
}

export function useUpdateManualDiscountType() {
  return useManualTypeMutation(
    ({ id, ...input }: UpdateManualDiscountTypeInput & { id: string }) =>
      send(`/api/discounts/manual-types/${id}`, 'PATCH', input, 'Failed to save the discount type'),
    (data) => `Discount type "${data.name}" saved`,
  );
}

export function useDeactivateManualDiscountType() {
  return useManualTypeMutation(
    ({ id, expected_version }: { id: string; expected_version: number }) =>
      send(`/api/discounts/manual-types/${id}/deactivate`, 'POST', { expected_version }, 'Failed to deactivate the discount type'),
    (data) => `Discount type "${data.name}" deactivated`,
  );
}
