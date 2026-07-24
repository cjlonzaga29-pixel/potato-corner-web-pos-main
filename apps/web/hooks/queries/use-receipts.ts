'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export interface PublicReceiptItem {
  product_name: string;
  variant_name: string;
  flavor_name: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface PublicReceipt {
  receipt_number: string;
  branch_name: string;
  status: 'completed' | 'voided' | 'refunded';
  created_at: string;
  items: PublicReceiptItem[];
  subtotal: number;
  discount_amount: number;
  discount_type: string | null;
  vat_amount: number;
  total_amount: number;
  payment_method: string;
  cash_tendered: number | null;
  change_given: number | null;
  gcash_reference_number: string | null;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Backs the public, unauthenticated `/r/[txn]` receipt view — no login required, matches `GET /api/receipts/:transactionNumber`. */
export function usePublicReceipt(transactionNumber: string | null | undefined) {
  return useQuery({
    queryKey: ['public-receipt', transactionNumber],
    queryFn: async () => {
      const response = await apiClient<PublicReceipt>(`/api/receipts/${encodeURIComponent(transactionNumber ?? '')}`);
      if (!response.data) throw new Error(errorMessage(response, 'Receipt not found'));
      return response.data;
    },
    enabled: Boolean(transactionNumber),
    retry: false,
  });
}
