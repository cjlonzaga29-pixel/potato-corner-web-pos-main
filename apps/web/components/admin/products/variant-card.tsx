'use client';

import { useState } from 'react';
import { Plus, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { InventoryMappingFormDialog } from '@/components/admin/products/inventory-mapping-form-dialog';
import { AssignOptionGroupDialog } from '@/components/admin/products/assign-option-group-dialog';
import { RecipeBomPanel } from '@/components/products/recipe-bom-panel';
import { useAuth } from '@/hooks/use-auth';
import { useProductInventoryList, useDeleteProductInventory, useSetProductInventoryActive } from '@/hooks/queries/use-product-inventory';
import { useVariantOptionGroups, useUnassignVariantOptionGroup } from '@/hooks/queries/use-product-options';
import { formatCurrency, cn } from '@/lib/utils';

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
  branchName,
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
        <InventoryItemsSection variant={variant} branchId={branchId} branchName={branchName} />

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
          <RecipeBomPanel productVariantId={variant.id} variantLabel={`${variant.name} (${variant.size_label})`} />
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

/**
 * Branch-scoped stock-item mappings for one variant (Phase 6). ProductInventory
 * is the active POS deduction mapping source — checkout blocks a sale for this
 * variant ("no recipe configured") until at least one active mapping exists
 * here, so this section is surfaced first on the card and calls that out
 * explicitly. Supports add/edit/deactivate/remove and optional flavor-scoped
 * mappings (a flavor-specific row overrides the base row for the same
 * inventory item at sale time, it does not stack — see product-inventory
 * .service.ts computeDeduction).
 */
function InventoryItemsSection({
  variant,
  branchId,
  branchName,
}: {
  variant: ProductVariantResponse;
  branchId: string | null;
  branchName?: string | null;
}) {
  const { isSupervisor: getIsSupervisor } = useAuth();
  const isSupervisor = getIsSupervisor();
  const { data: mappings, isLoading } = useProductInventoryList(branchId, variant.id);
  const deleteMapping = useDeleteProductInventory(branchId, variant.id);
  const toggleActive = useSetProductInventoryActive(branchId, variant.id);

  const [mappingDialog, setMappingDialog] = useState<{ open: boolean; mapping?: ProductInventoryResponse }>({ open: false });
  const [deletingMapping, setDeletingMapping] = useState<ProductInventoryResponse | null>(null);

  const activeMappings = (mappings ?? []).filter((mapping) => mapping.is_active);
  const isBlocked = Boolean(branchId) && !isLoading && activeMappings.length === 0;

  async function handleToggleActive(mapping: ProductInventoryResponse) {
    await toggleActive.mutateAsync({ mappingId: mapping.id, is_active: !mapping.is_active });
  }

  if (!branchId) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm font-semibold">Inventory Items</p>
        <p className="text-sm text-muted-foreground">Select a branch to view and manage inventory items.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Inventory Items</p>
          {branchName && <Badge variant="secondary">{branchName}</Badge>}
          <Badge variant={isBlocked ? 'critical' : 'active'}>
            {isBlocked ? 'Blocks POS sale' : `${activeMappings.length} active`}
          </Badge>
        </div>
        {isSupervisor && (
          <Button size="sm" variant="outline" onClick={() => setMappingDialog({ open: true })}>
            <Plus className="mr-1 h-3 w-3" />
            Add Inventory Item
          </Button>
        )}
      </div>

      {isBlocked && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            No active inventory item is configured for this variant at this branch. POS checkout will reject sales of{' '}
            {variant.name} ({variant.size_label}) with &quot;no recipe configured&quot; until Super Admin adds one.
          </span>
        </div>
      )}
      {!isBlocked && !isLoading && (
        <div className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>POS checkout is unblocked for this variant.</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading inventory items…</p>
      ) : !mappings || mappings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No inventory items linked yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {mappings.map((mapping) => (
            <div
              key={mapping.id}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                !mapping.is_active && 'opacity-60',
              )}
            >
              <span>{mapping.ingredient_name}</span>
              {mapping.flavor_name && (
                <Badge variant="pending" className="px-1.5 py-0 text-[10px]">
                  {mapping.flavor_name} only
                </Badge>
              )}
              <span className="text-muted-foreground">
                {mapping.quantity_required} {mapping.unit}
              </span>
              {!mapping.is_active && <Badge variant="inactive">Inactive</Badge>}
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
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => void handleToggleActive(mapping)}
                  >
                    {mapping.is_active ? 'Deactivate' : 'Activate'}
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
        editingBranchId={branchId ?? undefined}
      />

      {deletingMapping && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeletingMapping(null)}
          title={`Remove ${deletingMapping.ingredient_name}?`}
          description="Removing this mapping permanently deletes it — to temporarily stop it from deducting without losing its configuration, use Deactivate instead. Removing the last active mapping will block POS sales for this variant."
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
