'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useProduct, useProducts } from '@/hooks/queries/use-products';
import { useAddSnackOption } from '@/hooks/queries/use-flavor-slots';

interface SnackOptionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  slotId: string;
  excludeSnackVariantIds: string[];
  requiresReason: boolean;
}

/**
 * POS-PERF-P36R — "which snack ProductVariants are sellable into this slot"
 * (ProductFlavorSlotSnackOption). Two-step picker (product, then one of its
 * sizes) since the catalog has no flat variant search endpoint — mirrors
 * AssignOptionGroupDialog's single-select pattern.
 */
export function SnackOptionFormDialog({
  open,
  onOpenChange,
  productId,
  variantId,
  slotId,
  excludeSnackVariantIds,
  requiresReason,
}: SnackOptionFormDialogProps) {
  const { data: productList, isLoading: productsLoading } = useProducts({ status: 'active', limit: 100 });
  const [snackProductId, setSnackProductId] = useState('');
  const { data: snackProduct, isLoading: variantsLoading } = useProduct(snackProductId || null);
  const [snackVariantId, setSnackVariantId] = useState('');
  const [reason, setReason] = useState('');
  const addSnackOption = useAddSnackOption(productId, variantId, slotId);

  const availableVariants = useMemo(
    () => (snackProduct?.variants ?? []).filter((v) => v.is_active && v.id !== variantId && !excludeSnackVariantIds.includes(v.id)),
    [snackProduct, variantId, excludeSnackVariantIds],
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      setSnackProductId('');
      setSnackVariantId('');
      setReason('');
    }
    onOpenChange(next);
  }

  const canSubmit = Boolean(snackVariantId) && (!requiresReason || reason.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    await addSnackOption.mutateAsync({ snack_product_variant_id: snackVariantId, reason: requiresReason ? reason.trim() : undefined });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Snack Option</DialogTitle>
          <DialogDescription>Pick the product and size that is sellable into this slot.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Product</Label>
            <Select
              value={snackProductId}
              onValueChange={(value) => {
                setSnackProductId(value);
                setSnackVariantId('');
              }}
              disabled={productsLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={productsLoading ? 'Loading…' : 'Select a product'} />
              </SelectTrigger>
              <SelectContent>
                {(productList?.products ?? [])
                  .filter((p) => p.id !== productId)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Size</Label>
            <Select value={snackVariantId} onValueChange={setSnackVariantId} disabled={!snackProductId || variantsLoading}>
              <SelectTrigger>
                <SelectValue placeholder={!snackProductId ? 'Select a product first' : variantsLoading ? 'Loading…' : 'Select a size'} />
              </SelectTrigger>
              <SelectContent>
                {availableVariants.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No eligible sizes available</div>
                ) : (
                  availableVariants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} ({v.size_label})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {requiresReason && (
            <div className="space-y-2">
              <Label htmlFor="snack-option-reason">Reason (required — this variant is already live on POS)</Label>
              <Input id="snack-option-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change is needed" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit || addSnackOption.isPending}>
            {addSnackOption.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
