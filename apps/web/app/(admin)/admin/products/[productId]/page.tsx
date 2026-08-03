'use client';

import { use, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus } from 'lucide-react';
import type { ProductDetailResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatDateTime } from '@/lib/utils';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import {
  useProduct,
  useChangeProductStatus,
  useDeleteVariant,
  useProductReadiness,
} from '@/hooks/queries/use-products';
import { BranchSelector } from '@/components/admin/branch-selector';
import { BranchAvailabilityPanel } from '@/components/products/branch-availability-panel';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { VariantCard } from '@/components/admin/products/variant-card';
import { EditProductDialog } from '@/components/admin/products/edit-product-dialog';
import { ChangeProductStatusDialog } from '@/components/admin/products/change-product-status-dialog';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { EditVariantFlavorDialog } from '@/components/admin/products/edit-variant-flavor-dialog';
import { ReadinessChecklist } from '@/components/admin/products/readiness-checklist';

interface ProductDetailPageProps {
  params: Promise<{ productId: string }>;
}

export default function ProductDetailPage({ params }: ProductDetailPageProps) {
  const { productId } = use(params);
  const { data: product, isLoading, isError, refetch } = useProduct(productId);
  const changeStatus = useChangeProductStatus(productId);
  const { selectedBranchId, availableBranches } = useSelectedBranch();
  const selectedBranchName = availableBranches.find((b) => b.id === selectedBranchId)?.name ?? null;

  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !product) {
    return <ErrorState title="Product not found" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/admin/products">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to products
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{product.name}</h1>
            <ProductStatusBadge status={product.status} />
            <SeasonalBadge isSeasonal={product.is_seasonal} />
          </div>
          <p className="text-sm text-muted-foreground">{product.category ?? 'Uncategorized'}</p>
        </div>
        <div className="flex gap-2">
          {product.status === 'archived' ? (
            <Button
              onClick={() => changeStatus.mutate({ status: 'active' })}
              disabled={changeStatus.isPending}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                Edit Product
              </Button>
              <Button onClick={() => setStatusOpen(true)}>Change Status</Button>
              <Button variant="danger" onClick={() => setArchiveOpen(true)}>
                Archive
              </Button>
            </>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variants">Variants & Flavors</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <OverviewTab product={product} />
        </TabsContent>

        <TabsContent value="variants" className="space-y-4">
          <VariantsTab
            product={product}
            selectedBranchId={selectedBranchId}
            selectedBranchName={selectedBranchName}
            onNavigateToTab={setActiveTab}
          />
        </TabsContent>
      </Tabs>

      <EditProductDialog open={editOpen} onOpenChange={setEditOpen} product={product} />
      <ChangeProductStatusDialog open={statusOpen} onOpenChange={setStatusOpen} product={product} />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${product.name}?`}
        description="Archived products disappear from the POS and product selectors, but stay visible in past transactions and reports. You can restore this product to Active at any time."
        confirmLabel="Archive"
        variant="danger"
        onConfirm={async () => {
          await changeStatus.mutateAsync({ status: 'archived' });
        }}
      />
    </div>
  );
}

function OverviewTab({ product }: { product: ProductDetailResponse }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Product Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground">Description</p>
            <p className="font-medium">{product.description ?? 'No description'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Display Order</p>
            <p className="font-medium">{product.display_order ?? '—'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Variants</p>
            <p className="font-medium">
              {product.active_variant_count} active / {product.variant_count} total
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Active Branches</p>
            <p className="font-medium">{product.active_branch_count}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Seasonal Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground">Seasonal</p>
            <p className="font-medium">{product.is_seasonal ? 'Yes' : 'No'}</p>
          </div>
          {product.is_seasonal && (
            <div>
              <p className="text-muted-foreground">Active Window</p>
              <p className="font-medium">
                {product.seasonal_start_date} – {product.seasonal_end_date}
              </p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground">Created By</p>
            <p className="font-medium">
              {product.created_by_user ? `${product.created_by_user.first_name} ${product.created_by_user.last_name}` : 'System'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Created / Updated</p>
            <p className="font-medium">
              {formatDateTime(product.created_at)} / {formatDateTime(product.updated_at)}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VariantsTab({
  product,
  selectedBranchId,
  selectedBranchName,
  onNavigateToTab,
}: {
  product: ProductDetailResponse;
  selectedBranchId: string;
  selectedBranchName: string | null;
  onNavigateToTab: (tab: string) => void;
}) {
  const [variantDialog, setVariantDialog] = useState<{ open: boolean; variant?: ProductVariantResponse }>({ open: false });
  const [linkFlavorFor, setLinkFlavorFor] = useState<ProductVariantResponse | null>(null);
  const [editFlavor, setEditFlavor] = useState<{ variant: ProductVariantResponse; flavor: ProductVariantResponse['flavors'][number] } | null>(
    null,
  );
  const [deletingVariant, setDeletingVariant] = useState<ProductVariantResponse | null>(null);
  const deleteVariant = useDeleteVariant(product.id);
  const readiness = useProductReadiness(product.id, selectedBranchId);
  const availabilitySectionRef = useRef<HTMLDivElement>(null);

  const handleManageBranchAvailability = () => {
    availabilitySectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    availabilitySectionRef.current?.focus?.();
  };

  const isArchived = product.status === 'archived';
  const sortedVariants = [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const inventoryBranchId = selectedBranchId === 'all' ? null : selectedBranchId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <BranchSelector />
        </div>
        <Button size="sm" onClick={() => setVariantDialog({ open: true })} disabled={isArchived}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variant
        </Button>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium">Readiness</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {readiness.isLoading ? (
            <div className="flex justify-center py-4">
              <LoadingSpinner size="sm" />
            </div>
          ) : readiness.isError || !readiness.data ? (
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>Failed to load readiness.</span>
              <Button variant="outline" size="sm" onClick={() => void readiness.refetch()}>
                Retry
              </Button>
            </div>
          ) : readiness.data.scope === 'all_branches' ? (
            <p className="text-sm text-muted-foreground">Select a single branch to see readiness details.</p>
          ) : (
            <ReadinessChecklist
              data={readiness.data}
              onNavigateToTab={onNavigateToTab}
              onManageBranchAvailability={handleManageBranchAvailability}
            />
          )}
        </CardContent>
      </Card>

      {sortedVariants.length === 0 ? (
        <EmptyState title="No variants yet" description="Add a variant to start selling this product." />
      ) : (
        <div className="space-y-3">
          {sortedVariants.map((variant) => (
            <VariantCard
              key={variant.id}
              variant={variant}
              branchId={inventoryBranchId}
              branchName={inventoryBranchId ? selectedBranchName : null}
              onEditVariant={() => setVariantDialog({ open: true, variant })}
              onLinkFlavor={() => setLinkFlavorFor(variant)}
              onEditFlavorPricing={(flavor) => setEditFlavor({ variant, flavor })}
              onDeleteVariant={() => setDeletingVariant(variant)}
            />
          ))}
        </div>
      )}

      <Card ref={availabilitySectionRef} tabIndex={-1} className="outline-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium">Branch Availability</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <BranchAvailabilityPanel product={product} />
        </CardContent>
      </Card>

      <VariantFormDialog
        open={variantDialog.open}
        onOpenChange={(open) => setVariantDialog((prev) => ({ ...prev, open }))}
        productId={product.id}
        variant={variantDialog.variant}
      />

      {linkFlavorFor && (
        <LinkFlavorDialog
          open
          onOpenChange={(open) => !open && setLinkFlavorFor(null)}
          productId={product.id}
          variantId={linkFlavorFor.id}
          linkedFlavorIds={linkFlavorFor.flavors.map((f) => f.flavor_id)}
        />
      )}

      {editFlavor && (
        <EditVariantFlavorDialog
          open
          onOpenChange={(open) => !open && setEditFlavor(null)}
          productId={product.id}
          variantId={editFlavor.variant.id}
          flavor={editFlavor.flavor}
        />
      )}

      {deletingVariant && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingVariant(null)}
          title={`Delete ${deletingVariant.name}?`}
          description="This action cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            await deleteVariant.mutateAsync(deletingVariant.id);
          }}
        />
      )}
    </div>
  );
}
