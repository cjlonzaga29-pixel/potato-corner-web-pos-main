'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Minus, Package, Plus, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_EXTRA_SUPPLY_ISSUE_QUANTITY, availableIssueQuantity, type CreateExtraSupplyIssueInput, type ExtraSupplyIssueResponse, type ExtraSupplyTerminalCard } from '@potato-corner/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import {
  EXTRA_SUPPLIES_NOT_DEPLOYED,
  ExtraSupplyRequestError,
  provesNothingPosted,
  abandonExtraSupplyOperation,
  fetchExtraSupplyOperation,
  submitExtraSupplyIssue,
  useExtraSupplyCards,
} from '@/hooks/queries/use-extra-supplies';
import { useUploadPaymentProof } from '@/hooks/queries/use-transactions';
import { EMPTY_EXTRA_SUPPLY_DRAFT, extraSupplyDraftKey, useExtraSupplyDraftStore } from '@/stores/extra-supply-draft.store';
import { formatCurrency } from '@/lib/utils';

interface ExtraSuppliesPanelProps {
  branchId: string;
  /** The authenticated cashier. Only keys this browser's draft: the server takes the real identity from the token. */
  cashierId: string;
  isOnline: boolean;
  operatorToken?: string;
  refreshOperatorToken?: () => Promise<string | null>;
}

type Step = 'select' | 'review';

/**
 * POS-PERF-P61 — the terminal's Extra Supplies tab: select cards, set quantities, Give
 * free or With payment, reason, review, confirm. Records additional supplies only:
 * packaging an order already consumed is deducted by that order's recipe and never here.
 *
 * Online only, with no queue. The operation id is saved before the first send, and the
 * draft locks until that id's outcome is known. Only the same id can be retried, and a
 * new one is minted only after a refusal that proves nothing was posted, or a cancel
 * the server has fenced. Stock is never described as deducted until the server says so.
 */
