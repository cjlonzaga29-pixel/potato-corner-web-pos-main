'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { BranchInventoryStockRow, InventoryStockTransferResponse } from '@potato-corner/shared';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import {
  TransferStockError,
  useBranchInventoryStock,
  useInventoryStockRealtimeSync,
  useTransferInventoryStock,
  useUploadMovementProof,
} from '@/hooks/queries/use-universal-inventory';
import { affectedLabel, shortfallToLowThreshold, stockNeeds, stockStateOf } from '@/lib/inventory-stock-status';
import { readPrefillId } from '@/lib/transfer-links';
import { InventoryProofPhotoPicker } from './inventory-proof-photo-picker';
import { TransferStockNeedsPanel } from './transfer-stock-needs-panel';
import { TransferResultPanel, type CompletedTransfer } from './transfer-result-panel';

const formSchema = z
  .object({
    to_branch_id: z.uuid('Choose the destination branch in Stock needs'),
    from_branch_id: z.uuid('Select the source branch'),
    inventory_item_id: z.uuid('Select an item'),
    quantity: z.coerce.number('Enter a quantity').positive('Must be greater than zero'),
    notes: z.string().optional(),
  })
  .refine((v) => v.from_branch_id !== v.to_branch_id, {
    path: ['from_branch_id'],
    message: 'Source and destination must be different branches',
  });

type FormValues = z.input<typeof formSchema>;
type SubmitValues = z.output<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { to_branch_id: '', from_branch_id: '', inventory_item_id: '', quantity: '', notes: '' };

interface SubmitError {
  message: string;
  outcomeUnknown: boolean;
}

/** Rows answered for `branchId` only — a response still cached for a previously selected branch is never shown. */
function rowsFor(data: { branch_id: string; items: BranchInventoryStockRow[] } | undefined, branchId: string) {
  return branchId && data?.branch_id === branchId ? data.items : undefined;
}

function TransferFormContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const toBranchId = form.watch('to_branch_id');
  const fromBranchId = form.watch('from_branch_id');
  const inventoryItemId = form.watch('inventory_item_id');

  // The signed-in user's active branches, scoped server-side
  // (getAccessibleBranchIds) — the same set branchGuard accepts as a source
  // and getTransferDestinationBranchIds accepts as a destination for a
  // supervisor. Only a convenience list: the API re-authorizes both.
  const branchesQuery = useBranches({ status: 'active', limit: 100 });
  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'the selected branch';

  useInventoryStockRealtimeSync(toBranchId || null);
  useInventoryStockRealtimeSync(fromBranchId || null);
  const destStock = useBranchInventoryStock(toBranchId || null);
  const sourceStock = useBranchInventoryStock(fromBranchId || null);
  const destRows = rowsFor(destStock.data, toBranchId);
  const sourceRows = rowsFor(sourceStock.data, fromBranchId);
  const destRow = destRows?.find((r) => r.inventory_item_id === inventoryItemId);
  const sourceRow = sourceRows?.find((r) => r.inventory_item_id === inventoryItemId);

  const transfer = useTransferInventoryStock(fromBranchId || null);
  const uploadProof = useUploadMovementProof(fromBranchId || null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [pendingValues, setPendingValues] = useState<SubmitValues | null>(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [completed, setCompleted] = useState<CompletedTransfer | null>(null);
  const submittingRef = useRef(false);
  const formCardRef = useRef<HTMLDivElement>(null);
  // Set only once the transfer has actually been recorded (both legs already
  // written server-side). Once set, the form is replaced by a recovery
  // banner so a failed proof upload can never be "retried" by resubmitting
  // the whole form — that would call /transfer again and move stock twice.
  // Retry re-attaches to the same transfer_out movement id instead — proof
  // belongs to the transfer business event, not each leg independently
  // (see the backend's referenceId-sibling fallback for how the destination
  // branch's TRANSFER_IN leg resolves the same photo without a second upload).
  const [recordedTransfer, setRecordedTransfer] = useState<{ transferOutId: string } | null>(null);
  const [proofUploadFailed, setProofUploadFailed] = useState(false);

  // URL pre-fill, applied once the branch list is known. Ids outside the
  // user's own active branches are dropped (and said so) — never fetched.
  const prefillApplied = useRef(false);
  useEffect(() => {
    if (prefillApplied.current || branchesQuery.isLoading) return;
    prefillApplied.current = true;
    const allowed = new Set(branches.map((b) => b.id));
    const to = readPrefillId(searchParams, 'to_branch_id');
    const from = readPrefillId(searchParams, 'from_branch_id');
    const item = readPrefillId(searchParams, 'inventory_item_id');
    const dropped: string[] = [];
    if (to && allowed.has(to)) form.setValue('to_branch_id', to);
    else if (to) dropped.push('The destination in the link is not one of your active branches, so it was not selected.');
    if (from && allowed.has(from) && from !== to) form.setValue('from_branch_id', from);
    else if (from && from === to) dropped.push('The link named the same branch as source and destination, so no source was selected.');
    else if (from) dropped.push('The source in the link is not one of your active branches, so it was not selected.');
    if (item && to && allowed.has(to)) form.setValue('inventory_item_id', item);
    if (dropped.length > 0) setNotices(dropped);
  }, [branchesQuery.isLoading, branches, searchParams, form]);

  // An item the destination doesn't stock (e.g. a stale link) is cleared,
  // with a notice — the transfer would need a stock row there.
  useEffect(() => {
    if (!inventoryItemId || !destRows || destRow) return;
    form.setValue('inventory_item_id', '');
    form.setValue('quantity', '');
    setNotices((n) => [...n, `The linked item is not assigned to ${branchName(toBranchId)}, so it was cleared.`]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryItemId, destRows, destRow]);

  // Radix Select reports '' when its value isn't among the options yet (e.g.
  // a linked item before the destination's stock has loaded). No option has
  // an empty value, so '' is never a user choice — ignored in all three selects.
  function handleDestinationChange(nextId: string) {
    if (!nextId || nextId === toBranchId) return;
    const next: string[] = [];
    if (inventoryItemId) {
      next.push('Item and quantity were cleared because the destination changed.');
      form.setValue('inventory_item_id', '');
      form.setValue('quantity', '');
    }
    if (fromBranchId === nextId) {
      next.push(`${branchName(nextId)} is now the destination, so it was removed as the source.`);
      form.setValue('from_branch_id', '');
    }
    form.setValue('to_branch_id', nextId, { shouldValidate: form.formState.isSubmitted });
    setNotices(next);
    setSubmitError(null);
  }

  function handleItemChange(nextItemId: string) {
    if (!nextItemId || nextItemId === inventoryItemId) return;
    if (inventoryItemId && form.getValues('quantity') !== '') {
      form.setValue('quantity', '');
      setNotices(['Quantity was cleared because the item changed.']);
    } else {
      setNotices([]);
    }
    form.setValue('inventory_item_id', nextItemId, { shouldValidate: form.formState.isSubmitted });
    setSubmitError(null);
  }

  function handleSelectNeed(row: BranchInventoryStockRow) {
    handleItemChange(row.inventory_item_id);
    // Stacked layout (phone/tablet): bring the form card into view and focus
    // the next field without letting the focus jump override that scroll.
    // Side by side, the form is already in view.
    const stacked = typeof window !== 'undefined' && !window.matchMedia?.('(min-width: 1024px)').matches;
    if (stacked) formCardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const next = form.getValues('from_branch_id') ? 'quantity' : 'source';
    formCardRef.current?.querySelector<HTMLElement>(`[data-transfer-focus="${next}"]`)?.focus({ preventScroll: stacked });
  }

  function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    setSubmitError(null);
    if (!destRows || !destRows.some((r) => r.inventory_item_id === parsed.inventory_item_id)) {
      form.setError('inventory_item_id', { message: `This item is not assigned to ${branchName(parsed.to_branch_id)}.` });
      return;
    }
    if (!sourceRows) {
      form.setError('from_branch_id', { message: 'Source stock is still loading — try again in a moment.' });
      return;
    }
    const source = sourceRows.find((r) => r.inventory_item_id === parsed.inventory_item_id);
    if (!source) {
      form.setError('inventory_item_id', { message: `This item is not assigned to ${branchName(parsed.from_branch_id)}, so it cannot be sent from there.` });
      return;
    }
    if (parsed.quantity > source.quantity_available) {
      form.setError('quantity', {
        message: `Only ${source.quantity_available} ${source.base_unit_code} available at ${branchName(parsed.from_branch_id)}.`,
      });
      return;
    }
    setPendingValues(parsed);
  }

  async function handleConfirm() {
    const values = pendingValues;
    if (!values || submittingRef.current) return;
    // The mutation is bound to the source shown in the form; refuse if they differ.
    if (values.from_branch_id !== fromBranchId) return;
    submittingRef.current = true;
    const itemRow = destRows?.find((r) => r.inventory_item_id === values.inventory_item_id);
    try {
      const result: InventoryStockTransferResponse = await transfer.mutateAsync({
        inventory_item_id: values.inventory_item_id,
        to_branch_id: values.to_branch_id,
        quantity: values.quantity,
        notes: values.notes || undefined,
      });
      setRecordedTransfer({ transferOutId: result.transfer_out.id });
      let proofAttached = false;
      if (proofFile) {
        try {
          await uploadProof.mutateAsync({ movementId: result.transfer_out.id, file: proofFile });
          proofAttached = true;
        } catch {
          setProofUploadFailed(true); // Recovery banner takes over below.
        }
      }
      setCompleted({
        result,
        itemName: itemRow?.name ?? result.transfer_out.inventory_item_name,
        unit: result.transfer_out.unit_code ?? itemRow?.base_unit_code ?? '',
        fromName: branchName(values.from_branch_id),
        toName: branchName(values.to_branch_id),
        proofAttached,
      });
    } catch (error) {
      const unknown = error instanceof TransferStockError && error.outcomeUnknown;
      setSubmitError({
        message: unknown
          ? 'We could not confirm whether this transfer was recorded. Check the destination’s stock movements before submitting again — this form cannot detect a duplicate.'
          : error instanceof Error
            ? error.message
            : 'Failed to transfer stock',
        outcomeUnknown: unknown,
      });
    } finally {
      submittingRef.current = false;
    }
  }

  async function retryProofUpload() {
    if (!recordedTransfer || !proofFile) return;
    try {
      await uploadProof.mutateAsync({ movementId: recordedTransfer.transferOutId, file: proofFile });
    } catch {
      setProofUploadFailed(true);
      return;
    }
    setProofUploadFailed(false);
    setCompleted((c) => (c ? { ...c, proofAttached: true } : c));
  }

  function prepareAnother() {
    form.reset({ ...DEFAULT_VALUES, to_branch_id: toBranchId, from_branch_id: fromBranchId });
    setProofFile(null);
    setNotices([]);
    setSubmitError(null);
    setPendingValues(null);
    setCompleted(null);
    setRecordedTransfer(null);
    setProofUploadFailed(false);
  }

  if (recordedTransfer && proofUploadFailed) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <div role="alert" className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Transfer completed, but proof photo could not be uploaded.</p>
          <p className="mt-1">Both transfer legs have already been recorded — retrying below will not run the transfer again.</p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => setProofUploadFailed(false)}>
            Continue Without Photo
          </Button>
          <Button type="button" onClick={() => void retryProofUpload()} disabled={uploadProof.isPending || !proofFile}>
            {uploadProof.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Retry Photo Upload
          </Button>
        </div>
      </div>
    );
  }

  if (completed) {
    return <TransferResultPanel transfer={completed} onPrepareAnother={prepareAnother} onDone={() => router.push(`${basePath}/inventory`)} />;
  }

  const sourceOptions = branches.filter((b) => b.id !== toBranchId);
  const itemOptions = destRows ? [...stockNeeds(destRows), ...destRows.filter((r) => stockStateOf(r) === 'healthy').sort((a, b) => a.name.localeCompare(b.name))] : [];
  const shortfall = destRow ? shortfallToLowThreshold(destRow) : null;
  const isBusy = transfer.isPending || uploadProof.isPending;
  const noSecondBranch = !branchesQuery.isLoading && branches.length < 2;

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold">Transfer Stock</h1>
        <p className="text-sm text-muted-foreground">
          Pick the branch that needs stock, choose an item, then the branch to send it from. Stock moves only when you confirm — transfers are recorded
          immediately, with no approval step.
        </p>
      </div>

      {branchesQuery.isError && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          Could not load your branches.{' '}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => void branchesQuery.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {noSecondBranch && !branchesQuery.isError && (
        <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
          Transfers need at least two active branches assigned to you. You currently have {branches.length}.
        </p>
      )}

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <TransferStockNeedsPanel
          branches={branches}
          isBranchesLoading={branchesQuery.isLoading}
          destinationId={toBranchId}
          onDestinationChange={handleDestinationChange}
          rows={destRows}
          isLoading={destStock.isLoading || (destStock.data !== undefined && destRows === undefined)}
          isError={destStock.isError}
          onRetry={() => void destStock.refetch()}
          selectedItemId={inventoryItemId}
          onSelectNeed={handleSelectNeed}
        />

        <Card ref={formCardRef} className="min-w-0 scroll-mt-4">
          <CardHeader className="app-card-padding space-y-1 pb-3">
            <CardTitle className="text-base">2. Prepare transfer</CardTitle>
            <CardDescription>
              {toBranchId ? (
                <>
                  Sending to <span className="font-medium text-foreground">{branchName(toBranchId)}</span>
                </>
              ) : (
                'Choose a destination in Stock needs first.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="app-card-padding pt-0">
            {notices.length > 0 && (
              <div role="status" aria-live="polite" className="mb-4 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {notices.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </div>
            )}

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                <FormField
                  control={form.control}
                  name="to_branch_id"
                  render={() => (
                    <FormItem className="space-y-0">
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Radix Select takes value/onValueChange, not the onChange FormFieldWrapper clones onto children — wired directly via FormField instead. */}
                <FormField
                  control={form.control}
                  name="inventory_item_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Item<span className="ml-0.5 text-destructive">*</span>
                      </FormLabel>
                      <Select value={field.value} onValueChange={handleItemChange} disabled={!destRows}>
                        <FormControl>
                          <SelectTrigger ref={field.ref}>
                            <SelectValue placeholder={toBranchId ? 'Select an item' : 'Choose a destination first'} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {itemOptions.map((i) => (
                            <SelectItem key={i.inventory_item_id} value={i.inventory_item_id}>
                              {i.name} ({i.base_unit_code}){i.status !== 'healthy' ? ` — ${i.status}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {destRow && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                    <p>
                      At {branchName(toBranchId)}: <span className="font-medium tabular-nums">{destRow.quantity_available}</span> {destRow.base_unit_code}{' '}
                      available
                      {destRow.low_stock_threshold !== null && (
                        <span className="text-muted-foreground">
                          {' '}
                          · low at {destRow.low_stock_threshold} {destRow.base_unit_code}
                        </span>
                      )}
                    </p>
                    {destRow.recipe_shortage && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-testid="transfer-shortage-suggestion">
                        <p className="text-muted-foreground">
                          Suggestion: {destRow.recipe_shortage.deficit} {destRow.base_unit_code} — the least that lets {branchName(toBranchId)} make one serving of everything affected:{' '}
                          {affectedLabel(destRow.recipe_shortage)}. It covers one serving only. Not applied until you choose it.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => form.setValue('quantity', String(destRow.recipe_shortage?.deficit ?? ''), { shouldValidate: form.formState.isSubmitted })}
                        >
                          Use {destRow.recipe_shortage.deficit} {destRow.base_unit_code}
                        </Button>
                      </div>
                    )}
                    {shortfall !== null && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-muted-foreground">
                          Suggestion: {shortfall} {destRow.base_unit_code} — brings available stock ({destRow.quantity_available}) up to the low-stock
                          threshold ({destRow.low_stock_threshold}). Not applied until you choose it.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => form.setValue('quantity', String(shortfall), { shouldValidate: form.formState.isSubmitted })}
                        >
                          Use {shortfall} {destRow.base_unit_code}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="from_branch_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Send from (source branch)<span className="ml-0.5 text-destructive">*</span>
                      </FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          if (!v) return;
                          field.onChange(v);
                          setSubmitError(null);
                        }}
                        disabled={!toBranchId || sourceOptions.length === 0}
                      >
                        <FormControl>
                          <SelectTrigger ref={field.ref} data-transfer-focus="source">
                            <SelectValue placeholder={sourceOptions.length === 0 ? 'No other branch available' : 'Select the source branch'} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {sourceOptions.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {fromBranchId && inventoryItemId && (
                  <div className="rounded-md border p-3 text-sm" aria-live="polite" data-testid="source-availability">
                    {sourceStock.isError ? (
                      <p className="text-destructive">
                        Could not load stock at {branchName(fromBranchId)}.{' '}
                        <Button type="button" variant="link" className="h-auto p-0" onClick={() => void sourceStock.refetch()}>
                          Try again
                        </Button>
                      </p>
                    ) : !sourceRows ? (
                      <p className="text-muted-foreground">Loading stock at {branchName(fromBranchId)}…</p>
                    ) : !sourceRow ? (
                      <p className="text-destructive">
                        {destRow?.name ?? 'This item'} is not assigned to {branchName(fromBranchId)}, so it cannot be sent from there. Choose another source,
                        or ask the inventory owner to assign the item to that branch — this page does not create assignments.
                      </p>
                    ) : (
                      <p>
                        Available at {branchName(fromBranchId)}: <span className="font-medium tabular-nums">{sourceRow.quantity_available}</span>{' '}
                        {sourceRow.base_unit_code}
                        <span className="text-muted-foreground">
                          {' '}
                          ({sourceRow.quantity_on_hand} on hand{sourceRow.quantity_reserved > 0 ? `, ${sourceRow.quantity_reserved} reserved for pending sales` : ''})
                        </span>
                        {sourceRow.quantity_available <= 0 && <span className="block text-destructive">Nothing is available to send from this branch.</span>}
                        {shortfall !== null && sourceRow.quantity_available > 0 && sourceRow.quantity_available < shortfall && (
                          <span className="block text-muted-foreground">
                            This source has less than the suggested {shortfall} {sourceRow.base_unit_code}.
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                )}

                <FormFieldWrapper<FormValues> name="quantity" label={`Quantity to transfer${destRow ? ` (${destRow.base_unit_code})` : ''}`} required>
                  <Input type="number" step="any" min="0" inputMode="decimal" data-transfer-focus="quantity" />
                </FormFieldWrapper>

                <InventoryProofPhotoPicker label="Proof Photo (optional)" file={proofFile} onChange={setProofFile} />

                <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
                  <Textarea rows={3} />
                </FormFieldWrapper>

                {submitError && (
                  <div
                    role="alert"
                    className={
                      submitError.outcomeUnknown
                        ? 'rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900'
                        : 'rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm'
                    }
                  >
                    <p className="font-medium">{submitError.outcomeUnknown ? 'Transfer status unknown' : 'Transfer not recorded'}</p>
                    <p className="mt-1">{submitError.message}</p>
                    {!submitError.outcomeUnknown && <p className="mt-1 text-muted-foreground">No stock was moved. Your entries are kept.</p>}
                  </div>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="outline" onClick={() => router.back()}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isBusy || !!pendingValues}>
                    {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Transfer Stock
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={!!pendingValues}
        onOpenChange={(o) => !o && setPendingValues(null)}
        title="Confirm Stock Transfer"
        description={
          pendingValues
            ? `Move ${pendingValues.quantity} ${destRows?.find((r) => r.inventory_item_id === pendingValues.inventory_item_id)?.base_unit_code ?? ''} of ${
                destRows?.find((r) => r.inventory_item_id === pendingValues.inventory_item_id)?.name ?? 'this item'
              } from ${branchName(pendingValues.from_branch_id)} to ${branchName(pendingValues.to_branch_id)}. Stock moves as soon as you confirm; the source balance is checked again by the server.`
            : undefined
        }
        confirmLabel="Transfer Stock"
        variant="danger"
        onConfirm={handleConfirm}
      />
    </div>
  );
}

/** Body behind `/supervisor/inventory/transfer` (the branch route shows the managed-by-supervisor notice instead). */
export function InventoryTransferForm({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <TransferFormContent basePath={basePath} />
    </Suspense>
  );
}
