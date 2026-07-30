'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CreateTransactionInput, PosCatalogProduct, TransactionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useAuth } from '@/hooks/use-auth';
import { useCart } from '@/hooks/use-cart';
import { useOffline } from '@/hooks/use-offline';
import { useCatalog, useCatalogRealtimeSync } from '@/hooks/queries/use-products';
import { useIsClockedIn } from '@/hooks/queries/use-attendance';
import { useMyActiveShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useCreateTransaction, useUploadPaymentProof } from '@/hooks/queries/use-transactions';
import { cacheProductCatalog, getCachedProductCatalog } from '@/lib/offline/cache';
import { enqueueOfflineTransaction } from '@/lib/offline/sync-queue';
import { ReceiptModal } from '@/components/pos/receipt-modal';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

type DiscountChoice = 'none' | 'pwd' | 'senior_citizen' | 'employee' | 'promotional';

const DISCOUNT_LABELS: Record<DiscountChoice, string> = {
  none: 'No discount',
  pwd: 'PWD (20%)',
  senior_citizen: 'Senior Citizen (20%)',
  employee: 'Employee (20%)',
  promotional: 'Promotional',
};

/**
 * Client-side preview only — mirrors transactions.service's computeAmounts
 * closely enough to show the cashier a live total, but the server always
 * recomputes and persists the authoritative figures. Never trust this for
 * the actual charge.
 */
function previewAmounts(
  cartLines: { lineTotal: number; quantity: number; vatableCapAmount: number | null }[],
  discountType: DiscountChoice,
  promoAmount: number,
) {
  const subtotal = round2(cartLines.reduce((sum, l) => sum + l.lineTotal, 0));
  const vatableSubtotal = round2(
    cartLines.reduce((sum, l) => {
      const cap = l.vatableCapAmount;
      const vatableLine = cap != null ? Math.min(l.lineTotal, round2(cap * l.quantity)) : l.lineTotal;
      return sum + vatableLine;
    }, 0),
  );
  const nonVatableSubtotal = round2(subtotal - vatableSubtotal);

  if (discountType === 'pwd' || discountType === 'senior_citizen') {
    const vatableBase = vatableSubtotal / 1.12;
    const discountAmount = round2(vatableBase * 0.2);
    const discountedBase = round2(vatableBase - discountAmount);
    return { discountAmount, vatAmount: 0, totalAmount: round2(discountedBase + nonVatableSubtotal) };
  }
  let discountAmount = 0;
  if (discountType === 'employee') discountAmount = round2(vatableSubtotal * 0.2);
  else if (discountType === 'promotional') discountAmount = round2(promoAmount || 0);
  const vatableAfterDiscount = round2(vatableSubtotal - discountAmount);
  const vatAmount = round2(vatableAfterDiscount * (12 / 112));
  return { discountAmount, vatAmount, totalAmount: round2(vatableAfterDiscount + nonVatableSubtotal) };
}

