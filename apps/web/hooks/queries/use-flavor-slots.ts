'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AddFlavorSlotRequest, AddSnackOptionRequest, FlavorSlotResponse, UpdateFlavorSlotRequest } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function slotsKey(variantId: string) {
  return ['flavor-slots', variantId];
}

/** POS-PERF-P36R — Mix & Max slot editor data. One ProductFlavorSlot row per customer-facing choice (e.g. "Flavor 1", "Flavor 2"); each carries its own snack_options (which other ProductVariants are sellable into it). */
export function useFlavorSlots(productId: string, variantId: string | null | undefined) {
  return useQuery({
    queryKey: slotsKey(variantId ?? ''),
    queryFn: async () => {
      const response = await apiClient<FlavorSlotResponse[]>(`/api/products/${productId}/variants/${variantId}/flavor-slots`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load flavor slots'));
      return response.data;
    },
    enabled: Boolean(productId) && Boolean(variantId),
    staleTime: 30 * 1000,
  });
}

export function useAddFlavorSlot(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddFlavorSlotRequest) => {
      const response = await apiClient<FlavorSlotResponse>(`/api/products/${productId}/variants/${variantId}/flavor-slots`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to add flavor slot'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: slotsKey(variantId) });
      toast.success('Flavor slot added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateFlavorSlot(productId: string, variantId: string, slotId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateFlavorSlotRequest) => {
      const response = await apiClient<FlavorSlotResponse>(`/api/products/${productId}/variants/${variantId}/flavor-slots/${slotId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update flavor slot'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: slotsKey(variantId) });
      toast.success('Flavor slot updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useRemoveFlavorSlot(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slotId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}/variants/${variantId}/flavor-slots/${slotId}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove flavor slot'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: slotsKey(variantId) });
      toast.success('Flavor slot removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAddSnackOption(productId: string, variantId: string, slotId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddSnackOptionRequest) => {
      const response = await apiClient<{ id: string; snack_product_variant_id: string }>(
        `/api/products/${productId}/variants/${variantId}/flavor-slots/${slotId}/snack-options`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to add snack option'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: slotsKey(variantId) });
      toast.success('Snack option added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useRemoveSnackOption(productId: string, variantId: string, slotId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (snackOptionId: string) => {
      const response = await apiClient<null>(
        `/api/products/${productId}/variants/${variantId}/flavor-slots/${slotId}/snack-options/${snackOptionId}`,
        { method: 'DELETE', body: JSON.stringify({}) },
      );
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove snack option'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: slotsKey(variantId) });
      toast.success('Snack option removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
