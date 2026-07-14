'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AdjustIngredientInput,
  BranchInventoryResponse,
  IngredientListResponse,
  InventoryAlertListResponse,
  MovementListResponse,
  MovementResponse,
  MovementType,
  PhysicalCountResultResponse,
  PhysicalCountSubmission,
  StockInInput,
  WasteIngredientInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Phase 7 foundation: ingredient master data, scoped to one branch. */
export function useIngredients(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['ingredients', branchId],
    queryFn: async () => {
      const response = await apiClient<IngredientListResponse>(`/api/inventory/ingredients?branch_id=${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load ingredients'));
      return response.data.ingredients;
    },
    enabled: Boolean(branchId),
    staleTime: 30 * 1000,
  });
}

/** Derived current-stock view for every ingredient at a branch (Phase 8). */
export function useBranchInventory(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch-inventory', branchId],
    queryFn: async () => {
      const response = await apiClient<BranchInventoryResponse>(`/api/branches/${branchId}/inventory`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch inventory'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useBranchInventoryAlerts(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch-inventory', branchId, 'alerts'],
    queryFn: async () => {
      const response = await apiClient<InventoryAlertListResponse>(`/api/branches/${branchId}/inventory/alerts`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory alerts'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export interface MovementFilters {
  ingredient_id?: string;
  movement_type?: MovementType;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
}

function buildMovementsQueryString(filters: MovementFilters): string {
  const params = new URLSearchParams();
  if (filters.ingredient_id) params.set('ingredient_id', filters.ingredient_id);
  if (filters.movement_type) params.set('movement_type', filters.movement_type);
  if (filters.from_date) params.set('from_date', filters.from_date);
  if (filters.to_date) params.set('to_date', filters.to_date);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useInventoryMovements(branchId: string | null | undefined, filters: MovementFilters = {}) {
  return useQuery({
    queryKey: ['branch-inventory', branchId, 'movements', filters],
    queryFn: async () => {
      const response = await apiClient<MovementListResponse>(
        `/api/branches/${branchId}/inventory/movements?${buildMovementsQueryString(filters)}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory movements'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  });
}

/** Every mutation below invalidates both the ingredient list and the branch's derived stock views — a single movement changes what both would return. */
function invalidateInventory(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: ['ingredients', branchId] });
  void queryClient.invalidateQueries({ queryKey: ['branch-inventory', branchId] });
}

export function useStockIn(branchId: string | null | undefined, ingredientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StockInInput) => {
      const response = await apiClient<MovementResponse>(`/api/inventory/ingredients/${ingredientId}/stock-in`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record stock-in'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventory(queryClient, branchId);
      toast.success('Stock-in recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAdjustIngredient(branchId: string | null | undefined, ingredientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdjustIngredientInput) => {
      const response = await apiClient<MovementResponse>(`/api/inventory/ingredients/${ingredientId}/adjust`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record adjustment'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventory(queryClient, branchId);
      toast.success('Adjustment recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useWasteIngredient(branchId: string | null | undefined, ingredientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WasteIngredientInput) => {
      const response = await apiClient<MovementResponse>(`/api/inventory/ingredients/${ingredientId}/waste`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record waste'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventory(queryClient, branchId);
      toast.success('Waste recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useSubmitPhysicalCount(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PhysicalCountSubmission) => {
      const response = await apiClient<PhysicalCountResultResponse>(`/api/branches/${branchId}/inventory/count`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit physical count'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventory(queryClient, branchId);
      toast.success('Physical count submitted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
