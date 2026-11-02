'use client';

import type { ProductClassification } from '@potato-corner/shared';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProductTypeOption } from '@/lib/product-types';

const BUILT_IN_HELP: Record<ProductClassification, string> = {
  regular: 'Everyday menu item. Cannot have a promotion.',
  promotional: 'Can be given a promotion (discount) in Promotions.',
  seasonal: 'Limited-time item. Can be given a promotion in Promotions.',
};

interface ProductTypeSelectProps {
  id: string;
  value: string;
  options: ProductTypeOption[];
  onChange: (key: string) => void;
  disabled?: boolean;
  /** A saved product's classification, for what a custom type leaves in place. Absent for a new product, which starts as regular. */
  savedClassification?: ProductClassification;
}

/**
 * POS-PERF-P58 — Regular / Promotional / Seasonal and the custom types valid
 * here. Independent of publication status (Active/Drafts/Inactive). A custom
 * name is only a label, whatever it says: promotion eligibility stays where it was.
 */
export function ProductTypeSelect({ id, value, options, onChange, disabled, savedClassification }: ProductTypeSelectProps) {
  const builtInHelp = BUILT_IN_HELP[value as ProductClassification];
  const customHelp = savedClassification === 'promotional' || savedClassification === 'seasonal'
    ? 'A custom type is a label. This product can still be given a promotion, as it could before.'
    : 'A custom type is a label. This product cannot have a promotion unless you change it to Promotional or Seasonal.';
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Product type</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          // Radix reports '' while the value isn't among the options yet; never treat that as a choice.
          if (options.some((option) => option.key === next)) onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-help`}>
          <SelectValue placeholder="Choose a type" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.name}
              {!option.is_active && ' (inactive)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {builtInHelp ?? customHelp} The type alone never changes the price, and it does not affect whether the product is live on POS.
      </p>
    </div>
  );
}
