'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useVariantOptionGroups, useUnassignVariantOptionGroup } from '@/hooks/queries/use-product-options';
import { FlavorSlotPanel } from '@/components/admin/products/flavor-slot-panel';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { AssignOptionGroupDialog } from '@/components/admin/products/assign-option-group-dialog';

/**
 * One size's choices — linked flavors, assigned option groups and its Mix &
 * Max flavor slots. POS-PERF-P39 moved this out of the Product Builder's
 * Choices step unchanged so the product editor uses the same editor; every
 * action here saves on its own.
 */
export function VariantChoicesCard({ productId, variant }: { productId: string; variant: ProductVariantResponse }) {
  const { data: assignedGroups } = useVariantOptionGroups(productId, variant.id);
  const unassign = useUnassignVariantOptionGroup(productId, variant.id);
  const [assignOpen, setAssignOpen] = useState(false);
  const [linkFlavorOpen, setLinkFlavorOpen] = useState(false);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">
              {variant.name} ({variant.size_label})
            </CardTitle>
            <CardDescription>Flavors and option groups available for this size.</CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setLinkFlavorOpen(true)}>
              Link Flavor
            </Button>
            <Button size="sm" onClick={() => setAssignOpen(true)}>
              Assign Option Group
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {variant.flavors.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {variant.flavors.map((flavor) => (
                <Badge key={flavor.flavor_id} variant="outline">
                  {flavor.name}
                </Badge>
              ))}
            </div>
          )}
          {(assignedGroups ?? []).length === 0 && variant.flavors.length === 0 ? (
            <EmptyState title="No choices configured" description="Optional — skip if this size has no flavors or add-ons." />
          ) : (
            <div className="space-y-2">
              {(assignedGroups ?? []).map((group) => (
                <div key={group.id} className="flex items-center justify-between rounded-md border p-2.5 text-sm">
                  <div>
                    <p className="font-medium">{group.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {group.required ? 'Required' : 'Optional'} · {group.selection_type === 'SINGLE' ? 'Pick one' : 'Pick multiple'}
                    </p>
                  </div>
                  {/* POS-PERF-P41 — removes at once (no Cancel undoes it); busy until the server answers, and the hook toasts the result. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${group.name}`}
                    title="Removes it now"
                    disabled={unassign.isPending}
                    aria-busy={unassign.isPending && unassign.variables === group.id}
                    onClick={() => void unassign.mutateAsync(group.id).catch(() => undefined)}
                  >
                    {unassign.isPending && unassign.variables === group.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>

        <AssignOptionGroupDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          productId={productId}
          variantId={variant.id}
          assignedGroupIds={(assignedGroups ?? []).map((g) => g.option_group_id)}
        />
        <LinkFlavorDialog
          open={linkFlavorOpen}
          onOpenChange={setLinkFlavorOpen}
          productId={productId}
          variantId={variant.id}
          linkedFlavorIds={variant.flavors.map((f) => f.flavor_id)}
        />
      </Card>

      <FlavorSlotPanel
        productId={productId}
        variantId={variant.id}
        variantLabel={`${variant.name} (${variant.size_label})`}
        lifecycleStatus={variant.lifecycle_status}
      />
    </div>
  );
}
