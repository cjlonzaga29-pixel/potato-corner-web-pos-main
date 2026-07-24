'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranchStore } from '@/stores/branch.store';
import { useIngredients, useStockIn } from '@/hooks/queries/use-inventory';

const formSchema = z.object({
  ingredient_id: z.uuid('Select an ingredient'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  supplier_reference: z.string().max(100).optional(),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { ingredient_id: '', quantity: 0, supplier_reference: '', notes: '' };

function StockInFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const ingredientId = form.watch('ingredient_id');
  const ingredient = ingredients?.find((i) => i.id === ingredientId);
  const stockIn = useStockIn(activeBranchId, ingredientId);

  useEffect(() => {
    const preselected = searchParams.get('ingredient_id');
    if (preselected) form.setValue('ingredient_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await stockIn.mutateAsync({
      quantity: parsed.quantity,
      supplier_reference: parsed.supplier_reference || undefined,
      notes: parsed.notes || undefined,
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording stock-in.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock In</h1>
        <p className="text-sm text-muted-foreground">Record newly received stock for an ingredient at this branch.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Radix Select takes value/onValueChange, not the onChange FormFieldWrapper clones onto children — wired directly via FormField instead. */}
          <FormField
            control={form.control}
            name="ingredient_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Ingredient<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an ingredient" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {ingredients?.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name} ({i.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {ingredient && (
            <p className="rounded-md border bg-muted/30 p-3 text-sm">
              Current stock: <span className="font-medium">{ingredient.current_stock}</span> {ingredient.unit}
            </p>
          )}

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity Received${ingredient ? ` (${ingredient.unit})` : ''}`} required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues> name="supplier_reference" label="Supplier Reference" description="Optional">
            <Input placeholder="PO number, delivery receipt, etc." />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={stockIn.isPending}>
              {stockIn.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Stock In
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

/** Shared body behind both `/supervisor/inventory/stock-in` and `/branch/inventory/stock-in`. */
export function InventoryStockInForm({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <StockInFormContent basePath={basePath} />
    </Suspense>
  );
}
