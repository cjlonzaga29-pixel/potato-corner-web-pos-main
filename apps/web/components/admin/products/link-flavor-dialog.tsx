'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/shared/forms/currency-input';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { useFlavors } from '@/hooks/queries/use-flavors';
import { useLinkVariantFlavor } from '@/hooks/queries/use-products';

interface LinkFlavorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  linkedFlavorIds: string[];
}

export function LinkFlavorDialog({ open, onOpenChange, productId, variantId, linkedFlavorIds }: LinkFlavorDialogProps) {
  const { data, isLoading } = useFlavors({ isActive: true, limit: 100 });
  const linkFlavor = useLinkVariantFlavor(productId, variantId);

  const [flavorId, setFlavorId] = useState<string>('');
  const [pricePremium, setPricePremium] = useState(0);
  const [isAvailable, setIsAvailable] = useState(true);

  const availableFlavors = useMemo(
    () => (data?.flavors ?? []).filter((flavor) => !linkedFlavorIds.includes(flavor.id)),
    [data, linkedFlavorIds],
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      setFlavorId('');
      setPricePremium(0);
      setIsAvailable(true);
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!flavorId) return;
    await linkFlavor.mutateAsync({ flavor_id: flavorId, price_premium: pricePremium, is_available: isAvailable });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Link Flavor</DialogTitle>
          <DialogDescription>Flavors already linked to this variant are hidden from the list.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Flavor</Label>
            <Select value={flavorId} onValueChange={setFlavorId} disabled={isLoading}>
              <SelectTrigger>
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Select a flavor'} />
              </SelectTrigger>
              <SelectContent>
                {availableFlavors.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No unlinked flavors available</div>
                ) : (
                  availableFlavors.map((flavor) => (
                    <SelectItem key={flavor.id} value={flavor.id}>
                      <span className="flex items-center gap-2">
                        <FlavorColorSwatch colorHex={flavor.color_hex} />
                        {flavor.name}
                      </span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

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
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!flavorId || linkFlavor.isPending}>
            {linkFlavor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Link Flavor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
