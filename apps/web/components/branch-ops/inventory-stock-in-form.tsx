'use client';

import { Suspense, useEffect } from 'react';
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
import { useBranchInventoryStock, useReceiveInventoryStock } from '@/hooks/queries/use-universal-inventory';

const formSchema = z.object({
  inventory_item_id: z.uuid('Select an item'),
  quantity: z.coerce.number().positive('Must be greater than zero'),
  unit_cost: z.coerce.number().positive('Unit cost is required to record acquisition cost'),
  delivery_reference: z.string().max(100).optional(),
  notes: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { inventory_item_id: '', quantity: 0, unit_cost: 0, delivery_reference: '', notes: '' };

function StockInFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: stock } = useBranchInventoryStock(activeBranchId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const inventoryItemId = form.watch('inventory_item_id');
  const item = stock?.items.find((i) => i.inventory_item_id === inventoryItemId);
  const stockIn = useReceiveInventoryStock(activeBranchId, inventoryItemId);
  const quantity = form.watch('quantity');
  const unitCost = form.watch('unit_cost');
  const totalCost = Number(quantity || 0) * Number(unitCost || 0);

  useEffect(() => {
    const preselected = searchParams.get('inventory_item_id');
    if (preselected) form.setValue('inventory_item_id', preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await stockIn.mutateAsync({
      quantity: parsed.quantity,
      unit_cost: parsed.unit_cost,
      delivery_reference: parsed.delivery_reference || undefined,
      notes: parsed.notes || undefined,
    });
    router.push(`${basePath}/inventory`);
  }

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before recording stock-in.</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock In</h1>
        <p className="text-sm text-muted-foreground">Record newly received stock for an item at this branch.</p>
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

          <FormFieldWrapper<FormValues> name="quantity" label={`Quantity Received${item ? ` (${item.base_unit_code})` : ''}`} required>
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues>
            name="unit_cost"
            label={`Unit Cost${item ? ` (per ${item.base_unit_code})` : ''}`}
            description="Purchase cost per unit for this delivery"
            required
          >
            <Input type="number" step="any" inputMode="decimal" />
          </FormFieldWrapper>

          <p className="rounded-md border bg-muted/30 p-3 text-sm">
            Total Cost: <span className="font-medium">₱{totalCost.toFixed(2)}</span>
          </p>

          <FormFieldWrapper<FormValues> name="delivery_reference" label="Delivery Reference" description="Optional">
            <Input placeholder="PO number, delivery receipt, etc." />
          </FormFieldWrapper>

          <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
            <Textarea rows={3} />
          </FormFieldWrapper>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={stockIn.isPending}>
              {stockIn.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Stock In
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