export function ExtraSuppliesPanel({ branchId, cashierId, isOnline, operatorToken, refreshOperatorToken }: ExtraSuppliesPanelProps) {
  const operator = useMemo(() => ({ token: operatorToken, refresh: refreshOperatorToken }), [operatorToken, refreshOperatorToken]);
  const queryClient = useQueryClient();
  const key = extraSupplyDraftKey(branchId, cashierId);
  const draft = useExtraSupplyDraftStore((state) => state.drafts[key]) ?? EMPTY_EXTRA_SUPPLY_DRAFT;
  const update = useExtraSupplyDraftStore((state) => state.update);
  const clearDraft = useExtraSupplyDraftStore((state) => state.clear);
  const patch = useCallback((next: Partial<typeof draft>) => update(key, next), [key, update]);

  const cards = useExtraSupplyCards(branchId, operator);
  const uploadProof = useUploadPaymentProof(operatorToken, refreshOperatorToken);
  const [step, setStep] = useState<Step>('select');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtraSupplyIssueResponse | null>(null);
  const [isUncertain, setIsUncertain] = useState(false);
  // A disabled button isn't enough: two clicks can land before React re-renders it.
  const sending = useRef(false);

  const cardList = useMemo(() => cards.data ?? [], [cards.data]);
  const cardById = useMemo(() => new Map(cardList.map((card) => [card.id, card])), [cardList]);
  const selected = Object.entries(draft.quantities).filter(([, quantity]) => quantity > 0);
  const missingIds = cards.data ? selected.filter(([id]) => !cardById.has(id)).map(([id]) => id) : [];
  const lines = selected.flatMap(([id, quantity]) => {
    const card = cardById.get(id);
    return card ? [{ card, quantity }] : [];
  });
  const amountCents = lines.reduce((sum, { card, quantity }) => sum + Math.round((card.selling_price ?? 0) * 100) * quantity, 0);
  const amount = amountCents / 100;
  const tendered = Number(draft.cashTendered);
  const unpriced = lines.filter(({ card }) => card.selling_price === null);

  /** Other cards in this draft draw on the same stock, so availability is what's left after them. */
  const availableFor = useCallback(
    (card: ExtraSupplyTerminalCard) => {
      const usedByOthers = selected.reduce((sum, [id, quantity]) => {
        const other = cardById.get(id);
        return other && other.id !== card.id && other.inventory_item_id === card.inventory_item_id ? sum + other.base_quantity * quantity : sum;
      }, 0);
      return availableIssueQuantity(card.available_base_quantity - usedByOthers, card.base_quantity);
    },
    [cardById, selected],
  );
  const shortage = lines.find(({ card, quantity }) => quantity > availableFor(card));

  const finish = useCallback(
    (issue: ExtraSupplyIssueResponse) => {
      clearDraft(key);
      setResult(issue);
      setStep('select');
      setError(null);
      setIsUncertain(false);
      void queryClient.invalidateQueries({ queryKey: ['extra-supply-cards'] });
      void queryClient.invalidateQueries({ queryKey: ['extra-supply-issues'] });
      void queryClient.invalidateQueries({ queryKey: ['extra-supply-summary'] });
    },
    [clearDraft, key, queryClient],
  );

  /** Reads what happened to a sent id. Reloading, reconnecting and switching back to this cashier all land here. */
  const resolvePending = useCallback(async () => {
    const pending = useExtraSupplyDraftStore.getState().drafts[key]?.pending;
    if (!pending) return;
    setIsResolving(true);
    try {
      const outcome = await fetchExtraSupplyOperation(pending.operationId, operator);
      if (outcome.status === 'committed') {
        finish(outcome.issue);
        return;
      }
      if (outcome.status === 'abandoned') {
        patch({ pending: null });
        setIsUncertain(false);
        setError('That attempt was cancelled and did not go through. Your selection is saved.');
        return;
      }
      setIsUncertain(true);
    } catch {
      // Still not knowing isn't an answer. The id stays pending.
      setIsUncertain(true);
    } finally {
      setIsResolving(false);
    }
  }, [finish, key, operator, patch]);

  useEffect(() => {
    if (draft.pending && isOnline) void resolvePending();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival and on reconnect, not after every draft edit
  }, [isOnline, key]);

  async function send(payload: CreateExtraSupplyIssueInput, operationId: string, attempts: number) {
    if (sending.current) return;
    sending.current = true;
    setIsSubmitting(true);
    setError(null);
    // Saved first: a reload from here on still knows this id exists.
    patch({ pending: { operationId, payload, attempts } });
    try {
      finish(await submitExtraSupplyIssue(payload, operator));
    } catch (caught) {
      const refused = provesNothingPosted(caught);
      // The first answer to the only attempt ever sent proves nothing posted. After a
      // lost reply it proves only that this retry didn't: the original may have.
      if (refused && attempts === 1) {
        patch({ pending: null });
        setIsUncertain(false);
        setStep('select');
        setError(caught.message);
        void cards.refetch();
      } else {
        setIsUncertain(true);
        setError(refused ? caught.message : null);
      }
    } finally {
      sending.current = false;
      setIsSubmitting(false);
    }
  }

  function confirm() {
    if (!draft.kind || draft.pending) return;
    const payload: CreateExtraSupplyIssueInput = {
      operation_id: crypto.randomUUID(),
      branch_id: branchId,
      kind: draft.kind,
      lines: lines.map(({ card, quantity }) => ({ extra_supply_id: card.id, quantity, version: card.version })),
      ...(draft.reason.trim() && { reason: draft.reason.trim() }),
      ...(draft.orderReference.trim() && { order_reference: draft.orderReference.trim() }),
      ...(draft.kind === 'paid' && {
        payment_method: draft.paymentMethod,
        ...(draft.paymentMethod === 'cash' && { cash_tendered: tendered }),
        ...(draft.paymentMethod !== 'cash' && draft.paymentReference.trim() && { payment_reference: draft.paymentReference.trim() }),
        ...(draft.paymentMethod !== 'cash' && draft.proof && { payment_proof_key: draft.proof.key, payment_proof_type: draft.proof.type }),
      }),
    };
    void send(payload, payload.operation_id, 1);
  }

  function retryPending() {
    const pending = useExtraSupplyDraftStore.getState().drafts[key]?.pending;
    if (pending) void send(pending.payload, pending.operationId, pending.attempts + 1);
  }

  async function cancelPending() {
    const pending = useExtraSupplyDraftStore.getState().drafts[key]?.pending;
    if (!pending) return;
    setIsResolving(true);
    setError(null);
    try {
      const outcome = await abandonExtraSupplyOperation(pending.operationId, branchId, operator);
      if (outcome.status === 'committed') {
        finish(outcome.issue);
        return;
      }
      patch({ pending: null });
      setIsUncertain(false);
      setStep('review');
    } catch (caught) {
      setError(caught instanceof Error ? `${caught.message}. It stays open until the outcome is known.` : 'It stays open until the outcome is known.');
    } finally {
      setIsResolving(false);
    }
  }

  function setQuantity(id: string, quantity: number) {
    const quantities = { ...draft.quantities };
    if (quantity > 0) quantities[id] = Math.min(quantity, MAX_EXTRA_SUPPLY_ISSUE_QUANTITY);
    else delete quantities[id];
    patch({ quantities });
    setResult(null);
  }

  function reviewBlocker(): string | null {
    if (lines.length === 0) return 'Select at least one supply.';
    if (missingIds.length > 0) return 'A selected supply is no longer available. Remove it to continue.';
    if (shortage) return `Only ${availableFor(shortage.card)} ${shortage.card.issue_unit_name} of ${shortage.card.name} available.`;
    if (!draft.kind) return 'Choose Give free or With payment.';
    if (draft.kind === 'free' && !draft.reason.trim()) return 'Enter why these are being given free.';
    if (draft.kind === 'paid') {
      if (unpriced.length > 0) return `${unpriced[0]?.card.name} has no selling price, so it can only be given free.`;
      if (draft.paymentMethod === 'cash' && (!draft.cashTendered || !Number.isFinite(tendered) || Math.round(tendered * 100) < amountCents)) return `Enter the cash received: at least ${formatCurrency(amount)}.`;
      if (draft.paymentMethod !== 'cash' && !draft.proof) return 'Attach a payment proof photo.';
    }
    return null;
  }

  const notDeployed = cards.error instanceof ExtraSupplyRequestError && cards.error.code === EXTRA_SUPPLIES_NOT_DEPLOYED;
  const blocker = reviewBlocker();
  const confirmDisabled = isSubmitting || !isOnline || blocker !== null;

  return (
    <div className="space-y-3 p-3 lg:flex-1 lg:overflow-y-auto" data-testid="extra-supplies-panel">
      <h1 className="text-base font-semibold">Extra Supplies</h1>
      <p className="text-sm text-muted-foreground">For additional cups, tissue or bags only. Packaging that comes with an order is already deducted by that order.</p>

      {!isOnline && (
        <Alert className="border-warning/50" data-testid="extra-supplies-offline">
          <AlertDescription>You&apos;re offline. Extra Supplies needs a connection to confirm stock, so nothing can be issued right now. Your selection is saved.</AlertDescription>
        </Alert>
      )}
      {notDeployed && (
        <Alert className="border-warning/50" data-testid="extra-supplies-unavailable">
          <AlertDescription>Extra Supplies isn&apos;t available on this server yet. Nothing was recorded, and your selection is saved. Ask a supervisor about the update.</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" data-testid="extra-supplies-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <Alert className="border-success bg-success/10" data-testid="extra-supplies-result">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            <p className="font-medium">
              {result.kind === 'free' ? 'Issued free' : `Issued, ${formatCurrency(result.amount_collected)} collected`}. Reference{' '}
              <span data-testid="extra-supplies-reference" className="font-mono">
                {result.reference_number}
              </span>
            </p>
            {result.change_amount !== null && result.change_amount > 0 && <p>Change: {formatCurrency(result.change_amount)}</p>}
            <p className="text-sm">Stock was deducted by the server.</p>
          </AlertDescription>
        </Alert>
      )}

      {draft.pending ? (
        <div className="space-y-3 rounded-md border p-4" data-testid="extra-supplies-pending" role="status">
          {isSubmitting || isResolving || !isUncertain ? (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {isSubmitting ? 'Confirming with the server…' : 'Checking what happened to this issue…'}
            </p>
          ) : (
            <>
              <p className="font-medium">We don&apos;t know yet whether this issue went through.</p>
              <p className="text-sm text-muted-foreground">Don&apos;t hand out or collect again until this is resolved. Trying again can&apos;t deduct stock or take payment twice. Attempt {draft.pending.operationId.slice(0, 8)}.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={retryPending} disabled={!isOnline} className="touch-target gap-2" data-testid="extra-supplies-retry">
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Try again
                </Button>
                <Button variant="outline" onClick={() => void resolvePending()} disabled={!isOnline} className="touch-target" data-testid="extra-supplies-check">
                  Check again
                </Button>
                <Button variant="outline" onClick={() => void cancelPending()} disabled={!isOnline} className="touch-target" data-testid="extra-supplies-cancel-attempt">
                  Cancel this attempt
                </Button>
              </div>
            </>
          )}
        </div>
      ) : step === 'select' ? (
        <>
          {cards.isLoading && <p className="text-sm text-muted-foreground">Loading supplies…</p>}
          {cards.isError && !notDeployed && !cards.data && (
            <Alert variant="destructive">
              <AlertDescription>
                Supplies could not be loaded.{' '}
                <button type="button" className="underline" onClick={() => void cards.refetch()}>
                  Try again
                </button>
              </AlertDescription>
            </Alert>
          )}
          {cards.data?.length === 0 && <p className="rounded-md border p-4 text-sm text-muted-foreground">No extra supplies are set up for this branch. A supervisor adds them under Extra Supplies.</p>}

          {missingIds.length > 0 && (
            <Alert className="border-warning/50">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                {missingIds.length === 1 ? 'A selected supply is' : `${missingIds.length} selected supplies are`} no longer available here.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const kept = Object.fromEntries(Object.entries(draft.quantities).filter(([id]) => !missingIds.includes(id)));
                    patch({ quantities: kept });
                  }}
                >
                  Remove from selection
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="extra-supplies-grid">
            {cardList.map((card) => {
              const quantity = draft.quantities[card.id] ?? 0;
              const available = availableFor(card);
              return (
                <div key={card.id} className="flex min-w-0 flex-col gap-2 rounded-md border bg-card p-2" data-testid="extra-supply-card">
                  <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-muted">
                    {card.image_url ? <img src={card.image_url} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package className="h-10 w-10 text-muted-foreground" aria-hidden="true" />}
                  </div>
                  <p className="text-sm font-medium [overflow-wrap:anywhere]">{card.name}</p>
                  <p className="text-xs text-muted-foreground" data-testid="extra-supply-available">
                    {available} {card.issue_unit_name} available
                  </p>
                  <p className="text-xs text-muted-foreground">{card.selling_price === null ? 'Free only' : `${formatCurrency(card.selling_price)} each if paid`}</p>
                  <div className="mt-auto flex items-center gap-1">
                    <Button type="button" variant="outline" size="icon" className="touch-target shrink-0" aria-label={`Fewer ${card.name}`} disabled={quantity === 0} onClick={() => setQuantity(card.id, quantity - 1)}>
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      className="h-10 min-w-0 flex-1 px-1 text-center tabular-nums"
                      inputMode="numeric"
                      aria-label={`Quantity of ${card.name}`}
                      value={quantity === 0 ? '' : String(quantity)}
                      placeholder="0"
                      onChange={(event) => setQuantity(card.id, Number(event.target.value.replace(/\D/g, '')) || 0)}
                    />
                    <Button type="button" variant="outline" size="icon" className="touch-target shrink-0" aria-label={`More ${card.name}`} disabled={quantity >= available} onClick={() => setQuantity(card.id, quantity + 1)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {lines.length > 0 && (
            <div className="space-y-3 rounded-md border p-3" data-testid="extra-supplies-entry">
              <div className="flex gap-2" role="radiogroup" aria-label="Free or paid">
                <Button type="button" className="touch-target flex-1" variant={draft.kind === 'free' ? 'default' : 'outline'} role="radio" aria-checked={draft.kind === 'free'} onClick={() => patch({ kind: 'free' })}>
                  Give free
                </Button>
                <Button type="button" className="touch-target flex-1" variant={draft.kind === 'paid' ? 'default' : 'outline'} role="radio" aria-checked={draft.kind === 'paid'} onClick={() => patch({ kind: 'paid' })}>
                  With payment
                </Button>
              </div>

              {draft.kind === 'paid' && (
                <div className="space-y-3">
                  <p className="font-semibold tabular-nums" data-testid="extra-supplies-amount">
                    Amount to collect: {formatCurrency(amount)}
                  </p>
                  <Tabs value={draft.paymentMethod} onValueChange={(value) => patch({ paymentMethod: value as typeof draft.paymentMethod, proof: null })}>
                    <TabsList aria-label="Payment method" className="w-full">
                      <TabsTrigger value="cash">Cash</TabsTrigger>
                      <TabsTrigger value="gcash">GCash</TabsTrigger>
                      <TabsTrigger value="maya">Maya</TabsTrigger>
                      <TabsTrigger value="other">Other</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {draft.paymentMethod === 'cash' ? (
                    <div className="space-y-1">
                      <Label htmlFor="extra-supply-cash">Cash received</Label>
                      <Input id="extra-supply-cash" inputMode="decimal" value={draft.cashTendered} onChange={(event) => patch({ cashTendered: event.target.value.replace(/[^\d.]/g, '') })} />
                      {draft.cashTendered && Math.round(tendered * 100) >= amountCents && <p className="text-sm tabular-nums">Change: {formatCurrency((Math.round(tendered * 100) - amountCents) / 100)}</p>}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label htmlFor="extra-supply-reference">Reference (optional)</Label>
                        <Input id="extra-supply-reference" value={draft.paymentReference} maxLength={200} onChange={(event) => patch({ paymentReference: event.target.value })} />
                      </div>
                      {draft.proof ? (
                        <div className="flex items-center justify-between gap-2 rounded-md border border-success bg-success/10 p-2 text-sm">
                          Payment proof attached
                          <Button type="button" variant="ghost" size="sm" onClick={() => patch({ proof: null })}>
                            Replace
                          </Button>
                        </div>
                      ) : (
                        <ImageUpload
                          label="Payment proof photo"
                          required
                          onImageSelected={async (file, type) => {
                            const uploaded = await uploadProof.mutateAsync({ branchId, type, file });
                            patch({ proof: { key: uploaded.payment_proof_key, type: uploaded.payment_proof_type } });
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}

              {draft.kind && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="extra-supply-reason">{draft.kind === 'free' ? 'Reason' : 'Note (optional)'}</Label>
                    <Textarea id="extra-supply-reason" rows={2} maxLength={200} value={draft.reason} onChange={(event) => patch({ reason: event.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="extra-supply-order">Order reference (optional)</Label>
                    <Input id="extra-supply-order" maxLength={60} value={draft.orderReference} onChange={(event) => patch({ orderReference: event.target.value })} />
                  </div>
                </>
              )}

              {blocker && <p className="text-sm text-muted-foreground" data-testid="extra-supplies-blocker">{blocker}</p>}
              <Button className="touch-target w-full" disabled={blocker !== null} onClick={() => { setError(null); setResult(null); setStep('review'); }} data-testid="extra-supplies-review">
                Review
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3 rounded-md border p-4" data-testid="extra-supplies-review-step">
          <h2 className="font-semibold">Review before confirming</h2>
          <Badge variant={draft.kind === 'paid' ? 'default' : 'secondary'}>{draft.kind === 'paid' ? 'With payment' : 'Give free'}</Badge>
          <ul className="divide-y text-sm">
            {lines.map(({ card, quantity }) => (
              <li key={card.id} className="flex items-center justify-between gap-3 py-2">
                <span className="[overflow-wrap:anywhere]">
                  {quantity} {card.issue_unit_name} of {card.name}
                  <span className="block text-xs text-muted-foreground">
                    Uses {Math.round(card.base_quantity * quantity * 1000) / 1000} {card.base_unit_code} of {card.inventory_item_name}
                  </span>
                </span>
                {draft.kind === 'paid' && <span className="shrink-0 tabular-nums">{formatCurrency(((card.selling_price ?? 0) * 100 * quantity) / 100)}</span>}
              </li>
            ))}
          </ul>
          {draft.kind === 'paid' && (
            <p className="font-semibold tabular-nums">
              Collect {formatCurrency(amount)} by {draft.paymentMethod === 'gcash' ? 'GCash' : draft.paymentMethod === 'maya' ? 'Maya' : draft.paymentMethod === 'other' ? 'Other' : 'cash'}
            </p>
          )}
          {draft.reason.trim() && <p className="text-sm [overflow-wrap:anywhere]">{draft.kind === 'free' ? 'Reason' : 'Note'}: {draft.reason.trim()}</p>}
          {!isOnline && <p className="text-sm font-medium text-destructive">Connect to confirm. Your selection is saved.</p>}
          {blocker && <p className="text-sm text-destructive">{blocker}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="touch-target" onClick={() => setStep('select')} disabled={isSubmitting} data-testid="extra-supplies-back">
              Back
            </Button>
            <Button className="touch-target flex-1" onClick={confirm} disabled={confirmDisabled} data-testid="extra-supplies-confirm">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
