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
import { useAdjustInventoryStock, useBranchInventoryStock, useUploadMovementProof } from '@/hooks/queries/use-universal-inventory';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';

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
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { inventory_item_id: '', quantity_delta: 0, reason_code: 'count_correction', notes: '' };

function AdjustFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const inventoryItemId = form.watch('inventory_item_id');
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const adjust = useAdjustInventoryStock(activeBranchId, inventoryItemId);
  const uploadProof = useUploadMovementProof(activeBranchId);
  const [proofFile, setProofFile] = useState<File | null>(null);
  // Set only once the adjustment has actually been recorded (stock already
  // changed server-side). Once set, the form below is replaced by a
  // recovery banner so a failed proof upload can never be "retried" by
  // resubmitting the whole form — that would call /adjust again and double
  // the adjustment. Retry re-attaches to this same movement id instead.
  const [recordedMovement, setRecordedMovement] = useState<{ id: string } | null>(null);
  // Distinct from recordedMovement: only true once a proof upload has
  // actually failed — recordedMovement flips to non-null as soon as /adjust
  // succeeds, before the upload outcome is known, so the recovery banner
  // below must not key off it alone.
  const [proofUploadFailed, setProofUploadFailed] = useState(false);

  useEffect(() => {
    const preselected = searchParams.get('inventory_item_id');
    if (preselected) form.setValue('inventory_item_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [pendingValues, setPendingValues] = useState<z.output<typeof formSchema> | null>(null);

  function onSubmit(values: FormValues) {
    setPendingValues(formSchema.parse(values));
  }

  async function handleConfirm() {
    if (!pendingValues) return;
    const movement = await adjust.mutateAsync({
      quantity_delta: pendingValues.quantity_delta,
      reason_code: pendingValues.reason_code,
      notes: pendingValues.notes || undefined,
    });
    setRecordedMovement({ id: movement.id });
    if (proofFile) {
      try {
        await uploadProof.mutateAsync({ movementId: movement.id, file: proofFile });
      } catch {
        setProofUploadFailed(true); // Recovery banner takes over below.
        return;
      }
    }
    router.push(`${basePath}/inventory`);
  }

  async function retryProofUpload() {
    if (!recordedMovement || !proofFile) return;
    try {
      await uploadProof.mutateAsync({ movementId: recordedMovement.id, file: proofFile });
    } catch {
      setProofUploadFailed(true);
      return;
    }
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording an adjustment.</p>;
  }

  if (recordedMovement && proofUploadFailed) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <div className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Stock adjustment was recorded, but the proof photo could not be uploaded.</p>
          <p className="mt-1">The adjustment has already been applied — retrying below will not apply it again.</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push(`${basePath}/inventory`)}>
            Continue Without Photo
          </Button>
          <Button type="button" onClick={() => void retryProofUpload()} disabled={uploadProof.isPending || !proofFile}>
            {uploadProof.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Retry Photo Upload
          </Button>
        </div>
      </div>
    );
  }

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
          {/* Radix Select takes value/onValueChange, not the onChange FormFieldWrapper clones onto children — wired directly via FormField instead. */}
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

          <InventoryProofPhotoPicker label="Proof Photo (optional)" file={proofFile} onChange={setProofFile} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={adjust.isPending || uploadProof.isPending}>
              {(adjust.isPending || uploadProof.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Adjustment
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Stock Adjustment"
        description="This immediately changes the recorded stock level."
        confirmLabel="Adjust Stock"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}

/** Shared body behind both `/supervisor/inventory/adjust` and `/branch/inventory/adjust`. */
export function InventoryAdjustForm({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <AdjustFormContent basePath={basePath} />
    </Suspense>
  );
}
