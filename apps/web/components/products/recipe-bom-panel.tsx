'use client';

import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { ProductComponentResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useProductComponents, useDeleteProductComponent } from '@/hooks/queries/use-product-components';
import { useRecipeReadiness } from '@/hooks/queries/use-recipe-readiness';
import { RecipeComponentFormDialog } from './recipe-component-form-dialog';

interface RecipeBomPanelProps {
  productVariantId: string;
  variantLabel: string;
  branchId?: string | null;
}

/**
 * CR-011.1/CR-012 Recipe/BOM: ProductVariant -> InventoryItem components.
 * ProductComponent + InventoryStock is the authoritative POS inventory
 * pipeline (see recipe-readiness.service.ts) — this panel is the sole
 * inventory-mapping UI for a variant. Read-only for Supervisor and
 * read/write for Admin, matching the existing product-components
 * authorization split.
 */
export function RecipeBomPanel({ productVariantId, variantLabel, branchId }: RecipeBomPanelProps) {
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const { data: components, isLoading, isError, refetch } = useProductComponents(productVariantId);
  const deleteComponent = useDeleteProductComponent(productVariantId);
  const { data: readiness, isLoading: isReadinessLoading } = useRecipeReadiness(
    { productVariantId, branchId: branchId ?? undefined },
    Boolean(branchId),
  );

  const [formDialog, setFormDialog] = useState<{ open: boolean; component?: ProductComponentResponse }>({ open: false });
  const [deletingComponent, setDeletingComponent] = useState<ProductComponentResponse | null>(null);

  // Mirrors recipe-readiness.service.ts's NO_RECIPE check (zero active ProductComponent rows) so this badge and the Recipe Readiness report never disagree.
  const isReady = (components ?? []).some((component) => component.is_active);
  const variantReadiness = readiness?.variants.find((v) => v.product_variant_id === productVariantId);
  const isStockReady = variantReadiness?.status === 'READY';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Recipe / BOM</CardTitle>
            {!isLoading && !isError && <Badge variant={isReady ? 'active' : 'inactive'}>{isReady ? 'Recipe Ready' : 'No Recipe'}</Badge>}
            {branchId && !isReadinessLoading && isReady && (
              <Badge variant={isStockReady ? 'active' : 'critical'}>{isStockReady ? 'Inventory Ready' : 'Inventory Incomplete'}</Badge>
            )}
          </div>
          <CardDescription>Inventory items consumed by {variantLabel}.</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setFormDialog({ open: true })}>
            <Plus className="mr-2 h-4 w-4" />
            Add Component
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : isError ? (
          <ErrorState retry={() => void refetch()} />
        ) : !components || components.length === 0 ? (
          <EmptyState
            title="No recipe components yet"
            description={canManage ? 'Add an inventory item to define what this variant consumes.' : 'No inventory items have been linked yet.'}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {components.map((component) => (
              <div key={component.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{component.inventory_item_name}</p>
                    {component.inventory_item_sku && <p className="text-xs text-muted-foreground">SKU: {component.inventory_item_sku}</p>}
                  </div>
                  <Badge variant={component.is_active ? 'active' : 'inactive'}>{component.is_active ? 'Active' : 'Inactive'}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {component.quantity_required} {component.recipe_unit_code} required
                </p>
                {canManage && (
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setFormDialog({ open: true, component })}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      className="flex-1"
                      onClick={() => setDeletingComponent(component)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {canManage && (
        <RecipeComponentFormDialog
          open={formDialog.open}
          onOpenChange={(open) => setFormDialog((prev) => ({ ...prev, open }))}
          productVariantId={productVariantId}
          existingComponents={components ?? []}
          editingComponent={formDialog.component}
          productVariantLabel={variantLabel}
        />
      )}

      {deletingComponent && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingComponent(null)}
          title={`Remove ${deletingComponent.inventory_item_name}?`}
          description="This removes the component from this variant's recipe. This action cannot be undone."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={async () => {
            await deleteComponent.mutateAsync(deletingComponent.id);
          }}
        />
      )}
    </Card>
  );
}
