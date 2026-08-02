'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { ProductOptionAssignedVariantResponse, ProductOptionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useProductOptionAssignedVariants } from '@/hooks/queries/use-product-options';
import { useProductComponents } from '@/hooks/queries/use-product-components';
import { RecipeComponentFormDialog } from '@/components/products/recipe-component-form-dialog';

interface ManageOptionDeductionDialogProps {
  groupId: string;
  option: ProductOptionResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Lets an admin configure the ProductComponent deduction for one ProductOption
 * directly from the Product Option page. Step 1 picks which assigned variant
 * the deduction applies to; step 2 reuses RecipeComponentFormDialog (with the
 * product option locked) instead of duplicating the BOM editor.
 */
export function ManageOptionDeductionDialog({ groupId, option, open, onOpenChange }: ManageOptionDeductionDialogProps) {
  const [selectedVariant, setSelectedVariant] = useState<ProductOptionAssignedVariantResponse | null>(null);
  const [search, setSearch] = useState('');

  const { data: variants, isLoading: variantsLoading } = useProductOptionAssignedVariants(groupId, option?.id);
  const { data: components } = useProductComponents(selectedVariant?.product_variant_id);

  useEffect(() => {
    if (!open) {
      setSelectedVariant(null);
      setSearch('');
    }
  }, [open]);

  const groupedVariants = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (variants ?? []).filter(
      (variant) =>
        !query ||
        variant.product_name.toLowerCase().includes(query) ||
        variant.variant_name.toLowerCase().includes(query),
    );

    const groups = new Map<
      string,
      { productId: string; productName: string; variants: ProductOptionAssignedVariantResponse[] }
    >();
    for (const variant of filtered) {
      const group = groups.get(variant.product_id);
      if (group) {
        group.variants.push(variant);
      } else {
        groups.set(variant.product_id, {
          productId: variant.product_id,
          productName: variant.product_name,
          variants: [variant],
        });
      }
    }
    return Array.from(groups.values());
  }, [variants, search]);

  if (!option) return null;

  if (selectedVariant) {
    const existingComponents = components ?? [];
    const editingComponent = existingComponents.find((component) => component.product_option_id === option.id);

    return (
      <RecipeComponentFormDialog
        open
        onOpenChange={(next) => {
          if (!next) {
            setSelectedVariant(null);
            onOpenChange(false);
          }
        }}
        productVariantId={selectedVariant.product_variant_id}
        existingComponents={existingComponents}
        editingComponent={editingComponent}
        fixedProductOptionId={option.id}
        fixedProductOptionLabel={option.name}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Deduction — {option.name}</DialogTitle>
          <DialogDescription>Choose which variant&apos;s recipe this option&apos;s deduction applies to.</DialogDescription>
        </DialogHeader>

        {!variantsLoading && variants && variants.length > 0 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search product or variant..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
            />
          </div>
        )}

        <div className="max-h-80 space-y-4 overflow-y-auto">
          {variantsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !variants || variants.length === 0 ? (
            <EmptyState
              title="No assigned variants"
              description="Assign this option's group to a variant before configuring a deduction."
            />
          ) : groupedVariants.length === 0 ? (
            <EmptyState title="No matches" description="No product or variant matches your search." />
          ) : (
            groupedVariants.map((group) => (
              <div key={group.productId} className="space-y-1">
                <p className="text-xs font-semibold uppercase text-muted-foreground">{group.productName}</p>
                <div className="space-y-1">
                  {group.variants.map((variant) => (
                    <button
                      key={variant.product_variant_id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-muted/50"
                      onClick={() => setSelectedVariant(variant)}
                    >
                      <p className="text-sm">{variant.variant_name}</p>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
