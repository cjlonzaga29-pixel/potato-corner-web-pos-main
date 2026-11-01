'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MANUAL_DISCOUNT_MAX_AMOUNT,
  MANUAL_DISCOUNT_TYPE_NAME_MAX,
  STATUTORY_DISCOUNT_NAME_NOTICE,
  isStatutoryDiscountName,
  type ManualDiscountAmountMode,
  type ManualDiscountProductScope,
  type ManualDiscountTypeResponse,
} from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ManualDiscountTypeSaveError, useCreateManualDiscountType, useDiscountEligibleProducts, useUpdateManualDiscountType } from '@/hooks/queries/use-manual-discount-types';
import { SelectionChecklist } from './selection-checklist';

interface ManualDiscountTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Branches this supervisor manages. */
  branches: readonly { id: string; name: string }[];
  /** Preselected for a new type: the branch the list is showing. */
  branchId: string;
  /** null = create a new type. */
  editing: ManualDiscountTypeResponse | null;
}

function parseFixedAmount(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (text === '') return { value: null, error: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { value: null, error: 'Enter an amount in pesos, like 50 or 50.25.' };
  const value = Number(text);
  if (!(value > 0)) return { value: null, error: 'Enter an amount greater than ₱0.' };
  if (value > MANUAL_DISCOUNT_MAX_AMOUNT) return { value: null, error: 'That amount is too large.' };
  return { value, error: null };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value));

/**
 * POS-PERF-P55 — Create / Edit discount type. Turning a required proof photo
 * off needs an explicit confirmation so a proof-required type never silently
 * becomes proof-optional. Edits carry the version this dialog opened with; a
 * newer save is never overwritten.
 *
 * POS-PERF-P57 — also which branches, how the amount is decided, and which
 * products are eligible. Nothing here is automatic: a cashier still has to
 * choose the type on each sale.
 */
