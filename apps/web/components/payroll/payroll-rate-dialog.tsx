'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayRateEmployeeView } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreatePayRate } from '@/hooks/queries/use-payroll';
import { formatPeso } from '@/lib/payroll-format';

interface Props {
  branchId: string;
  employee: PayRateEmployeeView | null;
  today: string | null;
  onOpenChange: (open: boolean) => void;
}

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/** Per-minute preview, derived from the typed hourly rate with integer arithmetic (display only). */
function perMinute(hourly: string): string | null {
  if (!AMOUNT.test(hourly)) return null;
  const [whole = '0', fraction = ''] = hourly.split('.');
  const centavos = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  const tenThousandths = (centavos * 100n * 2n + 60n) / 120n;
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, '0')}`;
}

/** Adds an effective-dated hourly rate. Earlier earnings are untouched; the server refuses it if the rate list changed meanwhile. */
export function PayrollRateDialog({ branchId, employee, today, onOpenChange }: Props) {
  const [effectiveFrom, setEffectiveFrom] = useState(today ?? '');
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const create = useCreatePayRate(branchId);
  const valid = Boolean(employee) && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) && AMOUNT.test(rate) && /[1-9]/.test(rate) && reason.trim().length >= 3;
  const preview = perMinute(rate);

  return (
    <Dialog open={employee !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" hasUnsavedInput={rate.length > 0 || reason.length > 0}>
        <DialogHeader>
          <DialogTitle>Add hourly rate</DialogTitle>
          <DialogDescription>
            {employee?.name} at this branch. The rate applies from the start of the chosen business date; days before it keep their earlier rate.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !employee) return;
            create.mutate(
              { employee_id: employee.employee_id, effective_from: effectiveFrom, hourly_rate: rate, reason: reason.trim(), expected_latest_rate_id: employee.latest_rate_id },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="rate-effective">Effective from (business date)</Label>
            <Input id="rate-effective" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rate-hourly">Hourly rate (₱)</Label>
            <Input id="rate-hourly" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.trim())} placeholder="e.g. 80.00" />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {preview ? `${formatPeso(rate)} per hour ≈ ₱${preview} per minute (display only; pay is computed from the hourly rate).` : 'Up to 2 decimals. Must be more than zero.'}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rate-reason">Reason</Label>
            <Input id="rate-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Starting rate, annual increase" />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Add rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
