'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { COST_CORRECTION_REASON, type CostCorrectionReason } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateInventoryCostCorrection, useUploadCostCorrectionProof } from '@/hooks/queries/use-universal-inventory';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';

const REASON_LABELS: Record<CostCorrectionReason, string> = {
  incorrect_receiving_cost: 'Incorrect receiving cost',
  supplier_invoice_correction: 'Supplier invoice correction',
  data_entry_mistake: 'Data-entry mistake',
  opening_balance_correction: 'Opening balance correction',
  other: 'Other',
};

const formSchema = z.object({
  new_unit_cost: z.coerce.number().positive('New unit cost must be greater than zero'),
  reason_code: z.enum(Object.values(COST_CORRECTION_REASON) as [CostCorrectionReason, ...CostCorrectionReason[]]),
  notes: z.string().max(500).optional(),
});

type FormValues = z.input<typeof formSchema>;

interface CostCorrectionDialogProps {
  branchId: string;
  inventoryItemId: string;
  itemName: string;
  baseUnitCode: string;
  quantityOnHand: number;
  currentUnitCost: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Controlled valuation correction (Receiving Simplification V2 §12-15) —
 * changes InventoryStock.unit_cost prospectively only. Never rewrites past
 * sales/COGS/waste/receiving; the valuation-difference preview below is
 * shown so the actor sees the current-inventory impact before confirming,
 * but it is never itself booked as COGS (see the server's doc comment on
 * InventoryCostCorrection).
 */
export function CostCorrectionDialog({
  branchId,
  inventoryItemId,
  itemName,
  baseUnitCode,
  quantityOnHand,
  currentUnitCost,
  open,
  onOpenChange,
}: CostCorrectionDialogProps) {
  const createCorrection = useCreateInventoryCostCorrection(branchId, inventoryItemId);
  const uploadProof = useUploadCostCorrectionProof(branchId);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { new_unit_cost: currentUnitCost ?? 0, reason_code: 'incorrect_receiving_cost', notes: '' },
  });

  const newUnitCost = Number(form.watch('new_unit_cost') || 0);
  const valuationDifference = currentUnitCost !== null ? quantityOnHand * (newUnitCost - currentUnitCost) : 0;

  function handleOpenChange(next: boolean) {
    if (!next) {
      form.reset({ new_unit_cost: currentUnitCost ?? 0, reason_code: 'incorrect_receiving_cost', notes: '' });
      setProofFile(null);
    }
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    const correction = await createCorrection.mutateAsync({
      new_unit_cost: parsed.new_unit_cost,
      reason_code: parsed.reason_code,
      notes: parsed.notes || undefined,
    });
    if (proofFile) {
      await uploadProof.mutateAsync({ correctionId: correction.id, file: proofFile });
    }
    handleOpenChange(false);
  }

  const isPending = createCorrection.isPending || uploadProof.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct Cost — {itemName}</DialogTitle>
          <DialogDescription>
            Changes the current carrying cost only. Past sales, COGS, waste, and receiving history are never rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3 text-sm">
          <div>
            <p className="text-muted-foreground">Current Stock</p>
            <p className="font-medium">
              {quantityOnHand} {baseUnitCode}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Current Average Cost</p>
            <p className="font-medium">{currentUnitCost === null ? 'Cost not initialized' : `₱${currentUnitCost.toFixed(4)}`}</p>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="new_unit_cost" label="New Average Cost" required>
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
                      {(Object.values(COST_CORRECTION_REASON) as CostCorrectionReason[]).map((reason) => (
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

            <InventoryProofPhotoPicker label="Proof Photo (recommended)" file={proofFile} onChange={setProofFile} />

            {currentUnitCost !== null && (
              <p className="rounded-md border bg-muted/30 p-3 text-sm">
                Valuation Adjustment:{' '}
                <span className={`font-medium ${valuationDifference < 0 ? 'text-destructive' : ''}`}>
                  {valuationDifference >= 0 ? '+' : ''}₱{valuationDifference.toFixed(2)}
                </span>
                <span className="ml-1 text-muted-foreground">
                  ({quantityOnHand} × ₱{(newUnitCost - currentUnitCost).toFixed(4)})
                </span>
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Correct Cost
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
