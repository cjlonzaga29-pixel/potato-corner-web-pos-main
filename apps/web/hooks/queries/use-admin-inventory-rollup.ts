'use client';

import { useQuery } from '@tanstack/react-query';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { AdminInventoryValuationRollupResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}
function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/**
 * Admin-only inventory valuation rollup — no branch_id, aggregates across every branch.
 * InventoryStock/InventoryItem/Branch-sourced (never Ingredient/InventoryMovement), computed
 * fresh on every fetch (no server-side snapshot to go stale) — see
 * reports.service.ts's getInventoryValuationRollupReport.
 */
export function useAdminInventoryRollup() {
  return useQuery({
    queryKey: ['reports', 'ADMIN_INVENTORY_VALUATION_ROLLUP'],
    queryFn: async () => {
      const response = await apiClient<AdminInventoryValuationRollupResponse>('/api/reports/inventory-valuation-rollup');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory rollup'));
      return response.data;
    },
    staleTime: 60_000,
  });
}

/**
 * Keeps the all-branches valuation rollup in sync, without a manual refresh, after any of
 * the operations that can move InventoryStock quantity or value: Receiving, Adjustment,
 * Waste, Transfer, Physical Count (all emit INVENTORY_MOVEMENT_RECORDED from
 * universal-inventory.service.ts), and Sale / Sale Reversal (transactions.service.ts emits
 * TRANSACTION_COMPLETED on sale, TRANSACTION_REFUNDED on refund, VOID_REQUESTED on void —
 * both refund and void run the SALE_REVERSAL stock reversal).
 */
export function useAdminInventoryRollupRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED,
      SOCKET_EVENTS.INVENTORY_LOW_STOCK,
      SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
      SOCKET_EVENTS.TRANSACTION_COMPLETED,
      SOCKET_EVENTS.TRANSACTION_REFUNDED,
      SOCKET_EVENTS.VOID_REQUESTED,
    ],
    [['reports', 'ADMIN_INVENTORY_VALUATION_ROLLUP']],
  );
}
