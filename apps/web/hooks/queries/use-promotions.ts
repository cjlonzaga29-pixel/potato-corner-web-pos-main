'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePromotionInput,
  PromotionEligibleProduct,
  PromotionResponse,
  SetPromotionEnabledInput,
  UpdatePromotionInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string; details?: unknown } | string | null;
}

/** POS-PERF-P49 — keeps the server's code/details so the editor can explain ineligible products and conflicts inline. */
export class PromotionApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'PromotionApiError';
  }
}

function toError(response: ApiErrorShape, fallback: string): PromotionApiError {
  if (!response.error) return new PromotionApiError(fallback, undefined, undefined);
  if (typeof response.error === 'string') return new PromotionApiError(response.error, undefined, undefined);
  return new PromotionApiError(response.error.message ?? fallback, response.error.code, response.error.details);
}

/** True when the API predates P49 (no promotions route) — the page says so instead of showing an empty list. */
export function isPromotionsUnsupported(error: unknown): boolean {
  return error instanceof PromotionApiError && error.code === 'NOT_FOUND';
}

export function usePromotions() {
  return useQuery({
    queryKey: ['promotions'],
    queryFn: async () => {
      const response = await apiClient<PromotionResponse[]>('/api/discounts/promotions');
      if (!response.data) throw toError(response, 'Failed to load promotions');
      return response.data;
    },
    retry: (count, error) => !isPromotionsUnsupported(error) && count < 2,
  });
}

export function usePromotionEligibleProducts(enabled: boolean) {
  return useQuery({
    queryKey: ['promotions', 'eligible-products'],
    queryFn: async () => {
      const response = await apiClient<PromotionEligibleProduct[]>('/api/discounts/promotions/eligible-products');
      if (!response.data) throw toError(response, 'Failed to load products');
      return response.data;
    },
    enabled,
  });
}

function useInvalidatePromotionData() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['promotions'] });
    // The POS catalog carries the resolved promotion per size.
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };
}

export function useCreatePromotion() {
  const invalidate = useInvalidatePromotionData();
  return useMutation({
    mutationFn: async (input: CreatePromotionInput) => {
      const response = await apiClient<PromotionResponse>('/api/discounts/promotions', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw toError(response, 'Failed to create the promotion');
      return response.data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdatePromotion(promotionId: string | null) {
  const invalidate = useInvalidatePromotionData();
  return useMutation({
    mutationFn: async (input: UpdatePromotionInput) => {
      const response = await apiClient<PromotionResponse>(`/api/discounts/promotions/${promotionId}`, { method: 'PUT', body: JSON.stringify(input) });
      if (!response.data) throw toError(response, 'Failed to save the promotion');
      return response.data;
    },
    onSuccess: invalidate,
  });
}

export function useSetPromotionEnabled() {
  const invalidate = useInvalidatePromotionData();
  return useMutation({
    mutationFn: async ({ promotionId, ...input }: SetPromotionEnabledInput & { promotionId: string }) => {
      const response = await apiClient<PromotionResponse>(`/api/discounts/promotions/${promotionId}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw toError(response, 'Failed to change the promotion');
      return response.data;
    },
    onSuccess: invalidate,
  });
}
