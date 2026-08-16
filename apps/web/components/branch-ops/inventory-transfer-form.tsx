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
import { BranchCombobox } from '@/components/shared/branch-combobox';
import { useBranchStore } from '@/stores/branch.store';
import {
  useBranchInventoryStock,
  useTransferDestinationBranches,
  useTransferInventoryStock,
  useUploadMovementProof,
} from '@/hooks/queries/use-universal-inventory';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  to_branch_id: z.uuid('Select the destination branch'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { inventory_item_id: '', to_branch_id: '', quantity: 0, notes: '' };

function TransferFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const inventoryItemId = form.watch('inventory_item_id');
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const transfer = useTransferInventoryStock(activeBranchId);
  // Backend-authorized destinations only (Transfer RBAC policy) — never a
  // client-side filter over the full branch list, since what's authorized
  // depends on the actor's role (branch: any other active branch;
  // supervisor: assigned active branches only; admin: any active branch).
  const { data: destinationBranches = [] } = useTransferDestinationBranches(activeBranchId);
  const uploadProof = useUploadMovementProof(activeBranchId);
  const [proofFile, setProofFile] = useState<File | null>(null);
  // Set only once the transfer has actually been recorded (both legs already
  // written server-side). Once set, the form below is replaced by a recovery
  // banner so a failed proof upload can never be "retried" by resubmitting
  // the whole form — that would call /transfer again and move stock twice.
  // Retry re-attaches to the same transfer_out movement id instead — proof
  // belongs to the transfer business event, not each leg independently
  // (see the backend's referenceId-sibling fallback for how the destination
  // branch's TRANSFER_IN leg resolves the same photo without a second upload).
  const [recordedTransfer, setRecordedTransfer] = useState<{ transferOutId: string } | null>(null);
  // Distinct from recordedTransfer: only true once a proof upload has
  // actually failed — recordedTransfer flips to non-null as soon as
  // /transfer succeeds, before the upload outcome is known, so the recovery
  // banner below must not key off it alone.
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
    const result = await transfer.mutateAsync({
      inventory_item_id: pendingValues.inventory_item_id,
      to_branch_id: pendingValues.to_branch_id,
      quantity: pendingValues.quantity,
      notes: pendingValues.notes || undefined,
    });
    setRecordedTransfer({ transferOutId: result.transfer_out.id });
    if (proofFile) {
      try {
        await uploadProof.mutateAsync({ movementId: result.transfer_out.id, file: proofFile });
      } catch {
        setProofUploadFailed(true); // Recovery banner takes over below.
        return;
      }
    }
    router.push(`${basePath}/inventory`);
  }

  async function retryProofUpload() {
    if (!recordedTransfer || !proofFile) return;
    try {
      await uploadProof.mutateAsync({ movementId: recordedTransfer.transferOutId, file: proofFile });
    } catch {
      setProofUploadFailed(true);
      return;
    }
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before transferring stock.</p>;
  }

  if (recordedTransfer && proofUploadFailed) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <div className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Transfer completed, but proof photo could not be uploaded.</p>
          <p className="mt-1">Both transfer legs have already been recorded — retrying below will not run the transfer again.</p>
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

          <FormField
            control={form.control}
            name="to_branch_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Destination Branch<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <BranchCombobox
                    branches={destinationBranches}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Search branches..."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity to Transfer${item ? ` (${item.base_unit_code})` : ''}`} required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <InventoryProofPhotoPicker label="Proof Photo (optional)" file={proofFile} onChange={setProofFile} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={transfer.isPending || uploadProof.isPending}>
              {(transfer.isPending || uploadProof.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
