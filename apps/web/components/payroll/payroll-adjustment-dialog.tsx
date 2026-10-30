'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayrollAdjustmentCreateInput } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAddPayrollAdjustment } from '@/hooks/queries/use-payroll';
import { ADJUSTMENT_CATEGORY_LABELS, formatPeso } from '@/lib/payroll-format';

interface Props {
  branchId: string;
  runId: string;
  employee: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * A labelled earning (allowance/bonus/other) or a documented deduction.
 * Deductions require a reference to the written authorization/document —
 * this screen records a deduction; it does not decide that one is allowed.
 * Attendance is never changed from here.
 */
export function PayrollAdjustmentDialog({ branchId, runId, employee, onOpenChange }: Props) {
  const [kind, setKind] = useState<'earning' | 'deduction'>('earning');
  const [category, setCategory] = useState('allowance');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [doc, setDoc] = useState('');
  const add = useAddPayrollAdjustment(branchId, runId);
  const valid = AMOUNT.test(amount) && /[1-9]/.test(amount) && reason.trim().length >= 3 && (kind === 'earning' || doc.trim().length > 0);

  return (
    <Dialog open={employee !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" hasUnsavedInput={amount.length > 0 || reason.length > 0}>
        <DialogHeader>
          <DialogTitle>Add adjustment</DialogTitle>
          <DialogDescription>For {employee?.name}. Recorded with your name; it can later be voided (with a reason) but never edited.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !employee) return;
            add.mutate(
              {
                employee_id: employee.id,
                kind,
                category: category as PayrollAdjustmentCreateInput['category'],
                amount,
                reason: reason.trim(),
                documentation_ref: kind === 'deduction' ? doc.trim() : undefined,
              },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Type</legend>
            <RadioGroup
              value={kind}
              onValueChange={(v) => {
                setKind(v as 'earning' | 'deduction');
                setCategory(v === 'earning' ? 'allowance' : 'documented_deduction');
              }}
              className="grid grid-cols-2 gap-2"
            >
              <Label htmlFor="adj-earning" className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal">
                <RadioGroupItem id="adj-earning" value="earning" /> Earning
              </Label>
              <Label htmlFor="adj-deduction" className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal">
                <RadioGroupItem id="adj-deduction" value="deduction" /> Deduction
              </Label>
            </RadioGroup>
          </fieldset>
          {kind === 'earning' && (
            <div className="grid gap-2">
              <Label htmlFor="adj-category">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="adj-category" className="min-h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['allowance', 'bonus', 'other_earning'].map((c) => (
                    <SelectItem key={c} value={c}>
                      {ADJUSTMENT_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="adj-amount">Amount (₱)</Label>
            <Input id="adj-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="e.g. 150.00" />
            {AMOUNT.test(amount) && <p className="text-xs text-muted-foreground">{kind === 'earning' ? 'Adds' : 'Subtracts'} {formatPeso(amount)}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adj-reason">Reason</Label>
            <Input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={kind === 'earning' ? 'e.g. Meal allowance for inventory day' : 'e.g. Uniform replacement'} />
          </div>
          {kind === 'deduction' && (
            <div className="grid gap-2">
              <Label htmlFor="adj-doc">Documentation reference</Label>
              <Input id="adj-doc" value={doc} onChange={(e) => setDoc(e.target.value)} maxLength={200} placeholder="e.g. Signed authorization form #12" />
              <p className="text-xs text-muted-foreground">Required. Only record deductions the employee has authorized in writing or that are otherwise documented.</p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || add.isPending}>
              {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Add {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
