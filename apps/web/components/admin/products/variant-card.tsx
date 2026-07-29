'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { AssignOptionGroupDialog } from '@/components/admin/products/assign-option-group-dialog';
import { RecipeBomPanel } from '@/components/products/recipe-bom-panel';
import { useVariantOptionGroups, useUnassignVariantOptionGroup } from '@/hooks/queries/use-product-options';
import { formatCurrency } from '@/lib/utils';

interface VariantCardProps {
  variant: ProductVariantResponse;
  branchId: string | null;
  branchName?: string | null;
  onEditVariant: () => void;
  onLinkFlavor: () => void;
  onEditFlavorPricing: (flavor: ProductVariantResponse['flavors'][number]) => void;
  onDeleteVariant: () => void;
}

export function VariantCard({
  variant,
  branchId,
  onEditVariant,
  onLinkFlavor,
  onEditFlavorPricing,
  onDeleteVariant,
}: VariantCardProps) {
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
          <p className="text-sm text-muted-foreground border-t pt-3">No flavors linked yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2 border-t pt-3">
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

        <OptionGroupsSection productId={variant.product_id} variantId={variant.id} />

        <div className="border-t pt-3">
          <RecipeBomPanel productVariantId={variant.id} variantLabel={`${variant.name} (${variant.size_label})`} branchId={branchId} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * CR-008 R6 — Option Group assignments for this variant (Flavor/Size/
 * Add-ons/etc.), distinct from the legacy variantFlavors shown above.
 */
function OptionGroupsSection({ productId, variantId }: { productId: string; variantId: string }) {
  const { data: assignments, isLoading } = useVariantOptionGroups(productId, variantId);
  const unassign = useUnassignVariantOptionGroup(productId, variantId);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Option Groups</p>
        <Button size="sm" variant="outline" onClick={() => setAssignDialogOpen(true)}>
          <Plus className="mr-1 h-3 w-3" />
          Assign Option Group
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading option groups…</p>
      ) : !assignments || assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No option groups assigned yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {assignments.map((assignment) => (
            <div key={assignment.id} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
              <span>{assignment.name}</span>
              <Badge variant={assignment.required ? 'active' : 'inactive'}>{assignment.required ? 'Required' : 'Optional'}</Badge>
              <span className="text-muted-foreground">{assignment.allowed_options.length || 'all'} options</span>
              <button
                type="button"
                className="text-destructive hover:text-destructive/80"
                onClick={() => void unassign.mutateAsync(assignment.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <AssignOptionGroupDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        productId={productId}
        variantId={variantId}
        assignedGroupIds={(assignments ?? []).map((a) => a.option_group_id)}
      />
    </div>
  );
}
