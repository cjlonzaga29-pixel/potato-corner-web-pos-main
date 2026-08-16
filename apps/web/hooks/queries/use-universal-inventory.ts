'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  AdjustInventoryStockInput,
  AssignInventoryItemToBranchesInput,
  AssignInventoryItemToBranchesResponse,
  BranchInventoryStockListResponse,
  CreateInventoryCategoryInput,
  CreateInventoryCostCorrectionInput,
  CreateInventoryItemInput,
  CreateInventoryItemUnitConversionInput,
  CreateUnitConversionInput,
  CreateUnitOfMeasureInput,
  InventoryCategoryResponse,
  InventoryCostCorrectionListResponse,
  InventoryCostCorrectionResponse,
  InventoryItemDetailResponse,
  InventoryItemResponse,
  InventoryItemUnitConversionResponse,
  InventoryStockAlertListResponse,
  InventoryStockMovementListResponse,
  InventoryStockMovementResponse,
  InventoryStockTransferResponse,
  PhysicalCountInventoryStockInput,
  PhysicalCountStockResultResponse,
  ReceiveInventoryStockInput,
  TransferDestinationListResponse,
  TransferInventoryStockInput,
  UnitConversionResponse,
  UnitOfMeasureResponse,
  UpdateInventoryCategoryInput,
  UpdateInventoryItemInput,
  UpdateInventoryItemUnitConversionInput,
  UpdateUnitOfMeasureInput,
  WasteInventoryStockInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

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

// --- Item-specific unit conversions (TASK 121 — reuses TASK 115's backend) ---

export function useInventoryItemConversions(itemId: string | null | undefined) {
  return useQuery({
    queryKey: ['inventory-item-conversions', itemId],
    queryFn: async () => {
      const response = await apiClient<{ conversions: InventoryItemUnitConversionResponse[] }>(
        `/api/universal-inventory/items/${itemId}/conversions`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load unit conversions'));
      return response.data.conversions;
    },
    enabled: Boolean(itemId),
    staleTime: 30 * 1000,
  });
}

export function useCreateInventoryItemConversion(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInventoryItemUnitConversionInput) => {
      const response = await apiClient<InventoryItemUnitConversionResponse>(`/api/universal-inventory/items/${itemId}/conversions`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create conversion'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-item-conversions', itemId] });
      toast.success('Conversion created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateInventoryItemConversion(itemId: string, conversionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateInventoryItemUnitConversionInput) => {
      const response = await apiClient<InventoryItemUnitConversionResponse>(
        `/api/universal-inventory/items/${itemId}/conversions/${conversionId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update conversion'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-item-conversions', itemId] });
      toast.success('Conversion updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteInventoryItemConversion(itemId: string, conversionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<{ id: string }>(`/api/universal-inventory/items/${itemId}/conversions/${conversionId}`, {
        method: 'DELETE',
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to delete conversion'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-item-conversions', itemId] });
      toast.success('Conversion deleted');
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

// ---------------------------------------------------------------------------
// Branch inventory cutover — direct InventoryStock read/write. Replaces the
// legacy Ingredient-based branch inventory hooks (use-inventory.ts) as the
// active branch supply-side workflow; that file is left in place, unmodified,
// for historical/back-compat reads only.
// ---------------------------------------------------------------------------

export function useBranchInventoryStock(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId],
    queryFn: async () => {
      const response = await apiClient<BranchInventoryStockListResponse>(`/api/branches/${branchId}/inventory-stock`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch inventory'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useBranchInventoryStockAlerts(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId, 'alerts'],
    queryFn: async () => {
      const response = await apiClient<InventoryStockAlertListResponse>(`/api/branches/${branchId}/inventory-stock/alerts`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory alerts'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export interface InventoryStockMovementFilters {
  inventory_item_id?: string;
  movement_type?: InventoryStockMovementResponse['movement_type'];
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
}

function buildStockMovementsQueryString(filters: InventoryStockMovementFilters): string {
  const params = new URLSearchParams();
  if (filters.inventory_item_id) params.set('inventory_item_id', filters.inventory_item_id);
  if (filters.movement_type) params.set('movement_type', filters.movement_type);
  if (filters.from_date) params.set('from_date', filters.from_date);
  if (filters.to_date) params.set('to_date', filters.to_date);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useInventoryStockMovements(branchId: string | null | undefined, filters: InventoryStockMovementFilters = {}) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId, 'movements', filters],
    queryFn: async () => {
      const response = await apiClient<InventoryStockMovementListResponse>(
        `/api/branches/${branchId}/inventory-stock/movements?${buildStockMovementsQueryString(filters)}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory movements'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  });
}

/** Every mutation below invalidates the branch's stock list, alerts, and movement history — a single movement changes what all three would return. */
function invalidateInventoryStock(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: ['branch-inventory-stock', branchId] });
}

/** Keeps the branch inventory DataTable and alert banner in sync with stock movements recorded from any other device (including POS sales), without a manual refresh. */
export function useInventoryStockRealtimeSync(branchId: string | null | undefined): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_LOW_STOCK, SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED],
    [['branch-inventory-stock', branchId]],
  );
}

