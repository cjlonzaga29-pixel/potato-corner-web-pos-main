'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { WASTE_REASON, type WasteReason } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranchStore } from '@/stores/branch.store';
import { useIngredients, useWasteIngredient } from '@/hooks/queries/use-inventory';

const REASON_LABELS: Record<WasteReason, string> = {
  spoilage: 'Spoilage',
  preparation_error: 'Preparation Error',
  dropped: 'Dropped',
  expired: 'Expired',
  other: 'Other',
};

const formSchema = z.object({
  ingredient_id: z.uuid('Select an ingredient'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  reason_code: z.enum(Object.values(WASTE_REASON) as [WasteReason, ...WasteReason[]]),
  notes: z.string().optional(),
  image_proof_url: z.union([z.url(), z.literal('')]).optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  ingredient_id: '',
  quantity: 0,
  reason_code: 'spoilage',
  notes: '',
  image_proof_url: '',
};

function WasteFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients } = useIngredients(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const ingredientId = form.watch('ingredient_id');
  const ingredient = ingredients?.find((i) => i.id === ingredientId);
  const waste = useWasteIngredient(activeBranchId, ingredientId);

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
    await waste.mutateAsync({
      quantity: pendingValues.quantity,
      reason_code: pendingValues.reason_code,
      notes: pendingValues.notes || undefined,
      image_proof_url: pendingValues.image_proof_url || undefined,
      image_proof_type: pendingValues.image_proof_url ? 'gallery_upload' : undefined,
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording waste.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Record Waste</h1>
        <p className="text-sm text-muted-foreground">Remove spoiled, damaged, or otherwise unusable stock from the ledger.</p>
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

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity Wasted${ingredient ? ` (${ingredient.unit})` : ''}`} required>
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
                    {(Object.values(WASTE_REASON) as WasteReason[]).map((reason) => (
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

          <FormFieldWrapper<FormValues>
            name="image_proof_url"
            label="Image Proof URL"
            description="Optional — link to an already-uploaded photo of the waste"
          >
            <Input placeholder="https://..." />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={waste.isPending}>
              {waste.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Waste
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Waste Entry"
        description="This immediately removes the stock from the ledger."
        confirmLabel="Record Waste"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}

/** Shared body behind both `/supervisor/inventory/waste` and `/branch/inventory/waste`. */
export function InventoryWasteForm({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <WasteFormContent basePath={basePath} />
    </Suspense>
  );
}
