'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export type DiscountAuditType = 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';

export interface DiscountAuditRow {
  id: string;
  branchId: string;
  transactionNumber: string;
  discountType: DiscountAuditType;
  discountAmount: string;
  discountCustomerIdEncrypted: string | null;
  discountCustomerIdHash: string | null;
  createdAt: string;
  discountCustomerId: string | null;
  fraudFlagged: boolean;
}

export interface DiscountAuditResponse {
  data: DiscountAuditRow[];
  total: number;
  page: number;
  limit: number;
}

export interface DiscountAuditFilters {
  branch_id?: string;
  discount_type?: DiscountAuditType;
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

function buildQueryString(filters: DiscountAuditFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.discount_type) params.set('discount_type', filters.discount_type);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

/** GET /api/transactions/discount-audit — cross-branch discount trail with fraud-flag correlation. */
export function useDiscountAudit(filters: DiscountAuditFilters = {}) {
  return useQuery({
    queryKey: ['transactions', 'discount-audit', filters],
    queryFn: async () => {
      const response = await apiClient<DiscountAuditResponse>(`/api/transactions/discount-audit?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load discount audit trail'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
