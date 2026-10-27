'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProductDetailResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { useDeleteVariant } from '@/hooks/queries/use-products';

interface ProductSizesPanelProps {
  product: ProductDetailResponse;
  /** POS-PERF-P39 — the product editor asks before deleting a size of an existing product; the builder's draft deletes directly, as before. */
  confirmDelete?: boolean;
  disabled?: boolean;
}

/**
 * POS-PERF-P39 — the size list and its Add Size / Edit / delete actions,
 * shared by the Product Builder's Sizes & Prices step and the product
 * editor. Each action saves on its own (VariantFormDialog, DELETE variant).
 */
export function ProductSizesPanel({ product, confirmDelete = false, disabled = false }: ProductSizesPanelProps) {
  const deleteVariant = useDeleteVariant(product.id);
  const [variantDialog, setVariantDialog] = useState<{ open: boolean; variant?: ProductVariantResponse }>({ open: false });
  const [deleting, setDeleting] = useState<ProductVariantResponse | null>(null);
  const variants = [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setVariantDialog({ open: true })} disabled={disabled}>
          <Plus className="mr-2 h-4 w-4" />
          Add Size
        </Button>
      </div>
      {variants.length === 0 ? (
        <EmptyState title="No sizes yet" description="Add at least one size and price to continue." />
      ) : (
        variants.map((variant) => (
          <div key={variant.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="truncate font-medium">
                {variant.name} — {variant.size_label}
              </p>
              <p className="text-muted-foreground text-sm">₱{variant.base_price.toFixed(2)}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={() => setVariantDialog({ open: true, variant })} disabled={disabled}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Delete ${variant.name}`}
                disabled={disabled}
                onClick={() => (confirmDelete ? setDeleting(variant) : void deleteVariant.mutateAsync(variant.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))
      )}

      <VariantFormDialog
        open={variantDialog.open}
        onOpenChange={(open) => setVariantDialog((prev) => ({ ...prev, open }))}
        productId={product.id}
        variant={variantDialog.variant}
      />

      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={`Delete the ${deleting.name} size?`}
          description="This permanently deletes the size. A size with sales or other history can't be deleted — deactivate it instead."
          confirmLabel="Delete Size"
          variant="danger"
          onConfirm={async () => {
            await deleteVariant.mutateAsync(deleting.id);
          }}
        />
      )}
    </div>
  );
}
