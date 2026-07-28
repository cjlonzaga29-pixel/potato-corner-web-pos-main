'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AssignInventoryItemToBranchesInput,
  AssignInventoryItemToBranchesResponse,
  CreateInventoryCategoryInput,
  CreateInventoryItemInput,
  CreateUnitConversionInput,
  CreateUnitOfMeasureInput,
  InventoryCategoryResponse,
  InventoryItemDetailResponse,
  InventoryItemResponse,
  UnitConversionResponse,
  UnitOfMeasureResponse,
  UpdateInventoryCategoryInput,
  UpdateInventoryItemInput,
  UpdateUnitOfMeasureInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

// --- Inventory Categories ---

export function useInventoryCategories(includeInactive = false) {
  return useQuery({
    queryKey: ['inventory-categories', includeInactive],
    queryFn: async () => {
      const response = await apiClient<{ categories: InventoryCategoryResponse[] }>(
        `/api/universal-inventory/categories?include_inactive=${includeInactive}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory categories'));
      return response.data.categories;
    },
    staleTime: 30 * 1000,
  });
}

export function useCreateInventoryCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInventoryCategoryInput) => {
      const response = await apiClient<InventoryCategoryResponse>('/api/universal-inventory/categories', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create category'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-categories'] });
      toast.success('Inventory category created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateInventoryCategory(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateInventoryCategoryInput) => {
      const response = await apiClient<InventoryCategoryResponse>(`/api/universal-inventory/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update category'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-categories'] });
      toast.success('Inventory category updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// --- Units of measure ---

export function useUnitsOfMeasure(includeInactive = false) {
  return useQuery({
    queryKey: ['units-of-measure', includeInactive],
    queryFn: async () => {
      const response = await apiClient<{ units: UnitOfMeasureResponse[] }>(
        `/api/universal-inventory/units?include_inactive=${includeInactive}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load units'));
      return response.data.units;
    },
    staleTime: 30 * 1000,
  });
}

export function useCreateUnitOfMeasure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUnitOfMeasureInput) => {
      const response = await apiClient<UnitOfMeasureResponse>('/api/universal-inventory/units', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create unit'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['units-of-measure'] });
      toast.success('Unit created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateUnitOfMeasure(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateUnitOfMeasureInput) => {
      const response = await apiClient<UnitOfMeasureResponse>(`/api/universal-inventory/units/${unitId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update unit'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['units-of-measure'] });
      toast.success('Unit updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// --- Unit conversions ---

export function useUnitConversions() {
  return useQuery({
    queryKey: ['unit-conversions'],
    queryFn: async () => {
      const response = await apiClient<{ conversions: UnitConversionResponse[] }>('/api/universal-inventory/conversions');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load unit conversions'));
      return response.data.conversions;
    },
    staleTime: 30 * 1000,
  });
}

export function useCreateUnitConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUnitConversionInput) => {
      const response = await apiClient<UnitConversionResponse>('/api/universal-inventory/conversions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create conversion'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['unit-conversions'] });
      toast.success('Unit conversion created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// --- Inventory items (universal identity) ---

export function useInventoryItems(includeInactive = false) {
  return useQuery({
    queryKey: ['inventory-items', includeInactive],
    queryFn: async () => {
      const response = await apiClient<{ items: InventoryItemResponse[] }>(
        `/api/universal-inventory/items?include_inactive=${includeInactive}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory items'));
      return response.data.items;
    },
    staleTime: 30 * 1000,
  });
}

export function useInventoryItem(itemId: string | null | undefined) {
  return useQuery({
    queryKey: ['inventory-item', itemId],
    queryFn: async () => {
      const response = await apiClient<InventoryItemDetailResponse>(`/api/universal-inventory/items/${itemId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory item'));
      return response.data;
    },
    enabled: Boolean(itemId),
    staleTime: 30 * 1000,
  });
}

export function useCreateInventoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInventoryItemInput) => {
      const response = await apiClient<InventoryItemResponse>('/api/universal-inventory/items', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create inventory item'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-items'] });
      toast.success('Inventory item created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateInventoryItem(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateInventoryItemInput) => {
      const response = await apiClient<InventoryItemResponse>(`/api/universal-inventory/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update inventory item'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-item', itemId] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-items'] });
      toast.success('Inventory item updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAssignInventoryItemToBranches(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignInventoryItemToBranchesInput) => {
      const response = await apiClient<AssignInventoryItemToBranchesResponse>(`/api/universal-inventory/items/${itemId}/branches`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to assign branches'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-item', itemId] });
      toast.success('Branch assignment updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// --- Legacy migration report (read-only) ---

export function useMigrationReport(enabled: boolean) {
  return useQuery({
    queryKey: ['inventory-migration-report'],
    queryFn: async () => {
      const response = await apiClient<Record<string, unknown>>('/api/universal-inventory/migration-report');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load migration report'));
      return response.data;
    },
    enabled,
    staleTime: 0,
  });
}
