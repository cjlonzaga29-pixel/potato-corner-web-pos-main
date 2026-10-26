'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SOCKET_EVENTS,
  type BranchProductAvailabilityRow,
  type BulkBranchProductAvailabilityResponse,
  type CartAvailabilityCheckInput,
  type CartAvailabilityResult,
  type ChangeProductStatusInput,
  type CreateProductInput,
  type CreateVariantInput,
  type LinkVariantFlavorInput,
  type PosCatalogResponse,
  type ProductDetailResponse,
  type ProductImageResponse,
  type ProductListResponse,
  type ProductReadiness,
  type ProductStatus,
  type ProductVariantResponse,
  type PublicationCheckResponse,
  type UpdateProductInput,
  type UpdateVariantFlavorInput,
  type UpdateVariantInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { PRODUCT_CACHE_REFRESH_MINUTES } from '@/lib/constants';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface ProductFilters {
  status?: ProductStatus;
  category?: string;
  search?: string;
  isSeasonal?: boolean;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_at' | 'updated_at' | 'display_order' | 'status';
  sortOrder?: 'asc' | 'desc';
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/**
 * POS-PERF-P38 — keeps the API's error code next to its message, so the
 * Product Builder can tell a maintenance pause (SERVICE_WRITE_GATE_CLOSED)
 * apart from a real rejection and show it inline instead of guessing from
 * the text. Still an Error, so existing `error.message` callers are unchanged.
 */
export class ProductApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ProductApiError';
  }
}

function errorCode(response: ApiErrorShape): string | undefined {
  if (!response.error) return undefined;
  return typeof response.error === 'string' ? undefined : response.error.code;
}

function productApiError(response: ApiErrorShape, fallback: string): ProductApiError {
  return new ProductApiError(errorMessage(response, fallback), errorCode(response));
}

/**
 * POS-PERF-P38R3 — publication commits on the server before its audit
 * entries are written and before the response is sent, so these errors do
 * not say whether it happened: the request never got an answer
 * (NETWORK_ERROR), got a non-JSON proxy page (UNREADABLE_RESPONSE, e.g. a
 * 502/504), or failed unexpectedly (INTERNAL_ERROR). Every other code is the
 * API rejecting the request before anything was written.
 */
const UNCONFIRMED_PUBLISH_CODES = new Set(['NETWORK_ERROR', 'UNREADABLE_RESPONSE', 'INTERNAL_ERROR']);

function isUnconfirmedPublishError(error: ProductApiError): boolean {
  return error.code === undefined || UNCONFIRMED_PUBLISH_CODES.has(error.code);
}

export type PublicationOutcome = 'published' | 'not_published' | 'unknown';

/**
 * POS-PERF-P38R3 — reads whether the product is on POS at every one of these
 * branches right now, through the read-only publication check (a GET that
 * writes nothing). 'unknown' when the check itself fails.
 *
 * `fresh` makes every read a distinct URL: the service worker serves
 * same-origin /api GETs network-first with a cached fallback (offline, or
 * no answer within 10 s), and a plan cached before the publish would say
 * "not published" for one that committed. With no matching cache entry the
 * read fails instead, which is 'unknown'. The API ignores the extra field.
 */
export async function readPublicationOutcome(productId: string, branchIds: string[]): Promise<PublicationOutcome> {
  const key = [...branchIds].sort().join(',');
  const response = await apiClient<PublicationCheckResponse>(
    `/api/products/${productId}/publication-check?branch_ids=${encodeURIComponent(key)}&fresh=${Date.now()}`,
  );
  if (!response.data) return 'unknown';
  const requested = new Set(branchIds);
  const rows = response.data.branches.filter((b) => requested.has(b.branch_id));
  if (rows.length !== requested.size) return 'unknown';
  return rows.every((b) => b.is_published) ? 'published' : 'not_published';
}

/**
 * POS-PERF-P38R3 — a publish whose answer was lost, after the server's
 * current state was checked: 'not_published' (it is not on POS at all of
 * the branches yet — the earlier attempt may still be finishing, and a retry
 * never adds anything twice), or 'unknown' (the check failed too).
 */
