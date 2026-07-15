'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductRequestResponse, ProposedVariant } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { useReviewProductRequest } from '@/hooks/queries/use-product-requests';

interface ReviewProductRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: ProductRequestResponse;
}

export function ReviewProductRequestDialog({ open, onOpenChange, request }: ReviewProductRequestDialogProps) {
  const review = useReviewProductRequest(request.id);
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(request.proposed_name);
  const [description, setDescription] = useState(request.proposed_description ?? '');
  const [category, setCategory] = useState(request.proposed_category ?? '');
  const [variants, setVariants] = useState<ProposedVariant[]>(request.proposed_variants);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setNotes('');
      setEditing(false);
      setName(request.proposed_name);
      setDescription(request.proposed_description ?? '');
      setCategory(request.proposed_category ?? '');
      setVariants(request.proposed_variants);
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
            proposed_category: category || undefined,
            proposed_variants: variants,
          }
        : undefined,
    });
    handleOpenChange(false);
  }

  function updateVariant(index: number, patch: Partial<ProposedVariant>) {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review Product Request</DialogTitle>
          <DialogDescription>
            From {request.branch_name} — requested by {request.requested_by_name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {editing ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Name</p>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Category</p>
                <Input value={category} onChange={(e) => setCategory(e.target.value)} />
              </div>
              <div className="col-span-2 space-y-1">
                <p className="text-xs text-muted-foreground">Description</p>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </div>
            </div>
          ) : (
            <div>
              <p className="text-base font-semibold">{request.proposed_name}</p>
              <p className="text-muted-foreground">{request.proposed_category ?? 'Uncategorized'}</p>
              {request.proposed_description && <p className="mt-1">{request.proposed_description}</p>}
            </div>
          )}

          <div>
            <p className="mb-1 font-medium">Proposed Variants</p>
            <div className="space-y-2 rounded-md border p-2">
              {(editing ? variants : request.proposed_variants).map((variant, index) => (
                <div key={index} className="flex items-center gap-2">
                  {editing ? (
                    <>
                      <Input
                        className="h-8"
                        value={variant.name}
                        onChange={(e) => updateVariant(index, { name: e.target.value })}
                        placeholder="Name"
                      />
                      <Input
                        className="h-8"
                        value={variant.size_label}
                        onChange={(e) => updateVariant(index, { size_label: e.target.value })}
                        placeholder="Size"
                      />
                      <Input
                        className="h-8 w-24"
                        type="number"
                        value={variant.base_price}
                        onChange={(e) => updateVariant(index, { base_price: Number(e.target.value) })}
                      />
                    </>
                  ) : (
                    <p>
                      {variant.name} ({variant.size_label}) — {formatCurrency(variant.base_price)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {request.proposed_flavors.length > 0 && (
            <div>
              <p className="mb-1 font-medium">Proposed Flavors</p>
              <p className="text-muted-foreground">
                {request.proposed_flavors.map((f) => f.name ?? f.flavor_id).filter(Boolean).join(', ')}
              </p>
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
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={review.isPending || notes.trim().length < 20} onClick={() => void handleReject()}>
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button type="button" disabled={review.isPending} onClick={() => void handleApprove()}>
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? 'Approve with Modifications' : 'Approve as Requested'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
