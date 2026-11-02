'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MANUAL_DISCOUNT_POS_CAPABILITY } from '@potato-corner/shared';
import type {
  CreateManualDiscountTypeInput,
  ManualDiscountTypeResponse,
  PosManualDiscountType,
  ProductListResponse,
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

/** POS-PERF-P55 — a refused discount-type save; `code` is the server's (e.g. MANUAL_DISCOUNT_TYPE_CONFLICT, MANUAL_DISCOUNT_PRODUCT_INVALID). */
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

const PRODUCT_PAGE_SIZE = 100;
const RETIRED_PRODUCT_STATUSES: readonly string[] = ['archived', 'discontinued'];

/**
 * POS-PERF-P57 — every current product set up at any of these branches, for the
 * discount editor's checklist. Reads all pages, so "Select all" means all and
 * not the first page. The server re-checks whatever is saved.
 */
export function useDiscountEligibleProducts(branchIds: readonly string[]) {
  const results = useQueries({
    queries: branchIds.map((branchId) => ({
      queryKey: [...KEY, 'eligible-products', branchId],
      queryFn: async () => {
        const products: { id: string; name: string }[] = [];
        for (let page = 1; ; page += 1) {
          const response = await apiClient<ProductListResponse>(`/api/products?branch_id=${encodeURIComponent(branchId)}&sort_by=name&sort_order=asc&page=${page}&limit=${PRODUCT_PAGE_SIZE}`);
          if (!response.data) throw new Error(errorMessage(response, 'Failed to load products'));
          products.push(...response.data.products.filter((product) => !RETIRED_PRODUCT_STATUSES.includes(product.status)).map((product) => ({ id: product.id, name: product.name })));
          if (page * PRODUCT_PAGE_SIZE >= response.data.total) return products;
        }
      },
    })),
  });
  const isError = results.some((result) => result.isError);
  const ready = results.every((result) => result.data !== undefined);
  const byId = new Map(results.flatMap((result) => result.data ?? []).map((product) => [product.id, product]));
  return {
    data: ready && results.length > 0 ? [...byId.values()] : undefined,
    isError,
    refetch: () => results.forEach((result) => void result.refetch()),
  };
}

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
/**
 * P55 release fix — a pre-P55 API has no discount-types route (404
 * NOT_FOUND). That is not a transient failure: Retry cannot help until the
 * API is updated, so the checkout says so instead of offering Retry.
 */
export class ManualDiscountsUnsupportedError extends Error {
  constructor() {
    super('Manual discounts are not available on this server yet.');
    this.name = 'ManualDiscountsUnsupportedError';
  }
}

export function usePosManualDiscountTypes(branchId: string | null | undefined) {
  const { accessToken, isLoading } = useAuth();
  return useQuery({
    queryKey: [...KEY, 'pos', branchId],
    queryFn: async () => {
      const response = await apiClient<PosManualDiscountType[]>(`/api/discounts/manual-types/pos?branch_id=${encodeURIComponent(branchId as string)}&capabilities=${MANUAL_DISCOUNT_POS_CAPABILITY}`);
      if (!response.data) {
        if (typeof response.error === 'object' && response.error?.code === 'NOT_FOUND') throw new ManualDiscountsUnsupportedError();
        throw new Error(errorMessage(response, 'Failed to load discount types'));
      }
      return response.data;
    },
    enabled: !!accessToken && !isLoading && !!branchId,
    retry: (failureCount, error) => !(error instanceof ManualDiscountsUnsupportedError) && failureCount < 1,
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
