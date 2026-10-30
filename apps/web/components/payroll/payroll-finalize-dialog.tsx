'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayrollRunDetail } from '@potato-corner/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PayrollApiError, useFinalizePayroll } from '@/hooks/queries/use-payroll';
import { formatPayrollDuration, formatPeso } from '@/lib/payroll-format';

interface Props {
  branchId: string;
  detail: PayrollRunDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Finalization sends the fingerprint of the figures on screen. If anything
 * changed since (attendance, rates, policy, adjustments), the server refuses
 * and nothing is written: the dialog says so and the reviewer re-reviews the
 * refreshed figures. Finalizing never marks the payroll as paid.
 */
export function PayrollFinalizeDialog({ branchId, detail, open, onOpenChange }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const finalize = useFinalizePayroll(branchId, detail.id);
  const warnings = detail.issues.filter((i) => i.severity === 'warning').length;

  function close(next: boolean) {
    if (!next) {
      setAcknowledged(false);
      setProblem(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Finalize payroll</DialogTitle>
          <DialogDescription>
            {detail.branch_name}, {detail.period_start} to {detail.period_end}. Finalizing stores these exact figures, the rates and policy used, and your name. Later attendance or rate changes will not alter it; corrections need a revision.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
          <dt className="text-muted-foreground">Employees</dt>
          <dd className="text-right">{detail.employees.length}</dd>
          <dt className="text-muted-foreground">Payable time</dt>
          <dd className="text-right">{formatPayrollDuration(detail.totals.payable_ms)}</dd>
          <dt className="text-muted-foreground">Basic pay</dt>
          <dd className="text-right tabular-nums">{formatPeso(detail.totals.basic_pay)}</dd>
          <dt className="text-muted-foreground">Earnings adjustments</dt>
          <dd className="text-right tabular-nums">{formatPeso(detail.totals.earnings_adjustments)}</dd>
          <dt className="text-muted-foreground">Deductions</dt>
          <dd className="text-right tabular-nums">{formatPeso(detail.totals.deductions)}</dd>
          <dt className="font-medium">{detail.total_label}</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPeso(detail.totals.calculated_total)}</dd>
        </dl>

        {problem && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Not finalized</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-start gap-3 rounded-md border p-3">
          <Checkbox id="payroll-ack" checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
          <Label htmlFor="payroll-ack" className="text-sm font-normal leading-snug">
            I reviewed these figures{warnings > 0 ? ` and the ${warnings} warning${warnings === 1 ? '' : 's'} listed` : ''}. I understand this is basic time-based pay and does <strong>not</strong> include: {detail.exclusions.join('; ')}.
          </Label>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!acknowledged || finalize.isPending || !detail.fingerprint}
            onClick={() => {
              setProblem(null);
              finalize.mutate(
                { expected_fingerprint: detail.fingerprint as string },
                {
                  onSuccess: () => close(false),
                  onError: (error) => {
                    if (error instanceof PayrollApiError && error.code === 'STALE_PREVIEW') {
                      setAcknowledged(false);
                      setProblem('The figures changed after you opened this payroll (attendance, rates, settings or adjustments). The page now shows the updated figures — review them, then finalize again.');
                    } else {
                      setProblem(error.message);
                    }
                  },
                },
              );
            }}
          >
            {finalize.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Finalize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