export class PublicationNotConfirmedError extends ProductApiError {
  constructor(
    cause: ProductApiError,
    public readonly outcome: Exclude<PublicationOutcome, 'published'>,
  ) {
    super(cause.message, cause.code);
    this.name = 'PublicationNotConfirmedError';
  }
}

/** Turns a failed publish response into its error, after checking the server's state when the response doesn't say. Returns 'published' if the publication did commit. */
async function reconcilePublishFailure(response: ApiErrorShape, productId: string, branchIds: string[]): Promise<'published'> {
  const error = productApiError(response, 'Failed to publish product');
  if (!isUnconfirmedPublishError(error)) throw error;
  const outcome = await readPublicationOutcome(productId, branchIds);
  if (outcome === 'published') return outcome;
  throw new PublicationNotConfirmedError(error, outcome);
}

function buildQueryString(filters: ProductFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.category) params.set('category', filters.category);
  if (filters.search) params.set('search', filters.search);
  if (filters.isSeasonal !== undefined) params.set('is_seasonal', String(filters.isSeasonal));
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortOrder) params.set('sort_order', filters.sortOrder);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useProducts(filters: ProductFilters = {}) {
  return useQuery({
    queryKey: ['products', filters],
    queryFn: async () => {
      const response = await apiClient<ProductListResponse>(`/api/products?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load products'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useProduct(productId: string | null | undefined) {
  return useQuery({
    queryKey: ['product', productId],
    queryFn: async () => {
      const response = await apiClient<ProductDetailResponse>(`/api/products/${productId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load product'));
      return response.data;
    },
    enabled: Boolean(productId),
    staleTime: 30 * 1000,
  });
}

/** POS terminal catalog (Phase 10) — branch-filtered, availability-checked, override-priced. Distinct from useProducts (admin/supervisor management view). */
export function useCatalog(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['catalog', branchId],
    queryFn: async () => {
      const response = await apiClient<PosCatalogResponse>(`/api/products/catalog?branch_id=${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load the product catalog'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 60 * 1000,
    // Architecture doc §10.1 / cache.ts's own comment: the offline catalog
    // cache must refresh "on connect and at least every 30 minutes during
    // active use." staleTime alone doesn't guarantee that — without an
    // explicit refetchInterval, a terminal session that stays mounted
    // without a refocus/reconnect event to trigger a refetch would just
    // sit on a stale query indefinitely past the 60s staleTime.
    refetchInterval: PRODUCT_CACHE_REFRESH_MINUTES * 60 * 1000,
  });
}

/** Keeps the POS terminal's catalog (item availability/pricing) in sync with stock-driven changes at its own branch, without a manual refresh. */
export function useCatalogRealtimeSync(branchId: string | null | undefined): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK, SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, SOCKET_EVENTS.INVENTORY_LOW_STOCK],
    [['catalog', branchId]],
  );
}

/**
 * POS-PERF-P24 — cart-wide stock pre-check, called at discrete cashier
 * checkpoints (Add-ons/Mix & Max confirm, cart quantity +) — never on every
 * keystroke or product-card render. A mutation (not a query) since it's an
 * on-demand check tied to a user action, not cached/subscribed data.
 */
export function useCheckCartAvailability() {
  return useMutation({
    mutationFn: async (input: CartAvailabilityCheckInput) => {
      const response = await apiClient<CartAvailabilityResult>('/api/products/catalog/availability-check', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to check stock availability'));
      return response.data;
    },
  });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductInput) => {
      const response = await apiClient<ProductDetailResponse>('/api/products', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw productApiError(response, 'Failed to create product');
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProduct(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductInput) => {
      const response = await apiClient<ProductDetailResponse>(`/api/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update product'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// ---------------------------------------------------------------------------
// Task 209.6 — Product Image Management (Admin Only). image_url is always a
// short-lived signed URL minted server-side per request — never cached
// beyond this query's own staleTime, and never a public URL.
// ---------------------------------------------------------------------------

/** enabled defaults to true so a direct GET works standalone, but callers (list thumbnail, edit dialog) pass has_image so a product known to have no image never fires a request. */
export function useProductImage(productId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['product', productId, 'image'],
    queryFn: async () => {
      const response = await apiClient<ProductImageResponse>(`/api/products/${productId}/image`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load the product image'));
      return response.data;
    },
    enabled: Boolean(productId) && enabled,
    staleTime: 30 * 1000,
  });
}

/**
 * productId is a per-call mutation variable, not a hook argument — unlike
 * most mutations in this file, the Create Product dialog doesn't know the
 * product's id until the product itself has just been created in the same
 * submit, so binding productId at hook-creation time (a stale closure by
 * the time the mutation actually fires) would silently upload to the wrong
 * URL. The Edit Product dialog, which does have a stable id, just passes it
 * through on every call instead.
 */
export function useUploadProductImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, file }: { productId: string; file: File }) => {
      const formData = new FormData();
      formData.set('image', file);
      const response = await apiClient<ProductImageResponse>(`/api/products/${productId}/image`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the product image'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['product', variables.productId, 'image'] });
      void queryClient.invalidateQueries({ queryKey: ['product', variables.productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product image uploaded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Same productId-as-mutation-variable shape as useUploadProductImage, for the same reason. */
export function useDeleteProductImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId }: { productId: string }) => {
      const response = await apiClient<ProductImageResponse>(`/api/products/${productId}/image`, { method: 'DELETE' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to delete the product image'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['product', variables.productId, 'image'] });
      void queryClient.invalidateQueries({ queryKey: ['product', variables.productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product image deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useChangeProductStatus(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangeProductStatusInput) => {
      const response = await apiClient<ProductDetailResponse | BranchProductAvailabilityRow>(`/api/products/${productId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to change product status'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      // Product status/lifecycle is not branch-scoped, so it can flip
      // readiness at every branch that carries this product — invalidate all
      // catalog entries rather than guessing which branchIds are affected.
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Product status updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBranchProductAvailability(productId: string | null | undefined) {
  return useQuery({
    queryKey: ['product', productId, 'branch-availability'],
    queryFn: async () => {
      const response = await apiClient<BranchProductAvailabilityRow[]>(`/api/products/${productId}/branch-availability`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch availability'));
      return response.data;
    },
    enabled: Boolean(productId),
    staleTime: 30 * 1000,
  });
}

export function useUpdateBranchProductAvailability(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ branchId, isAvailable }: { branchId: string; isAvailable: boolean }) => {
      const response = await apiClient<BranchProductAvailabilityRow>(`/api/products/${productId}/branch-availability/${branchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_available: isAvailable }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch availability'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog', variables.branchId] });
      toast.success('Branch availability updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBulkUpdateBranchProductAvailability(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updates: { branch_id: string; is_available: boolean }[]) => {
      const response = await apiClient<BulkBranchProductAvailabilityResponse>(
        `/api/products/${productId}/branch-availability/bulk`,
        {
          method: 'PATCH',
          body: JSON.stringify({ updates }),
        },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch availability'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      for (const update of variables) {
        void queryClient.invalidateQueries({ queryKey: ['catalog', update.branch_id] });
      }
      toast.success('Branch availability updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Phase D1 — Admin Readiness panel. branchId 'all' returns a read-only per-branch summary; a specific id returns full readiness detail for that branch. */
function productReadinessQuery(productId: string | null | undefined, branchId: string | null | undefined) {
  return {
    queryKey: ['product', productId, 'readiness', branchId],
    queryFn: async () => {
      const response = await apiClient<ProductReadiness>(`/api/products/${productId}/readiness?branch_id=${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load readiness'));
      return response.data;
    },
    enabled: Boolean(productId) && Boolean(branchId),
    staleTime: 15 * 1000,
  };
}

export function useProductReadiness(productId: string | null | undefined, branchId: string | null | undefined) {
  return useQuery(productReadinessQuery(productId, branchId));
}

/**
 * POS-PERF-P38 — Review's single source of truth: the server's own plan for
 * Add to POS at these branches (the exact decision publish-branches makes),
 * so the button can never disagree with the server about what blocks it.
 * POS-PERF-P38R — the product page reads it for its one branch: the same
 * decision its single-branch publish makes.
 */
export function usePublicationCheck(productId: string | null | undefined, branchIds: string[]) {
  const key = [...branchIds].sort().join(',');
  return useQuery({
    queryKey: ['product', productId, 'publication-check', key],
    queryFn: async () => {
      const response = await apiClient<PublicationCheckResponse>(
        `/api/products/${productId}/publication-check?branch_ids=${encodeURIComponent(key)}`,
      );
      if (!response.data) throw productApiError(response, 'Failed to check this product');
      return response.data;
    },
    enabled: Boolean(productId) && branchIds.length > 0,
  });
}

/**
 * POS-PERF-P36R — mirrors products.service.ts's replaceSharedProductAtBranch
 * gate (and, before POS-PERF-P38R, publishProduct's — the product page's
 * Publish now reads usePublicationCheck instead):
 * BRANCH_NOT_AVAILABLE is the one blocking issue publish itself resolves,
 * so it must never be a precondition for enabling the Publish/"Add to POS"
 * button. readiness.sellable (= blockingIssues.length === 0, no exclusion)
 * does treat it as a precondition — every caller that gated a publish
 * button on `.sellable` directly made a first-time publish of any
 * branch-exclusive product (the only kind a supervisor may create, per
 * POS-PERF-P34R) permanently unclickable, confirmed by actually driving the
 * Simple Product Builder in a real browser. Never remove this exclusion
 * without re-verifying a first publish end-to-end in a browser.
 */
export function isReadyToPublish(readiness: { eligible_variant_count: number; blocking_issues: { code: string }[] } | null | undefined): boolean {
  if (!readiness) return false;
  const gatingBlockers = readiness.blocking_issues.filter((issue) => issue.code !== 'BRANCH_NOT_AVAILABLE');
  return readiness.eligible_variant_count > 0 && gatingBlockers.length === 0;
}

/** Scoped invalidation only (Phase D1 spec): product detail, readiness (every branch view for this product), and the affected branch's catalog — never a global reset. */
function invalidateAfterPublishChange(queryClient: ReturnType<typeof useQueryClient>, productId: string, branchId: string) {
  void queryClient.invalidateQueries({ queryKey: ['product', productId] });
  void queryClient.invalidateQueries({ queryKey: ['product', productId, 'readiness'] });
  void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
  void queryClient.invalidateQueries({ queryKey: ['catalog', branchId] });
}

/**
 * POS-PERF-P38R3 — "Check again" after an unconfirmed publish: reads the
 * server's state (never publishes), refreshes what the page shows, and
 * confirms with the same toast as a normal success when it is on POS.
 */
export function useConfirmPublication(productId: string) {
  const queryClient = useQueryClient();
  return async (branchIds: string[]): Promise<PublicationOutcome> => {
    const outcome = await readPublicationOutcome(productId, branchIds);
    for (const branchId of branchIds) invalidateAfterPublishChange(queryClient, productId, branchId);
    void queryClient.invalidateQueries({ queryKey: ['product', productId, 'publication-check'] });
    if (outcome === 'published') toast.success(branchIds.length === 1 ? 'Product is on POS at this branch' : `Product is on POS at ${branchIds.length} branches`);
    return outcome;
  };
}

export function usePublishProduct(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (branchId: string): Promise<BranchProductAvailabilityRow | 'published'> => {
      const response = await apiClient<BranchProductAvailabilityRow>(`/api/products/${productId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ branch_id: branchId }),
      });
      if (!response.data) return reconcilePublishFailure(response, productId, [branchId]);
      return response.data;
    },
    onSuccess: (_data, branchId) => {
      invalidateAfterPublishChange(queryClient, productId, branchId);
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'publication-check'] });
      toast.success('Product published at this branch');
    },
    onError: (_error, branchId) => {
      // POS-PERF-P38R — same as Add to POS: the product page shows the error
      // inline and persistent, and refetches the plan in case setup changed.
      // POS-PERF-P38R3 — and the product itself, in case an unconfirmed
      // publication commits after all.
      invalidateAfterPublishChange(queryClient, productId, branchId);
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'publication-check'] });
    },
  });
}

/** POS-PERF-P37 — all-or-nothing "Add to POS" across the builder's branch selection. */
export function usePublishProductToBranches(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (branchIds: string[]) => {
      const response = await apiClient<{
        product_id: string;
        branches: BranchProductAvailabilityRow[];
        setup: { stock_links: { branch_id: string; inventory_item_id: string }[] };
      }>(`/api/products/${productId}/publish-branches`, { method: 'POST', body: JSON.stringify({ branch_ids: branchIds }) });
      // POS-PERF-P38R3 — an answer lost after commit resolves as 'published' once the check confirms it.
      if (!response.data) return reconcilePublishFailure(response, productId, branchIds);
      return response.data;
    },
    onSuccess: (_data, branchIds) => {
      for (const branchId of branchIds) invalidateAfterPublishChange(queryClient, productId, branchId);
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'publication-check'] });
      toast.success(branchIds.length === 1 ? 'Product added to POS at this branch' : `Product added to POS at ${branchIds.length} branches`);
    },
    onError: (_error, branchIds) => {
      // A failed publish may mean the setup changed underneath Review —
      // refetch so it shows the current state. Review shows the error
      // itself, inline and persistent (POS-PERF-P38), so no toast here.
      for (const branchId of branchIds) invalidateAfterPublishChange(queryClient, productId, branchId);
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'publication-check'] });
    },
  });
}

