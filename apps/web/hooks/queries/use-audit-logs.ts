'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { AuditLogListResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

export interface AuditLogFilters {
  action?: string;
  entity_type?: string;
  branch_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.entity_type) params.set('entity_type', filters.entity_type);
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useAuditLogs(filters: AuditLogFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: async () => {
      const response = await apiClient<AuditLogListResponse>(`/api/audit?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load audit logs'));
      return response.data;
    },
    enabled,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
