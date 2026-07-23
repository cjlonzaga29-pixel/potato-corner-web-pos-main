'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { FlavorRequestResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { useReviewFlavorRequest } from '@/hooks/queries/use-flavor-requests';

interface ReviewFlavorRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: FlavorRequestResponse;
}

export function ReviewFlavorRequestDialog({ open, onOpenChange, request }: ReviewFlavorRequestDialogProps) {
  const review = useReviewFlavorRequest(request.id);
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmApproveOpen, setConfirmApproveOpen] = useState(false);
  const [name, setName] = useState(request.proposed_name);
  const [description, setDescription] = useState(request.proposed_description ?? '');
  const [colorHex, setColorHex] = useState(request.proposed_color_hex);
  const [displayOrder, setDisplayOrder] = useState(request.proposed_display_order?.toString() ?? '');

  function handleOpenChange(next: boolean) {
    if (!next) {
      setNotes('');
      setEditing(false);
      setName(request.proposed_name);
      setDescription(request.proposed_description ?? '');
      setColorHex(request.proposed_color_hex);
      setDisplayOrder(request.proposed_display_order?.toString() ?? '');
    }
    onOpenChange(next);
  }

  async function handleReject() {
    if (notes.trim().length < 20) return;
    await review.mutateAsync({ action: 'reject', review_notes: notes.trim() });
    handleOpenChange(false);
  }

  async function handleApprove() {
    await review.mutateAsync({
      action: 'approve',
      review_notes: notes.trim() || undefined,
      overrides: editing
        ? {
            proposed_name: name,
            proposed_description: description || undefined,
            proposed_color_hex: colorHex,
            proposed_display_order: displayOrder ? Number(displayOrder) : undefined,
          }
        : undefined,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review Flavor Request</DialogTitle>
          <DialogDescription>
            From {request.branch_name} — requested by {request.requested_by_name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Name</p>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Description</p>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={255} />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Color</p>
                <div className="flex items-center gap-2">
                  <FlavorColorSwatch colorHex={colorHex} className="h-8 w-8" />
                  <Input type="color" className="h-9 w-16 p-1" value={colorHex} onChange={(e) => setColorHex(e.target.value)} />
                  <Input value={colorHex} onChange={(e) => setColorHex(e.target.value)} className="w-28" maxLength={7} />
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Display Order</p>
                <Input
                  type="number"
                  min={0}
                  className="w-24"
                  value={displayOrder}
                  onChange={(e) => setDisplayOrder(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <FlavorColorSwatch colorHex={request.proposed_color_hex} />
              <div>
                <p className="text-base font-semibold">{request.proposed_name}</p>
                {request.proposed_description && <p className="text-muted-foreground">{request.proposed_description}</p>}
              </div>
            </div>
          )}

          <div>
            <p className="mb-1 font-medium">Reason</p>
            <p>{request.request_reason}</p>
          </div>

          {!editing && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit before approving
            </Button>
          )}

          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Review notes <span className="italic">(required, min 20 characters, if rejecting)</span>
            </p>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            <p className="mt-1 text-xs text-muted-foreground">{notes.trim().length}/20 characters</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={review.isPending || notes.trim().length < 20} onClick={() => void handleReject()}>
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button
            type="button"
            disabled={review.isPending}
            onClick={() => (editing ? void handleApprove() : setConfirmApproveOpen(true))}
          >
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? 'Approve with Modifications' : 'Approve as Requested'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmApproveOpen}
        onOpenChange={setConfirmApproveOpen}
        title="Approve Flavor Request"
        description="This approves the request exactly as submitted, with no modifications."
        confirmLabel="Approve"
        onConfirm={handleApprove}
      />
    </Dialog>
  );
}
