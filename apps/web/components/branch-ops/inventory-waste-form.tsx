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
import { useBranchInventoryStock, useUploadMovementProof, useWasteInventoryStock } from '@/hooks/queries/use-universal-inventory';
import { useEmployees } from '@/hooks/queries/use-employees';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';

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
  responsible_user_id: z.uuid('Select the staff member responsible'),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  inventory_item_id: '',
  quantity: 0,
  reason_code: 'spoilage',
  responsible_user_id: '',
  notes: '',
};

function WasteFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const inventoryItemId = form.watch('inventory_item_id');
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const waste = useWasteInventoryStock(activeBranchId, inventoryItemId);
  const uploadProof = useUploadMovementProof(activeBranchId);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const quantity = form.watch('quantity');
  const wasteCost = item?.avg_unit_cost != null ? Number(quantity || 0) * item.avg_unit_cost : null;

  const currentUser = useAuthStore((s) => s.user);
  const { data: staffData } = useEmployees({ branchId: activeBranchId ?? undefined, isActive: true }, { enabled: Boolean(activeBranchId) });
  const staff = staffData?.employees ?? [];

  useEffect(() => {
    const preselected = searchParams.get('inventory_item_id');
    if (preselected) form.setValue('inventory_item_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Default Responsible Staff to the logged-in actor once the same-branch roster loads and includes them.
  useEffect(() => {
    if (!currentUser) return;
    if (form.getValues('responsible_user_id')) return;
    if (staff.some((employee) => employee.id === currentUser.id)) {
      form.setValue('responsible_user_id', currentUser.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, currentUser]);

  const [pendingValues, setPendingValues] = useState<z.output<typeof formSchema> | null>(null);

  function onSubmit(values: FormValues) {
    setPendingValues(formSchema.parse(values));
  }

  async function handleConfirm() {
    if (!pendingValues) return;
    const movement = await waste.mutateAsync({
      quantity: pendingValues.quantity,
      reason_code: pendingValues.reason_code,
      responsible_user_id: pendingValues.responsible_user_id,
      notes: pendingValues.notes || undefined,
    });
    if (proofFile) {
      await uploadProof.mutateAsync({ movementId: movement.id, file: proofFile });
    }
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

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity Wasted${item ? ` (${item.base_unit_code})` : ''}`} required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          {item && (
            <p className="rounded-md border bg-muted/30 p-3 text-sm">
              Current Unit Cost:{' '}
              <span className="font-medium">{item.avg_unit_cost === null ? 'Cost not initialized' : `₱${item.avg_unit_cost.toFixed(4)}`}</span>
              {wasteCost !== null && (
                <>
                  {' — '}Estimated Waste Cost: <span className="font-medium">₱{wasteCost.toFixed(2)}</span>
                </>
              )}
            </p>
          )}

          <FormField
            control={form.control}
            name="responsible_user_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Responsible Staff<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select the staff member responsible" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {staff.map((employee) => (
                      <SelectItem key={employee.id} value={employee.id}>
                        {employee.first_name} {employee.last_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

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

          <InventoryProofPhotoPicker label="Photo Proof (optional)" file={proofFile} onChange={setProofFile} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={waste.isPending || uploadProof.isPending}>
              {(waste.isPending || uploadProof.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
