'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/shared/forms/currency-input';
import { useUpdateVariantFlavor } from '@/hooks/queries/use-products';

interface EditVariantFlavorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  flavor: ProductVariantResponse['flavors'][number];
}

export function EditVariantFlavorDialog({ open, onOpenChange, productId, variantId, flavor }: EditVariantFlavorDialogProps) {
  const updateVariantFlavor = useUpdateVariantFlavor(productId, variantId, flavor.flavor_id);
  const [pricePremium, setPricePremium] = useState(flavor.price_premium);
  const [isAvailable, setIsAvailable] = useState(flavor.is_available);

  useEffect(() => {
    if (open) {
      setPricePremium(flavor.price_premium);
      setIsAvailable(flavor.is_available);
    }
  }, [open, flavor]);

  async function handleSubmit() {
    await updateVariantFlavor.mutateAsync({ price_premium: pricePremium, is_available: isAvailable });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Flavor Pricing</DialogTitle>
          <DialogDescription>{flavor.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Price Premium</Label>
            <CurrencyInput value={pricePremium} onChange={setPricePremium} id="price-premium" name="price_premium" aria-label="Price Premium" />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <p className="text-sm font-medium">Available</p>
            <Switch checked={isAvailable} onCheckedChange={setIsAvailable} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={updateVariantFlavor.isPending}>
            {updateVariantFlavor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
