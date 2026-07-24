'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useBranchStore } from '@/stores/branch.store';
import { useIngredients, useSubmitPhysicalCount } from '@/hooks/queries/use-inventory';

const formSchema = z.object({
  started_at: z.iso.datetime(),
  notes: z.string().optional(),
  counts: z
    .array(
      z.object({
        ingredient_id: z.uuid(),
        name: z.string(),
        unit: z.string(),
        previous_quantity: z.number(),
        counted_quantity: z.coerce.number().nonnegative('Cannot be negative'),
      }),
    )
    .min(1),
});

type FormValues = z.input<typeof formSchema>;

/** Shared body behind both `/supervisor/inventory/count` and `/branch/inventory/count`. */
export function InventoryCountForm({ basePath }: { basePath: string }) {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: ingredients, isLoading } = useIngredients(activeBranchId);
  const submitCount = useSubmitPhysicalCount(activeBranchId);
  const startedAt = useMemo(() => new Date().toISOString(), []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { started_at: startedAt, notes: '', counts: [] },
  });
  const { fields, replace } = useFieldArray({ control: form.control, name: 'counts' });

  useEffect(() => {
    // Seeds the field array once, the first time the ingredient list loads.
    // Re-running this on every refetch (e.g. a window-focus refetch while
    // mid-count) would silently overwrite whatever counted_quantity values
    // were already typed in.
    if (!ingredients || fields.length > 0) return;
    replace(
      ingredients.map((i) => ({
        ingredient_id: i.id,
        name: i.name,
        unit: i.unit,
        previous_quantity: i.current_stock,
        counted_quantity: i.current_stock,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients]);

  const [pendingValues, setPendingValues] = useState<z.output<typeof formSchema> | null>(null);

  function onSubmit(values: FormValues) {
    setPendingValues(formSchema.parse(values));
  }

  async function handleConfirm() {
    if (!pendingValues) return;
    await submitCount.mutateAsync({
      branch_id: activeBranchId as string,
      started_at: pendingValues.started_at,
      notes: pendingValues.notes || undefined,
      counts: pendingValues.counts.map((c) => ({ ingredient_id: c.ingredient_id, counted_quantity: c.counted_quantity })),
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before submitting a physical count.</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Physical Count</h1>
        <p className="text-sm text-muted-foreground">
          Enter the actual counted quantity for each ingredient. Only rows that differ from the current recorded stock produce a
          movement.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : fields.length === 0 ? (
        <EmptyState title="No ingredients yet" description="There's nothing to count until an admin adds ingredients to this branch." />
      ) : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="rounded-md border divide-y">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{field.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Recorded: {field.previous_quantity} {field.unit}
                    </p>
                  </div>
                  <FormFieldWrapper<FormValues> name={`counts.${index}.counted_quantity`}>
                    <Input type="number" step="any" inputMode="decimal" className="w-32" />
                  </FormFieldWrapper>
                </div>
              ))}
            </div>

            <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
              <Textarea rows={3} />
            </FormFieldWrapper>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitCount.isPending}>
                {submitCount.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit Count
              </Button>
            </div>
          </form>
        </Form>
      )}
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Physical Count"
        description="This posts inventory movements for every ingredient that differs from the current recorded stock."
        confirmLabel="Submit Count"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}