export default function TerminalPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { items, addItem, removeItem, updateItemQuantity, clearCart } = useCart();
  const { data: liveCatalog, isLoading: isCatalogLoading } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);
  const { isClockedIn, isLoading: isAttendanceLoading } = useIsClockedIn();
  const { shift, belongsToAnother, isLoading: isShiftLoading } = useMyActiveShift(branchId);
  useShiftsRealtimeSync();
  const { isOnline } = useOffline();
  const createTransaction = useCreateTransaction();
  const uploadPaymentProof = useUploadPaymentProof();

  const [cachedProducts, setCachedProducts] = useState<PosCatalogProduct[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [flavorPrompt, setFlavorPrompt] = useState<{ product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] } | null>(null);
  const [slotPrompt, setSlotPrompt] = useState<{
    product: PosCatalogProduct;
    variant: PosCatalogProduct['variants'][number];
    selections: Record<number, { snackProductVariantId: string; flavorId: string }>;
  } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'gcash' | 'maya' | 'other'>('cash');
  const [discountType, setDiscountType] = useState<DiscountChoice>('none');
  const [discountIdReference, setDiscountIdReference] = useState('');
  const [promoAmount, setPromoAmount] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  // Shared by GCash and Maya — both are reference-number + photo-proof
  // e-wallet payments with identical requirements (audit §5).
  const [gcashReferenceNumber, setGcashReferenceNumber] = useState('');
  const [gcashManuallyVerified, setGcashManuallyVerified] = useState(false);
  const [paymentProofKey, setPaymentProofKey] = useState<string | null>(null);
  const [paymentProofType, setPaymentProofType] = useState<'live_capture' | 'gallery_upload' | null>(null);
  // "other" only — a short free-text reference/note, no photo proof required.
  const [otherReferenceNote, setOtherReferenceNote] = useState('');
  const [receipt, setReceipt] = useState<TransactionResponse | null>(null);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);
  const [chargeError, setChargeError] = useState<string | null>(null);

  // GCash/Maya proof capture and Other's reference note both require a live
  // connection (see createTransactionSchema's offline-must-be-cash rule) —
  // there's no offline blob/note queue for them (see lib/offline/db.ts), so a
  // cashier can't start or continue a non-cash sale while offline. Revert to
  // cash immediately if the connection drops mid-selection.
  useEffect(() => {
    if (!isOnline && paymentMethod !== 'cash') {
      setPaymentMethod('cash');
    }
  }, [isOnline, paymentMethod]);

  // Single clean cashier workflow: Clock In -> Open Shift once -> POS. No
  // attendance sends the cashier back to clock in; clocked in with no active
  // shift of their own sends them to open one — never a generic
  // NO_ACTIVE_SHIFT toast when the app already knows where to send them. A
  // shift that closes (or gets closed elsewhere) while this page is open
  // falls through the same "no shift" branch and redirects back out.
  const isGuardLoading = isAttendanceLoading || isShiftLoading;
  const shouldRedirectToClockIn = !isGuardLoading && !isClockedIn;
  const shouldRedirectToOpenShift = !isGuardLoading && isClockedIn && shift === null;

  useEffect(() => {
    if (shouldRedirectToClockIn) router.replace('/branch/clock-in');
  }, [shouldRedirectToClockIn, router]);

  useEffect(() => {
    if (shouldRedirectToOpenShift) router.replace('/branch/shift/open');
  }, [shouldRedirectToOpenShift, router]);

  // Refresh the offline cache whenever the live catalog loads — Architecture
  // doc §10.1: refreshed on connect and at least every 30 minutes.
  useEffect(() => {
    if (!liveCatalog) return;
    void cacheProductCatalog(liveCatalog.products.map((p) => ({ id: p.id, data: p })));
  }, [liveCatalog]);

  // Fall back to the Dexie-cached catalog when offline or before the first
  // live fetch resolves.
  useEffect(() => {
    if (liveCatalog) return;
    void (async () => {
      const cached = await getCachedProductCatalog();
      const products = cached.map((row) => row.data as PosCatalogProduct);
      setCachedProducts(products);
    })();
  }, [liveCatalog]);

  const catalog = liveCatalog?.products ?? cachedProducts;
  const categories = useMemo(
    () => [...new Set(catalog.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort(),
    [catalog],
  );
  const visibleProducts = activeCategory === 'all' ? catalog : catalog.filter((p) => p.category === activeCategory);

  const variantIndex = useMemo(() => {
    const map = new Map<string, { product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] }>();
    for (const product of catalog) {
      for (const variant of product.variants) map.set(variant.id, { product, variant });
    }
    return map;
  }, [catalog]);

  function readinessMessage(variant: PosCatalogProduct['variants'][number]): string | null {
    if (variant.live_ready) return null;
    if (variant.readiness_code === 'MISSING_FLAVOR_MAPPING') {
      const flavorNames = variant.blocking_issues.map((issue) => issue.flavor_name).filter((name): name is string => Boolean(name));
      if (flavorNames.length > 0) return `Not ready: missing setup for ${flavorNames.join(', ')}.`;
      return 'Flavor inventory mapping incomplete.';
    }
    switch (variant.readiness_code) {
      case 'NOT_AVAILABLE_IN_BRANCH':
        return 'Not available at this branch.';
      case 'INACTIVE':
        return 'Currently unavailable.';
      case 'PRICE_MISSING':
        return 'Price not set.';
      case 'MIX_MAX_INCOMPLETE':
        return 'Mix & Max setup incomplete.';
      case 'MISSING_BASE_MAPPING':
      default:
        return 'Inventory setup incomplete.';
    }
  }

  function handleProductTap(product: PosCatalogProduct, variant: PosCatalogProduct['variants'][number]) {
    if (!variant.live_ready) return;
    if (variant.flavor_slots.length > 0) {
      setSlotPrompt({ product, variant, selections: {} });
      return;
    }
    if (variant.flavors.length > 0) {
      setFlavorPrompt({ product, variant });
      return;
    }
    addItem({ product_id: product.id, product_variant_id: variant.id, quantity: 1 });
  }

  function handleFlavorPick(flavorId: string) {
    if (!flavorPrompt) return;
    addItem({
      product_id: flavorPrompt.product.id,
      product_variant_id: flavorPrompt.variant.id,
      flavor_id: flavorId,
      quantity: 1,
    });
    setFlavorPrompt(null);
  }

  function handleSlotSnackPick(slotIndex: number, snackProductVariantId: string) {
    setSlotPrompt((prev) =>
      prev ? { ...prev, selections: { ...prev.selections, [slotIndex]: { snackProductVariantId, flavorId: '' } } } : prev,
    );
  }

  function handleSlotFlavorPick(slotIndex: number, flavorId: string) {
    setSlotPrompt((prev) => {
      if (!prev) return prev;
      const current = prev.selections[slotIndex];
      if (!current) return prev;
      return { ...prev, selections: { ...prev.selections, [slotIndex]: { ...current, flavorId } } };
    });
  }

  function handleSlotAddToCart() {
    if (!slotPrompt) return;
    const selectedFlavors = slotPrompt.variant.flavor_slots.map((slot) => ({
      slot_index: slot.slot_index,
      snack_product_variant_id: slotPrompt.selections[slot.slot_index]?.snackProductVariantId ?? '',
      flavor_id: slotPrompt.selections[slot.slot_index]?.flavorId ?? '',
    }));
    if (selectedFlavors.some((s) => !s.snack_product_variant_id || !s.flavor_id)) return;
    addItem({
      product_id: slotPrompt.product.id,
      product_variant_id: slotPrompt.variant.id,
      selected_flavors: selectedFlavors as { slot_index: number; snack_product_variant_id: string; flavor_id: string }[],
      quantity: 1,
    });
    setSlotPrompt(null);
  }

  // Memoized so it only recomputes when the cart or catalog actually change —
  // without this, every keystroke in an unrelated field (cash tendered,
  // discount ID, payment reference) re-derived every cart line from scratch.
  const cartLines = useMemo(
    () =>
      items.map((item, index) => {
        const info = variantIndex.get(item.product_variant_id);
        const flavor = info?.variant.flavors.find((f) => f.flavor_id === item.flavor_id);
        const slotSelections = (item.selected_flavors ?? [])
          .slice()
          .sort((a, b) => a.slot_index - b.slot_index)
          .map((sel) => {
            const slot = info?.variant.flavor_slots.find((s) => s.slot_index === sel.slot_index);
            const snackOption = slot?.snack_options.find((so) => so.product_variant_id === sel.snack_product_variant_id);
            const slotFlavor = snackOption?.flavors.find((f) => f.flavor_id === sel.flavor_id);
            return {
              label: slot?.label ?? `Slot ${sel.slot_index}`,
              snackName: snackOption ? `${snackOption.product_name} (${snackOption.variant_name})` : 'Unknown snack',
              flavorName: slotFlavor?.name ?? 'Unknown flavor',
              pricePremium: slotFlavor?.price_premium ?? 0,
            };
          });
        const unitPrice =
          slotSelections.length > 0
            ? (info?.variant.price ?? 0) + slotSelections.reduce((sum, s) => sum + s.pricePremium, 0)
            : (info?.variant.price ?? 0) + (flavor?.price_premium ?? 0);
        return {
          index,
          item,
          productName: info?.product.name ?? 'Unknown item',
          variantName: info?.variant.name ?? '',
          flavorName: flavor?.name ?? null,
          slotSelections,
          unitPrice,
          quantity: item.quantity,
          lineTotal: round2(unitPrice * item.quantity),
          vatableCapAmount: info?.variant.vatable_cap_amount ?? null,
        };
      }),
    [items, variantIndex],
  );

  const subtotal = round2(cartLines.reduce((sum, line) => sum + line.lineTotal, 0));
  const { discountAmount, vatAmount, totalAmount } = useMemo(
    () => previewAmounts(cartLines, discountType, Number(promoAmount)),
    [cartLines, discountType, promoAmount],
  );
  const tenderedNumber = Number(cashTendered);
  const change = paymentMethod === 'cash' && tenderedNumber >= totalAmount ? round2(tenderedNumber - totalAmount) : 0;

  const canCharge =
    Boolean(branchId) &&
    Boolean(shift) &&
    cartLines.length > 0 &&
    (discountType !== 'pwd' && discountType !== 'senior_citizen' ? true : discountIdReference.trim().length > 0) &&
    (paymentMethod === 'cash'
      ? cashTendered !== '' && tenderedNumber >= totalAmount
      : paymentMethod === 'other'
        ? otherReferenceNote.trim().length > 0
        : gcashReferenceNumber.trim().length > 0 && gcashManuallyVerified && paymentProofKey !== null);

  function resetPaymentFields() {
    setDiscountType('none');
    setDiscountIdReference('');
    setPromoAmount('');
    setCashTendered('');
    setGcashReferenceNumber('');
    setGcashManuallyVerified(false);
    setPaymentProofKey(null);
    setPaymentProofType(null);
    setOtherReferenceNote('');
  }

  async function handleCharge() {
    // Belt-and-suspenders alongside the button's disabled={..isPending} below —
    // isPending flips synchronously on mutate, but guards here too in case a
    // second click event is already queued (e.g. double-tap on a touchscreen)
    // before React re-renders the disabled state.
    if (!branchId || !shift || createTransaction.isPending) return;
    setChargeError(null);

    const payload: CreateTransactionInput = {
      branch_id: branchId,
      shift_id: shift.id,
      items,
      payment_method: paymentMethod,
      discount_type: discountType === 'none' ? undefined : discountType,
      discount_id_reference: discountIdReference.trim() || undefined,
      discount_amount: discountType === 'promotional' ? Number(promoAmount) : undefined,
      cash_tendered: paymentMethod === 'cash' ? tenderedNumber : undefined,
      gcash_reference_number: paymentMethod === 'gcash' || paymentMethod === 'maya' ? gcashReferenceNumber.trim() : undefined,
      gcash_manually_verified: paymentMethod === 'gcash' || paymentMethod === 'maya' ? gcashManuallyVerified : undefined,
      other_reference_note: paymentMethod === 'other' ? otherReferenceNote.trim() : undefined,
      payment_proof_key: paymentMethod === 'gcash' || paymentMethod === 'maya' ? (paymentProofKey ?? undefined) : undefined,
      payment_proof_type: paymentMethod === 'gcash' || paymentMethod === 'maya' ? (paymentProofType ?? undefined) : undefined,
      is_offline_transaction: !isOnline,
    };

    if (!isOnline) {
      // Real BIR receipt numbers are only ever assigned by the server at
      // sync time — this provisional id just needs to be locally unique.
      const provisionalId = await enqueueOfflineTransaction(branchId.slice(0, 8), payload);
      clearCart();
      resetPaymentFields();
      setQueuedNotice(provisionalId);
      return;
    }

    try {
      const transaction = await createTransaction.mutateAsync(payload);
      clearCart();
      resetPaymentFields();
      setReceipt(transaction);
    } catch (error) {
      setChargeError(error instanceof Error ? error.message : 'Failed to record transaction');
    }
  }

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned.</p>;
  }

  if (isGuardLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Redirect in flight — render nothing rather than flashing the catalog/cart.
  if (shouldRedirectToClockIn || shouldRedirectToOpenShift) {
    return null;
  }

  if (belongsToAnother) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <h1 className="text-xl font-bold">Shift mismatch</h1>
        <p className="text-sm text-muted-foreground">
          The active shift at this branch is open under a different cashier account. Checkout is blocked until this is
          resolved — view the Current Shift page, or ask a supervisor/super_admin to close it.
        </p>
        <Button asChild variant="outline">
          <Link href="/branch/shift">View Current Shift</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {!isOnline && (
        <div className="absolute inset-x-0 top-0 z-10 bg-warning px-4 py-1 text-center text-xs font-medium text-warning-foreground">
          Offline — sales will be queued and synced automatically once you reconnect.
        </div>
      )}

      {/* LEFT PANEL — product catalog */}
      <div className="relative flex w-2/3 flex-col overflow-hidden border-r">
        <div className="border-b p-3">
          <Tabs value={activeCategory} onValueChange={setActiveCategory}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              {categories.map((category) => (
                <TabsTrigger key={category} value={category}>
                  {category}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="grid flex-1 grid-cols-3 gap-2 overflow-y-auto p-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
          {visibleProducts.map((product) =>
            product.variants.map((variant) => {
              const message = readinessMessage(variant);
              return (
                <Card
                  key={variant.id}
                  aria-disabled={!variant.live_ready}
                  className={`flex h-full flex-col touch-target transition ${
                    variant.live_ready ? 'cursor-pointer hover:border-primary' : 'cursor-not-allowed opacity-60'
                  }`}
                  onClick={() => handleProductTap(product, variant)}
                >
                  <CardContent className="flex h-full flex-col gap-0.5 p-2">
                    {product.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.image_url} alt={product.name} className="mb-1 h-14 w-full rounded object-cover" />
                    ) : (
                      <div className="mb-1 h-14 w-full rounded bg-muted" />
                    )}
                    <p className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-tight">{product.name}</p>
                    <p className="text-[11px] text-muted-foreground">{variant.name}</p>
                    <p className="mt-auto text-sm font-semibold tabular-nums">{formatPeso(variant.price)}</p>
                    {message && <p className="text-[11px] font-medium text-destructive">{message}</p>}
                  </CardContent>
                </Card>
              );
            }),
          )}
          {visibleProducts.length === 0 && (
            <p className="col-span-full p-6 text-center text-sm text-muted-foreground">
              {isCatalogLoading ? 'Loading catalog…' : 'No products available.'}
            </p>
          )}
        </div>

        {flavorPrompt && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-sm">
              <CardContent className="space-y-3 p-4">
                <p className="font-medium">Choose a flavor — {flavorPrompt.product.name} ({flavorPrompt.variant.name})</p>
                <div className="grid grid-cols-2 gap-2">
                  {flavorPrompt.variant.flavors.map((flavor) => (
                    <Button key={flavor.flavor_id} variant="outline" onClick={() => handleFlavorPick(flavor.flavor_id)}>
                      {flavor.name}
                      {flavor.price_premium > 0 ? ` (+${formatPeso(flavor.price_premium)})` : ''}
                    </Button>
                  ))}
                </div>
                <Button variant="outline" className="w-full" onClick={() => setFlavorPrompt(null)}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {slotPrompt && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-sm">
              <CardContent className="space-y-3 p-4">
                <p className="font-medium">
                  {slotPrompt.product.name} ({slotPrompt.variant.name})
                </p>
                {slotPrompt.variant.flavor_slots
                  .slice()
                  .sort((a, b) => a.slot_index - b.slot_index)
                  .map((slot) => {
                    const selection = slotPrompt.selections[slot.slot_index];
                    const chosenSnack = slot.snack_options.find(
                      (so) => so.product_variant_id === selection?.snackProductVariantId,
                    );
                    return (
                      <div key={slot.slot_index} className="space-y-1">
                        <p className="text-sm font-medium">{slot.label}</p>
                        <Select
                          value={selection?.snackProductVariantId ?? ''}
                          onValueChange={(snackProductVariantId) => handleSlotSnackPick(slot.slot_index, snackProductVariantId)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a snack" />
                          </SelectTrigger>
                          <SelectContent>
                            {slot.snack_options.map((option) => (
                              <SelectItem key={option.product_variant_id} value={option.product_variant_id}>
                                {option.product_name} ({option.variant_name})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={selection?.flavorId ?? ''}
                          onValueChange={(flavorId) => handleSlotFlavorPick(slot.slot_index, flavorId)}
                          disabled={!chosenSnack}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a flavor" />
                          </SelectTrigger>
                          <SelectContent>
                            {(chosenSnack?.flavors ?? []).map((flavor) => (
                              <SelectItem key={flavor.flavor_id} value={flavor.flavor_id}>
                                {flavor.name}
                                {flavor.price_premium > 0 ? ` (+${formatPeso(flavor.price_premium)})` : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                <p className="text-xs text-muted-foreground">
                  {
                    Object.values(slotPrompt.selections).filter((s) => s.snackProductVariantId && s.flavorId).length
                  }{' '}
                  of {slotPrompt.variant.flavor_slots.length} slots selected
                </p>
                <Button
                  className="w-full"
                  disabled={slotPrompt.variant.flavor_slots.some(
                    (slot) => !slotPrompt.selections[slot.slot_index]?.snackProductVariantId || !slotPrompt.selections[slot.slot_index]?.flavorId,
                  )}
                  onClick={handleSlotAddToCart}
                >
                  Add to Cart
                </Button>
                <Button variant="outline" className="w-full" onClick={() => setSlotPrompt(null)}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* RIGHT PANEL — cart + payment */}
      <div className="flex w-1/3 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-3">
          {cartLines.length === 0 && <p className="text-sm text-muted-foreground">Cart is empty — tap a product to add it.</p>}
          <div className="space-y-2">
            {cartLines.map((line) => (
              <div key={line.index} className="flex items-center justify-between gap-2 border-b pb-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {line.productName}
                    {line.flavorName ? ` — ${line.flavorName}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {line.variantName} · {formatPeso(line.unitPrice)} each
                  </p>
                  {line.slotSelections.map((sel, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      {sel.label}: {sel.snackName} — {sel.flavorName}
                    </p>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" className="touch-target h-7 w-7 p-0" onClick={() => updateItemQuantity(line.index, line.item.quantity - 1)}>
                    −
                  </Button>
                  <span className="w-6 text-center tabular-nums">{line.item.quantity}</span>
                  <Button variant="outline" className="touch-target h-7 w-7 p-0" onClick={() => updateItemQuantity(line.index, line.item.quantity + 1)}>
                    +
                  </Button>
                </div>
                <p className="w-16 text-right tabular-nums">{formatPeso(line.lineTotal)}</p>
                <Button variant="ghost" className="touch-target h-7 w-7 p-0 text-destructive" onClick={() => removeItem(line.index)}>
                  ×
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 border-t bg-card p-3">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatPeso(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-destructive">
                <span>Discount</span>
                <span className="tabular-nums">-{formatPeso(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>VAT (12%)</span>
              <span className="tabular-nums">{formatPeso(vatAmount)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatPeso(totalAmount)}</span>
            </div>
          </div>

          <Select value={discountType} onValueChange={(v) => setDiscountType(v as DiscountChoice)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DISCOUNT_LABELS) as DiscountChoice[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {DISCOUNT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(discountType === 'pwd' || discountType === 'senior_citizen') && (
            <Input
              placeholder="PWD / Senior Citizen ID number"
              value={discountIdReference}
              onChange={(e) => setDiscountIdReference(e.target.value)}
            />
          )}
          {discountType === 'promotional' && (
            <Input type="number" min={0} placeholder="Promo discount amount" value={promoAmount} onChange={(e) => setPromoAmount(e.target.value)} />
          )}

          <Tabs value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'cash' | 'gcash' | 'maya' | 'other')}>
            <TabsList className="w-full">
              <TabsTrigger value="cash" className="flex-1">
                Cash
              </TabsTrigger>
              <TabsTrigger value="gcash" className="flex-1" disabled={!isOnline}>
                GCash
              </TabsTrigger>
              <TabsTrigger value="maya" className="flex-1" disabled={!isOnline}>
                Maya
              </TabsTrigger>
              <TabsTrigger value="other" className="flex-1" disabled={!isOnline}>
                Other
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!isOnline && paymentMethod === 'cash' && (
            <p className="text-xs text-muted-foreground">GCash, Maya, and Other are unavailable offline — proof/reference can only be captured while connected.</p>
          )}

          {paymentMethod === 'cash' && (
            <div className="space-y-1">
              <Input type="number" min={0} placeholder="Cash tendered" value={cashTendered} onChange={(e) => setCashTendered(e.target.value)} />
              <p className="text-xs text-muted-foreground">Change: {formatPeso(change)}</p>
            </div>
          )}

          {(paymentMethod === 'gcash' || paymentMethod === 'maya') && (
            <div className="space-y-2">
              <Input
                placeholder={paymentMethod === 'gcash' ? 'GCash reference number' : 'Maya reference number'}
                value={gcashReferenceNumber}
                onChange={(e) => setGcashReferenceNumber(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={gcashManuallyVerified} onCheckedChange={(v) => setGcashManuallyVerified(v === true)} />
                I manually verified this {paymentMethod === 'gcash' ? 'GCash' : 'Maya'} payment
              </label>
              {paymentProofKey ? (
                <div className="flex items-center justify-between rounded-md border border-success bg-success/10 px-3 py-2 text-xs text-success">
                  <span>Payment proof captured</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-xs underline"
                    onClick={() => {
                      setPaymentProofKey(null);
                      setPaymentProofType(null);
                    }}
                  >
                    Retake
                  </Button>
                </div>
              ) : (
                <ImageUpload
                  label="Payment Proof"
                  required
                  onImageSelected={(file, type) => {
                    if (!branchId || !shift) return;
                    void uploadPaymentProof
                      .mutateAsync({ branchId, shiftId: shift.id, type, file })
                      .then((result) => {
                        setPaymentProofKey(result.payment_proof_key);
                        setPaymentProofType(result.payment_proof_type);
                      });
                  }}
                />
              )}
            </div>
          )}

          {paymentMethod === 'other' && (
            <div className="space-y-1">
              <Input
                placeholder="Payment reference or note (e.g. bank transfer, voucher)"
                value={otherReferenceNote}
                onChange={(e) => setOtherReferenceNote(e.target.value)}
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">No photo proof required — just a short note identifying the payment.</p>
            </div>
          )}

          {chargeError && <p className="text-xs text-destructive">{chargeError}</p>}

          <Button variant="pos" className="w-full" disabled={!canCharge || createTransaction.isPending} onClick={() => void handleCharge()}>
            {createTransaction.isPending ? 'Charging…' : `Charge ${formatPeso(totalAmount)}`}
          </Button>
        </div>
      </div>

      <ReceiptModal transaction={receipt} onClose={() => setReceipt(null)} />

      {queuedNotice && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-sm">
            <CardContent className="space-y-3 p-4 text-center">
              <p className="font-medium">Sale queued for sync</p>
              <p className="text-sm text-muted-foreground">Provisional ID: {queuedNotice}</p>
              <Textarea readOnly value="This device is offline. The sale is saved locally and will sync automatically once you're back online." className="text-xs" rows={3} />
              <Button className="w-full" onClick={() => setQueuedNotice(null)}>
                Done
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
