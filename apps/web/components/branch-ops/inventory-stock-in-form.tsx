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
import {
  useBranchInventoryStock,
  useInventoryItemConversions,
  useReceiveInventoryStock,
  useUploadMovementProof,
} from '@/hooks/queries/use-universal-inventory';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  entered_unit_id: z.uuid('Select a purchase unit'),
  total_cost: z.coerce.number().positive('Total cost is required to record acquisition cost'),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { inventory_item_id: '', quantity: 0, entered_unit_id: '', total_cost: 0, notes: '' };

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
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const inventoryItemId = form.watch('inventory_item_id');
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const { data: conversions = [] } = useInventoryItemConversions(inventoryItemId || undefined);
  const stockIn = useReceiveInventoryStock(activeBranchId, inventoryItemId);
  const uploadProof = useUploadMovementProof(activeBranchId);
  const [proofFile, setProofFile] = useState<File | null>(null);

  const purchaseUnitOptions = useMemo(
    () => (item ? buildPurchaseUnitOptions(item.base_unit_id, item.base_unit_code, conversions) : []),
    [item, conversions],
  );

  const quantity = form.watch('quantity');
  const enteredUnitId = form.watch('entered_unit_id');
  const totalCost = form.watch('total_cost');
  const selectedUnit = purchaseUnitOptions.find((u) => u.unitId === enteredUnitId);
  const baseQuantityAdded = selectedUnit ? Number(quantity || 0) * selectedUnit.baseUnitsPerPurchaseUnit : 0;
  const costPerBaseUnit = baseQuantityAdded > 0 ? Number(totalCost || 0) / baseQuantityAdded : 0;

  useEffect(() => {
    const preselected = searchParams.get('inventory_item_id');
    if (preselected) form.setValue('inventory_item_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
    const movement = await stockIn.mutateAsync({
      quantity: parsed.quantity,
      entered_unit_id: parsed.entered_unit_id,
      total_cost: parsed.total_cost,
      notes: parsed.notes || undefined,
    });
    if (proofFile) {
      await uploadProof.mutateAsync({ movementId: movement.id, file: proofFile });
    }
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording stock-in.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock In</h1>
        <p className="text-sm text-muted-foreground">Record what&apos;s on the receipt — the system converts it and works out the cost.</p>
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

          <FormFieldWrapper<FormValues> name="total_cost" label="Total Purchase Cost" description="The whole delivery's cost, as printed on the receipt" required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <InventoryProofPhotoPicker label="Receipt / Delivery Proof" file={proofFile} onChange={setProofFile} />

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          {item && selectedUnit && baseQuantityAdded > 0 && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Calculated by System</p>
              <p>
                Inventory Quantity Added: <span className="font-medium">{baseQuantityAdded.toFixed(3)}</span> {item.base_unit_code}
              </p>
              <p>
                Cost Per Inventory Unit: <span className="font-medium">₱{costPerBaseUnit.toFixed(4)}</span>
              </p>
              <p>
                Total Purchase Cost: <span className="font-medium">₱{Number(totalCost || 0).toFixed(2)}</span>
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={stockIn.isPending || uploadProof.isPending}>
              {(stockIn.isPending || uploadProof.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Receiving
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
