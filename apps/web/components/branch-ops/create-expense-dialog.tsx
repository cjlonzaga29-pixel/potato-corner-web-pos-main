'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { manilaToday } from '@/lib/manila-date';
import { useExpenseTypes } from '@/hooks/queries/use-expense-types';
import { useCreateExpense, useUploadExpenseReceiptForExpense } from '@/hooks/queries/use-expenses';

interface CreateExpenseDialogProps {
  branchId: string;
  /** Selected when active at this branch: Add Expense from a type's own view. */
  preselectedTypeId: string | null;
  canManageTypes: boolean;
  onCreateType: () => void;
  onOpenChange: (open: boolean) => void;
}

export function CreateExpenseDialog({ branchId, preselectedTypeId, canManageTypes, onCreateType, onOpenChange }: CreateExpenseDialogProps) {
  const queryClient = useQueryClient();
  const createExpense = useCreateExpense();
  const uploadReceipt = useUploadExpenseReceiptForExpense();
  const types = useExpenseTypes({ branchId, includeInactive: false });
  const activeTypes = types.data ?? [];
  const [chosenTypeId, setChosenTypeId] = useState<string | null>(preselectedTypeId);
  const typeId = activeTypes.some((type) => type.id === chosenTypeId) ? chosenTypeId : null;
  const [amount, setAmount] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [description, setDescription] = useState('');
  const [incurredAt, setIncurredAt] = useState(() => manilaToday());
  const [saveError, setSaveError] = useState<string | null>(null);

  // POS-PERF-P60 — one key for this dialog's whole life, so retrying after a lost
  // reply returns the expense that was saved instead of adding another. A refused
  // attempt saves nothing, key included, so correcting the form and resubmitting
  // under it is fine. If a lost reply did save and the form then changed, the
  // server refuses rather than guess; a new dialog gets a new key.
  const idempotencyKey = useRef(crypto.randomUUID());
  // isPending only disables the button after a render; two fast clicks can land first.
  const inFlight = useRef(false);

  // Task: expense receipt upload — a receipt needs an expense id, which
  // doesn't exist until createExpense resolves. handleCreate stages the
  // create first, then uploads the receipt as a second, isolated step.
  // createdExpenseId only becomes non-null if that second step fails, so the
  // dialog can stay open and retry the upload (same expense id) without ever
  // re-creating the expense — same shape as CreateProductDialog (Task 209.6).
  const [pendingReceipt, setPendingReceipt] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [createdExpenseId, setCreatedExpenseId] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  function handleReceiptStaged(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingReceipt(file);
    setPreviewUrl(URL.createObjectURL(file));
    setReceiptError(null);
  }

  function handleReceiptRemove() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingReceipt(null);
    setPreviewUrl(null);
    setReceiptError(null);
  }

  async function submit() {
    let expenseId = createdExpenseId;

    if (!expenseId) {
      if (!typeId) return;
      setSaveError(null);
      try {
        const created = await createExpense.mutateAsync({
          branch_id: branchId,
          expense_type_id: typeId,
          amount: Number(amount),
          vendor_name: vendorName || undefined,
          description: description || undefined,
          incurred_at: incurredAt,
          idempotencyKey: idempotencyKey.current,
        });
        expenseId = created.id;
        setCreatedExpenseId(created.id);
      } catch (error) {
        // Everything typed stays in the form. A type that stopped being usable leaves the list.
        setSaveError(error instanceof Error ? error.message : 'The expense could not be saved. Try again.');
        void queryClient.invalidateQueries({ queryKey: ['expense-types'] });
        return;
      }
    }

    if (pendingReceipt) {
      try {
        await uploadReceipt.mutateAsync({ expenseId, file: pendingReceipt });
      } catch (error) {
        // The expense itself is already recorded — only the receipt step
        // failed. Keep the dialog open (createdExpenseId is now set) so
        // retrying re-uses this same expense instead of creating another.
        setReceiptError(error instanceof Error ? error.message : 'Receipt upload failed — try again.');
        return;
      }
    }

    onOpenChange(false);
  }

  async function handleCreate() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await submit();
    } finally {
      inFlight.current = false;
    }
  }

  function handleContinueWithoutPhoto() {
    onOpenChange(false);
  }

  const isRetryingReceipt = Boolean(createdExpenseId) && Boolean(receiptError);
  const isSubmitting = createExpense.isPending || uploadReceipt.isPending;
  const noActiveTypes = types.isSuccess && activeTypes.length === 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Expense</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="expense-type-select">Expense Type</Label>
            {types.isError ? (
              <Alert variant="destructive" className="px-3 py-2">
                <AlertDescription>
                  Expense types could not be loaded.{' '}
                  <button type="button" className="underline underline-offset-2" onClick={() => void types.refetch()}>
                    Try again
                  </button>
                </AlertDescription>
              </Alert>
            ) : noActiveTypes ? (
              <Alert className="px-3 py-2" data-testid="no-active-expense-types">
                <AlertDescription>
                  {canManageTypes ? 'This branch has no active expense types yet.' : 'This branch has no active expense types yet. Ask your Supervisor to create one.'}
                  {canManageTypes && (
                    <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0" onClick={onCreateType}>
                      Create Expense Type
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            ) : (
              <Select value={typeId ?? undefined} onValueChange={setChosenTypeId} disabled={Boolean(createdExpenseId) || types.isLoading}>
                <SelectTrigger id="expense-type-select">
                  <SelectValue placeholder={types.isLoading ? 'Loading types…' : 'Select a type'} />
                </SelectTrigger>
                <SelectContent>
                  {activeTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="expense-amount">Amount</Label>
              <Input id="expense-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={Boolean(createdExpenseId)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-incurred-at">Date Incurred</Label>
              <Input id="expense-incurred-at" type="date" value={incurredAt} onChange={(e) => setIncurredAt(e.target.value)} disabled={Boolean(createdExpenseId)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-vendor">Vendor (optional)</Label>
            <Input id="expense-vendor" value={vendorName} onChange={(e) => setVendorName(e.target.value)} disabled={Boolean(createdExpenseId)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-description">Description (optional)</Label>
            <Textarea id="expense-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} disabled={Boolean(createdExpenseId)} />
          </div>

          {!isRetryingReceipt && (
            <div className="space-y-2">
              {!pendingReceipt ? (
                <ImageUpload
                  label="Receipt / Expense Proof"
                  description="Optional — JPEG, PNG, or WebP, up to 5MB."
                  onImageSelected={handleReceiptStaged}
                />
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Receipt / Expense Proof</p>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview of a not-yet-uploaded file */}
                  {previewUrl && <img src={previewUrl} alt="Receipt preview" className="max-h-[200px] w-full rounded-md border object-contain" />}
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={handleReceiptRemove} disabled={isSubmitting}>
                      Replace
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleReceiptRemove} disabled={isSubmitting}>
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {saveError && (
            <Alert variant="destructive" className="px-3 py-2" data-testid="expense-save-error">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          {isRetryingReceipt && (
            <Alert variant="destructive" className="px-3 py-2">
              <AlertDescription>
                Expense was recorded, but the receipt photo could not be uploaded.
                {receiptError ? ` (${receiptError})` : ''}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {isRetryingReceipt ? (
            <Button variant="outline" onClick={handleContinueWithoutPhoto}>
              Continue Without Photo
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={Boolean(createdExpenseId)}>
              Cancel
            </Button>
          )}
          <Button
            onClick={() => void handleCreate()}
            disabled={(!createdExpenseId && (!typeId || !amount || Number(amount) <= 0)) || isSubmitting}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isRetryingReceipt ? 'Retry Photo Upload' : 'Save Expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
