import type { ProductVariantResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
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
      <CardContent>
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
      </CardContent>
    </Card>
  );
}
