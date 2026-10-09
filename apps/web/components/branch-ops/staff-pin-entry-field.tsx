'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVerifyStaffPin } from '@/hooks/queries/use-staff-pin';
import type { InventoryApprovalOperation } from '@potato-corner/shared';

export interface StaffPinDraft {
  operation: InventoryApprovalOperation;
  inventoryItemId?: string;
  quantity?: number;
  unitId?: string;
  reasonCode?: string;
  notes?: string;
}

interface StaffPinEntryFieldProps {
  branchId: string | null | undefined;
  draft: StaffPinDraft;
  verificationToken: string | null;
  onVerified: (token: string | null) => void;
}

/**
 * POS-PERF-P29 — masked PIN entry that calls the verify endpoint and holds
 * the resulting short-lived token for the parent form to submit alongside
 * the operation body. The raw PIN is cleared from this component's own
 * state immediately after the verify call resolves (success or failure) —
 * it is never held longer than the single request needs it. If any bound
 * draft field changes after a successful verify, the held token is cleared
 * and the staff name hidden, since the server will reject a stale token
 * anyway (payload-hash mismatch) — this just surfaces that upfront instead
 * of after a failed submit.
 */
export function StaffPinEntryField({ branchId, draft, verificationToken, onVerified }: StaffPinEntryFieldProps) {
  const [pin, setPin] = useState('');
  const [staffName, setStaffName] = useState<string | null>(null);
  const verify = useVerifyStaffPin(branchId);
  const draftKey = JSON.stringify(draft);
  const lastVerifiedDraftKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastVerifiedDraftKey.current !== null && lastVerifiedDraftKey.current !== draftKey) {
      onVerified(null);
      setStaffName(null);
      lastVerifiedDraftKey.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  async function handleVerify() {
    try {
      const result = await verify.mutateAsync({
        pin,
        operation: draft.operation,
        inventory_item_id: draft.inventoryItemId,
        quantity: draft.quantity,
        unit_id: draft.unitId,
        reason_code: draft.reasonCode,
        notes: draft.notes,
      });
      setStaffName(result.staff_name);
      lastVerifiedDraftKey.current = draftKey;
      onVerified(result.verification_token);
    } catch {
      setStaffName(null);
      onVerified(null);
    } finally {
      setPin('');
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        Staff PIN<span className="ml-0.5 text-destructive">*</span>
      </p>
      {verificationToken && staffName ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" />
          Verified — <span className="font-medium">{staffName}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-auto p-0 text-emerald-800 underline"
            onClick={() => {
              onVerified(null);
              setStaffName(null);
              lastVerifiedDraftKey.current = null;
            }}
          >
            Change
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            inputMode="numeric"
            maxLength={6}
            placeholder="Enter 4-6 digit PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="max-w-[160px]"
          />
          <Button type="button" variant="outline" onClick={() => void handleVerify()} disabled={verify.isPending || pin.length < 4}>
            {verify.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify
          </Button>
        </div>
      )}
      {verify.isError && !verificationToken && <p className="text-sm text-destructive">{verify.error.message}</p>}
    </div>
  );
}