export function useReceiveInventoryStock(branchId: string | null | undefined, inventoryItemId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReceiveInventoryStockInput) => {
      const response = await apiClient<InventoryStockMovementResponse>(
        `/api/branches/${branchId}/inventory-stock/${inventoryItemId}/receive`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to receive stock'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      toast.success('Stock received');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAdjustInventoryStock(branchId: string | null | undefined, inventoryItemId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdjustInventoryStockInput) => {
      const response = await apiClient<InventoryStockMovementResponse>(
        `/api/branches/${branchId}/inventory-stock/${inventoryItemId}/adjust`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record adjustment'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      toast.success('Adjustment recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useWasteInventoryStock(branchId: string | null | undefined, inventoryItemId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WasteInventoryStockInput) => {
      const response = await apiClient<InventoryStockMovementResponse>(
        `/api/branches/${branchId}/inventory-stock/${inventoryItemId}/waste`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record waste'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      toast.success('Waste recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Transfer-destination candidates authorized by the backend for this source branch/actor (Transfer RBAC policy) — the picker must never offer a branch the backend would reject. */
export function useTransferDestinationBranches(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId, 'transfer-destinations'],
    queryFn: async () => {
      const response = await apiClient<TransferDestinationListResponse>(`/api/branches/${branchId}/inventory-stock/transfer-destinations`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load transfer destinations'));
      return response.data.branches;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
  });
}

/** Branch-to-branch transfer — posts both the source's transfer_out and the destination's transfer_in atomically. `branchId` is the source (from) branch, taken from the URL, not the request body. */
export function useTransferInventoryStock(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransferInventoryStockInput) => {
      const response = await apiClient<InventoryStockTransferResponse>(`/api/branches/${branchId}/inventory-stock/transfer`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to transfer stock'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      toast.success('Stock transferred');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useSubmitInventoryStockCount(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PhysicalCountInventoryStockInput) => {
      const response = await apiClient<PhysicalCountStockResultResponse>(`/api/branches/${branchId}/inventory-stock/count`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit physical count'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      toast.success('Physical count submitted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// ---------------------------------------------------------------------------
// Receipt/waste photo proof (Receiving Simplification V2 §7-8) — two-step,
// mirrors useUploadExpenseReceipt: the movement already exists (created by
// useReceiveInventoryStock/useWasteInventoryStock above) before this attaches
// a photo to it. Optional — callers only invoke this when the user picked a
// file.
// ---------------------------------------------------------------------------

export function useUploadMovementProof(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ movementId, file }: { movementId: string; file: File }) => {
      const formData = new FormData();
      formData.set('proof', file);
      const response = await apiClient<InventoryStockMovementResponse>(
        `/api/branches/${branchId}/inventory-stock/movements/${movementId}/proof`,
        { method: 'POST', body: formData },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the proof photo'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/**
 * Resolves a fresh signed proof-photo URL for one movement, on demand — used
 * by the Admin Reports "Inventory Movement" tab, whose row data (unlike the
 * branch-scoped Inventory Movements screen) only carries a proof_available
 * Yes/No flag, never a pre-resolved URL, so the report row shape stays safe
 * to also feed CSV/PDF export. Only enabled while a "View Proof" dialog for
 * this movement is open — same pattern as useDiscountProof/usePaymentProof.
 */
export function useMovementProofUrl(branchId: string | null | undefined, movementId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId, 'movement-proof-url', movementId],
    queryFn: async () => {
      const response = await apiClient<{ proof_url: string | null }>(
        `/api/branches/${branchId}/inventory-stock/movements/${movementId}/proof-url`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load proof photo'));
      return response.data;
    },
    enabled: Boolean(branchId) && Boolean(movementId) && enabled,
  });
}

// ---------------------------------------------------------------------------
// Cost correction (Receiving Simplification V2 §12-15) — controlled,
// audited change to a branch's current carrying cost. adminOrSupervisor
// only; branch accounts never see these hooks invoked since the UI that
// calls them is itself role-gated (server independently enforces the same
// rule regardless).
// ---------------------------------------------------------------------------

export function useCreateInventoryCostCorrection(branchId: string | null | undefined, inventoryItemId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInventoryCostCorrectionInput) => {
      const response = await apiClient<InventoryCostCorrectionResponse>(
        `/api/branches/${branchId}/inventory-stock/${inventoryItemId}/cost-corrections`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record cost correction'));
      return response.data;
    },
    onSuccess: () => {
      invalidateInventoryStock(queryClient, branchId);
      void queryClient.invalidateQueries({ queryKey: ['branch-inventory-stock', branchId, 'cost-corrections'] });
      toast.success('Cost correction recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export interface InventoryCostCorrectionFilters {
  inventory_item_id?: string;
  page?: number;
  limit?: number;
}

export function useInventoryCostCorrections(branchId: string | null | undefined, filters: InventoryCostCorrectionFilters = {}) {
  return useQuery({
    queryKey: ['branch-inventory-stock', branchId, 'cost-corrections', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.inventory_item_id) params.set('inventory_item_id', filters.inventory_item_id);
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));
      const response = await apiClient<InventoryCostCorrectionListResponse>(
        `/api/branches/${branchId}/inventory-stock/cost-corrections?${params.toString()}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load cost correction history'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useUploadCostCorrectionProof(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ correctionId, file }: { correctionId: string; file: File }) => {
      const formData = new FormData();
      formData.set('proof', file);
      const response = await apiClient<InventoryCostCorrectionResponse>(
        `/api/branches/${branchId}/inventory-stock/cost-corrections/${correctionId}/proof`,
        { method: 'POST', body: formData },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the proof photo'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branch-inventory-stock', branchId, 'cost-corrections'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
