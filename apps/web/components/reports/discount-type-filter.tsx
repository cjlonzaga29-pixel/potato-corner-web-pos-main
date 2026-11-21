'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DiscountTypeOption } from '@/lib/discount-report';

export const ALL_DISCOUNT_TYPES = 'all';

interface DiscountTypeFilterProps {
  options: DiscountTypeOption[];
  value: string;
  onChange: (value: string) => void;
}

/** POS-PERF-P59 — filters by discount identity, never by name, so same-named types stay apart. */
export function DiscountTypeFilter({ options, value, onChange }: DiscountTypeFilterProps) {
  const id = useId();
  return (
    <div className="w-full sm:w-auto">
      <Label htmlFor={id}>Discount Type</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full sm:w-[240px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_DISCOUNT_TYPES}>All discount types</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
