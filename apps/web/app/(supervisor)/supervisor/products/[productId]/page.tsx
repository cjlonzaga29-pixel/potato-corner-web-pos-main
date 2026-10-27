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
import { canEditProductInPlace } from '@/lib/product-authority';
import { useAuth } from '@/hooks/use-auth';
import {
  useProduct,
  useChangeProductStatus,
  useDeleteVariant,
  useProductReadiness,
  useProductImage,
  useUploadProductImage,
  usePublishProduct,
  usePublicationCheck,
  useConfirmPublication,
  PublicationNotConfirmedError,
  useUnpublishProduct,
  isReadyToPublish,
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
import { BranchCopyDialog } from '@/components/admin/products/branch-copy-dialog';
import { ReplaceSourceDialog } from '@/components/admin/products/replace-source-dialog';
import { ProductWriteError } from '@/components/products/product-write-error';

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
  const [branchCopyOpen, setBranchCopyOpen] = useState(false);

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

  // POS-PERF-P36 — authority follows the supervisor's active branch
  // assignments, not who created the product (apps/api/src/lib/
  // catalog-authority.ts's hasActiveCatalogAuthorityForProduct). This
  // mirrors that check client-side using the JWT's branchIds snapshot —
  // advisory only, driving the read-only banner and disabling actions up
  // front; the server re-validates live on every write regardless.
  //
  // POS-PERF-P36R6 — must match hasActiveCatalogAuthority exactly: EVERY
  // branch this shared product is configured at (branchScopeFromProduct
  // deliberately includes a branch even while temporarily unpublished —
  // row.is_available filtered OUT here before would have under-counted the
  // required set), and the actor must cover ALL of them (.every, not
  // .some) — partial coverage is exactly the case "Create Branch Copy"
  // exists for, not in-place edit authority. The previous .some()-over-
  // available-only check showed full Edit/Change Status/Archive controls
  // (and silently-failing writes) to a supervisor who only partially
  // covered a shared product, instead of the read-only banner.
  const activeBranchIds = user?.branchIds ?? [];
  const isOwner =
    Boolean(user) &&
    canEditProductInPlace({ ...product, configuredBranchIds: product.branch_availability.map((row) => row.branch_id) }, activeBranchIds);
  // Supervisor-created products are always branch-exclusive (POS-PERF-P34R) —
  // configuration and publishing both target that one branch directly, no
  // branch selector needed.
  const branchId = product.exclusive_branch_id;

  // POS-PERF-P36R5 — "Create Branch Copy" is only offered for a shared
  // (non-exclusive) product the actor has partial coverage over: at least
  // one, but not every, branch it's configured at. branch_availability
  // carries a row for every branch this product is configured at
  // (products.repository.ts's detailInclude), not only currently-available
  // ones, matching catalog-authority.ts's branchScopeFromProduct — a branch
  // temporarily unpublished is still one the actor needs coverage of to
  // edit in place.
  const eligibleCopyBranches = product.branch_exclusive
    ? []
    : product.branch_availability
        .filter((row) => activeBranchIds.includes(row.branch_id))
        .map((row) => ({ id: row.branch_id, name: row.branch_name }));
  const canOfferBranchCopy = !isOwner && !product.branch_exclusive && eligibleCopyBranches.length > 0;

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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span>
            {canOfferBranchCopy
              ? "This product is shared with branches outside your assignment, so you can't edit it directly. Create a copy scoped to your own branch instead."
              : "You don't currently have an active branch assignment that gives you authority over this product. You can view its configuration, but only a supervisor actively assigned to its branch may edit it."}
          </span>
          {canOfferBranchCopy && (
            <Button size="sm" variant="outline" onClick={() => setBranchCopyOpen(true)}>
              Create Branch Copy
            </Button>
          )}
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

      {canOfferBranchCopy && (
        <BranchCopyDialog open={branchCopyOpen} onOpenChange={setBranchCopyOpen} product={product} eligibleBranches={eligibleCopyBranches} />
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
            <p className="text-xs text-muted-foreground">Only a supervisor with active authority over this product may change its image.</p>
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
  const [replaceSourceOpen, setReplaceSourceOpen] = useState(false);
  const deleteVariant = useDeleteVariant(product.id);
  const readiness = useProductReadiness(product.id, branchId);
  const publishProduct = usePublishProduct(product.id);
  const unpublishProduct = useUnpublishProduct(product.id);
  const availabilitySectionRef = useRef<HTMLDivElement>(null);
  // POS-PERF-P36R5 — only a branch-exclusive fork-to-branch copy can
  // replace its source; a regular product never shows this action.
  const isBranchCopy = Boolean(product.forked_from_product_id);

  const isArchived = product.status === 'archived';
  const canConfigure = isOwner && !isArchived;
  const sortedVariants = [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const isPublishedAtBranch = branchId ? product.branch_availability.some((row) => row.branch_id === branchId && row.is_available) : false;

  // POS-PERF-P38R — Publish is gated on the server's own publication plan for
  // this one branch (the decision POST /publish makes), not on sale
  // readiness: a missing inventory link that publishing creates, or being
  // unpublished, never disables it. Only checked while there is something
  // to publish and the actor may publish here.
  const publicationCheck = usePublicationCheck(product.id, branchId && isOwner && !isPublishedAtBranch ? [branchId] : []);
  const [publishError, setPublishError] = useState<Error | null>(null);
  const confirmPublication = useConfirmPublication(product.id);
  const [checkingPublication, setCheckingPublication] = useState(false);
  const plan = publicationCheck.data;
  const branchPlan = plan?.branches.find((b) => b.branch_id === branchId);
  const publicationIssues = plan ? [...plan.issues, ...(branchPlan?.issues ?? [])] : [];
  // POS-PERF-P38R3 — after an answer that couldn't be confirmed, Check again comes first (the last plan may be stale).
  const unconfirmed = publishError instanceof PublicationNotConfirmedError && publishError.outcome === 'unknown';
  const canPublish = Boolean(plan?.ready) && !publishProduct.isPending && !checkingPublication && !unconfirmed && !isArchived;

  async function handlePublish(targetBranchId: string) {
    setPublishError(null);
    try {
      await publishProduct.mutateAsync(targetBranchId);
    } catch (error) {
      // Keep the page as it is; the inline error explains what happened.
      setPublishError(error instanceof Error ? error : new Error('Failed to publish this product.'));
    }
  }

  // POS-PERF-P38R3 — read-only: never repeats Publish.
  async function handleCheckAgain() {
    if (!branchId || !(publishError instanceof PublicationNotConfirmedError)) return;
    setCheckingPublication(true);
    try {
      const outcome = await confirmPublication([branchId]);
      setPublishError(outcome === 'published' ? null : new PublicationNotConfirmedError(publishError, outcome));
    } finally {
      setCheckingPublication(false);
    }
  }

  function publicationSummary(): string {
    if (isPublishedAtBranch) return 'On POS at your branch.';
    if (!isOwner) {
      return isReadyToPublish(readiness.data && readiness.data.scope === 'branch' ? readiness.data : null)
        ? 'Readiness checks pass — ready to publish.'
        : 'Resolve the blocking issues below before publishing.';
    }
    if (publicationCheck.isLoading) return 'Checking publication setup…';
    if (publicationCheck.error) return `Couldn't check this product: ${publicationCheck.error.message}`;
    if (!plan?.ready) return 'Fix the setup below before publishing.';
    return 'Ready to publish.';
  }

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
                  <p className="text-xs text-muted-foreground" data-testid="publication-summary">
                    {publicationSummary()}
                  </p>
                  {!isPublishedAtBranch && branchPlan && branchPlan.setup_items.length > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="publication-setup-items">
                      Publishing also adds {branchPlan.setup_items.length === 1 ? 'this item' : `these ${branchPlan.setup_items.length} items`} to
                      this branch&apos;s inventory at zero stock: {branchPlan.setup_items.map((item) => item.name).join(', ')}.
                    </p>
                  )}
                </div>
                {isOwner && (
                  <div className="flex gap-2">
                    {isPublishedAtBranch ? (
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
                        disabled={!canPublish}
                        onClick={() => void handlePublish(branchId)}
                      >
                        {publishProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Publish
                      </Button>
                    )}
                    {isBranchCopy && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!isReadyToPublish(readiness.data) || isArchived}
                        onClick={() => setReplaceSourceOpen(true)}
                      >
                        Replace Source Product
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {!isPublishedAtBranch && publicationIssues.length > 0 && (
                <ul className="space-y-2" data-testid="publication-issues">
                  {publicationIssues.map((issue) => (
                    <li key={`${issue.code}-${issue.message}`} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
                      <span>{issue.message}</span>
                      {issue.fix_step === 'details' && (
                        <Button variant="outline" size="sm" onClick={() => onNavigateToTab('overview')}>
                          Fix
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!isPublishedAtBranch &&
                branchPlan?.notices.map((notice) => (
                  <p key={notice} className="text-xs text-muted-foreground">
                    {notice}
                  </p>
                ))}
              {/* POS-PERF-P38R3 — once the product shows as published here, an unconfirmed attempt is settled. */}
              {publishError && !(isPublishedAtBranch && publishError instanceof PublicationNotConfirmedError) && (
                <ProductWriteError
                  error={publishError}
                  failedTitle="Couldn't publish this product"
                  pausedTitle="Publishing is paused for maintenance"
                  testId="product-publish-error"
                  onCheckAgain={() => void handleCheckAgain()}
                  checking={checkingPublication}
                />
              )}
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Sale readiness at this branch</h3>
                <p className="text-xs text-muted-foreground">
                  What the POS checks before each sale. An unpublished product and inventory links Publish will add are listed here until
                  it is published.
                </p>
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

      {isBranchCopy && branchId && (
        <ReplaceSourceDialog open={replaceSourceOpen} onOpenChange={setReplaceSourceOpen} copy={product} branchId={branchId} />
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
