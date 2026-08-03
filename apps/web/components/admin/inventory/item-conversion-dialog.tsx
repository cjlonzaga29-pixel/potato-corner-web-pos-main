'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { InventoryItemUnitConversionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateInventoryItemConversion, useUpdateInventoryItemConversion } from '@/hooks/queries/use-universal-inventory';

const formSchema = z
  .object({
    from_unit_id: z.uuid('Select a unit'),
    to_unit_id: z.uuid('Select a unit'),
    factor: z.coerce.number().positive('Factor must be greater than zero'),
  })
  .refine((v) => v.from_unit_id !== v.to_unit_id, { message: 'From and to units must differ', path: ['to_unit_id'] });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { from_unit_id: '', to_unit_id: '', factor: 0 };

interface ItemConversionDialogProps {
  itemId: string;
  units: UnitOfMeasureResponse[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null (default) creates a new conversion; passing a conversion switches the dialog to edit mode with From/To Unit locked. */
  conversion?: InventoryItemUnitConversionResponse | null;
}

export function ItemConversionDialog({ itemId, units, open, onOpenChange, conversion = null }: ItemConversionDialogProps) {
  const isEdit = Boolean(conversion);
  const createConversion = useCreateInventoryItemConversion(itemId);
  const updateConversion = useUpdateInventoryItemConversion(itemId, conversion?.id ?? '');
  // `values` (not `defaultValues`) keeps the form synced whenever the target conversion changes,
  // since this dialog stays mounted across create/edit opens rather than remounting per-target.
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
    values: conversion
      ? { from_unit_id: conversion.from_unit_id, to_unit_id: conversion.to_unit_id, factor: conversion.factor }
      : DEFAULT_VALUES,
  });

  const fromUnitId = form.watch('from_unit_id');
  const toUnitId = form.watch('to_unit_id');
  const factor = Number(form.watch('factor'));
  const fromUnit = units.find((u) => u.id === fromUnitId);
  const toUnit = units.find((u) => u.id === toUnitId);
  const previewFromCode = isEdit ? conversion?.from_unit_code : fromUnit?.code;
  const previewToCode = isEdit ? conversion?.to_unit_code : toUnit?.code;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    if (isEdit) {
      await updateConversion.mutateAsync({ factor: parsed.factor });
    } else {
      await createConversion.mutateAsync({ from_unit_id: parsed.from_unit_id, to_unit_id: parsed.to_unit_id, factor: parsed.factor });
    }
    handleOpenChange(false);
  }

  const isPending = isEdit ? updateConversion.isPending : createConversion.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Conversion' : 'Add Conversion'}</DialogTitle>
          <DialogDescription>
            Ingredient-specific mapping — cross-dimension conversions (e.g. volume to weight) are allowed on purpose.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="from_unit_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    From Unit<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  {isEdit ? (
                    <Input value={conversion ? `${conversion.from_unit_name} (${conversion.from_unit_code})` : ''} disabled />
                  ) : (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a unit" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {units.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name} ({u.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormFieldWrapper<FormValues> name="factor" label="Factor" required>
              <Input type="number" step="any" inputMode="decimal" />
            </FormFieldWrapper>

            <FormField
              control={form.control}
              name="to_unit_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    To Unit<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  {isEdit ? (
                    <Input value={conversion ? `${conversion.to_unit_name} (${conversion.to_unit_code})` : ''} disabled />
                  ) : (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a unit" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {/* Same-unit selection blocked: the from unit is excluded from the to-unit options. */}
                        {units
                          .filter((u) => u.id !== fromUnitId)
                          .map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.name} ({u.code})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {previewFromCode && previewToCode && factor > 0 && (
              <p className="rounded-md border bg-muted/30 p-3 text-sm font-medium">
                1 {previewFromCode} = {factor} {previewToCode}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Add Conversion'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
