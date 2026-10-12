'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
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
import { useAdjustInventoryStock, useBranchInventoryStock } from '@/hooks/queries/use-universal-inventory';
import { EvidenceUploadField } from './evidence-upload-field';
import { LockedItemDisplay } from './locked-item-display';
import { InventoryAdjustmentHistory } from './inventory-adjustment-history';

const REASON_LABELS: Record<AdjustmentReason, string> = {
  count_correction: 'Count Correction',
  damaged: 'Damaged',
  expired: 'Expired',
  supplier_error: 'Supplier Error',
  other: 'Other',
};

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  quantity_delta: z.coerce.number().refine((n) => n !== 0, 'Must not be zero'),
  reason_code: z.enum(Object.values(ADJUSTMENT_REASON) as [AdjustmentReason, ...AdjustmentReason[]]),
  notes: z.string().optional(),
  staff_involved_name: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  inventory_item_id: '',
  quantity_delta: 0,
  reason_code: 'count_correction',
  notes: '',
  staff_involved_name: '',
};

function AdjustFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  // See inventory-waste-form.tsx's matching comment: the URL param takes
  // priority over the watched form field for display/lookup, never only
  // the (possibly not-yet-synced) form value.
  const lockedItemId = searchParams.get('inventory_item_id');
  const watchedItemId = form.watch('inventory_item_id');
  const inventoryItemId = lockedItemId || watchedItemId;
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const adjust = useAdjustInventoryStock(activeBranchId, inventoryItemId);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);

  useEffect(() => {
    if (lockedItemId && form.getValues('inventory_item_id') !== lockedItemId) {
      form.setValue('inventory_item_id', lockedItemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedItemId, watchedItemId]);

  const [pendingValues, setPendingValues] = useState<z.output<typeof formSchema> | null>(null);

  function onSubmit(values: FormValues) {
    setPendingValues(formSchema.parse(values));
  }

  async function handleConfirm() {
    if (!pendingValues || !evidenceKey) return;
    await adjust.mutateAsync({
      quantity_delta: pendingValues.quantity_delta,
      reason_code: pendingValues.reason_code,
      notes: pendingValues.notes || undefined,
      staff_involved_name: pendingValues.staff_involved_name || undefined,
      evidence_key: evidenceKey,
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording an adjustment.</p>;
  }

  const canSubmit = Boolean(evidenceKey);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Adjust Stock</h1>
        <p className="text-sm text-muted-foreground">
          Correct an item&apos;s stock level. Use a positive quantity to increase, negative to decrease.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {lockedItemId && item ? (
            <LockedItemDisplay name={item.name} unitCode={item.base_unit_code} />
          ) : (
            <FormField
              control={form.control}
              name="inventory_item_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Item<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an item" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {stock?.items.map((i) => (
                        <SelectItem key={i.inventory_item_id} value={i.inventory_item_id}>
                          {i.name} ({i.base_unit_code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {item && (
            <p className="rounded-md border bg-muted/30 p-3 text-sm">
              Current stock: <span className="font-medium">{item.quantity_on_hand}</span> {item.base_unit_code}
            </p>
          )}

          <FormFieldWrapper<FormValues>
            name="quantity_delta"
            label={`Quantity Change${item ? ` (${item.base_unit_code})` : ''}`}
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

          <EvidenceUploadField branchId={activeBranchId} label="Proof Photo" evidenceKey={evidenceKey} onChange={setEvidenceKey} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues>
            name="staff_involved_name"
            label="Staff Involved (reported)"
            description="Optional — who physically reported or caused this, if relevant. Not identity-verified."
          >
            <Input />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || adjust.isPending}>
              {adjust.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Adjustment
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Stock Adjustment"
        description="This applies the adjustment immediately — recorded under your account."
        confirmLabel="Save Adjustment"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}

/** Shared body behind both `/supervisor/inventory/adjust` and `/branch/inventory/adjust`. */
export function InventoryAdjustForm({ basePath }: { basePath: string }) {
  return (
    <div className="space-y-10">
      <Suspense>
        <AdjustFormContent basePath={basePath} />
      </Suspense>
      <InventoryAdjustmentHistory />
    </div>
  );
}
