'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { ADJUSTMENT_REASON, WASTE_REASON, type AdjustmentReason, type WasteReason, type InventoryApprovalRequestDetailResponse } from '@potato-corner/shared';
import {
  useApproveInventoryApprovalRequest,
  useCancelInventoryApprovalRequest,
  useCorrectInventoryApprovalRequest,
  useInventoryApprovalDetail,
  useReturnInventoryApprovalRequest,
} from '@/hooks/queries/use-inventory-approvals';
import { useInventoryItemConversions } from '@/hooks/queries/use-universal-inventory';
import { EvidenceUploadField } from '@/components/branch-ops/evidence-upload-field';
import { StaffPinEntryField } from '@/components/branch-ops/staff-pin-entry-field';

const OPERATION_LABELS: Record<string, string> = {
  RECEIVING: 'Stock In',
  ADJUSTMENT: 'Stock Adjustment',
  PHYSICAL_COUNT: 'Physical Count',
  WASTE: 'Waste',
};

const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  count_correction: 'Count Correction',
  damaged: 'Damaged',
  expired: 'Expired',
  supplier_error: 'Supplier Error',
  other: 'Other',
};

const WASTE_REASON_LABELS: Record<WasteReason, string> = {
  spoilage: 'Spoilage',
  preparation_error: 'Preparation Error',
  dropped: 'Dropped',
  expired: 'Expired',
  other: 'Other',
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

function IdentityStatus({ name, pinVerifiedAt }: { name: string | null; pinVerifiedAt: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">Identity Status</p>
      <div className="text-sm">
        {pinVerifiedAt ? (
          <>
            <Badge variant="active">PIN Verified</Badge> <span className="text-xs text-muted-foreground">{formatDateTime(pinVerifiedAt)}</span>
          </>
        ) : name ? (
          <Badge variant="secondary">Not PIN verified</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}

type Detail = InventoryApprovalRequestDetailResponse;

/** The quantity field relevant to this request's operation — mirrors the server's own per-operation field mapping. */
function quantityFieldOf(request: Pick<Detail, 'operation' | 'entered_quantity' | 'quantity_delta' | 'counted_quantity'>): number | null {
  if (request.operation === 'RECEIVING' || request.operation === 'WASTE') return request.entered_quantity;
  if (request.operation === 'ADJUSTMENT') return request.quantity_delta;
  return request.counted_quantity;
}

interface CorrectionFormProps {
  request: Detail;
  branchId: string | null | undefined;
  onDone: () => void;
}

/**
 * The Correct & Resubmit form for a RETURNED request. Mounted keyed by
 * request.id by the parent (see InventoryApprovalDetailDialog below), so its
 * local state is always freshly initialized from the current revision's
 * actual values — never a blank `''` the user has to notice and refill
 * before Resubmit will even consider enabling itself (the root cause of the
 * "edit quantity/notes -> disabled Resubmit" defect this replaces).
 */
function CorrectionForm({ request, branchId, onDone }: CorrectionFormProps) {
  const correct = useCorrectInventoryApprovalRequest(branchId);
  const op = request.operation;
  const originalQuantity = quantityFieldOf(request);

  const [quantity, setQuantity] = useState(originalQuantity !== null ? String(originalQuantity) : '');
  const [notes, setNotes] = useState(request.notes ?? '');
  const [enteredUnitId, setEnteredUnitId] = useState(request.entered_unit_id ?? '');
  const [reasonCode, setReasonCode] = useState(request.reason_code ?? '');
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

  const { data: conversions = [] } = useInventoryItemConversions(op === 'RECEIVING' ? (request.inventory_item_id ?? undefined) : undefined);
  const unitOptions = conversions.length
    ? Array.from(
        new Map(
          [
            { unitId: request.entered_unit_id ?? '', code: request.item_unit_code ?? '' },
            ...conversions.flatMap((c) => [
              { unitId: c.from_unit_id, code: c.from_unit_code },
              { unitId: c.to_unit_id, code: c.to_unit_code },
            ]),
          ]
            .filter((u) => u.unitId)
            .map((u) => [u.unitId, u] as const),
        ).values(),
      )
    : [];

  // POS-PERF-P29R3 / P31 — mirrors the server's exact pinBoundFieldChanged
  // check in inventory-approval.service.ts#correct(): only RECEIVING/
  // ADJUSTMENT/WASTE against a UNIVERSAL_ITEM ever carry a mandatory PIN/
  // evidence requirement, and only actually CHANGING a PIN-bound field
  // (quantity, unit, reason, or notes) demands fresh verification —
  // resubmitting unchanged figures, or a notes-only correction that leaves
  // everything else untouched, may inherit the original revision's
  // verification, exactly as the server allows.
  const requiresVerification = request.target === 'UNIVERSAL_ITEM' && (op === 'RECEIVING' || op === 'ADJUSTMENT' || op === 'WASTE');
  const quantityChanged = quantity !== '' && Number(quantity) !== (originalQuantity ?? Number.NaN);
  const unitChanged = op === 'RECEIVING' && enteredUnitId !== '' && enteredUnitId !== (request.entered_unit_id ?? '');
  const reasonChanged = (op === 'ADJUSTMENT' || op === 'WASTE') && reasonCode !== (request.reason_code ?? '');
  const notesChanged = notes.trim() !== (request.notes ?? '').trim();
  const pinBoundFieldChanged = quantityChanged || unitChanged || reasonChanged || notesChanged;
  const needsFreshVerification = requiresVerification && pinBoundFieldChanged;

  const missingReasons: string[] = [];
  if (quantity === '' || Number.isNaN(Number(quantity))) missingReasons.push('Enter a quantity.');
  if (op === 'ADJUSTMENT' && Number(quantity) === 0) missingReasons.push('Quantity change must not be zero.');
  if ((op === 'ADJUSTMENT' || op === 'WASTE') && !reasonCode) missingReasons.push('Select a reason.');
  if (needsFreshVerification && !evidenceKey) missingReasons.push('Upload a new proof photo — the quantity, unit, reason, or notes changed.');
  if (needsFreshVerification && !verificationToken) missingReasons.push('Verify a staff PIN again — the quantity, unit, reason, or notes changed.');

  const canSubmit = missingReasons.length === 0 && !correct.isPending;

  async function handleSubmit() {
    const verification = needsFreshVerification ? { verification_token: verificationToken ?? undefined, evidence_key: evidenceKey ?? undefined } : {};
    const input =
      op === 'RECEIVING'
        ? { entered_quantity: Number(quantity), entered_unit_id: enteredUnitId || undefined, notes: notes || undefined, ...verification }
        : op === 'ADJUSTMENT'
          ? { quantity_delta: Number(quantity), reason_code: reasonCode, notes: notes || undefined, ...verification }
          : op === 'WASTE'
            ? { entered_quantity: Number(quantity), reason_code: reasonCode, notes: notes || undefined, ...verification }
            : { counted_quantity: Number(quantity), notes: notes || undefined };
    await correct.mutateAsync({ id: request.id, input });
    onDone();
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Correct &amp; Resubmit</p>

      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        <p className="text-xs text-muted-foreground">Original Verification (carried forward unless a quantity/unit/reason/notes field below changes)</p>
        <IdentityStatus name={request.responsible_staff_name} pinVerifiedAt={request.pin_verified_at} />
      </div>

      <Label htmlFor="correction-quantity">
        {op === 'ADJUSTMENT' ? 'Corrected Quantity Change' : op === 'PHYSICAL_COUNT' ? 'Corrected Counted Quantity' : 'Corrected Quantity'}
      </Label>
      <Input id="correction-quantity" type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />

      {op === 'RECEIVING' && unitOptions.length > 0 && (
        <>
          <Label htmlFor="correction-unit">Unit</Label>
          <Select value={enteredUnitId} onValueChange={setEnteredUnitId}>
            <SelectTrigger id="correction-unit">
              <SelectValue placeholder="Select a unit" />
            </SelectTrigger>
            <SelectContent>
              {unitOptions.map((u) => (
                <SelectItem key={u.unitId} value={u.unitId}>
                  {u.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}

      {op === 'ADJUSTMENT' && (
        <>
          <Label htmlFor="correction-reason">Reason</Label>
          <Select value={reasonCode} onValueChange={setReasonCode}>
            <SelectTrigger id="correction-reason">
              <SelectValue placeholder="Select a reason" />
            </SelectTrigger>
            <SelectContent>
              {(Object.values(ADJUSTMENT_REASON) as AdjustmentReason[]).map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {ADJUSTMENT_REASON_LABELS[reason]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}

      {op === 'WASTE' && (
        <>
          <Label htmlFor="correction-reason">Reason</Label>
          <Select value={reasonCode} onValueChange={setReasonCode}>
            <SelectTrigger id="correction-reason">
              <SelectValue placeholder="Select a reason" />
            </SelectTrigger>
            <SelectContent>
              {(Object.values(WASTE_REASON) as WasteReason[]).map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {WASTE_REASON_LABELS[reason]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}

      <Label htmlFor="correction-notes">Notes</Label>
      <Textarea id="correction-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

      {needsFreshVerification && (
        <div className="space-y-3 rounded-md border border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">New Verification Required</p>
          <p className="text-sm text-amber-900">
            The quantity, unit, reason, or notes changed from the original submission — a fresh staff PIN verification and proof photo are required before
            this correction can be resubmitted.
          </p>
          <EvidenceUploadField branchId={branchId} label="Proof Photo" evidenceKey={evidenceKey} onChange={setEvidenceKey} />
          <StaffPinEntryField
            branchId={branchId}
            draft={{
              operation: op,
              inventoryItemId: request.inventory_item_id ?? undefined,
              quantity: Number(quantity || 0),
              unitId: enteredUnitId || undefined,
              reasonCode: reasonCode || undefined,
              notes: notes || undefined,
            }}
            verificationToken={verificationToken}
            onVerified={setVerificationToken}
          />
        </div>
      )}

      <div className="space-y-1">
        <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {correct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Resubmit for Review
        </Button>
        {missingReasons.length > 0 && (
          <ul className="list-inside list-disc text-xs text-muted-foreground">
            {missingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface InventoryApprovalDetailDialogProps {
  id: string | null;
  onOpenChange: (open: boolean) => void;
  branchId: string | null | undefined;
}

/**
 * One side panel for the full review detail: submission + revision history +
 * proof + Approve/Return/Cancel actions with inline reason entry (no stacked
 * dialogs). Approve/Return/Cancel are rendered only for adminOrSupervisor —
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
  const cancelRequest = useCancelInventoryApprovalRequest(branchId);

  const [returnAction, setReturnAction] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [cancelAction, setCancelAction] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [approveAction, setApproveAction] = useState(false);

  function closeInlineActions() {
    setReturnAction(false);
    setReturnReason('');
    setCancelAction(false);
    setCancelReason('');
    setApproveAction(false);
  }

  function handleOpenChange(open: boolean) {
    if (!open) closeInlineActions();
    onOpenChange(open);
  }

  if (!data) {
    return (
      <Sheet open={Boolean(id)} onOpenChange={handleOpenChange}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl" />
      </Sheet>
    );
  }

  const current = data;
  const isSubmitter = user?.id === current.submitted_by_user_id;
  const quantityField = quantityFieldOf(current);
  // Server-computed: true only for an APPROVED request with a real applied
  // movement. Zero-variance physical-count approvals apply no stock movement
  // at all (applyApprovedRequest returns movementId: request.id as a
  // placeholder — see inventory-approval.service.ts) — never re-derive this
  // from applied_movement_id's truthiness/equality on the client.
  const hasNoStockChange = !current.stock_changed;
  const isZeroVarianceApproval = current.status === 'APPROVED' && !current.stock_changed;

  return (
    <Sheet open={Boolean(id)} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full space-y-4 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {current.item_name ?? 'Item'} — {OPERATION_LABELS[current.operation] ?? current.operation}
            <StatusBadge status={current.status} />
          </SheetTitle>
        </SheetHeader>

        {current.status === 'PENDING' && (
          <p className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">Not yet applied to stock.</p>
        )}
        {hasNoStockChange && current.status !== 'PENDING' && (
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {isZeroVarianceApproval ? 'No quantity change — the physical count matched stock on hand.' : 'No stock change.'}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" value={quantityField !== undefined && quantityField !== null ? `${quantityField} ${current.item_unit_code ?? ''}` : null} />
          <Field label="Reason" value={current.reason_code} />
          <Field label="Submitted At" value={formatDateTime(current.submitted_at)} />
          <Field label="Reviewed By" value={current.reviewed_by_name} />
          <Field label="Reviewed At" value={current.reviewed_at ? formatDateTime(current.reviewed_at) : null} />
          <Field label="Recorded By" value={current.responsible_staff_name ?? 'Not recorded'} />
          <IdentityStatus name={current.responsible_staff_name} pinVerifiedAt={current.pin_verified_at} />
        </div>
        <Field label="Notes" value={current.notes} />
        {current.status === 'RETURNED' && <Field label="Return Reason" value={current.return_reason} />}
        {current.proof_url && (
          <a href={current.proof_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
            View Proof Photo
          </a>
        )}

        {current.revisions.length > 1 && (
          <div className="space-y-1 rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">Revision History</p>
            {current.revisions.map((revision) => (
              <p key={revision.id} className="text-xs text-muted-foreground">
                Rev {revision.revision_number}: <StatusBadge status={revision.status} />
                {revision.status === 'RETURNED' && revision.return_reason ? ` — ${revision.return_reason}` : ''}
                {revision.status === 'CANCELLED' && revision.cancel_reason ? ` — ${revision.cancel_reason}` : ''}
              </p>
            ))}
          </div>
        )}

        {current.status === 'PENDING' && canReview && !isSubmitter && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setApproveAction((v) => !v)} disabled={approve.isPending}>
                {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Approve
              </Button>
              <Button variant="outline" onClick={() => setReturnAction((v) => !v)} disabled={returnRequest.isPending}>
                Return for Correction
              </Button>
            </div>

            {approveAction && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">This will immediately apply the change to stock.</p>
                <Button
                  onClick={async () => {
                    await approve.mutateAsync(current.id);
                    closeInlineActions();
                    onOpenChange(false);
                  }}
                  disabled={approve.isPending}
                >
                  {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm Approve
                </Button>
              </div>
            )}

            {returnAction && (
              <div className="space-y-2 rounded-md border p-3">
                <Label htmlFor="return-reason">Explanation (required)</Label>
                <Textarea id="return-reason" value={returnReason} onChange={(e) => setReturnReason(e.target.value)} rows={3} />
                <Button
                  variant="destructive"
                  disabled={!returnReason.trim() || returnRequest.isPending}
                  onClick={async () => {
                    await returnRequest.mutateAsync({ id: current.id, reason: returnReason });
                    closeInlineActions();
                    onOpenChange(false);
                  }}
                >
                  {returnRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm Return for Correction
                </Button>
              </div>
            )}
          </div>
        )}
        {current.status === 'PENDING' && canReview && isSubmitter && (
          <p className="text-xs text-muted-foreground">You submitted this request — it must be reviewed by someone else.</p>
        )}

        {current.status === 'RETURNED' && <CorrectionForm key={current.id} request={current} branchId={branchId} onDone={() => onOpenChange(false)} />}

        {/* Permanent cancellation (POS-PERF-P28R2) — only reachable from
            PENDING/RETURNED, same as the server; separate from Return for
            Correction, which still leaves the request correctable into a
            new revision. Shown regardless of isSubmitter: unlike
            approve/return, cancelling performs no stock mutation, so the
            server does not deny self-cancellation. */}
        {(current.status === 'PENDING' || current.status === 'RETURNED') && canReview && (
          <div className="space-y-2 border-t pt-3">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setCancelAction((v) => !v)} disabled={cancelRequest.isPending}>
              Cancel Request Permanently
            </Button>
            {cancelAction && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm text-muted-foreground">
                  This cannot be undone. The request (and any further correction attempts against it) will be permanently closed — stock is never changed
                  either way.
                </p>
                <Label htmlFor="cancel-reason">Explanation (required)</Label>
                <Textarea id="cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} />
                <Button
                  variant="destructive"
                  disabled={!cancelReason.trim() || cancelRequest.isPending}
                  onClick={async () => {
                    await cancelRequest.mutateAsync({ id: current.id, reason: cancelReason });
                    closeInlineActions();
                    onOpenChange(false);
                  }}
                >
                  {cancelRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm Cancel Permanently
                </Button>
              </div>
            )}
          </div>
        )}
        {current.status === 'CANCELLED' && (
          <div className="space-y-1 border-t pt-3">
            <Field label="Cancel Reason" value={current.cancel_reason} />
            <Field label="Cancelled By" value={current.cancelled_by_name} />
            <Field label="Cancelled At" value={current.cancelled_at ? formatDateTime(current.cancelled_at) : null} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
