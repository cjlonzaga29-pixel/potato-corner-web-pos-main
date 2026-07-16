'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  DismissFraudAlertInput,
  EscalateFraudAlertInput,
  FraudAlertListResponse,
  FraudAlertResponse,
  InvestigateFraudAlertInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface FraudAlertFilters {
  status?: FraudAlertResponse['status'];
  severity?: FraudAlertResponse['severity'];
  branch_id?: string;
  alert_type?: string;
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

function buildQueryString(filters: FraudAlertFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.alert_type) params.set('alert_type', filters.alert_type);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useFraudAlerts(filters: FraudAlertFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['fraud-alerts', filters],
    queryFn: async () => {
      const response = await apiClient<FraudAlertListResponse>(`/api/fraud?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load fraud alerts'));
      return response.data;
    },
    enabled,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useFraudAlertById(id: string | null) {
  return useQuery({
    queryKey: ['fraud-alerts', id],
    queryFn: async () => {
      const response = await apiClient<FraudAlertResponse>(`/api/fraud/${id}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load fraud alert'));
      return response.data;
    },
    enabled: Boolean(id),
  });
}

/** Keeps the fraud alerts list (and any open detail view) in sync with alerts raised from any branch, without a manual refresh. */
export function useFraudAlertsRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.FRAUD_ALERT_CREATED], [['fraud-alerts']]);
}

export function useInvestigateAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input?: InvestigateFraudAlertInput }) => {
      const response = await apiClient<FraudAlertResponse>(`/api/fraud/${id}/investigate`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to start investigation'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fraud-alerts'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDismissAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: DismissFraudAlertInput }) => {
      const response = await apiClient<FraudAlertResponse>(`/api/fraud/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to dismiss alert'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fraud-alerts'] });
      toast.success('Alert dismissed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useEscalateAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input?: EscalateFraudAlertInput }) => {
      const response = await apiClient<FraudAlertResponse>(`/api/fraud/${id}/escalate`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to escalate alert'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fraud-alerts'] });
      toast.success('Alert escalated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
