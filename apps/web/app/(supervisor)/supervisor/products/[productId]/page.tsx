'use client';

import { use, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ImageIcon, Loader2, Plus } from 'lucide-react';
import type { ProductDetailResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { formatDateTime } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import {
  useProduct,
  useChangeProductStatus,
  useDeleteVariant,
  useProductReadiness,
  useProductImage,
  useUploadProductImage,
  usePublishProduct,
  useUnpublishProduct,
} from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { VariantCard } from '@/components/admin/products/variant-card';
import { EditProductDialog } from '@/components/admin/products/edit-product-dialog';
import { ChangeProductStatusDialog } from '@/components/admin/products/change-product-status-dialog';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { EditVariantFlavorDialog } from '@/components/admin/products/edit-variant-flavor-dialog';
import { ReadinessChecklist } from '@/components/admin/products/readiness-checklist';

interface SupervisorProductDetailPageProps {
  params: Promise<{ productId: string }>;
}

export default function SupervisorProductDetailPage({ params }: SupervisorProductDetailPageProps) {
  const { productId } = use(params);
  const { user } = useAuth();
  const { data: product, isLoading, isError, refetch } = useProduct(productId);
  const changeStatus = useChangeProductStatus(productId);
  const [activeTab, setActiveTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

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

  // POS-PERF-P34R — a supervisor may configure (variants, flavors, option
  // groups, recipe/BOM, image, publish) only a product they themselves
  // created; the server enforces this on every write, this just drives the
  // read-only banner and disables the actions up front.
  const isOwner = Boolean(user) && product.created_by_user?.id === user?.id;
  // Supervisor-created products are always branch-exclusive (POS-PERF-P34R) —
  // configuration and publishing both target that one branch directly, no
  // branch selector needed.
  const branchId = product.exclusive_branch_id;

  return (
    <div className="app-section app-section-gap">
      <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
        <Link href="/supervisor/products">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to products
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="app-title font-bold">{product.name}</h1>
            <ProductStatusBadge status={product.status} />
            <SeasonalBadge isSeasonal={product.is_seasonal} />
          </div>
          <p className="text-sm text-muted-foreground">{product.category_name ?? 'Uncategorized'}</p>
        </div>
        {isOwner && (
          <div className="flex gap-2">
            {product.status === 'archived' ? (
              <Button onClick={() => changeStatus.mutate({ status: 'active' })} disabled={changeStatus.isPending}>
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
        )}
      </div>

      {!isOwner && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This product was created by{' '}
          {product.created_by_user ? `${product.created_by_user.first_name} ${product.created_by_user.last_name}` : 'another user'}. You can
          view its configuration, but only the supervisor who created it may edit it.
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variants">Variants, Flavors & Recipe</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <OverviewTab product={product} isOwner={isOwner} />
        </TabsContent>

        <TabsContent value="variants" className="space-y-4">
          <VariantsTab product={product} branchId={branchId} isOwner={isOwner} onNavigateToTab={setActiveTab} />
        </TabsContent>
      </Tabs>

      {isOwner && (
        <>
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
        </>
      )}
    </div>
  );
}

function OverviewTab({ product, isOwner }: { product: ProductDetailResponse; isOwner: boolean }) {
  const { data: imageData, isLoading: imageLoading } = useProductImage(product.id, product.has_image);
  const uploadImage = useUploadProductImage();

  async function handleImageSelected(file: File) {
    await uploadImage.mutateAsync({ productId: product.id, file });
  }

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
            <p className="text-muted-foreground">Variants</p>
            <p className="font-medium">
              {product.active_variant_count} active / {product.variant_count} total
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Branch</p>
            <p className="font-medium">{product.branch_exclusive ? 'Branch-exclusive' : `${product.active_branch_count} active branches`}</p>
          </div>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Product Image</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {product.has_image && (
            <div className="flex items-center gap-3">
              {imageLoading || !imageData?.image_url ? (
                <div className="h-20 w-20 shrink-0 animate-pulse rounded-md bg-muted" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
                <img src={imageData.image_url} alt={product.name} className="h-20 w-20 shrink-0 rounded-md border object-cover" />
              )}
            </div>
          )}
          {!product.has_image && !imageLoading && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              No image yet.
            </p>
          )}
          {isOwner ? (
            <ImageUpload
              label={product.has_image ? 'Replace Image' : 'Upload Image'}
              description="JPEG, PNG, or WebP, up to 5MB. Shown in the product list and POS."
              onImageSelected={handleImageSelected}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Only the creator of this product may change its image.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function VariantsTab({
  product,
  branchId,
  isOwner,
  onNavigateToTab,
}: {
  product: ProductDetailResponse;
  branchId: string | null;
  isOwner: boolean;
  onNavigateToTab: (tab: string) => void;
}) {
  const [variantDialog, setVariantDialog] = useState<{ open: boolean; variant?: ProductVariantResponse }>({ open: false });
  const [linkFlavorFor, setLinkFlavorFor] = useState<ProductVariantResponse | null>(null);
  const [editFlavor, setEditFlavor] = useState<{ variant: ProductVariantResponse; flavor: ProductVariantResponse['flavors'][number] } | null>(
    null,
  );
  const [deletingVariant, setDeletingVariant] = useState<ProductVariantResponse | null>(null);
  const deleteVariant = useDeleteVariant(product.id);
  const readiness = useProductReadiness(product.id, branchId);
  const publishProduct = usePublishProduct(product.id);
  const unpublishProduct = useUnpublishProduct(product.id);
  const availabilitySectionRef = useRef<HTMLDivElement>(null);

  const isArchived = product.status === 'archived';
  const canConfigure = isOwner && !isArchived;
  const sortedVariants = [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const isPublishedAtBranch = branchId ? product.branch_availability.some((row) => row.branch_id === branchId && row.is_available) : false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{branchId ? 'Configuring this product for your branch.' : 'No branch assigned.'}</div>
        <Button size="sm" onClick={() => setVariantDialog({ open: true })} disabled={!canConfigure}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variant
        </Button>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium">Readiness & Publication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {!branchId ? (
            <p className="text-sm text-muted-foreground">This product has no assigned branch yet.</p>
          ) : readiness.isLoading ? (
            <div className="flex justify-center py-4">
              <LoadingSpinner size="sm" />
            </div>
          ) : readiness.isError || !readiness.data || readiness.data.scope !== 'branch' ? (
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>Failed to load readiness.</span>
              <Button variant="outline" size="sm" onClick={() => void readiness.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                <div className="flex-1">
                  <p className="text-sm font-medium">{isPublishedAtBranch ? 'Published at your branch' : 'Not published at your branch'}</p>
                  <p className="text-xs text-muted-foreground">
                    {readiness.data.sellable
                      ? 'Readiness checks pass — ready to publish.'
                      : 'Resolve the blocking issues below before publishing.'}
                  </p>
                </div>
                {isOwner &&
                  (isPublishedAtBranch ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={unpublishProduct.isPending}
                      onClick={() => void unpublishProduct.mutateAsync(branchId)}
                    >
                      {unpublishProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Unpublish
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!readiness.data.sellable || publishProduct.isPending || isArchived}
                      onClick={() => void publishProduct.mutateAsync(branchId)}
                    >
                      {publishProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Publish
                    </Button>
                  ))}
              </div>
              <ReadinessChecklist
                data={readiness.data}
                onNavigateToTab={onNavigateToTab}
                onManageBranchAvailability={() => availabilitySectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
              />
            </>
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
              branchId={branchId}
              branchName={null}
              onEditVariant={() => setVariantDialog({ open: true, variant })}
              onLinkFlavor={() => setLinkFlavorFor(variant)}
              onEditFlavorPricing={(flavor) => setEditFlavor({ variant, flavor })}
              onDeleteVariant={() => setDeletingVariant(variant)}
            />
          ))}
        </div>
      )}

      <div ref={availabilitySectionRef} tabIndex={-1} className="outline-none" />

      <VariantFormDialog
        open={variantDialog.open && canConfigure}
        onOpenChange={(open) => setVariantDialog((prev) => ({ ...prev, open }))}
        productId={product.id}
        variant={variantDialog.variant}
      />

      {linkFlavorFor && canConfigure && (
        <LinkFlavorDialog
          open
          onOpenChange={(open) => !open && setLinkFlavorFor(null)}
          productId={product.id}
          variantId={linkFlavorFor.id}
          linkedFlavorIds={linkFlavorFor.flavors.map((f) => f.flavor_id)}
        />
      )}

      {editFlavor && canConfigure && (
        <EditVariantFlavorDialog
          open
          onOpenChange={(open) => !open && setEditFlavor(null)}
          productId={product.id}
          variantId={editFlavor.variant.id}
          flavor={editFlavor.flavor}
        />
      )}

      {deletingVariant && canConfigure && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingVariant(null)}
          title={`Permanently delete "${deletingVariant.name}"?`}
          description="This permanently deletes the variant. This action cannot be undone. Variants with transaction history cannot be deleted — deactivate them instead."
          confirmLabel="Permanently Delete"
          variant="danger"
          requireTypedConfirmation="DELETE"
          onConfirm={async () => {
            await deleteVariant.mutateAsync(deletingVariant.id);
          }}
        />
      )}
    </div>
  );
}
