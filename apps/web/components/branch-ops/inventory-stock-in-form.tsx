'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
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
import { useAuthStore } from '@/stores/auth.store';
import { useBranchInventoryStock, useInventoryItemConversions, useReceiveInventoryStock } from '@/hooks/queries/use-universal-inventory';
import { EvidenceUploadField } from './evidence-upload-field';
import { StaffPinEntryField } from './staff-pin-entry-field';
import { LockedItemDisplay } from './locked-item-display';

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  entered_unit_id: z.uuid('Select a purchase unit'),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { inventory_item_id: '', quantity: 0, entered_unit_id: '', notes: '' };

/**
 * Purchase-unit options for an item: its own base unit (always available,
 * 1:1) plus every unit with an admin-configured InventoryItemUnitConversion
 * touching that base unit (Receiving Simplification V2 §2-3) — never a
 * meaningless/unconfigured conversion. baseUnitsPerPurchaseUnit only feeds
 * the client-side preview below; the server (convertQuantity) is the
 * authoritative conversion.
 */
interface PurchaseUnitOption {
  unitId: string;
  code: string;
  baseUnitsPerPurchaseUnit: number;
}

function buildPurchaseUnitOptions(
  baseUnitId: string,
  baseUnitCode: string,
  conversions: { from_unit_id: string; from_unit_code: string; to_unit_id: string; to_unit_code: string; factor: number }[],
): PurchaseUnitOption[] {
  const options = new Map<string, PurchaseUnitOption>();
  options.set(baseUnitId, { unitId: baseUnitId, code: baseUnitCode, baseUnitsPerPurchaseUnit: 1 });

  for (const conv of conversions) {
    if (conv.to_unit_id === baseUnitId && conv.from_unit_id !== baseUnitId) {
      options.set(conv.from_unit_id, { unitId: conv.from_unit_id, code: conv.from_unit_code, baseUnitsPerPurchaseUnit: conv.factor });
    } else if (conv.from_unit_id === baseUnitId && conv.to_unit_id !== baseUnitId) {
      options.set(conv.to_unit_id, { unitId: conv.to_unit_id, code: conv.to_unit_code, baseUnitsPerPurchaseUnit: 1 / conv.factor });
    }
  }

  return Array.from(options.values());
}

function StockInFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const role = useAuthStore((s) => s.user?.role);
  const isDirectRecord = role === 'supervisor' || role === 'super_admin';
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  // POS-PERF-P29 — a row action passes ?inventory_item_id=; once present the
  // item is locked (read-only) rather than re-offering the <Select>. Read
  // directly from the URL every render (never only the watched form field,
  // which the self-healing effect below re-syncs but isn't guaranteed to
  // have already applied on the very first renders).
  const lockedItemId = searchParams.get('inventory_item_id');
  const watchedItemId = form.watch('inventory_item_id');
  const inventoryItemId = lockedItemId || watchedItemId;
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const { data: conversions = [] } = useInventoryItemConversions(inventoryItemId || undefined);
  const stockIn = useReceiveInventoryStock(activeBranchId, inventoryItemId);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

  const purchaseUnitOptions = useMemo(
    () => (item ? buildPurchaseUnitOptions(item.base_unit_id, item.base_unit_code, conversions) : []),
    [item, conversions],
  );

  const quantity = form.watch('quantity');
  const enteredUnitId = form.watch('entered_unit_id');
  const selectedUnit = purchaseUnitOptions.find((u) => u.unitId === enteredUnitId);
  const baseQuantityAdded = selectedUnit ? Number(quantity || 0) * selectedUnit.baseUnitsPerPurchaseUnit : 0;

  useEffect(() => {
    if (lockedItemId && form.getValues('inventory_item_id') !== lockedItemId) {
      form.setValue('inventory_item_id', lockedItemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedItemId, watchedItemId]);

  // Default the Purchase Unit to the item's own base unit once options load,
  // so the common case (no configured purchase-unit conversions) needs zero
  // extra taps — quantity is then entered directly in the base unit.
  useEffect(() => {
    if (!item) return;
    if (form.getValues('entered_unit_id')) return;
    form.setValue('entered_unit_id', item.base_unit_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    if (!verificationToken || !evidenceKey) return;
    await stockIn.mutateAsync({
      quantity: parsed.quantity,
      entered_unit_id: parsed.entered_unit_id,
      notes: parsed.notes || undefined,
      verification_token: verificationToken,
      evidence_key: evidenceKey,
    });
    router.push(isDirectRecord ? `${basePath}/inventory` : `${basePath}/inventory/approvals`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording stock-in.</p>;
  }

  const canSubmit = Boolean(verificationToken && evidenceKey) && !stockIn.isPending;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock In</h1>
        <p className="text-sm text-muted-foreground">Record what&apos;s on the receipt — the system converts the quantity into inventory units.</p>
        <p className="text-sm text-muted-foreground">
          {isDirectRecord ? 'Recorded by Supervisor — applies immediately.' : "Submitted for supervisor review — stock will not change until it's approved."}
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
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      form.setValue('entered_unit_id', '');
                    }}
                  >
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

          <FormFieldWrapper<FormValues> name="quantity" label="Purchase Quantity" required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <FormField
            control={form.control}
            name="entered_unit_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Purchase Unit<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={!item}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an item first" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {purchaseUnitOptions.map((u) => (
                      <SelectItem key={u.unitId} value={u.unitId}>
                        {u.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <EvidenceUploadField branchId={activeBranchId} label="Receipt / Delivery Proof" evidenceKey={evidenceKey} onChange={setEvidenceKey} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <StaffPinEntryField
            branchId={activeBranchId}
            draft={{ operation: 'RECEIVING', inventoryItemId, quantity: Number(quantity || 0), unitId: enteredUnitId, notes: form.watch('notes') }}
            verificationToken={verificationToken}
            onVerified={setVerificationToken}
          />

          {item && selectedUnit && baseQuantityAdded > 0 && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Calculated by System</p>
              <p>
                Inventory Quantity Added: <span className="font-medium">{baseQuantityAdded.toFixed(3)}</span> {item.base_unit_code}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {stockIn.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isDirectRecord ? 'Save Stock In' : 'Submit for Review'}
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
