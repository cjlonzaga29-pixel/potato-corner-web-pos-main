'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import {
  useApproveInventoryApprovalRequest,
  useCancelInventoryApprovalRequest,
  useCorrectInventoryApprovalRequest,
  useInventoryApprovalDetail,
  useReturnInventoryApprovalRequest,
} from '@/hooks/queries/use-inventory-approvals';
import { EvidenceUploadField } from '@/components/branch-ops/evidence-upload-field';
import { StaffPinEntryField } from '@/components/branch-ops/staff-pin-entry-field';

const OPERATION_LABELS: Record<string, string> = {
  RECEIVING: 'Stock In',
  ADJUSTMENT: 'Stock Adjustment',
  PHYSICAL_COUNT: 'Physical Count',
  WASTE: 'Waste',
};

function StatusBadge({ status }: { status: string }) {
  if (status === 'PENDING') return <Badge variant="pending">Pending Review</Badge>;
  if (status === 'APPROVED') return <Badge variant="active">Approved</Badge>;
  if (status === 'CANCELLED') return <Badge variant="inactive">Cancelled</Badge>;
  return <Badge variant="critical">Returned for Correction</Badge>;
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

interface InventoryApprovalDetailDialogProps {
  id: string | null;
  onOpenChange: (open: boolean) => void;
  branchId: string | null | undefined;
}

/**
 * Full review detail: submission + revision history + proof + Approve/
 * Return actions. Approve/Return are rendered only for adminOrSupervisor —
 * mirrors the server's own gate (authorize.ts's adminOrSupervisor) so a
 * branch account only ever sees a read-only detail, never a disabled button
 * it could still try to click.
 */
export function InventoryApprovalDetailDialog({ id, onOpenChange, branchId }: InventoryApprovalDetailDialogProps) {
  const user = useAuthStore((s) => s.user);
  const canReview = user?.role === 'super_admin' || user?.role === 'supervisor';
  const { data } = useInventoryApprovalDetail(id);
  const approve = useApproveInventoryApprovalRequest(branchId);
  const returnRequest = useReturnInventoryApprovalRequest(branchId);
  const correct = useCorrectInventoryApprovalRequest(branchId);
  const cancelRequest = useCancelInventoryApprovalRequest(branchId);

  const [returnReason, setReturnReason] = useState('');
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [correctionQuantity, setCorrectionQuantity] = useState('');
  const [correctionNotes, setCorrectionNotes] = useState('');
  const [correctionEvidenceKey, setCorrectionEvidenceKey] = useState<string | null>(null);
  const [correctionVerificationToken, setCorrectionVerificationToken] = useState<string | null>(null);

  if (!data) {
    return (
      <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg" />
      </Dialog>
    );
  }

  const current = data;
  const isSubmitter = user?.id === current.submitted_by_user_id;
  const quantityField =
    current.operation === 'RECEIVING' || current.operation === 'WASTE'
      ? current.entered_quantity
      : current.operation === 'ADJUSTMENT'
        ? current.quantity_delta
        : current.counted_quantity;

  // POS-PERF-P29R3 — mirrors the server's own correct() gate
  // (inventory-approval.service.ts's pinBoundFieldChanged check): only
  // RECEIVING/ADJUSTMENT/WASTE against a UNIVERSAL_ITEM ever carried a
  // mandatory PIN/evidence requirement, and a correction that changes the
  // quantity or notes from what the original revision recorded is treated
  // as a fresh physical event, not an edit to the old one — it needs its
  // own fresh verification/evidence rather than inheriting the original's.
  // Re-submitting the exact same figures (a notes-only correction, or
  // fixing something else the server tracks that this dialog doesn't even
  // expose for editing) is allowed to inherit, same as the server.
  const requiresVerification = current.target === 'UNIVERSAL_ITEM' && (current.operation === 'RECEIVING' || current.operation === 'ADJUSTMENT' || current.operation === 'WASTE');
  const quantityChanged = correctionQuantity !== '' && Number(correctionQuantity) !== (quantityField ?? Number.NaN);
  const notesChanged = correctionNotes.trim() !== '' && correctionNotes.trim() !== (current.notes ?? '').trim();
  const needsFreshVerification = requiresVerification && (quantityChanged || notesChanged);
  const canCorrect = Boolean(correctionQuantity) && (!needsFreshVerification || Boolean(correctionVerificationToken && correctionEvidenceKey));

  async function handleCorrect() {
    if (!id) return;
    const verification = needsFreshVerification ? { verification_token: correctionVerificationToken ?? undefined, evidence_key: correctionEvidenceKey ?? undefined } : {};
    const input =
      current.operation === 'RECEIVING'
        ? { entered_quantity: Number(correctionQuantity), notes: correctionNotes || undefined, ...verification }
        : current.operation === 'ADJUSTMENT'
          ? { quantity_delta: Number(correctionQuantity), notes: correctionNotes || undefined, ...verification }
          : { counted_quantity: Number(correctionQuantity), notes: correctionNotes || undefined };
    await correct.mutateAsync({ id, input });
    onOpenChange(false);
  }

  return (
    <>
      <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {data.item_name ?? 'Item'} — {OPERATION_LABELS[data.operation] ?? data.operation}
              <StatusBadge status={data.status} />
            </DialogTitle>
          </DialogHeader>

          {data.status === 'PENDING' && (
            <p className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Not yet applied to stock.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity" value={quantityField !== undefined && quantityField !== null ? `${quantityField} ${data.item_unit_code ?? ''}` : null} />
            <Field label="Reason" value={data.reason_code} />
            <Field label="Recorded By" value={data.submitted_by_name} />
            <Field label="Submitted At" value={formatDateTime(data.submitted_at)} />
            <Field label="Reviewed/Approved By" value={data.reviewed_by_name} />
            <Field label="Reviewed At" value={data.reviewed_at ? formatDateTime(data.reviewed_at) : null} />
            <Field label="Responsible Staff (PIN-verified)" value={data.responsible_staff_name} />
            <Field label="PIN Verified At" value={data.pin_verified_at ? formatDateTime(data.pin_verified_at) : null} />
          </div>
          <Field label="Notes" value={data.notes} />
          {data.status === 'RETURNED' && <Field label="Return Reason" value={data.return_reason} />}
          {data.proof_url && (
            <a href={data.proof_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
              View Proof Photo
            </a>
          )}

          {data.revisions.length > 1 && (
            <div className="space-y-1 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">Revision History</p>
              {data.revisions.map((revision) => (
                <p key={revision.id} className="text-xs text-muted-foreground">
                  Rev {revision.revision_number}: <StatusBadge status={revision.status} />
                  {revision.status === 'RETURNED' && revision.return_reason ? ` — ${revision.return_reason}` : ''}
                  {revision.status === 'CANCELLED' && revision.cancel_reason ? ` — ${revision.cancel_reason}` : ''}
                </p>
              ))}
            </div>
          )}

          {data.status === 'PENDING' && canReview && !isSubmitter && (
            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={() => setShowApproveConfirm(true)} disabled={approve.isPending}>
                {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Approve
              </Button>
              <Button variant="outline" onClick={() => setShowReturnConfirm(true)} disabled={returnRequest.isPending}>
                Return for Correction
              </Button>
            </div>
          )}
          {data.status === 'PENDING' && canReview && isSubmitter && (
            <p className="text-xs text-muted-foreground">You submitted this request — it must be reviewed by someone else.</p>
          )}

          {data.status === 'RETURNED' && (
            <div className="space-y-2 border-t pt-3">
              <Label htmlFor="correction-quantity">Corrected Quantity</Label>
              <Input id="correction-quantity" type="number" step="any" value={correctionQuantity} onChange={(e) => setCorrectionQuantity(e.target.value)} placeholder={String(quantityField ?? '')} />
              <Label htmlFor="correction-notes">Notes</Label>
              <Textarea id="correction-notes" value={correctionNotes} onChange={(e) => setCorrectionNotes(e.target.value)} rows={2} />

              {needsFreshVerification && (
                <div className="space-y-3 rounded-md border border-amber-400 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    The quantity or notes changed from the original submission — a fresh staff PIN verification and proof photo are required before this correction can be resubmitted.
                  </p>
                  <EvidenceUploadField branchId={branchId} label="Proof Photo" evidenceKey={correctionEvidenceKey} onChange={setCorrectionEvidenceKey} />
                  <StaffPinEntryField
                    branchId={branchId}
                    draft={{
                      operation: current.operation as 'RECEIVING' | 'ADJUSTMENT' | 'WASTE',
                      inventoryItemId: current.inventory_item_id ?? undefined,
                      quantity: Number(correctionQuantity || 0),
                      notes: correctionNotes || undefined,
                    }}
                    verificationToken={correctionVerificationToken}
                    onVerified={setCorrectionVerificationToken}
                  />
                </div>
              )}

              <Button onClick={() => void handleCorrect()} disabled={correct.isPending || !canCorrect}>
                {correct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Resubmit for Review
              </Button>
            </div>
          )}

          {/* Permanent cancellation (POS-PERF-P28R2) — only reachable from
              PENDING/RETURNED, same as the server; separate from Return for
              Correction, which still leaves the request correctable into a
              new revision. Shown regardless of isSubmitter: unlike
              approve/return, cancelling performs no stock mutation, so the
              server does not deny self-cancellation. */}
          {(data.status === 'PENDING' || data.status === 'RETURNED') && canReview && (
            <div className="border-t pt-3">
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setShowCancelConfirm(true)} disabled={cancelRequest.isPending}>
                Cancel Request Permanently
              </Button>
            </div>
          )}
          {data.status === 'CANCELLED' && (
            <div className="space-y-1 border-t pt-3">
              <Field label="Cancel Reason" value={data.cancel_reason} />
              <Field label="Cancelled By" value={data.cancelled_by_name} />
              <Field label="Cancelled At" value={data.cancelled_at ? formatDateTime(data.cancelled_at) : null} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showApproveConfirm}
        onOpenChange={setShowApproveConfirm}
        title="Approve this request?"
        description="This will immediately apply the change to stock."
        confirmLabel="Approve"
        onConfirm={async () => {
          if (id) await approve.mutateAsync(id);
          onOpenChange(false);
        }}
      />

      <Dialog open={showReturnConfirm} onOpenChange={setShowReturnConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Return for Correction</DialogTitle>
          </DialogHeader>
          <Label htmlFor="return-reason">Explanation (required)</Label>
          <Textarea id="return-reason" value={returnReason} onChange={(e) => setReturnReason(e.target.value)} rows={3} />
          <Button
            variant="destructive"
            disabled={!returnReason.trim() || returnRequest.isPending}
            onClick={async () => {
              if (!id) return;
              await returnRequest.mutateAsync({ id, reason: returnReason });
              setReturnReason('');
              setShowReturnConfirm(false);
              onOpenChange(false);
            }}
          >
            {returnRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Return for Correction
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel This Request Permanently</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This cannot be undone. The request (and any further correction attempts against it) will be permanently closed — stock is never changed either way.
          </p>
          <Label htmlFor="cancel-reason">Explanation (required)</Label>
          <Textarea id="cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} />
          <Button
            variant="destructive"
            disabled={!cancelReason.trim() || cancelRequest.isPending}
            onClick={async () => {
              if (!id) return;
              await cancelRequest.mutateAsync({ id, reason: cancelReason });
              setCancelReason('');
              setShowCancelConfirm(false);
              onOpenChange(false);
            }}
          >
            {cancelRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Cancel Request Permanently
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
