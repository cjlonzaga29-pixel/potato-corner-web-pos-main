'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSetStaffPin, useRevokeStaffPin, useStaffPinStatus } from '@/hooks/queries/use-staff-pin';

interface ManageStaffPinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

const PIN_FORMAT_RE = /^\d{4,6}$/;

/**
 * POS-PERF-P30 — Supervisor/Branch authorizes setup/reset/deactivation;
 * the PIN itself is always typed by the staff member in these masked
 * fields, never displayed back, and cleared from local state on success,
 * cancellation, or the dialog closing — never persisted outside this one
 * submit. Duplicate-PIN / invalid-format errors surface verbatim (the
 * server's message is already generic — see staff-pin.service.ts#setPin —
 * and never names another staff member).
 */
export function ManageStaffPinDialog({ open, onOpenChange, employee }: ManageStaffPinDialogProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const status = useStaffPinStatus(employee.id, open);
  const setStaffPin = useSetStaffPin(employee.id);
  const revokeStaffPin = useRevokeStaffPin(employee.id);

  function resetFields() {
    setPin('');
    setConfirmPin('');
    setError(null);
  }

  useEffect(() => {
    if (open) resetFields();
  }, [open]);

  function handleOpenChange(next: boolean) {
    resetFields();
    onOpenChange(next);
  }

  const hasActivePin = status.data?.has_pin && status.data.is_active;
  const formatValid = PIN_FORMAT_RE.test(pin);
  const pinsMatch = pin.length > 0 && pin === confirmPin;
  const canSubmit = formatValid && pinsMatch;

  async function handleSetPin() {
    setError(null);
    if (!formatValid) {
      setError('PIN must be 4-6 digits.');
      return;
    }
    if (!pinsMatch) {
      setError('PINs do not match.');
      return;
    }
    try {
      await setStaffPin.mutateAsync({ pin });
      handleOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save PIN');
      resetFields();
    }
  }

  async function handleDeactivate() {
    try {
      await revokeStaffPin.mutateAsync();
      handleOpenChange(false);
    } catch {
      // useRevokeStaffPin's onError already toasts.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{hasActivePin ? 'Reset Inventory/POS PIN' : 'Set Up Inventory/POS PIN'}</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name} — have them enter and confirm a new PIN below. It is never shown back to
            anyone, including you.
          </DialogDescription>
        </DialogHeader>

        {status.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="staff-pin-new">New PIN (4-6 digits)</Label>
              <Input
                id="staff-pin-new"
                type="password"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                value={pin}
                onChange={(e) => {
                  setError(null);
                  setPin(e.target.value.replace(/\D/g, ''));
                }}
                placeholder="Staff enters their PIN"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-pin-confirm">Confirm PIN</Label>
              <Input
                id="staff-pin-confirm"
                type="password"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                value={confirmPin}
                onChange={(e) => {
                  setError(null);
                  setConfirmPin(e.target.value.replace(/\D/g, ''));
                }}
                placeholder="Staff confirms their PIN"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          {hasActivePin ? (
            <Button
              type="button"
              variant="danger"
              className="sm:mr-auto"
              disabled={revokeStaffPin.isPending}
              onClick={() => void handleDeactivate()}
            >
              {revokeStaffPin.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Deactivate PIN
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmit || setStaffPin.isPending} onClick={() => void handleSetPin()}>
              {setStaffPin.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {hasActivePin ? 'Save Reset PIN' : 'Save PIN'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
