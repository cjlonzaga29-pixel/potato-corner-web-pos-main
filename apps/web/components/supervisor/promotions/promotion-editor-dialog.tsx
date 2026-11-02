'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import {
  createPromotionSchema,
  PRODUCT_CLASSIFICATION_LABELS,
  VAT_RATE_PERCENT,
  type ProductClassification,
  type PromotionApplicationMode,
  type PromotionDiscountKind,
  type PromotionResponse,
} from '@potato-corner/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { PromotionApiError, useCreatePromotion, usePromotionEligibleProducts, useUpdatePromotion } from '@/hooks/queries/use-promotions';
import { PromotionPricePreview } from './promotion-price-preview';

interface EditorBranch {
  id: string;
  name: string;
}

interface PromotionEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create. */
  promotion: PromotionResponse | null;
  /** Every promotion the supervisor can see, for the overlap notice. */
  allPromotions: PromotionResponse[];
  branches: EditorBranch[];
}

interface FormState {
  name: string;
  discountKind: PromotionDiscountKind;
  discountValue: string;
  isEnabled: boolean;
  applicationMode: PromotionApplicationMode;
  startsOn: string;
  endsOn: string;
  productIds: string[];
  branchIds: string[];
}

function initialState(promotion: PromotionResponse | null, branches: EditorBranch[]): FormState {
  if (!promotion) {
    return {
      name: '',
      discountKind: 'percentage',
      discountValue: '',
      isEnabled: true,
      applicationMode: 'automatic',
      startsOn: '',
      endsOn: '',
      productIds: [],
      branchIds: branches.length === 1 && branches[0] ? [branches[0].id] : [],
    };
  }
  return {
    name: promotion.name,
    discountKind: promotion.discount_kind,
    discountValue: String(promotion.discount_value),
    isEnabled: promotion.is_enabled,
    // An older API omits the field: every P49 promotion is automatic.
    applicationMode: promotion.application_mode ?? 'automatic',
    startsOn: promotion.starts_on ?? '',
    endsOn: promotion.ends_on ?? '',
    productIds: promotion.products.map((p) => p.id),
    branchIds: promotion.branches.map((b) => b.id),
  };
}

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);
}

/** Server refusal details for PROMOTION_PRODUCT_INELIGIBLE, one line per product. */
function ineligibleLines(error: PromotionApiError): string[] {
  const details = error.details as { products?: { product_name: string | null; reason: string }[] } | undefined;
  return (details?.products ?? []).map((p) => `${p.product_name ?? 'A product'}: ${p.reason}`);
}

/** Why this product can't be picked in this mode (Regular products are allowed for cashier-selected discounts). */
function reasonFor(product: { ineligible_reason: string | null; cashier_selected_ineligible_reason?: string | null }, mode: PromotionApplicationMode): string | null {
  if (mode === 'automatic') return product.ineligible_reason;
  return product.cashier_selected_ineligible_reason === undefined ? product.ineligible_reason : product.cashier_selected_ineligible_reason;
}

/**
 * POS-PERF-P49 — create/edit one product promotion. Everything entered here is
 * re-validated by the API against the supervisor's live branch assignments
 * and each product's current classification; this form only explains.
 *
 * POS-PERF-P50R — the Create/Edit Discount popup: also chooses how the
 * discount reaches a sale. Automatic (P49) applies to eligible items by
 * itself; cashier-selected is offered in the POS discount picker and
 * applies only when the cashier chooses it. Either way it is a taxable
 * (VATable) discount — it never makes a sale VAT-exempt.
 */