export function ManualDiscountTypeDialog({ open, onOpenChange, branches, branchId, editing }: ManualDiscountTypeDialogProps) {
  const create = useCreateManualDiscountType();
  const update = useUpdateManualDiscountType();
  const [name, setName] = useState('');
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [amountMode, setAmountMode] = useState<ManualDiscountAmountMode>('manual');
  const [fixedText, setFixedText] = useState('');
  const [productScope, setProductScope] = useState<ManualDiscountProductScope>('all');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [applyToPos, setApplyToPos] = useState(true);
  const [requireProof, setRequireProof] = useState(false);
  const [confirmProofOff, setConfirmProofOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setBranchIds(editing ? editing.branch_ids.filter((id) => branches.some((b) => b.id === id)) : [branchId]);
    setAmountMode(editing?.amount_mode ?? 'manual');
    setFixedText(editing?.fixed_amount != null ? String(editing.fixed_amount) : '');
    setProductScope(editing?.product_scope ?? 'all');
    setProductIds(editing?.product_ids ?? []);
    setApplyToPos(editing?.apply_to_pos ?? true);
    setRequireProof(editing?.require_proof ?? false);
    setConfirmProofOff(false);
    setError(null);
    // Reset only when a different type/version is opened — a background
    // refetch of the same version must not wipe what the supervisor typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, editing?.version]);

  const products = useDiscountEligibleProducts(open && productScope === 'selected' ? branchIds : []);
  // A product already on the type stays listed even when it no longer shows up, so saving never drops it unnoticed.
  const productOptions = useMemo(() => {
    const listed = new Map((products.data ?? []).map((product) => [product.id, product.name]));
    for (const id of productIds) if (!listed.has(id) && products.data) listed.set(id, 'Product no longer available here');
    return [...listed].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [products.data, productIds]);

  const trimmed = name.trim();
  const statutoryLooking = trimmed.length > 0 && isStatutoryDiscountName(trimmed);
  const fixed = parseFixedAmount(fixedText);
  const turningProofOff = editing?.require_proof === true && !requireProof;
  const fixedValid = amountMode === 'manual' || fixed.value !== null;
  const productsValid = productScope === 'all' || productIds.length > 0;
  const unchanged =
    editing !== null &&
    trimmed === editing.name &&
    applyToPos === editing.apply_to_pos &&
    requireProof === editing.require_proof &&
    amountMode === editing.amount_mode &&
    (amountMode === 'manual' || fixed.value === editing.fixed_amount) &&
    productScope === editing.product_scope &&
    sameSet(productIds, editing.product_ids) &&
    sameSet(branchIds, editing.branch_ids.filter((id) => branches.some((b) => b.id === id)));
  const pending = create.isPending || update.isPending;
  const canSave = trimmed.length > 0 && branchIds.length > 0 && fixedValid && productsValid && !unchanged && (!turningProofOff || confirmProofOff) && !pending;

  function handleSave() {
    if (!canSave) return;
    setError(null);
    const onError = (err: Error) => {
      setError(
        err instanceof ManualDiscountTypeSaveError && err.code === 'MANUAL_DISCOUNT_TYPE_CONFLICT'
          ? 'Someone else changed this discount type after you opened it. Close this window to see the latest version, then make your change again.'
          : err.message,
      );
    };
    const onSuccess = () => onOpenChange(false);
    const settings = {
      amount_mode: amountMode,
      fixed_amount: amountMode === 'fixed' ? fixed.value : null,
      product_scope: productScope,
      product_ids: productScope === 'selected' ? productIds : [],
    };
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          expected_version: editing.version,
          branch_ids: branchIds,
          ...settings,
          ...(trimmed !== editing.name ? { name: trimmed } : {}),
          ...(applyToPos !== editing.apply_to_pos ? { apply_to_pos: applyToPos } : {}),
          ...(requireProof !== editing.require_proof ? { require_proof: requireProof } : {}),
        },
        { onSuccess, onError },
      );
    } else {
      create.mutate({ branch_ids: branchIds, name: trimmed, apply_to_pos: applyToPos, require_proof: requireProof, ...settings }, { onSuccess, onError });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit discount type' : 'New discount type'}</DialogTitle>
          <DialogDescription>Cashiers choose this type themselves on a sale. It is never applied automatically.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="manual-type-name">Name</Label>
            <Input
              id="manual-type-name"
              value={name}
              maxLength={MANUAL_DISCOUNT_TYPE_NAME_MAX}
              placeholder="e.g. Staff meal"
              aria-describedby={statutoryLooking ? 'manual-type-name-notice' : undefined}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {statutoryLooking && (
              <p id="manual-type-name-notice" className="text-xs text-amber-700 dark:text-amber-400">
                {STATUTORY_DISCOUNT_NAME_NOTICE}
              </p>
            )}
          </div>

          <SelectionChecklist
            title="Branches"
            noun="branches"
            options={branches.map((branch) => ({ id: branch.id, label: branch.name }))}
            selected={branchIds}
            onChange={setBranchIds}
            error={branchIds.length === 0 ? 'Choose at least one branch.' : null}
          />

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Amount</legend>
            <RadioGroup value={amountMode} onValueChange={(value) => setAmountMode(value as ManualDiscountAmountMode)} className="space-y-1">
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manual" id="manual-type-amount-manual" className="mt-0.5" />
                <Label htmlFor="manual-type-amount-manual" className="font-normal">
                  Staff enters amount at checkout
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="fixed" id="manual-type-amount-fixed" className="mt-0.5" />
                <Label htmlFor="manual-type-amount-fixed" className="font-normal">
                  Fixed peso amount
                </Label>
              </div>
            </RadioGroup>
            {amountMode === 'fixed' && (
              <div className="space-y-1">
                <Label htmlFor="manual-type-fixed-amount" className="text-xs">
                  Amount (₱)
                </Label>
                <Input
                  id="manual-type-fixed-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="tabular-nums"
                  placeholder="0.00"
                  value={fixedText}
                  aria-invalid={fixed.error !== null}
                  aria-describedby="manual-type-fixed-help"
                  onChange={(e) => setFixedText(e.target.value)}
                />
                <p id="manual-type-fixed-help" className={fixed.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                  {fixed.error ?? 'Taken once off the order, not per item. If the eligible items come to less, the discount stops at their subtotal.'}
                </p>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Eligible products</legend>
            <RadioGroup value={productScope} onValueChange={(value) => setProductScope(value as ManualDiscountProductScope)} className="space-y-1">
              <div className="flex items-start gap-2">
                <RadioGroupItem value="all" id="manual-type-products-all" className="mt-0.5" />
                <Label htmlFor="manual-type-products-all" className="font-normal">
                  All products, including ones added later
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="selected" id="manual-type-products-selected" className="mt-0.5" />
                <Label htmlFor="manual-type-products-selected" className="font-normal">
                  Only the products I choose
                </Label>
              </div>
            </RadioGroup>
            {productScope === 'selected' &&
              (products.isError ? (
                <p role="alert" className="text-xs text-destructive">
                  Couldn&apos;t load products.{' '}
                  <button type="button" className="underline" onClick={products.refetch}>
                    Retry
                  </button>
                </p>
              ) : !products.data && branchIds.length > 0 ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <>
                  <SelectionChecklist
                    title="Products at the chosen branches"
                    noun="products"
                    options={productOptions}
                    selected={productIds}
                    onChange={setProductIds}
                    searchable
                    error={productIds.length === 0 ? 'Choose at least one product.' : null}
                  />
                  <p className="text-xs text-muted-foreground">Products you add later are not included until you tick them here. An eligible item&apos;s add-ons count with it.</p>
                </>
              ))}
          </fieldset>

          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <Label htmlFor="manual-type-pos" className="font-medium">
                Apply to POS
              </Label>
              <p className="text-xs text-muted-foreground">Cashiers at the chosen branches can select it at checkout.</p>
            </div>
            <Switch id="manual-type-pos" checked={applyToPos} onCheckedChange={setApplyToPos} />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="manual-type-proof" className="font-medium">
                  Require proof photo
                </Label>
                <p className="text-xs text-muted-foreground">The cashier must take or upload a photo (e.g. an ID) before Charge is enabled.</p>
              </div>
              <Switch
                id="manual-type-proof"
                checked={requireProof}
                onCheckedChange={(checked) => {
                  setRequireProof(checked);
                  setConfirmProofOff(false);
                }}
              />
            </div>
            {turningProofOff && (
              <label className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <Checkbox checked={confirmProofOff} onCheckedChange={(checked) => setConfirmProofOff(checked === true)} aria-label="Confirm proof photo is no longer required" />
                <span>This type currently requires a proof photo. Turn it off so cashiers can apply it without a photo? Past sales keep their photos.</span>
              </label>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {pending ? 'Saving…' : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
