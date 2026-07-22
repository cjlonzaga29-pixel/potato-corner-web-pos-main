'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export interface AuditLogReportRow {
  id: string;
  created_at: string;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  ip_address: string | null;
}

export interface AuditLogReportResponse {
  report_type: string;
  generated_at: string;
  filters: { branch_id?: string; date_from?: string; date_to?: string; page: number; limit: number };
  data: AuditLogReportRow[];
  total: number;
  page: number;
  limit: number;
}

export interface AuditLogReportFilters {
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

function buildQueryString(filters: AuditLogReportFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

/** Login-event audit report — GET /api/reports/audit-log (super_admin only, backend already restricts to login-related actions). */
export function useAuditLogReport(filters: AuditLogReportFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'audit-log', filters],
    queryFn: async () => {
      const response = await apiClient<AuditLogReportResponse>(`/api/reports/audit-log?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load login audit report'));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}
