'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { InventoryMappingFormDialog } from '@/components/admin/products/inventory-mapping-form-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useProductInventoryList, useDeleteProductInventory } from '@/hooks/queries/use-product-inventory';
import { formatCurrency } from '@/lib/utils';

interface VariantCardProps {
  variant: ProductVariantResponse;
  onEditVariant: () => void;
  onLinkFlavor: () => void;
  onEditFlavorPricing: (flavor: ProductVariantResponse['flavors'][number]) => void;
  onDeleteVariant: () => void;
}

export function VariantCard({ variant, onEditVariant, onLinkFlavor, onEditFlavorPricing, onDeleteVariant }: VariantCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium">{variant.name}</p>
            <Badge variant={variant.is_active ? 'active' : 'inactive'}>{variant.is_active ? 'Active' : 'Inactive'}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {variant.size_label} · {formatCurrency(variant.base_price)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onEditVariant}>
            Edit Variant
          </Button>
          <Button size="sm" variant="outline" onClick={onLinkFlavor}>
            Link Flavor
          </Button>
          <Button size="sm" variant="danger" onClick={onDeleteVariant}>
            Delete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {variant.flavors.length === 0 ? (
          <p className="text-sm text-muted-foreground">No flavors linked yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {variant.flavors.map((flavor) => (
              <button
                key={flavor.flavor_id}
                type="button"
                onClick={() => onEditFlavorPricing(flavor)}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-accent"
              >
                <FlavorColorSwatch colorHex={flavor.color_hex} className="h-3 w-3" />
                <span>{flavor.name}</span>
                {flavor.price_premium > 0 && <span className="text-muted-foreground">+{formatCurrency(flavor.price_premium)}</span>}
                {!flavor.is_available && <Badge variant="inactive">Unavailable</Badge>}
              </button>
            ))}
          </div>
        )}

        <InventoryItemsSection variant={variant} />
      </CardContent>
    </Card>
  );
}

/**
 * Business-neutral stock-item mappings for one variant (Phase 6). Additive to
 * Recipe, which remains the sole POS deduction engine — this section only
 * manages ProductInventory rows and never references recipes or flavors.
 */
function InventoryItemsSection({ variant }: { variant: ProductVariantResponse }) {
  const { isSupervisor: getIsSupervisor } = useAuth();
  const isSupervisor = getIsSupervisor();
  const { data: mappings, isLoading } = useProductInventoryList(variant.id);
  const deleteMapping = useDeleteProductInventory(variant.id);

  const [mappingDialog, setMappingDialog] = useState<{ open: boolean; mapping?: ProductInventoryResponse }>({ open: false });
  const [deletingMapping, setDeletingMapping] = useState<ProductInventoryResponse | null>(null);

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Inventory Items</p>
        {isSupervisor && (
          <Button size="sm" variant="outline" onClick={() => setMappingDialog({ open: true })}>
            <Plus className="mr-1 h-3 w-3" />
            Add Inventory Item
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading inventory items…</p>
      ) : !mappings || mappings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No inventory items linked yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {mappings.map((mapping) => (
            <div key={mapping.id} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
              <span>{mapping.ingredient_name}</span>
              <span className="text-muted-foreground">
                {mapping.quantity_required} {mapping.unit}
              </span>
              {isSupervisor && (
                <>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setMappingDialog({ open: true, mapping })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-destructive hover:text-destructive/80"
                    onClick={() => setDeletingMapping(mapping)}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <InventoryMappingFormDialog
        open={mappingDialog.open}
        onOpenChange={(open) => setMappingDialog((prev) => ({ ...prev, open }))}
        variant={variant}
        existingMappings={mappings ?? []}
        editingMapping={mappingDialog.mapping}
      />

      {deletingMapping && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingMapping(null)}
          title={`Remove ${deletingMapping.ingredient_name}?`}
          description="This only removes the informational stock mapping — it does not affect POS deduction, which is driven by Recipe."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={async () => {
            await deleteMapping.mutateAsync(deletingMapping.id);
          }}
        />
      )}
    </div>
  );
}
