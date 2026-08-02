'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Fingerprint, Loader2, LogOut, MapPin, User } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import type { CreateTransactionInput, PosCatalogProduct, TransactionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { SearchInput } from '@/components/shared/forms/search-input';
import { useAuth } from '@/hooks/use-auth';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { useCart } from '@/hooks/use-cart';
import type { PosCartSelectedOption } from '@/stores/cart.store';
import { useOffline } from '@/hooks/use-offline';
import { useCatalog, useCatalogRealtimeSync } from '@/hooks/queries/use-products';
import { useIsClockedIn, useClockIn, useClockOut } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useMyActiveShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useCreateTransaction, useUploadPaymentProof } from '@/hooks/queries/use-transactions';
import { cacheProductCatalog, getCachedProductCatalog } from '@/lib/offline/cache';
import { enqueueOfflineTransaction } from '@/lib/offline/sync-queue';
import { getCurrentPosition, type GpsCoords } from '@/lib/geolocation';
import { ReceiptModal } from '@/components/pos/receipt-modal';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

// Signed display for a price adjustment, e.g. "(+₱5.00)" or "(-₱5.00)" —
// formatPeso alone can't express the sign since toFixed already carries a
// leading "-" for negative amounts.
function formatAdjustment(amount: number): string {
  return amount >= 0 ? ` (+${formatPeso(amount)})` : ` (-${formatPeso(Math.abs(amount))})`;
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// Cashier-facing label for a Product Option Group — pos_button_label is the
// admin-configured override; falls back to the internal name when unset or
// blank. Never touches the internal name itself (admin/API/DB unaffected).
function resolveGroupLabel(group: { name: string; pos_button_label: string | null }): string {
  return group.pos_button_label?.trim() || group.name;
}

// Cashier-facing label for the "skip this optional group" choice, e.g.
// "No Fries Add-ons" for a group labeled "Fries Add-ons". Falls back to the
// generic "No Add-ons" when the resolved label already starts with
// "Add-ons"/"No " (would read awkwardly, e.g. "No Add-ons Add-ons") or is
// empty. UI text only — never touches selection/clear logic.
function resolveNoOptionLabel(group: { name: string; pos_button_label: string | null }): string {
  const label = resolveGroupLabel(group);
  if (!label || /^(add-?ons?|no)\b/i.test(label)) {
    return 'No Add-ons';
  }
  return `No ${label}`;
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
  const { user, selectEmployee } = useAuth();
  const branchId = user?.branchIds[0];
  const isBranchAccount = user?.role === ROLES.BRANCH;
  const { items, addItem, removeItem, updateItemQuantity, clearCart } = useCart();
  const { data: liveCatalog, isLoading: isCatalogLoading } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);
  const { isClockedIn, record: attendanceRecord, isLoading: isAttendanceLoading } = useIsClockedIn();
  // Informational only below (payment-proof storage path fallback) — never
  // gates the Charge button. The API resolves and auto-opens the cashier's
  // own active shift server-side via shiftGuard, so checkout is never
  // blocked on this client-side lookup being loaded or fresh.
  const { shift } = useMyActiveShift(branchId);
  useShiftsRealtimeSync();
  const { isOnline } = useOffline();
  const createTransaction = useCreateTransaction();
  const uploadPaymentProof = useUploadPaymentProof();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  // STATE 1 — "Who is working?" (Branch Employee Authorization). Only a
  // `branch` (Branch Account) session ever sees this: a `staff` login is
  // already bound to one Employee via its own JWT, same exemption
  // select-employee/page.tsx has always applied. Selecting an employee here
  // swaps the client session in place (selectEmployee -> setAuth) — no
  // navigation, no separate route — so the very next render already has
  // `user.role === 'staff'` and falls straight into STATE 2/3 below.
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectingEmployeeId, setSelectingEmployeeId] = useState<string | null>(null);
  const [selectEmployeeError, setSelectEmployeeError] = useState<string | null>(null);
  // Snapshot of the Branch Account session, captured right before handing
  // off to the selected Employee — restored on Clock Out so the panel goes
  // back to "Who is working?" instead of staying on this Employee's Clock In
  // card. Only ever set when the hand-off actually came from a Branch
  // Account; a genuine `staff` login has nothing to restore, so Clock Out
  // for it correctly leaves the cashier on their own Clock In card.
  const branchSessionRef = useRef<{ user: AuthUser; accessToken: string } | null>(null);
  const {
    data: employeesData,
    isLoading: isEmployeesLoading,
    isError: isEmployeesError,
    refetch: refetchEmployees,
  } = useEmployees(
    { role: ROLES.STAFF, isActive: true, search: employeeSearch || undefined, limit: 100 },
    { enabled: isBranchAccount },
  );

  async function handleSelectEmployee(employeeId: string) {
    if (selectingEmployeeId) return;
    const snapshot = useAuthStore.getState();
    setSelectingEmployeeId(employeeId);
    setSelectEmployeeError(null);
    try {
      await selectEmployee(employeeId);
      if (snapshot.user && snapshot.accessToken) {
        branchSessionRef.current = { user: snapshot.user, accessToken: snapshot.accessToken };
      }
    } catch (error) {
      setSelectEmployeeError(error instanceof Error ? error.message : 'Could not start employee session');
    } finally {
      setSelectingEmployeeId(null);
    }
  }

  const [cachedProducts, setCachedProducts] = useState<PosCatalogProduct[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [flavorPrompt, setFlavorPrompt] = useState<{ product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] } | null>(null);
  const [slotPrompt, setSlotPrompt] = useState<{
    product: PosCatalogProduct;
    variant: PosCatalogProduct['variants'][number];
    selections: Record<number, { snackProductVariantId: string; flavorId: string }>;
  } | null>(null);
  // CR-008 Product Option Groups (Task 21) — `groups` is pre-filtered to
  // groups that actually have at least one active option, so every group
  // rendered here is guaranteed non-empty.
  const [optionPrompt, setOptionPrompt] = useState<{
    product: PosCatalogProduct;
    variant: PosCatalogProduct['variants'][number];
    groups: PosCatalogProduct['variants'][number]['option_groups'];
    selections: Record<string, string[]>;
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

  // Single clean cashier workflow: Clock In -> Ready to Sell, both inside
  // this page. The shift itself is auto-managed (opened transparently on
  // clock-in — see attendanceService.clockIn / shiftGuard), so there is no
  // separate "open a shift" step and no redirect to another route — a
  // clocked-out cashier sees the Clock In card below instead of the catalog.
  async function handleClockIn() {
    if (!user || !branchId) return;
    setGpsError(null);
    setIsLocating(true);
    try {
      const coords: GpsCoords = await getCurrentPosition();
      await clockIn.mutateAsync({ employee_id: user.id, branch_id: branchId, gps_lat: coords.lat, gps_lng: coords.lng });
    } catch (error) {
      setGpsError(error instanceof Error ? error.message : 'Unable to read your location.');
    } finally {
      setIsLocating(false);
    }
  }

  async function handleClockOut() {
    if (!user || !branchId || createTransaction.isPending) return;
    setGpsError(null);
    setIsLocating(true);
    let coords: GpsCoords | null = null;
    try {
      coords = await getCurrentPosition();
    } catch {
      coords = null;
    }
    setIsLocating(false);
    await clockOut.mutateAsync({ employee_id: user.id, branch_id: branchId, ...(coords ? { gps_lat: coords.lat, gps_lng: coords.lng } : {}) });
    // Hand the panel back to the Branch Account that selected this Employee,
    // if that's how this session started — same page, no navigation, back
    // to STATE 1 ("Who is working?").
    if (branchSessionRef.current) {
      useAuthStore.getState().setAuth(branchSessionRef.current.user, branchSessionRef.current.accessToken);
      branchSessionRef.current = null;
    }
  }

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
    const groupsWithActiveOptions = variant.option_groups
      .map((group) => ({ ...group, options: group.options.filter((option) => option.is_active) }))
      .filter((group) => group.options.length > 0);
    if (groupsWithActiveOptions.length > 0) {
      setOptionPrompt({ product, variant, groups: groupsWithActiveOptions, selections: {} });
      return;
    }
    addItem({ product_id: product.id, product_variant_id: variant.id, quantity: 1 });
  }

  function handleOptionSelect(groupId: string, optionId: string, selectionType: 'SINGLE' | 'MULTIPLE', maxSelections: number | null) {
    setOptionPrompt((prev) => {
      if (!prev) return prev;
      const current = prev.selections[groupId] ?? [];
      if (selectionType === 'SINGLE') {
        return { ...prev, selections: { ...prev.selections, [groupId]: [optionId] } };
      }
      if (current.includes(optionId)) {
        return { ...prev, selections: { ...prev.selections, [groupId]: current.filter((id) => id !== optionId) } };
      }
      if (maxSelections !== null && current.length >= maxSelections) {
        return prev;
      }
      return { ...prev, selections: { ...prev.selections, [groupId]: [...current, optionId] } };
    });
  }

  function handleOptionClear(groupId: string) {
    setOptionPrompt((prev) => (prev ? { ...prev, selections: { ...prev.selections, [groupId]: [] } } : prev));
  }

  function optionGroupHelperText(minSelections: number, maxSelections: number | null): string {
    if (maxSelections !== null && minSelections === maxSelections) return `Choose exactly ${minSelections}`;
    if (maxSelections !== null && minSelections === 0) return `Choose up to ${maxSelections}`;
    if (maxSelections === null && minSelections > 0) return `Choose at least ${minSelections}`;
    if (maxSelections !== null && minSelections > 0) return `Choose between ${minSelections} and ${maxSelections}`;
    return 'Choose any number';
  }

  const optionPromptValid = optionPrompt
    ? optionPrompt.groups.every((group) => {
        const count = optionPrompt.selections[group.id]?.length ?? 0;
        return count >= group.min_selections && (group.max_selections === null || count <= group.max_selections);
      })
    : false;

  // This dialog always renders every applicable group together (no separate
  // per-group modal exists in this UI), so the title stays the
  // product/variant name in all cases — including the single-group case —
  // to avoid duplicating the resolved label already shown as that group's
  // section heading below.
  const optionPromptTitle = optionPrompt ? `${optionPrompt.product.name} (${optionPrompt.variant.name})` : '';

  function handleOptionAddToCart() {
    if (!optionPrompt || !optionPromptValid) return;
    const selected_options: PosCartSelectedOption[] = optionPrompt.groups.flatMap((group) =>
      (optionPrompt.selections[group.id] ?? []).map((optionId) => {
        const option = group.options.find((o) => o.id === optionId);
        return {
          option_group_id: group.id,
          option_group_name: resolveGroupLabel(group),
          option_id: optionId,
          option_name: option?.name ?? 'Unknown option',
          price_adjustment: option?.price_adjustment ?? 0,
        };
      }),
    );
    addItem({
      product_id: optionPrompt.product.id,
      product_variant_id: optionPrompt.variant.id,
      selected_options,
      quantity: 1,
    });
    setOptionPrompt(null);
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
        const optionSelections = item.selected_options ?? [];
        const optionsAdjustment = optionSelections.reduce((sum, o) => sum + o.price_adjustment, 0);
        const unitPrice =
          slotSelections.length > 0
            ? (info?.variant.price ?? 0) + slotSelections.reduce((sum, s) => sum + s.pricePremium, 0) + optionsAdjustment
            : (info?.variant.price ?? 0) + (flavor?.price_premium ?? 0) + optionsAdjustment;
        return {
          index,
          item,
          productName: info?.product.name ?? 'Unknown item',
          variantName: info?.variant.name ?? '',
          flavorName: flavor?.name ?? null,
          slotSelections,
          optionSelections,
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

  // Single clear reason shown above the Charge button — checkout only ever
  // needs an authenticated cashier, active branch, clocked-in attendance, a
  // valid cart, and valid payment details (no shift/shift-ownership check:
  // the API auto-manages the shift server-side). Checked in the order a
  // cashier would naturally fix them.
  const chargeDisabledReason: string | null = (() => {
    if (createTransaction.isPending) return 'Checkout is already processing.';
    if (!isClockedIn) return 'Clock in before completing a sale.';
    if (cartLines.length === 0) return 'Add items to the cart to start a sale.';
    if ((discountType === 'pwd' || discountType === 'senior_citizen') && discountIdReference.trim().length === 0) {
      return 'Enter the PWD/Senior Citizen ID number.';
    }
    if (paymentMethod === 'cash') {
      if (cashTendered === '') return 'Enter cash tendered.';
      if (tenderedNumber < totalAmount) return `Cash tendered is ${formatPeso(round2(totalAmount - tenderedNumber))} short.`;
    } else if (paymentMethod === 'other') {
      if (otherReferenceNote.trim().length === 0) return 'Enter a payment reference or note.';
    } else {
      if (gcashReferenceNumber.trim().length === 0) return 'Enter the reference number.';
      if (!paymentProofKey) return 'Upload payment proof before continuing.';
      if (!gcashManuallyVerified) return 'Confirm you manually verified the payment.';
    }
    return null;
  })();

  const canCharge = Boolean(branchId) && chargeDisabledReason === null;

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
    if (!branchId || createTransaction.isPending) return;
    setChargeError(null);

    const payload: CreateTransactionInput = {
      branch_id: branchId,
      // Optional — the API resolves/auto-opens the cashier's own active
      // shift server-side (shiftGuard) and trusts that over this value.
      shift_id: shift?.id,
      // selected_options display metadata (names, price_adjustment) is
      // frontend-only and never sent as trusted backend fields (Task 21) —
      // only option_id is forwarded, as selected_option_ids (Task 26).
      items: items.map((item) => ({
        product_id: item.product_id,
        product_variant_id: item.product_variant_id,
        flavor_id: item.flavor_id,
        selected_flavors: item.selected_flavors,
        ...(item.selected_options?.length
          ? { selected_option_ids: item.selected_options.map((option) => option.option_id) }
          : {}),
        quantity: item.quantity,
      })),
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

  // STATE 1 — no Employee selected yet. Branch Employee Authorization:
  // rendered right here instead of a separate /branch/select-employee route,
  // so the Branch shell (sidebar/header) never unmounts and there is no
  // in-between page to flash through.
  if (isBranchAccount) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 overflow-y-auto p-6">
        <div>
          <h1 className="text-2xl font-bold">Who&apos;s working?</h1>
          <p className="text-sm text-muted-foreground">Select the employee operating the POS Terminal right now.</p>
        </div>

        <SearchInput value={employeeSearch} onChange={setEmployeeSearch} placeholder="Search by name..." />

        {selectEmployeeError && (
          <Alert variant="destructive">
            <AlertTitle>Could not start employee session</AlertTitle>
            <AlertDescription>{selectEmployeeError}</AlertDescription>
          </Alert>
        )}

        {isEmployeesLoading ? (
          <div className="flex justify-center py-16">
            <LoadingSpinner size="lg" />
          </div>
        ) : isEmployeesError ? (
          <ErrorState title="Failed to load employees" retry={() => void refetchEmployees()} />
        ) : (employeesData?.employees.length ?? 0) === 0 ? (
          <EmptyState
            icon={User}
            title="No active employees"
            description="No active employees are assigned to this branch yet. Create one from the Employees section."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {employeesData?.employees.map((employee) => (
              <Card
                key={employee.id}
                className="touch-target min-h-[120px] cursor-pointer transition-colors hover:border-primary"
                onClick={() => selectingEmployeeId === null && void handleSelectEmployee(employee.id)}
              >
                <CardContent className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                  {selectingEmployeeId === employee.id ? (
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  ) : (
                    <User className="h-8 w-8 text-muted-foreground" />
                  )}
                  <span className="text-lg font-medium">
                    {employee.first_name} {employee.last_name}
                  </span>
                  {employee.position && <span className="text-sm text-muted-foreground">{employee.position}</span>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isAttendanceLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Not clocked in — POS owns the whole cashier workflow, so Clock In
  // happens right here instead of a separate page/redirect. The product
  // grid and cart never render until this succeeds.
  if (!isClockedIn) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardContent className="space-y-4 p-6 text-center">
            <Fingerprint className="mx-auto h-10 w-10 text-primary" />
            <div>
              <p className="text-lg font-semibold">Clock In to Start Selling</p>
              <p className="text-sm text-muted-foreground">You need to clock in before you can use the POS Terminal.</p>
            </div>
            {gpsError && (
              <Alert variant="destructive">
                <MapPin className="h-4 w-4" />
                <AlertTitle>Location error</AlertTitle>
                <AlertDescription>{gpsError}</AlertDescription>
              </Alert>
            )}
            <Button className="w-full touch-target" size="lg" onClick={() => void handleClockIn()} disabled={isLocating || clockIn.isPending}>
              {(isLocating || clockIn.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Clock In
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!isOnline && (
        <div className="bg-warning px-4 py-1 text-center text-xs font-medium text-warning-foreground">
          Offline — sales will be queued and synced automatically once you reconnect.
        </div>
      )}

      {/* Cashier attendance strip — Clock In happens above (the whole selling UI is hidden until then); this is Clock Out only. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="active">Clocked In</Badge>
          <span className="font-medium">{user ? `${user.firstName} ${user.lastName}`.trim() || user.email : ''}</span>
          {attendanceRecord && (
            <span className="text-xs text-muted-foreground">
              since {new Date(attendanceRecord.clock_in_server_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="touch-target gap-1.5"
          onClick={() => void handleClockOut()}
          disabled={isLocating || clockOut.isPending || createTransaction.isPending}
        >
          {isLocating || clockOut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
          Clock Out
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
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

        <div className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
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
                      <img src={product.image_url} alt={product.name} className="mb-1 aspect-[4/3] w-full rounded object-cover" />
                    ) : (
                      <div className="mb-1 aspect-[4/3] w-full rounded bg-muted" />
                    )}
                    <p className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-tight">{product.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{variant.name}</p>
                    <p className="mt-auto text-sm font-semibold tabular-nums">{formatPeso(variant.price)}</p>
                    {message && <p className="line-clamp-2 text-[11px] font-medium text-destructive">{message}</p>}
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

        <Dialog open={optionPrompt !== null} onOpenChange={(open) => !open && setOptionPrompt(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{optionPromptTitle}</DialogTitle>
            </DialogHeader>
            {optionPrompt && (
              <div className="space-y-4">
                {optionPrompt.groups.map((group, groupIndex) => {
                  const selected = optionPrompt.selections[group.id] ?? [];
                  const atMax = group.max_selections !== null && selected.length >= group.max_selections;
                  return (
                    <div key={group.id} className="space-y-2">
                      {groupIndex > 0 && <Separator />}
                      <p className="text-sm font-medium">
                        {resolveGroupLabel(group)}
                        {group.required && <span className="text-destructive"> *</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{optionGroupHelperText(group.min_selections, group.max_selections)}</p>
                      {group.selection_type === 'SINGLE' ? (
                        <RadioGroup
                          value={selected[0] ?? ''}
                          onValueChange={(value) =>
                            value === '__none__'
                              ? handleOptionClear(group.id)
                              : handleOptionSelect(group.id, value, 'SINGLE', group.max_selections)
                          }
                        >
                          {group.min_selections === 0 && (
                            <label className="flex items-center gap-2 text-sm">
                              <RadioGroupItem value="__none__" />
                              {resolveNoOptionLabel(group)}
                            </label>
                          )}
                          {group.options.map((option) => (
                            <label key={option.id} className="flex items-center gap-2 text-sm">
                              <RadioGroupItem value={option.id} />
                              {option.name}
                              {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                            </label>
                          ))}
                        </RadioGroup>
                      ) : (
                        <div className="space-y-1">
                          {group.options.map((option) => {
                            const isChecked = selected.includes(option.id);
                            return (
                              <label
                                key={option.id}
                                className={`flex items-center gap-2 text-sm ${!isChecked && atMax ? 'opacity-50' : ''}`}
                              >
                                <Checkbox
                                  checked={isChecked}
                                  disabled={!isChecked && atMax}
                                  onCheckedChange={() => handleOptionSelect(group.id, option.id, 'MULTIPLE', group.max_selections)}
                                />
                                {option.name}
                                {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOptionPrompt(null)}>
                Cancel
              </Button>
              <Button disabled={!optionPromptValid} onClick={handleOptionAddToCart}>
                Add to Cart
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* RIGHT PANEL — cart + payment */}
      <div className="flex w-1/3 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-3">
          {cartLines.length === 0 && <p className="text-sm text-muted-foreground">Cart is empty — tap a product to add it.</p>}
          <div className="space-y-3">
            {cartLines.map((line) => (
              <div key={line.index} className="space-y-1.5 border-b pb-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 min-w-0 flex-1 font-medium leading-snug">
                    {line.productName}
                    {line.flavorName ? ` — ${line.flavorName}` : ''}
                  </p>
                  <Button
                    variant="ghost"
                    className="touch-target h-7 w-7 shrink-0 p-0 text-destructive"
                    onClick={() => removeItem(line.index)}
                    aria-label={`Remove ${line.productName} from cart`}
                  >
                    ×
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {line.variantName} · {formatPeso(line.unitPrice)} each
                </p>
                {line.slotSelections.map((sel, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {sel.label}: {sel.snackName} — {sel.flavorName}
                  </p>
                ))}
                {line.optionSelections.map((opt) => (
                  <p key={opt.option_id} className="text-xs text-muted-foreground">
                    {opt.option_group_name}: {opt.option_name}
                    {opt.price_adjustment !== 0 ? formatAdjustment(opt.price_adjustment) : ''}
                  </p>
                ))}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" className="touch-target h-7 w-7 p-0" onClick={() => updateItemQuantity(line.index, line.item.quantity - 1)}>
                      −
                    </Button>
                    <span className="w-6 text-center tabular-nums">{line.item.quantity}</span>
                    <Button variant="outline" className="touch-target h-7 w-7 p-0" onClick={() => updateItemQuantity(line.index, line.item.quantity + 1)}>
                      +
                    </Button>
                  </div>
                  <p className="text-right font-semibold tabular-nums">{formatPeso(line.lineTotal)}</p>
                </div>
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
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>VAT (12%)</span>
              <span className="tabular-nums">{formatPeso(vatAmount)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-destructive">
                <span>Discount</span>
                <span className="tabular-nums">-{formatPeso(discountAmount)}</span>
              </div>
            )}
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
                    if (!branchId) return;
                    void uploadPaymentProof
                      .mutateAsync({ branchId, shiftId: shift?.id, type, file })
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

          {chargeDisabledReason && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium text-foreground">{chargeDisabledReason}</p>
          )}

          <Button
            variant="pos"
            className="touch-target w-full"
            size="lg"
            disabled={!canCharge}
            onClick={() => void handleCharge()}
          >
            {createTransaction.isPending ? 'Processing sale…' : `Charge ${formatPeso(totalAmount)}`}
          </Button>
        </div>
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
