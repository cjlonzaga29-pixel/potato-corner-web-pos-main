'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { IngredientResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useCreateIngredient, useUpdateIngredient } from '@/hooks/queries/use-inventory';

const optionalNumber = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().nonnegative().optional(),
);

const formSchema = z.object({
  name: z.string().min(1, 'Required').max(100),
  unit: z.string().min(1, 'Required').max(20),
  current_stock: z.coerce.number().nonnegative(),
  low_stock_threshold: z.coerce.number().nonnegative(),
  critical_threshold: z.coerce.number().nonnegative(),
  unit_cost: optionalNumber,
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  unit: '',
  current_stock: 0,
  low_stock_threshold: 0,
  critical_threshold: 0,
  unit_cost: undefined,
};

interface IngredientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string;
  ingredient?: IngredientResponse | null;
}

export function IngredientDialog({ open, onOpenChange, branchId, ingredient }: IngredientDialogProps) {
  const mode = ingredient ? 'edit' : 'create';
  const createIngredient = useCreateIngredient(branchId);
  const updateIngredient = useUpdateIngredient(branchId, ingredient?.id ?? '');
  const isPending = createIngredient.isPending || updateIngredient.isPending;

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  useEffect(() => {
    if (!open) return;
    form.reset(
      ingredient
        ? {
            name: ingredient.name,
            unit: ingredient.unit,
            current_stock: ingredient.current_stock,
            low_stock_threshold: ingredient.low_stock_threshold,
            critical_threshold: ingredient.critical_threshold,
            unit_cost: ingredient.unit_cost ?? undefined,
          }
        : DEFAULT_VALUES,
    );
  }, [open, ingredient, form]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    try {
      if (mode === 'create') {
        await createIngredient.mutateAsync({
          branch_id: branchId,
          name: parsed.name,
          unit: parsed.unit,
          current_stock: parsed.current_stock,
          low_stock_threshold: parsed.low_stock_threshold,
          critical_threshold: parsed.critical_threshold,
          unit_cost: parsed.unit_cost,
        });
      } else {
        await updateIngredient.mutateAsync({
          name: parsed.name,
          unit: parsed.unit,
          low_stock_threshold: parsed.low_stock_threshold,
          critical_threshold: parsed.critical_threshold,
          unit_cost: parsed.unit_cost,
        });
      }
      onOpenChange(false);
      form.reset(DEFAULT_VALUES);
    } catch {
      // no-op — the mutation hook's onError already showed a toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create Ingredient' : 'Edit Ingredient'}</DialogTitle>
          <DialogDescription>
            {mode === 'create' ? 'Add a new ingredient to this branch.' : 'Update this ingredient’s details.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="name" label="Name" required>
                <Input placeholder="Cheese Powder" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="unit" label="Unit" required>
                <Input placeholder="kg" />
              </FormFieldWrapper>
            </div>

            {mode === 'create' && (
              <FormFieldWrapper<FormValues> name="current_stock" label="Current Stock" required>
                <Input type="number" step="any" />
              </FormFieldWrapper>
            )}

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="low_stock_threshold" label="Low Stock Threshold" required>
                <Input type="number" step="any" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="critical_threshold" label="Critical Threshold" required>
                <Input type="number" step="any" />
              </FormFieldWrapper>
            </div>

            <FormFieldWrapper<FormValues> name="unit_cost" label="Unit Cost" description="Optional — PHP per unit">
              <Input type="number" step="any" />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === 'create' ? 'Create Ingredient' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
