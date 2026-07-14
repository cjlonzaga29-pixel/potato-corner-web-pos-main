'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { ADJUSTMENT_REASON, type AdjustmentReason } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranchStore } from '@/stores/branch.store';
import { useAdjustIngredient, useIngredients } from '@/hooks/queries/use-inventory';

const REASON_LABELS: Record<AdjustmentReason, string> = {
  count_correction: 'Count Correction',
  damaged: 'Damaged',
  expired: 'Expired',
  supplier_error: 'Supplier Error',
  other: 'Other',
};

const formSchema = z.object({
  ingredient_id: z.uuid('Select an ingredient'),
  quantity_delta: z.coerce.number().refine((n) => n !== 0, 'Must not be zero'),
  reason_code: z.enum(Object.values(ADJUSTMENT_REASON) as [AdjustmentReason, ...AdjustmentReason[]]),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { ingredient_id: '', quantity_delta: 0, reason_code: 'count_correction', notes: '' };

function AdjustForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const ingredientId = form.watch('ingredient_id');
  const ingredient = ingredients?.find((i) => i.id === ingredientId);
  const adjust = useAdjustIngredient(activeBranchId, ingredientId);

  useEffect(() => {
    const preselected = searchParams.get('ingredient_id');
    if (preselected) form.setValue('ingredient_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await adjust.mutateAsync({
      quantity_delta: parsed.quantity_delta,
      reason_code: parsed.reason_code,
      notes: parsed.notes || undefined,
    });
    router.push('/supervisor/inventory');
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording an adjustment.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Adjust Stock</h1>
        <p className="text-sm text-muted-foreground">
          Correct an ingredient&apos;s stock level. Use a positive quantity to increase, negative to decrease.
        </p>
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

          <FormFieldWrapper<FormValues>
            name="quantity_delta"
            label={`Quantity Change${ingredient ? ` (${ingredient.unit})` : ''}`}
            description="Positive to increase, negative to decrease"
            required
          >
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <FormField
            control={form.control}
            name="reason_code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Reason<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.values(ADJUSTMENT_REASON) as AdjustmentReason[]).map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {REASON_LABELS[reason]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={adjust.isPending}>
              {adjust.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Adjustment
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

export default function AdjustPage() {
  return (
    <Suspense>
      <AdjustForm />
    </Suspense>
  );
}
