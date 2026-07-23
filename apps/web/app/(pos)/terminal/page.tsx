'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CreateTransactionInput, PosCatalogProduct, TransactionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { useCart } from '@/hooks/use-cart';
import { useOffline } from '@/hooks/use-offline';
import { useCatalog, useCatalogRealtimeSync } from '@/hooks/queries/use-products';
import { useCurrentShift } from '@/hooks/queries/use-shifts';
import { useCreateTransaction } from '@/hooks/queries/use-transactions';
import { cacheBranchPriceOverrides, cacheProductCatalog, getCachedPriceOverrides, getCachedProductCatalog } from '@/lib/offline/cache';
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
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { items, addItem, removeItem, updateItemQuantity, clearCart } = useCart();
  const { data: liveCatalog, isLoading: isCatalogLoading } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);
  const { data: shift } = useCurrentShift(branchId);
  const { isOnline } = useOffline();
  const createTransaction = useCreateTransaction();

  const [cachedProducts, setCachedProducts] = useState<PosCatalogProduct[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [flavorPrompt, setFlavorPrompt] = useState<{ product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'gcash'>('cash');
  const [discountType, setDiscountType] = useState<DiscountChoice>('none');
  const [discountIdReference, setDiscountIdReference] = useState('');
  const [promoAmount, setPromoAmount] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [gcashReferenceNumber, setGcashReferenceNumber] = useState('');
  const [gcashManuallyVerified, setGcashManuallyVerified] = useState(false);
  const [receipt, setReceipt] = useState<TransactionResponse | null>(null);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);
  const [chargeError, setChargeError] = useState<string | null>(null);

  // Refresh the offline cache whenever the live catalog loads — Architecture
  // doc §10.1: refreshed on connect and at least every 30 minutes.
  useEffect(() => {
    if (!liveCatalog) return;
    void cacheProductCatalog(liveCatalog.products.map((p) => ({ id: p.id, data: p })));
    void cacheBranchPriceOverrides(
      liveCatalog.products.flatMap((p) => p.variants.map((v) => ({ productVariantId: v.id, price: v.price }))),
    );
  }, [liveCatalog]);

  // Fall back to the Dexie-cached catalog (with cached override prices
  // layered on top) when offline or before the first live fetch resolves.
  useEffect(() => {
    if (liveCatalog) return;
    void (async () => {
      const [cached, overrides] = await Promise.all([getCachedProductCatalog(), getCachedPriceOverrides()]);
      const overrideMap = new Map(overrides.map((o) => [o.id, o.price]));
      const products = cached.map((row) => row.data as PosCatalogProduct).map((product) => ({
        ...product,
        variants: product.variants.map((variant) => ({ ...variant, price: overrideMap.get(variant.id) ?? variant.price })),
      }));
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

  function handleProductTap(product: PosCatalogProduct, variant: PosCatalogProduct['variants'][number]) {
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

  const cartLines = items.map((item, index) => {
    const info = variantIndex.get(item.product_variant_id);
    const flavor = info?.variant.flavors.find((f) => f.flavor_id === item.flavor_id);
    const unitPrice = (info?.variant.price ?? 0) + (flavor?.price_premium ?? 0);
    return {
      index,
      item,
      productName: info?.product.name ?? 'Unknown item',
      variantName: info?.variant.name ?? '',
      flavorName: flavor?.name ?? null,
      unitPrice,
      quantity: item.quantity,
      lineTotal: round2(unitPrice * item.quantity),
      vatableCapAmount: info?.variant.vatable_cap_amount ?? null,
    };
  });

  const subtotal = round2(cartLines.reduce((sum, line) => sum + line.lineTotal, 0));
  const { discountAmount, vatAmount, totalAmount } = previewAmounts(cartLines, discountType, Number(promoAmount));
  const tenderedNumber = Number(cashTendered);
  const change = paymentMethod === 'cash' && tenderedNumber >= totalAmount ? round2(tenderedNumber - totalAmount) : 0;

  const canCharge =
    Boolean(branchId) &&
    Boolean(shift) &&
    cartLines.length > 0 &&
    (discountType !== 'pwd' && discountType !== 'senior_citizen' ? true : discountIdReference.trim().length > 0) &&
    (paymentMethod === 'cash' ? cashTendered !== '' && tenderedNumber >= totalAmount : gcashReferenceNumber.trim().length > 0 && gcashManuallyVerified);

  function resetPaymentFields() {
    setDiscountType('none');
    setDiscountIdReference('');
    setPromoAmount('');
    setCashTendered('');
    setGcashReferenceNumber('');
    setGcashManuallyVerified(false);
  }

  async function handleCharge() {
    if (!branchId || !shift) return;
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
      gcash_reference_number: paymentMethod === 'gcash' ? gcashReferenceNumber.trim() : undefined,
      gcash_manually_verified: paymentMethod === 'gcash' ? gcashManuallyVerified : undefined,
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

        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleProducts.map((product) =>
            product.variants.map((variant) => (
              <Card
                key={variant.id}
                className="flex h-full flex-col cursor-pointer touch-target transition hover:border-primary"
                onClick={() => handleProductTap(product, variant)}
              >
                <CardContent className="flex h-full flex-col gap-1 p-3">
                  {product.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.image_url} alt={product.name} className="mb-1 h-20 w-full rounded object-cover" />
                  ) : (
                    <div className="mb-1 h-20 w-full rounded bg-muted" />
                  )}
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-tight">{product.name}</p>
                  <p className="text-xs text-muted-foreground">{variant.name}</p>
                  <p className="mt-auto text-sm font-semibold tabular-nums">{formatPeso(variant.price)}</p>
                </CardContent>
              </Card>
            )),
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

          <Tabs value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'cash' | 'gcash')}>
            <TabsList className="w-full">
              <TabsTrigger value="cash" className="flex-1">
                Cash
              </TabsTrigger>
              <TabsTrigger value="gcash" className="flex-1">
                GCash
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {paymentMethod === 'cash' ? (
            <div className="space-y-1">
              <Input type="number" min={0} placeholder="Cash tendered" value={cashTendered} onChange={(e) => setCashTendered(e.target.value)} />
              <p className="text-xs text-muted-foreground">Change: {formatPeso(change)}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                placeholder="GCash reference number"
                value={gcashReferenceNumber}
                onChange={(e) => setGcashReferenceNumber(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={gcashManuallyVerified} onCheckedChange={(v) => setGcashManuallyVerified(v === true)} />
                I manually verified this GCash payment
              </label>
            </div>
          )}

          {chargeError && <p className="text-xs text-destructive">{chargeError}</p>}
          {!shift && (
            <div className="space-y-1.5">
              <p className="text-xs text-destructive">No active shift — open a shift before charging.</p>
              <Button variant="outline" size="sm" className="w-full" asChild>
                <Link href="/shift/open">Open Shift</Link>
              </Button>
            </div>
          )}

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
