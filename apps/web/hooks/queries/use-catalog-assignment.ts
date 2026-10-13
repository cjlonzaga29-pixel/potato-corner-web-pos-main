'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CatalogResourceType } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface UnmanagedResource {
  id: string;
  label: string;
  created_by: string | null;
}

export interface UnmanagedListResponse {
  resources: UnmanagedResource[];
  total: number;
  page: number;
  limit: number;
}

export interface AssignmentImpactPreview {
  resource_type: CatalogResourceType;
  resource_id: string;
  resource_label: string;
  current_created_by: string | null;
  current_managed_by: string | null;
  current_manager_label: string | null;
  dependent_summary: { resource_type: CatalogResourceType; count: number; distinct_other_managers: number }[];
  eligible_branch_ids: string[] | null;
}

export interface CreateCatalogAssignmentInput {
  resource_type: CatalogResourceType;
  resource_id: string;
  supervisor_id: string;
  reason: string;
}

// POS-PERF-P35R — the Super Admin catalog-management assignment surface.
// Every write here goes through POST /api/catalog-assignments, the one
// path allowed to set managedBy; see catalog-assignment.service.ts.

export function useUnmanagedCatalogResources(resourceType: CatalogResourceType, page = 1, limit = 25) {
  return useQuery({
    queryKey: ['catalog-assignments', 'unmanaged', resourceType, page, limit],
    queryFn: async () => {
      const response = await apiClient<UnmanagedListResponse>(
        `/api/catalog-assignments/unmanaged?resource_type=${resourceType}&page=${page}&limit=${limit}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load unmanaged catalog resources'));
      return response.data;
    },
    staleTime: 30 * 1000,
  });
}

export function useCatalogAssignmentPreview(resourceType: CatalogResourceType | null, resourceId: string | null) {
  return useQuery({
    queryKey: ['catalog-assignments', 'preview', resourceType, resourceId],
    queryFn: async () => {
      const response = await apiClient<AssignmentImpactPreview>(
        `/api/catalog-assignments/preview?resource_type=${resourceType}&resource_id=${resourceId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load the impact preview'));
      return response.data;
    },
    enabled: Boolean(resourceType && resourceId),
  });
}

export function useCreateCatalogAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCatalogAssignmentInput) => {
      const response = await apiClient<{ id: string }>('/api/catalog-assignments', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to assign catalog management'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['catalog-assignments'] });
      toast.success('Catalog management assigned');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