export function useUnpublishProduct(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (branchId: string) => {
      const response = await apiClient<BranchProductAvailabilityRow>(`/api/products/${productId}/unpublish`, {
        method: 'POST',
        body: JSON.stringify({ branch_id: branchId }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to unpublish product'));
      return response.data;
    },
    onSuccess: (_data, branchId) => {
      invalidateAfterPublishChange(queryClient, productId, branchId);
      toast.success('Product unpublished at this branch');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/**
 * POS-PERF-P36R5 — "Create Branch Copy": a supervisor with only partial
 * authority over a shared product cannot edit it in place (see
 * catalog-authority.ts). This gives them a branch-exclusive copy, scoped to
 * one branch they do control, that they fully own. Idempotent server-side
 * (findForkCopy before create) — calling this again for the same
 * (product, branch) pair, including after a network failure/retry, returns
 * the same copy rather than creating a duplicate, so the caller can always
 * just retry and navigate to whatever product id comes back.
 */
export function useForkProductToBranch(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (branchId: string) => {
      const response = await apiClient<ProductDetailResponse>(`/api/products/${productId}/fork-to-branch`, {
        method: 'POST',
        body: JSON.stringify({ branch_id: branchId }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create a branch copy of this product'));
      return response.data;
    },
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: ['product', copy.id] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/**
 * POS-PERF-P36R5 — explicit replacement: makes the branch copy the sellable
 * product at its branch and disables the source there, atomically, in one
 * request. Every other branch the source sells at is untouched.
 */
export function useReplaceSourceWithCopy(copyProductId: string, sourceProductId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (branchId: string) => {
      const response = await apiClient<{ copy: BranchProductAvailabilityRow; source: BranchProductAvailabilityRow }>(
        `/api/products/${copyProductId}/replace-source`,
        { method: 'POST', body: JSON.stringify({ branch_id: branchId }) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to replace the source product with this branch copy'));
      return response.data;
    },
    onSuccess: (_data, branchId) => {
      invalidateAfterPublishChange(queryClient, copyProductId, branchId);
      void queryClient.invalidateQueries({ queryKey: ['product', sourceProductId] });
      toast.success('This branch copy now replaces the source product at your branch');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCreateVariant(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVariantInput) => {
      const response = await apiClient<ProductVariantResponse>(`/api/products/${productId}/variants`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create variant'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Variant created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateVariant(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateVariantInput) => {
      const response = await apiClient<ProductVariantResponse>(`/api/products/${productId}/variants/${variantId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update variant'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Variant updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useLinkVariantFlavor(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkVariantFlavorInput) => {
      const response = await apiClient(`/api/products/${productId}/variants/${variantId}/flavors`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to link flavor'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Flavor linked');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (productId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete product'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteVariant(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variantId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}/variants/${variantId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete variant'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Variant deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateVariantFlavor(productId: string, variantId: string, flavorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateVariantFlavorInput) => {
      const response = await apiClient(`/api/products/${productId}/variants/${variantId}/flavors/${flavorId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update flavor pricing'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Flavor pricing updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
