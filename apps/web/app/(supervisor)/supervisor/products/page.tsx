'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import type { ProductBranchView, ProductResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchInput } from '@/components/shared/forms/search-input';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { useBranch } from '@/hooks/use-branch';
import { useBranches } from '@/hooks/queries/use-branches';
import { useProducts } from '@/hooks/queries/use-products';
import { useProductBuilderStore } from '@/stores/product-builder.store';
import { canEditProductInPlace } from '@/lib/product-authority';
import { ProductListRow, type ProductRowAction } from '@/components/supervisor/products/product-list-row';
import { ProductEditorDialog, type ProductEditorTab } from '@/components/supervisor/products/product-editor-dialog';
import { DeactivateProductDialog } from '@/components/supervisor/products/deactivate-product-dialog';
import { RemoveProductDialog } from '@/components/supervisor/products/remove-product-dialog';

const PAGE_SIZE = 25;

const VIEW_LABELS: Record<ProductBranchView, string> = { active: 'Active', drafts: 'Drafts', inactive: 'Inactive' };

const EMPTY_COPY: Record<ProductBranchView, { title: string; description: string }> = {
  active: { title: 'Nothing on POS here yet', description: 'Products you publish at this branch show up here.' },
  drafts: { title: 'No drafts', description: 'Products you started with Create Product and haven’t put on POS yet show up here.' },
  inactive: { title: 'No inactive products', description: 'Products set up for this branch but off POS here — including archived ones — show up here.' },
};

/**
 * POS-PERF-P39 — compact product list for the selected branch (the sidebar's
 * branch selector), split into Active / Drafts / Inactive tabs. The server
 * classifies (GET /api/products?branch_id&view, see
 * productListResponseSchema), so each product is in exactly one tab for this
 * branch and the counts, search and pages all use the same filters.
 */
export default function SupervisorProductsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { activeBranchId, activeBranch } = useBranch();
  const resetBuilder = useProductBuilderStore((state) => state.reset);
  const loadExisting = useProductBuilderStore((state) => state.loadExisting);
  const [view, setView] = useState<ProductBranchView>('active');
  const [search, setSearch] = useState('');
  // SearchInput already debounces its onChange.
  const debouncedSearch = search.trim();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ productId: string; tab: ProductEditorTab } | null>(null);
  const [deactivating, setDeactivating] = useState<ProductResponse | null>(null);
  const [removing, setRemoving] = useState<ProductResponse | null>(null);

  // A different branch, tab or search starts again from page 1.
  useEffect(() => setPage(1), [activeBranchId, view, debouncedSearch]);

  const { data, isLoading, isFetching, isError, isPlaceholderData, refetch } = useProducts({
    branchId: activeBranchId ?? undefined,
    view,
    search: debouncedSearch || undefined,
    sortBy: 'name',
    sortOrder: 'asc',
    page,
    limit: PAGE_SIZE,
  }, { enabled: Boolean(activeBranchId) });
  // useProducts keeps the previous page's rows while the next loads. That is
  // fine for a new search or page within the same tab, but rows from another
  // branch or another tab would be shown under the wrong label — those wait
  // for their own answer instead.
  const viewKey = `${activeBranchId}:${view}`;
  const settledViewKey = useRef<string | null>(null);
  if (data && !isPlaceholderData) settledViewKey.current = viewKey;
  const listIsForThisBranch = Boolean(data) && (!isPlaceholderData || settledViewKey.current === viewKey);
  const products = listIsForThisBranch ? (data?.products ?? []) : [];
  const counts = listIsForThisBranch ? data?.counts : undefined;
  // Only the branch id survives a reload (branch.store); the name comes from the sidebar selector's own (cached) branch list.
  const { data: branchData } = useBranches({ status: 'active', limit: 100 });
  const branchName = activeBranch?.name ?? branchData?.branches.find((b) => b.id === activeBranchId)?.name ?? 'this branch';
  const activeBranchIds = user?.branchIds ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  function startNewProduct() {
    // POS-PERF-P36 — Create Product always starts a fresh builder draft.
    resetBuilder();
    router.push('/supervisor/products/builder');
  }

  function handleAction(action: ProductRowAction, product: ProductResponse) {
    if (action === 'continue') {
      // Reopens the saved builder draft exactly where its saved configuration is.
      loadExisting(product.id);
      router.push(`/supervisor/products/builder?product_id=${product.id}`);
    } else if (action === 'edit') {
      setEditing({ productId: product.id, tab: 'details' });
    } else if (action === 'publish') {
      setEditing({ productId: product.id, tab: 'branches' });
    } else if (action === 'deactivate') {
      setDeactivating(product);
    } else {
      setRemoving(product);
    }
  }

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="app-title mr-auto font-bold">Products</h1>
        <SearchInput value={search} onChange={setSearch} placeholder="Search products..." className="w-full sm:w-64" />
        <Button onClick={startNewProduct} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Product
        </Button>
      </div>

      {!activeBranchId ? (
        <EmptyState title="Select a branch" description="Choose a branch in the sidebar to see its products." />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={view} onValueChange={(value) => setView(value as ProductBranchView)}>
              <TabsList aria-label="Product status">
                {(Object.keys(VIEW_LABELS) as ProductBranchView[]).map((value) => (
                  <TabsTrigger key={value} value={value} data-testid={`products-tab-${value}`}>
                    {VIEW_LABELS[value]}
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{counts ? counts[value] : '–'}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              At {branchName}
              {isFetching && !isLoading && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Updating…
                </span>
              )}
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border bg-card">
            <div
              aria-hidden="true"
              className="hidden grid-cols-[3rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.6fr)_9rem_auto] gap-x-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
            >
              <span />
              <span>Product</span>
              <span>Category</span>
              <span>Branches</span>
              <span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            {/* A failed request for this tab/branch is an error even while another tab's rows are still held. */}
            {isError && !listIsForThisBranch ? (
              <div className="p-6">
                <ErrorState retry={() => void refetch()} />
              </div>
            ) : !listIsForThisBranch ? (
              <ul aria-label="Loading products" className="divide-y">
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="h-12 w-12 rounded-md" />
                    <Skeleton className="h-4 w-1/3" />
                  </li>
                ))}
              </ul>
            ) : products.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={debouncedSearch ? 'No matching products' : EMPTY_COPY[view].title}
                  description={debouncedSearch ? `Nothing in ${VIEW_LABELS[view]} matches "${debouncedSearch}".` : EMPTY_COPY[view].description}
                />
              </div>
            ) : (
              <ul className="divide-y" aria-label={`${VIEW_LABELS[view]} products`} data-testid="products-list">
                {products.map((product) => (
                  <ProductListRow
                    key={product.id}
                    product={product}
                    view={view}
                    branchName={branchName}
                    canEdit={canEditProductInPlace(
                      { ...product, configuredBranchIds: (product.branches ?? []).map((b) => b.branch_id) },
                      activeBranchIds,
                    )}
                    canDeactivate={activeBranchIds.includes(activeBranchId)}
                    onAction={handleAction}
                  />
                ))}
              </ul>
            )}
          </div>

          {data && data.total > PAGE_SIZE && listIsForThisBranch && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {editing && <ProductEditorDialog productId={editing.productId} initialTab={editing.tab} onClose={() => setEditing(null)} />}
      {deactivating && activeBranchId && (
        <DeactivateProductDialog product={deactivating} branch={{ id: activeBranchId, name: branchName }} onOpenChange={(open) => !open && setDeactivating(null)} />
      )}
      {removing && <RemoveProductDialog product={removing} onOpenChange={(open) => !open && setRemoving(null)} />}
    </div>
  );
}
