'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
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
import { useIngredients, useTransferStock } from '@/hooks/queries/use-inventory';

const formSchema = z.object({
  ingredient_id: z.uuid('Select an ingredient'),
  to_branch_id: z.uuid('Enter the destination branch ID'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { ingredient_id: '', to_branch_id: '', quantity: 0, notes: '' };

function TransferFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const ingredientId = form.watch('ingredient_id');
  const ingredient = ingredients?.find((i) => i.id === ingredientId);
  const transfer = useTransferStock(activeBranchId);

  useEffect(() => {
    const preselected = searchParams.get('ingredient_id');
    if (preselected) form.setValue('ingredient_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [pendingValues, setPendingValues] = useState<z.output<typeof formSchema> | null>(null);

  function onSubmit(values: FormValues) {
    setPendingValues(formSchema.parse(values));
  }

  async function handleConfirm() {
    if (!pendingValues) return;
    await transfer.mutateAsync({
      ingredient_id: pendingValues.ingredient_id,
      to_branch_id: pendingValues.to_branch_id,
      quantity: pendingValues.quantity,
      notes: pendingValues.notes || undefined,
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before transferring stock.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Transfer Stock</h1>
        <p className="text-sm text-muted-foreground">
          Move stock from this branch to another. Both legs (out here, in at the destination) are recorded atomically.
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
            name="to_branch_id"
            label="Destination Branch ID"
            description="Ask your supervisor or admin for the receiving branch's ID"
            required
          >
            <Input placeholder="00000000-0000-0000-0000-000000000000" />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity to Transfer${ingredient ? ` (${ingredient.unit})` : ''}`} required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={transfer.isPending}>
              {transfer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Transfer Stock
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Stock Transfer"
        description="This immediately moves stock out of this branch and into the destination branch."
        confirmLabel="Transfer Stock"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}

/** Shared body behind both `/supervisor/inventory/transfer` and `/branch/inventory/transfer`. */
export function InventoryTransferForm({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <TransferFormContent basePath={basePath} />
    </Suspense>
  );
}
