'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react';
import { VAT_RATE_PERCENT, type BranchTaxProfileResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSaveError, useUpdateBranchTaxProfile } from '@/hooks/queries/use-settings';
import { formatManilaDateTime } from '@/lib/manila-date';

const STATUS_LABELS = {
  unconfirmed: 'Not confirmed',
  vat_registered: 'VAT-registered (confirmed)',
  non_vat_registered: 'Non-VAT registered',
} as const;

interface BranchVatRegistrationProps {
  branchId: string;
  branchName: string;
  profile: BranchTaxProfileResponse;
  canEdit: boolean;
}

/**
 * POS-PERF-P50R — a branch's VAT registration is a legal fact, not a tax
 * switch. Every branch is calculated as VAT-registered (12%, prices include
 * VAT); until a Super Admin records the registration, that assumption is
 * shown as "Not confirmed". Non-VAT registration is listed but cannot be
 * chosen: this version has no non-VAT calculation or receipt.
 */
export function BranchVatRegistration({ branchId, branchName, profile, canEdit }: BranchVatRegistrationProps) {
  const save = useUpdateBranchTaxProfile(branchId);
  const [status, setStatus] = useState<'unconfirmed' | 'vat_registered'>(profile.vatRegistration === 'vat_registered' ? 'vat_registered' : 'unconfirmed');
  const [note, setNote] = useState(profile.note ?? '');
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    setStatus(profile.vatRegistration === 'vat_registered' ? 'vat_registered' : 'unconfirmed');
    setNote(profile.note ?? '');
  }, [profile]);

  const confirmed = profile.vatRegistration === 'vat_registered';
  const dirty = status !== profile.vatRegistration || note.trim() !== (profile.note ?? '');
  const noteId = `vat-note-${branchId}`;
  const statusId = `vat-status-${branchId}`;

  return (
    <section className="space-y-2 rounded-md border p-3" aria-labelledby={`${statusId}-heading`} data-testid="branch-vat-registration">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${statusId}-heading`} className="text-sm font-medium">
            VAT registration
          </h3>
          <p className="text-xs text-muted-foreground">
            Checkout calculates {branchName} as a VAT-registered seller: {VAT_RATE_PERCENT}% VAT, already included in menu prices. The rate is set by law and
            is not editable.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${confirmed ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400' : 'border-amber-500/50 text-amber-700 dark:text-amber-400'}`}
          data-testid="vat-registration-status"
        >
          {confirmed ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
          {STATUS_LABELS[profile.vatRegistration]}
        </span>
      </div>

      {!confirmed && (
        <p className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs dark:bg-amber-950/20" role="note">
          Assumption, not yet confirmed: this branch is VAT-registered. If it is not, its receipts show VAT it should not charge. The owner must confirm the
          branch&apos;s BIR registration; a Super Admin then records it here.
        </p>
      )}
      {profile.note && <p className="text-xs text-muted-foreground">Note: {profile.note}</p>}
      {profile.updatedAt && <p className="text-xs text-muted-foreground">Last recorded {formatManilaDateTime(profile.updatedAt)}</p>}

      {canEdit ? (
        <div className="grid gap-2 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={statusId} className="text-xs">
              Registration
            </Label>
            <Select value={status} onValueChange={(value) => setStatus(value as 'unconfirmed' | 'vat_registered')}>
              <SelectTrigger id={statusId} aria-label={`VAT registration for ${branchName}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unconfirmed">{STATUS_LABELS.unconfirmed}</SelectItem>
                <SelectItem value="vat_registered">{STATUS_LABELS.vat_registered}</SelectItem>
                <SelectItem value="non_vat_registered" disabled>
                  {STATUS_LABELS.non_vat_registered} — not supported yet
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={noteId} className="text-xs">
              Where it was confirmed (optional)
            </Label>
            <Input id={noteId} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. BIR Form 2303 seen on 2026-10-30" />
          </div>
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setConflict(false);
              save.mutate(
                { vatRegistration: status, note: note.trim() === '' ? null : note.trim(), expectedUpdatedAt: profile.updatedAt },
                { onError: (error) => setConflict(error instanceof SettingsSaveError && error.code === 'SETTINGS_CHANGED') },
              );
            }}
          >
            {save.isPending ? 'Saving…' : 'Record'}
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Non-VAT registration cannot be chosen: a non-VAT branch needs a different calculation and receipt that this version does not have.
          </p>
          {conflict && (
            <p role="alert" className="text-xs text-destructive sm:col-span-3">
              Someone else recorded this after you opened it. The current value is shown now — check it before recording again.
            </p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" /> Only a Super Admin records a branch&apos;s VAT registration, from its BIR registration.
        </p>
      )}
    </section>
  );
}
