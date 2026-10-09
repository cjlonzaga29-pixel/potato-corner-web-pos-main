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
import { useAuthStore } from '@/stores/auth.store';
import { useBranchInventoryStock, useWasteInventoryStock } from '@/hooks/queries/use-universal-inventory';
import { EvidenceUploadField } from './evidence-upload-field';
import { StaffPinEntryField } from './staff-pin-entry-field';
import { LockedItemDisplay } from './locked-item-display';

const REASON_LABELS: Record<WasteReason, string> = {
  spoilage: 'Spoilage',
  preparation_error: 'Preparation Error',
  dropped: 'Dropped',
  expired: 'Expired',
  other: 'Other',
};

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  reason_code: z.enum(Object.values(WASTE_REASON) as [WasteReason, ...WasteReason[]]),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  inventory_item_id: '',
  quantity: 0,
  reason_code: 'spoilage',
  notes: '',
};

function WasteFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const role = useAuthStore((s) => s.user?.role);
  const isDirectRecord = role === 'supervisor' || role === 'super_admin';
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  // A row action's ?inventory_item_id= is read directly from the URL on
  // every render (never subject to whatever reset the watched form field
  // back to '' below) and takes priority over the form's own value — the
  // form field is still kept in sync (for submission) by the effect, but
  // display/lookup never depends on that sync having already landed.
  const lockedItemId = searchParams.get('inventory_item_id');
  const watchedItemId = form.watch('inventory_item_id');
  const inventoryItemId = lockedItemId || watchedItemId;
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const waste = useWasteInventoryStock(activeBranchId, inventoryItemId);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

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
    if (!pendingValues || !verificationToken || !evidenceKey) return;
    await waste.mutateAsync({
      quantity: pendingValues.quantity,
      reason_code: pendingValues.reason_code,
      notes: pendingValues.notes || undefined,
      verification_token: verificationToken,
      evidence_key: evidenceKey,
    });
    router.push(isDirectRecord ? `${basePath}/inventory` : `${basePath}/inventory/approvals`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording waste.</p>;
  }

  const canSubmit = Boolean(verificationToken && evidenceKey);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Record Waste</h1>
        <p className="text-sm text-muted-foreground">Remove spoiled, damaged, or otherwise unusable stock from the ledger.</p>
        <p className="text-sm text-muted-foreground">
          {isDirectRecord
            ? `Recorded by ${role === 'super_admin' ? 'Admin' : 'Supervisor'} — applies immediately.`
            : "Submitted for supervisor review — stock will not change until it's approved."}
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

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity Wasted${item ? ` (${item.base_unit_code})` : ''}`} required>
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

          <EvidenceUploadField branchId={activeBranchId} label="Photo Proof" evidenceKey={evidenceKey} onChange={setEvidenceKey} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          {/* POS-PERF-P29 — Responsible Staff is no longer a client-picked field: the
              PIN verification below resolves and server-authenticates the
              accountable staff member, replacing the old spoofable responsible_user_id select. */}
          <StaffPinEntryField
            branchId={activeBranchId}
            draft={{
              operation: 'WASTE',
              inventoryItemId,
              quantity: Number(form.watch('quantity') || 0),
              reasonCode: form.watch('reason_code'),
              notes: form.watch('notes') || undefined,
            }}
            verificationToken={verificationToken}
            onVerified={setVerificationToken}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || waste.isPending}>
              {waste.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isDirectRecord ? 'Save Waste' : 'Submit for Review'}
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Waste Entry"
        description={
          isDirectRecord
            ? 'This immediately removes the stock from the ledger, labeled as recorded by a supervisor.'
            : "This submits the waste entry for supervisor review — stock will not change until it's approved."
        }
        confirmLabel={isDirectRecord ? 'Save Waste' : 'Submit for Review'}
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
