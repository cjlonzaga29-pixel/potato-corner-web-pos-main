'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { EmployeePayrollResponse, EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useEmployeePayroll } from '@/hooks/queries/use-employees';

const AUTO_CLOSE_SECONDS = 60;

type PayrollFieldKey = 'sss_number' | 'philhealth_number' | 'tin_number' | 'pagibig_number';

const FIELDS: { key: PayrollFieldKey; label: string }[] = [
  { key: 'sss_number', label: 'SSS Number' },
  { key: 'philhealth_number', label: 'PhilHealth Number' },
  { key: 'tin_number', label: 'TIN' },
  { key: 'pagibig_number', label: 'Pag-IBIG Number' },
];

interface PayrollDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

/** Super Admin only — gate this at the call site with RoleGuard, this component doesn't re-check the role itself. */
export function PayrollDataDialog({ open, onOpenChange, employee }: PayrollDataDialogProps) {
  const [secondsRemaining, setSecondsRemaining] = useState(AUTO_CLOSE_SECONDS);
  const { data: payroll, isLoading, isError } = useEmployeePayroll(employee.id, open);

  // Auto-close is a security measure (locked rule) — decrypted values shouldn't stay on screen indefinitely.
  useEffect(() => {
    if (!open) return;
    setSecondsRemaining(AUTO_CLOSE_SECONDS);
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          onOpenChange(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function fieldValue(key: PayrollFieldKey, data: EmployeePayrollResponse): string | null {
    return data[key];
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="select-none sm:max-w-md"
        onCopy={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Payroll Data</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name} — {employee.employee_id}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This data is sensitive and access is being logged. This dialog closes automatically in {secondsRemaining}s.
          </span>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : isError || !payroll ? (
          <p className="text-sm text-destructive">Failed to load payroll data.</p>
        ) : (
          <div className="space-y-3">
            {FIELDS.map((field) => {
              const value = fieldValue(field.key, payroll);
              return (
                <div key={field.key} className="flex items-center justify-between gap-2 rounded-md border p-3">
                  <div>
                    <p className="text-xs text-muted-foreground">{field.label}</p>
                    <p className="font-mono text-sm">{value ?? 'Not on file'}</p>
                  </div>
                  {value && <CopyButton value={value} label={`Copy ${field.label}`} />}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
