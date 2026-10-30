'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** Field label; defaults to "Reason". */
  fieldLabel?: string;
  /** When false, an empty value is allowed (e.g. an optional payment reference). */
  required?: boolean;
  destructive?: boolean;
  isPending: boolean;
  onConfirm: (value: string) => void;
}

/** One text field + confirm — used for voids, discard, revise and mark-as-paid. Every such action records who and why. */
export function PayrollReasonDialog({ open, onOpenChange, title, description, confirmLabel, fieldLabel = 'Reason', required = true, destructive, isPending, onConfirm }: Props) {
  const [value, setValue] = useState('');
  const tooShort = required && value.trim().length < 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setValue('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" hasUnsavedInput={value.trim().length > 0}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooShort) onConfirm(value.trim());
          }}
          className="grid gap-3"
        >
          <div className="grid gap-2">
            <Label htmlFor="payroll-reason-field">{fieldLabel}</Label>
            <Textarea id="payroll-reason-field" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} rows={3} autoFocus />
            {required && <p className="text-xs text-muted-foreground">Required, at least 3 characters.</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={tooShort || isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
