'use client';

import { PRODUCT_CLASSIFICATIONS, PRODUCT_CLASSIFICATION_LABELS, type ProductClassification } from '@potato-corner/shared';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const DESCRIPTIONS: Record<ProductClassification, string> = {
  regular: 'Everyday menu item. Cannot have a promotion.',
  promotional: 'Can be given a promotion (discount) in Promotions.',
  seasonal: 'Limited-time item. Can be given a promotion in Promotions.',
};

interface ProductClassificationSelectProps {
  id: string;
  value: ProductClassification;
  onChange: (value: ProductClassification) => void;
  disabled?: boolean;
}

/**
 * POS-PERF-P49 — Regular / Promotional / Seasonal. Independent of the
 * product's publication status (Active/Drafts/Inactive) and never changes a
 * price on its own: a discount is configured separately in Promotions.
 */
export function ProductClassificationSelect({ id, value, onChange, disabled }: ProductClassificationSelectProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Classification</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          // Radix reports '' while the value isn't among the options yet; never treat that as a choice.
          if ((PRODUCT_CLASSIFICATIONS as readonly string[]).includes(next)) onChange(next as ProductClassification);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRODUCT_CLASSIFICATIONS.map((classification) => (
            <SelectItem key={classification} value={classification}>
              {PRODUCT_CLASSIFICATION_LABELS[classification]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {DESCRIPTIONS[value]} Classification alone never changes the price, and it does not affect whether the product is live on POS.
      </p>
    </div>
  );
}