export function PromotionEditorDialog({ open, onOpenChange, promotion, allPromotions, branches }: PromotionEditorDialogProps) {
  const [state, setState] = useState<FormState>(() => initialState(promotion, branches));
  const [productSearch, setProductSearch] = useState('');
  const [submitError, setSubmitError] = useState<PromotionApiError | Error | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const submittingRef = useRef(false);
  const eligible = usePromotionEligibleProducts(open);
  const createPromotion = useCreatePromotion();
  const updatePromotion = useUpdatePromotion(promotion?.id ?? null);
  const isPending = createPromotion.isPending || updatePromotion.isPending;

  useEffect(() => {
    if (!open) return;
    setState(initialState(promotion, branches));
    setSubmitError(null);
    setFieldErrors({});
    setProductSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the dialog opens or the edited promotion changes
  }, [open, promotion?.id, promotion?.version]);

  const products = useMemo(() => eligible.data ?? [], [eligible.data]);
  const selectedProducts = useMemo(() => products.filter((p) => state.productIds.includes(p.id)), [products, state.productIds]);
  const visibleProducts = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    return products
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(reasonFor(a, state.applicationMode) !== null) - Number(reasonFor(b, state.applicationMode) !== null) || a.name.localeCompare(b.name),
      );
  }, [products, productSearch, state.applicationMode]);
  const isAutomatic = state.applicationMode === 'automatic';
  const noun = isAutomatic ? 'promotion' : 'discount';

  const numericValue = Number(state.discountValue);
  const valueIsUsable = state.discountValue.trim() !== '' && Number.isFinite(numericValue) && numericValue > 0;

  const overlapping = useMemo(
    () =>
      allPromotions.filter(
        (other) =>
          other.id !== promotion?.id &&
          (other.application_mode ?? 'automatic') === state.applicationMode &&
          (other.schedule_state === 'active' || other.schedule_state === 'scheduled') &&
          other.products.some((p) => state.productIds.includes(p.id)) &&
          other.branches.some((b) => state.branchIds.includes(b.id)),
      ),
    [allPromotions, promotion?.id, state.productIds, state.branchIds, state.applicationMode],
  );

  const selectedNotSoldAtBranches = selectedProducts.filter((p) => state.branchIds.length > 0 && !p.branch_ids.some((id) => state.branchIds.includes(id)));

  async function handleSave() {
    if (submittingRef.current) return;
    setSubmitError(null);
    const payload = {
      name: state.name,
      discount_kind: state.discountKind,
      discount_value: numericValue,
      is_enabled: state.isEnabled,
      application_mode: state.applicationMode,
      starts_on: state.startsOn || null,
      ends_on: state.endsOn || null,
      product_ids: state.productIds,
      branch_ids: state.branchIds,
    };
    const parsed = createPromotionSchema.safeParse(payload);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!next[key]) next[key] = issue.path[0] === 'discount_value' && !valueIsUsable ? 'Enter an amount greater than 0' : issue.message;
      }
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});
    submittingRef.current = true;
    try {
      if (promotion) await updatePromotion.mutateAsync({ ...parsed.data, expected_version: promotion.version });
      else await createPromotion.mutateAsync(parsed.data);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error : new Error(`Failed to save the ${noun}`));
    } finally {
      submittingRef.current = false;
    }
  }

  const exampleBase = 39;
  const example =
    state.discountKind === 'percentage'
      ? `Example: 10% off a ₱${exampleBase}.00 item → ₱35.10. Each item is discounted separately.`
      : `Example: ₱10 off each ₱${exampleBase}.00 item → ₱29.00 each; 3 items save ₱30.00. If the amount is more than an item's price, that item sells for ₱0.00 — never less. This is not a whole-order discount.`;

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{promotion ? `Edit ${noun}` : `New ${noun}`}</DialogTitle>
          <DialogDescription>
            {isAutomatic
              ? 'Discounts the selected Promotional or Seasonal products at the selected branches automatically.'
              : 'A discount the cashier can choose at checkout for the selected products at the selected branches.'}{' '}
            Product prices and product setup are not changed.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          aria-label="Promotion details"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <fieldset disabled={isPending} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="promotion-name">Discount name</Label>
              <Input
                id="promotion-name"
                value={state.name}
                maxLength={80}
                placeholder="e.g. Halloween Fries Promo"
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? 'promotion-name-error' : undefined}
                onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              />
              {fieldErrors.name && (
                <p id="promotion-name-error" className="text-xs text-destructive">
                  {fieldErrors.name}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label id="promotion-mode-label">How it applies</Label>
              <RadioGroup
                aria-labelledby="promotion-mode-label"
                value={state.applicationMode}
                onValueChange={(value) => {
                  if (value === 'automatic' || value === 'cashier_selected') setState((s) => ({ ...s, applicationMode: value }));
                }}
                className="grid gap-2 sm:grid-cols-2"
              >
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                  <RadioGroupItem value="automatic" id="promotion-mode-automatic" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Automatic promotion</span>
                    <span className="block text-xs text-muted-foreground">Applied to eligible items without the cashier doing anything. Promotional or Seasonal products only.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                  <RadioGroupItem value="cashier_selected" id="promotion-mode-cashier" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Cashier selects at checkout</span>
                    <span className="block text-xs text-muted-foreground">
                      Listed in the POS discount picker (e.g. a loyalty card). Applies only when the cashier chooses it. Any product, including Regular.
                    </span>
                  </span>
                </label>
              </RadioGroup>
              {!isAutomatic && (
                <p className="text-xs text-muted-foreground" data-testid="selection-requirement-note">
                  Selection requirement: at a branch where &ldquo;Cashier must choose a discount&rdquo; is on (Settings), the cashier picks this discount
                  if it applies, another one, or &ldquo;No applicable discount&rdquo;. Choosing it is never forced.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label id="promotion-kind-label">Discount type</Label>
              <RadioGroup
                aria-labelledby="promotion-kind-label"
                value={state.discountKind}
                onValueChange={(value) => {
                  if (value === 'percentage' || value === 'fixed_amount') setState((s) => ({ ...s, discountKind: value }));
                }}
                className="grid gap-2 sm:grid-cols-2"
              >
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                  <RadioGroupItem value="percentage" id="promotion-kind-percentage" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Percentage off each item</span>
                    <span className="block text-xs text-muted-foreground">e.g. 10% off</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                  <RadioGroupItem value="fixed_amount" id="promotion-kind-fixed" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Fixed amount off each item</span>
                    <span className="block text-xs text-muted-foreground">e.g. ₱10 off every unit</span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor="promotion-value">{state.discountKind === 'percentage' ? 'Percent off (1–100)' : 'Pesos off each item'}</Label>
              <div className="flex max-w-xs items-center gap-2">
                {state.discountKind === 'fixed_amount' && <span aria-hidden="true">₱</span>}
                <Input
                  id="promotion-value"
                  inputMode="decimal"
                  value={state.discountValue}
                  aria-invalid={Boolean(fieldErrors.discount_value)}
                  aria-describedby="promotion-value-help"
                  onChange={(e) => setState((s) => ({ ...s, discountValue: e.target.value.replace(/[^\d.]/g, '') }))}
                />
                {state.discountKind === 'percentage' && <span aria-hidden="true">%</span>}
              </div>
              <p id="promotion-value-help" className="text-xs text-muted-foreground">
                {example}
              </p>
              {fieldErrors.discount_value && <p className="text-xs text-destructive">{fieldErrors.discount_value}</p>}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Branches</legend>
              <p className="text-xs text-muted-foreground">Only branches you manage. The discount applies only at the branches ticked here.</p>
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                {branches.length === 0 && <p className="text-sm text-muted-foreground">You have no active branch assignment.</p>}
                {branches.map((branch) => (
                  <label key={branch.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={state.branchIds.includes(branch.id)}
                      onCheckedChange={(checked) => setState((s) => ({ ...s, branchIds: toggle(s.branchIds, branch.id, checked === true) }))}
                      aria-label={branch.name}
                    />
                    {branch.name}
                  </label>
                ))}
              </div>
              {fieldErrors.branch_ids && <p className="text-xs text-destructive">{fieldErrors.branch_ids}</p>}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Products</legend>
              <p className="text-xs text-muted-foreground">
                {isAutomatic ? 'Only products classified Promotional or Seasonal can be selected. ' : ''}Every size of a selected product is discounted
                from its own price. Flavor premiums and add-ons are never discounted. Sizes with a VATable price cap cannot be discounted.
              </p>
              <Input
                aria-label="Search products"
                placeholder="Search products"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="max-w-xs"
              />
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2" role="group" aria-label="Products">
                {eligible.isLoading && <p className="p-2 text-sm text-muted-foreground">Loading products…</p>}
                {eligible.isError && <p className="p-2 text-sm text-destructive">{eligible.error.message}</p>}
                {!eligible.isLoading && visibleProducts.length === 0 && <p className="p-2 text-sm text-muted-foreground">No products found.</p>}
                {visibleProducts.map((product) => {
                  const selected = state.productIds.includes(product.id);
                  const reason = reasonFor(product, state.applicationMode);
                  const blocked = reason !== null && !selected;
                  return (
                    <label
                      key={product.id}
                      className={`flex items-start gap-2 rounded px-2 py-1.5 text-sm ${blocked ? 'opacity-60' : 'hover:bg-muted/50'}`}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected}
                        disabled={blocked}
                        onCheckedChange={(checked) => setState((s) => ({ ...s, productIds: toggle(s.productIds, product.id, checked === true) }))}
                        aria-label={product.name}
                        aria-describedby={reason ? `promotion-product-${product.id}-reason` : undefined}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{product.name}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          ({product.product_type_name ?? PRODUCT_CLASSIFICATION_LABELS[product.classification as ProductClassification] ?? product.classification})
                        </span>
                        {reason && (
                          <span id={`promotion-product-${product.id}-reason`} className="block text-xs text-muted-foreground">
                            {reason}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {fieldErrors.product_ids && <p className="text-xs text-destructive">{fieldErrors.product_ids}</p>}
              {selectedNotSoldAtBranches.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Not sold at any ticked branch: {selectedNotSoldAtBranches.map((p) => p.name).join(', ')}. Tick one of its branches or remove it.
                </p>
              )}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="promotion-starts-on">Start date (optional)</Label>
                <Input id="promotion-starts-on" type="date" value={state.startsOn} onChange={(e) => setState((s) => ({ ...s, startsOn: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="promotion-ends-on">End date (optional)</Label>
                <Input id="promotion-ends-on" type="date" value={state.endsOn} onChange={(e) => setState((s) => ({ ...s, endsOn: e.target.value }))} />
                {fieldErrors.ends_on && <p className="text-xs text-destructive">{fieldErrors.ends_on}</p>}
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Philippine time. Both days are included: the discount starts at 12:00 AM on the start date and stops after 11:59 PM on the end date.
                Leave empty for no limit.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium" id="promotion-enabled-label">
                  Enabled
                </p>
                <p className="text-xs text-muted-foreground">Turn off to pause the discount without deleting it.</p>
              </div>
              <Switch
                aria-labelledby="promotion-enabled-label"
                checked={state.isEnabled}
                onCheckedChange={(checked) => setState((s) => ({ ...s, isEnabled: checked }))}
              />
            </div>

            <section className="space-y-2" aria-labelledby="promotion-preview-heading">
              <h3 id="promotion-preview-heading" className="text-sm font-medium">
                Price preview
              </h3>
              {valueIsUsable ? (
                <PromotionPricePreview products={selectedProducts} discountKind={state.discountKind} discountValue={numericValue} />
              ) : (
                <p className="text-sm text-muted-foreground">Enter the discount to see original, discount and final prices.</p>
              )}
            </section>

            <Alert data-testid="promotion-vat-treatment">
              <Info className="h-4 w-4" />
              <AlertTitle>VAT treatment: taxable discount</AlertTitle>
              <AlertDescription className="space-y-1 text-xs">
                <p>
                  The discount comes off the price with VAT; VAT ({VAT_RATE_PERCENT}%) is then charged on what remains. It never makes a sale VAT-exempt and
                  never adds VAT to an exempt sale. Only the statutory PWD and Senior Citizen discounts are VAT-exempt, and they are set in Settings, not
                  here.
                </p>
              </AlertDescription>
            </Alert>

            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>How this combines with other discounts</AlertTitle>
              <AlertDescription className="space-y-1 text-xs">
                {isAutomatic ? (
                  <>
                    <p>An item gets at most one promotion. If several cover it, it gets the one with the bigger discount (on a tie, the older one).</p>
                    <p>Promotions are not combined with PWD, Senior Citizen, Employee or a cashier-selected discount — when one of those is chosen, regular prices apply.</p>
                  </>
                ) : (
                  <p>
                    One discount per sale. When the cashier chooses this, automatic promotions are not applied to that sale, and it cannot be combined
                    with PWD, Senior Citizen or Employee. The POS shows the new total before the cashier charges.
                  </p>
                )}
                <p>Offline sales are charged regular prices, because a {noun} can&apos;t be confirmed without a connection.</p>
              </AlertDescription>
            </Alert>

            {overlapping.length > 0 && (
              <Alert data-testid="promotion-overlap">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Overlaps with {overlapping.length === 1 ? `another ${noun}` : `${overlapping.length} other ${noun}s`}</AlertTitle>
                <AlertDescription className="text-xs">
                  {overlapping.map((o) => o.name).join(', ')} also cover{overlapping.length === 1 ? 's' : ''} some of these products at a selected
                  branch. {isAutomatic ? 'Each item still gets only one discount — the bigger one.' : 'The cashier chooses at most one of them per sale.'}
                </AlertDescription>
              </Alert>
            )}
          </fieldset>

          {submitError && (
            <Alert variant="destructive" role="alert">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {submitError instanceof PromotionApiError && submitError.code === 'PROMOTION_CONFLICT' ? 'Not saved — changed elsewhere' : 'Not saved'}
              </AlertTitle>
              <AlertDescription className="space-y-1">
                <p>{submitError.message}</p>
                {submitError instanceof PromotionApiError &&
                  submitError.code === 'PROMOTION_PRODUCT_INELIGIBLE' &&
                  ineligibleLines(submitError).map((line) => <p key={line}>{line}</p>)}
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {promotion ? 'Save changes' : `Create ${noun}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
