'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus } from 'lucide-react';
import type { ProductDetailResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatDateTime } from '@/lib/utils';
import {
  useBranchProductAvailability,
  useBulkUpdateBranchProductAvailability,
  useProduct,
  useUpdateBranchProductAvailability,
  useDeleteProduct,
  useDeleteVariant,
  useDeleteProductImage,
} from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { VariantCard } from '@/components/admin/products/variant-card';
import { EditProductDialog } from '@/components/admin/products/edit-product-dialog';
import { ChangeProductStatusDialog } from '@/components/admin/products/change-product-status-dialog';
import { UploadProductImageDialog } from '@/components/admin/products/upload-product-image-dialog';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { EditVariantFlavorDialog } from '@/components/admin/products/edit-variant-flavor-dialog';

interface ProductDetailPageProps {
  params: Promise<{ productId: string }>;
}

export default function ProductDetailPage({ params }: ProductDetailPageProps) {
  const router = useRouter();
  const { productId } = use(params);
  const { data: product, isLoading, isError, refetch } = useProduct(productId);
  const deleteProduct = useDeleteProduct();

  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
        <div className="flex items-center gap-4">
          {product.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- product photo from Supabase Storage
            <img src={product.image_url} alt={product.name} className="h-16 w-16 rounded-md object-cover" />
          ) : (
            <div className="h-16 w-16 rounded-md bg-muted" />
          )}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{product.name}</h1>
              <ProductStatusBadge status={product.status} />
              <SeasonalBadge isSeasonal={product.is_seasonal} />
            </div>
            <p className="text-sm text-muted-foreground">{product.category ?? 'Uncategorized'}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImageOpen(true)}>
            Upload Image
          </Button>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            Edit Product
          </Button>
          <Button onClick={() => setStatusOpen(true)}>Change Status</Button>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variants">Variants & Flavors</TabsTrigger>
          <TabsTrigger value="availability">Branch Availability</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <OverviewTab product={product} />
        </TabsContent>

        <TabsContent value="variants" className="space-y-4">
          <VariantsTab product={product} />
        </TabsContent>

        <TabsContent value="availability" className="space-y-4">
          <BranchAvailabilityTab product={product} />
        </TabsContent>

        <TabsContent value="media" className="space-y-4">
          <MediaTab product={product} onUpload={() => setImageOpen(true)} />
        </TabsContent>
      </Tabs>

      <EditProductDialog open={editOpen} onOpenChange={setEditOpen} product={product} />
      <ChangeProductStatusDialog open={statusOpen} onOpenChange={setStatusOpen} product={product} />
      <UploadProductImageDialog open={imageOpen} onOpenChange={setImageOpen} productId={productId} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${product.name}?`}
        description="This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          await deleteProduct.mutateAsync(productId);
          router.push('/admin/products');
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

function VariantsTab({ product }: { product: ProductDetailResponse }) {
  const [variantDialog, setVariantDialog] = useState<{ open: boolean; variant?: ProductVariantResponse }>({ open: false });
  const [linkFlavorFor, setLinkFlavorFor] = useState<ProductVariantResponse | null>(null);
  const [editFlavor, setEditFlavor] = useState<{ variant: ProductVariantResponse; flavor: ProductVariantResponse['flavors'][number] } | null>(
    null,
  );
  const [deletingVariant, setDeletingVariant] = useState<ProductVariantResponse | null>(null);
  const deleteVariant = useDeleteVariant(product.id);

  const isArchived = product.status === 'archived';
  const sortedVariants = [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setVariantDialog({ open: true })} disabled={isArchived}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variant
        </Button>
      </div>

      {sortedVariants.length === 0 ? (
        <EmptyState title="No variants yet" description="Add a variant to start selling this product." />
      ) : (
        <div className="space-y-3">
          {sortedVariants.map((variant) => (
            <VariantCard
              key={variant.id}
              variant={variant}
              onEditVariant={() => setVariantDialog({ open: true, variant })}
              onLinkFlavor={() => setLinkFlavorFor(variant)}
              onEditFlavorPricing={(flavor) => setEditFlavor({ variant, flavor })}
              onDeleteVariant={() => setDeletingVariant(variant)}
            />
          ))}
        </div>
      )}

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

function BranchAvailabilityTab({ product }: { product: ProductDetailResponse }) {
  const { data, isLoading, isError, refetch } = useBranchProductAvailability(product.id);
  const updateAvailability = useUpdateBranchProductAvailability(product.id);
  const bulkUpdate = useBulkUpdateBranchProductAvailability(product.id);
  const globallyLocked = product.status === 'discontinued' || product.status === 'archived';

  const [confirmAction, setConfirmAction] = useState<'enable' | 'disable' | null>(null);
  const [copyFromBranch, setCopyFromBranch] = useState('');

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }
  if (isError) return <ErrorState retry={() => void refetch()} />;
  if (!data || data.length === 0) {
    return <EmptyState title="No active branches" description="There are no active branches to configure yet." />;
  }

  async function handleCopyFromBranch(branchId: string) {
    setCopyFromBranch(branchId);
    const source = data?.find((row) => row.branch_id === branchId);
    if (!source) {
      setCopyFromBranch('');
      return;
    }
    try {
      await bulkUpdate.mutateAsync(
        (data ?? [])
          .filter((row) => row.branch_id !== branchId)
          .map((row) => ({ branch_id: row.branch_id, is_available: source.is_available })),
      );
    } finally {
      setCopyFromBranch('');
    }
  }

  return (
    <div className="space-y-3">
      {globallyLocked && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          This product is globally {product.status_label.toLowerCase()} — branch availability cannot be re-enabled until it changes globally.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={globallyLocked}
          onClick={() => setConfirmAction('enable')}
        >
          Enable All
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmAction('disable')}>
          Disable All
        </Button>
        <Select value={copyFromBranch} onValueChange={(value) => void handleCopyFromBranch(value)} disabled={globallyLocked || data.length <= 1}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Copy from branch..." />
          </SelectTrigger>
          <SelectContent>
            {data.map((row) => (
              <SelectItem key={row.branch_id} value={row.branch_id}>
                {row.branch_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="p-3 font-medium">Branch Code</th>
              <th className="p-3 font-medium">Branch Name</th>
              <th className="p-3 font-medium">City</th>
              <th className="p-3 font-medium">Available</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.branch_id} className="border-b last:border-0">
                <td className="p-3 font-mono text-xs">{row.branch_code}</td>
                <td className="p-3">{row.branch_name}</td>
                <td className="p-3">{row.city}</td>
                <td className="p-3">
                  <Switch
                    checked={row.is_available}
                    disabled={globallyLocked && !row.is_available}
                    onCheckedChange={(checked) =>
                      void updateAvailability.mutateAsync({ branchId: row.branch_id, isAvailable: checked })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction === 'enable' ? 'Enable this product for all branches?' : 'Disable this product for all branches?'}
        description="This updates availability for every active branch at once."
        confirmLabel={confirmAction === 'enable' ? 'Enable All' : 'Disable All'}
        variant={confirmAction === 'disable' ? 'danger' : 'default'}
        onConfirm={async () => {
          try {
            await bulkUpdate.mutateAsync(
              data.map((row) => ({ branch_id: row.branch_id, is_available: confirmAction === 'enable' })),
            );
          } finally {
            setConfirmAction(null);
          }
        }}
      />
    </div>
  );
}

function MediaTab({ product, onUpload }: { product: ProductDetailResponse; onUpload: () => void }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const deleteImage = useDeleteProductImage(product.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Product Image</CardTitle>
        <CardDescription>Compressed server-side with Sharp and stored in Supabase Storage.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- product photo from Supabase Storage
          <img src={product.image_url} alt={product.name} className="max-h-72 rounded-md border object-contain" />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No image uploaded yet
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onUpload} disabled={product.status === 'archived'}>
            Upload Image
          </Button>
          {product.image_url && (
            <Button variant="danger" onClick={() => setRemoveOpen(true)} disabled={product.status === 'archived'}>
              Remove Image
            </Button>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this image?"
        description="This action cannot be undone."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={async () => {
          await deleteImage.mutateAsync();
        }}
      />
    </Card>
  );
}
