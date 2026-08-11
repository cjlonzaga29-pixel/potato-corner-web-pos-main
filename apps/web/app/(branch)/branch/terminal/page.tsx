'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDensityMode, type DensityMode } from '@/hooks/use-density-mode';
import { DENSITY_POS_GRID_COLUMNS } from '@/lib/density-tokens';
import { shouldShowInlineCart } from '@/lib/pos/cart-layout';
import { Fingerprint, Loader2, LogOut, MapPin, ShoppingCart, User } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import type { CreateTransactionInput, ImageProofType, PosCatalogProduct, TransactionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { AddOnsDialog, multiGroupTarget, type AddOnsDialogGroup, type AddOnSelections } from '@/components/pos/add-ons-dialog';
import { ProductCard } from '@/components/pos/product-card';
import { CartLineItem, type CartLine } from '@/components/pos/cart-line-item';
import type { DiscountChoice } from '@/components/pos/payment-footer';
import { CheckoutWorkspace } from '@/components/pos/checkout-workspace';
import { splitAddOnLines, isAddOnsGroup, NO_ADD_ON_KEY, type AddOnAssignments } from '@/lib/pos/split-add-ons';
import type { PosCartSelectedOption } from '@/stores/cart.store';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { SearchInput } from '@/components/shared/forms/search-input';
import { useAuth } from '@/hooks/use-auth';
import { useCart } from '@/hooks/use-cart';
import { useOffline } from '@/hooks/use-offline';
import { useCatalog, useCatalogRealtimeSync } from '@/hooks/queries/use-products';
import { useClockIn, useClockOut } from '@/hooks/queries/use-attendance';
import { useTerminalOperator } from '@/hooks/use-terminal-operator';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useMyActiveShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useCreateTransaction, useUploadPaymentProof, useUploadDiscountProof } from '@/hooks/queries/use-transactions';
import { cacheProductCatalog, getCachedProductCatalog } from '@/lib/offline/cache';
import { enqueueOfflineTransaction } from '@/lib/offline/sync-queue';
import { getCurrentPosition, type GpsCoords } from '@/lib/geolocation';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { VoidRefundSaleDialog } from '@/components/pos/void-refund-sale-dialog';

// Task 140 — the same allowed-roles set ViewTransactionDetailDialog itself
// gates Void/Refund actions on (view-transaction-detail-dialog.tsx); kept
// here only to decide whether the POS entry point is worth showing at all.
const VOID_REFUND_ENTRY_ROLES: readonly string[] = [ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.BRANCH];

// Task 200 (adaptive density engine) — the inline-cart-vs-Sheet split used to
// be a single raw `useIsDesktop('(min-width: 1024px)')` width check. It's
// now `shouldShowInlineCart(densityMode, hasRoomForInlinePanel)` (see
// lib/pos/cart-layout.ts): mobile always gets the Sheet, comfortable/
// standard/compact always get the inline panel, and compact-touch (touch
// input, but width varies a lot — a touch laptop vs. a tablet) falls back to
// this same >=1024px width check to decide whether there's room for the
// panel. Kept as its own tiny matchMedia hook (not merged into
// useDensityMode) because "is there room for a second panel" is a layout
// concern specific to this one page, not part of the shared density
// classification every other surface reads.
//
// Same defaulting pattern as before (and as useDensityMode itself): starts
// `true` (matches server render and every test environment, since jsdom has
// no matchMedia) and only ever flips based on a real matchMedia result, so
// no existing test needs to simulate opening a drawer to reach the cart —
// they keep seeing the same inline panel as before.
//
// Task 209.29 (Part F) — the query used to be width-only, so a coarse-
// pointer (compact-touch) tablet in landscape at, say, 1024x500 (a
// constrained/split-screen tablet) was classified as "has room" purely on
// width and got the full two-pane Checkout Workspace squeezed into a short
// viewport. `min-height` is added so 2-pane is only ever chosen when BOTH
// dimensions actually have room — a genuinely short landscape tablet now
// falls back to the same stepped checkout phones/portrait tablets already
// get. 640px is comfortably below common tablet landscape heights (a 1024x768
// iPad landscape, 1280x800 Android tablets) while still catching real
// constrained/split-screen cases.
function useHasRoomForInlineCart(query = '(min-width: 1024px) and (min-height: 640px)'): boolean {
  const [hasRoom, setHasRoom] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    setHasRoom(mql.matches);
    const listener = (event: MediaQueryListEvent) => setHasRoom(event.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query is effectively static per call site
  }, []);

  return hasRoom;
}

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

// Task 200 (adaptive density engine) — single source of truth for the
// product grid's column count, shared by the real grid and the
// loading-skeleton grid so they can never drift out of sync. Used to be a
// hardcoded Tailwind breakpoint string (`md:grid-cols-3 lg:grid-cols-3
// xl:grid-cols-4 2xl:grid-cols-5`) keyed only on width; now keyed on the
// full density classification via DENSITY_POS_GRID_COLUMNS (comfortable/
// standard/compact: 5, compact-touch: 3, mobile: 2 — Task 209.8 raised
// standard/compact from 4 to 5 for a denser catalog at the 1366x768 priority
// viewport), which also accounts for pointer/touch capability, not just
// viewport width. `pb-24`/`lg:pb-4`
// leaves room for the mobile sticky "View Cart" bar, which overlaps the
// bottom of this scroll region below `lg`.
function productGridClasses(densityMode: DensityMode): string {
  return `grid content-start gap-1.5 p-3 pb-24 lg:gap-2 lg:p-4 lg:pb-4 ${DENSITY_POS_GRID_COLUMNS[densityMode]}`;
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

// Task 107 — only groups with at least one active option are cashier-facing;
// a group left with zero active options is invisible at the POS. Pure
// function of `variant` alone (module scope, not a component method) so it
// stays referentially irrelevant to any memoized child's props — nothing
// here reads component state/props via closure.
function activeOptionGroups(variant: PosCatalogProduct['variants'][number]) {
  return variant.option_groups
    .map((group) => ({ ...group, options: group.options.filter((option) => option.is_active) }))
    .filter((group) => group.options.length > 0);
}

// Task 131 — groups the Add-ons dialog for a variant: groups matching the
// Add-ons naming rule (isAddOnsGroup) render as the simplified optional
// multi-select; every other group keeps the original per-choice quantity
// allocator (label/allowNoAddOn computed exactly as before).
// Task 182 — selectionType/required/minSelections/maxSelections passed
// through so the dialog can render a required SINGLE-selection group
// (e.g. Flavor) as checkbox-style single-select instead of an allocator.
function dialogGroupsFor(variant: PosCatalogProduct['variants'][number]): AddOnsDialogGroup[] {
  return activeOptionGroups(variant).map((group) => ({
    id: group.id,
    name: resolveGroupLabel(group),
    label: resolveGroupLabel(group),
    allowNoAddOn: group.min_selections === 0,
    simplified: isAddOnsGroup(group),
    selectionType: group.selection_type,
    required: group.required,
    minSelections: group.min_selections,
    maxSelections: group.max_selections,
    options: group.options.map((option) => ({ id: option.id, name: option.name, price_adjustment: option.price_adjustment })),
  }));
}

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
  const { user, selectEmployee, isLoading: isAuthLoading } = useAuth();
  const branchId = user?.branchIds[0];
  const isBranchAccount = user?.role === ROLES.BRANCH;
  // Task 140 — the authenticated account's own role, never the selected
  // Employee's (a Branch Account picking a Staff employee to run the
  // terminal must still see this; a genuine `staff` login must not).
  const canManageVoidRefund = user?.role !== undefined && VOID_REFUND_ENTRY_ROLES.includes(user.role);

  // STATE 1 — "Who is working?" (Branch Employee Authorization). Only a
  // `branch` (Branch Account) session ever sees this: a `staff` login is
  // already bound to one Employee via its own JWT. Task 120: selecting an
  // employee here sets ONLY this terminal-local state — it never touches
  // the global auth store, so the authenticated user (sidebar, header,
  // every other /branch page) stays the Branch Account for the whole
  // session. activeEmployeeToken is the Employee-scoped access token the
  // backend still issues (same /api/auth/select-employee call as before) —
  // held here, never written to useAuthStore, and passed as an explicit
  // override only on the specific calls below that must be attributed to
  // this Employee (clock-in/out, checkout, payment-proof upload), because
  // the API derives cashier/attendance attribution from the request's
  // bearer token server-side.
  //
  // Task 209.27 — this local state is still wiped on every remount (route
  // navigation unmounts this page), which used to force "Who's working?"
  // back up even for a still-clocked-in Employee. useTerminalOperator below
  // restores it from a branch-scoped sessionStorage hint, but only once
  // it has re-validated that Employee against live attendance.
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectingEmployeeId, setSelectingEmployeeId] = useState<string | null>(null);
  const [selectEmployeeError, setSelectEmployeeError] = useState<string | null>(null);
  const [activeEmployee, setActiveEmployee] = useState<{ id: string; firstName: string; lastName: string; role: string } | null>(null);
  const [activeEmployeeToken, setActiveEmployeeToken] = useState<string | null>(null);

  const {
    operatorId,
    isClockedIn,
    record: attendanceRecord,
    isAttendanceLoading,
    isRestoringOperator,
    clearTerminalOperator,
  } = useTerminalOperator({
    isBranchAccount,
    branchId,
    userId: user?.id,
    activeEmployee,
    activeEmployeeToken,
    setActiveEmployee,
    setActiveEmployeeToken,
  });
  const operatorToken = isBranchAccount ? (activeEmployeeToken ?? undefined) : undefined;
  const operatorName = isBranchAccount && activeEmployee ? `${activeEmployee.firstName} ${activeEmployee.lastName}`.trim() : `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || user?.email;

  const { items, addItem, removeItem, updateItemQuantity, replaceItem, clearCart } = useCart();
  const {
    data: liveCatalog,
    isLoading: isCatalogLoading,
    isError: isCatalogError,
    refetch: refetchCatalog,
  } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);
  // Informational only below (payment-proof storage path fallback) — never
  // gates the Charge button. The API resolves and auto-opens the cashier's
  // own active shift server-side via shiftGuard, so checkout is never
  // blocked on this client-side lookup being loaded or fresh.
  const { shift } = useMyActiveShift(branchId);
  useShiftsRealtimeSync();
  const { isOnline } = useOffline();
  const createTransaction = useCreateTransaction(operatorToken);
  const uploadPaymentProof = useUploadPaymentProof(operatorToken);
  const uploadDiscountProof = useUploadDiscountProof(operatorToken);
  const clockIn = useClockIn(operatorToken);
  const clockOut = useClockOut(operatorToken);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  const {
    data: employeesData,
    isLoading: isEmployeesLoading,
    isError: isEmployeesError,
    refetch: refetchEmployees,
  } = useEmployees(
    { role: ROLES.STAFF, isActive: true, search: employeeSearch || undefined, limit: 100 },
    { enabled: isBranchAccount && !activeEmployee && !isRestoringOperator },
  );

  async function handleSelectEmployee(employeeId: string) {
    if (selectingEmployeeId) return;
    setSelectingEmployeeId(employeeId);
    setSelectEmployeeError(null);
    try {
      const selected = await selectEmployee(employeeId);
      setActiveEmployee({ id: selected.user.id, firstName: selected.user.firstName, lastName: selected.user.lastName, role: selected.user.role });
      setActiveEmployeeToken(selected.accessToken);
    } catch (error) {
      setSelectEmployeeError(error instanceof Error ? error.message : 'Could not start employee session');
    } finally {
      setSelectingEmployeeId(null);
    }
  }

  const [cachedProducts, setCachedProducts] = useState<PosCatalogProduct[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  // Task 196 (visual redesign) — cashier-facing product search, purely a
  // client-side display filter layered on top of the existing category
  // filter below; never touches catalog fetching, ordering, or category
  // derivation logic.
  const [productSearch, setProductSearch] = useState('');
  // Task 200 (adaptive density engine) — the app-wide density classification
  // (see hooks/use-density-mode.ts), used here to pick the product grid's
  // column count and, combined with useHasRoomForInlineCart below, whether
  // the cart renders inline or in a Sheet.
  const densityMode = useDensityMode();
  // Task 196 (visual redesign) — mobile cart access: a sticky "View Cart"
  // bar opens this Sheet instead of the inline desktop panel. See
  // useHasRoomForInlineCart above for why this never changes existing test
  // behavior.
  const hasRoomForInlineCart = useHasRoomForInlineCart();
  const isDesktop = shouldShowInlineCart(densityMode, hasRoomForInlineCart);
  const [isCartSheetOpen, setIsCartSheetOpen] = useState(false);
  // Task 209.25 — the dedicated Checkout Workspace (checkout-workspace.tsx)
  // that now owns payment method/discount/proof/Cash Tendered/Charge; the
  // permanent cart panel and mobile cart Sheet only ever show cart lines +
  // a compact subtotal + this Checkout button. Opening it never creates a
  // transaction, clears the cart, or touches any payment/discount/proof
  // state — all of that still lives below, unchanged, and is only ever
  // submitted by the workspace's own Charge/Confirm control.
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [flavorPrompt, setFlavorPrompt] = useState<{ product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] } | null>(null);
  const [slotPrompt, setSlotPrompt] = useState<{
    product: PosCatalogProduct;
    variant: PosCatalogProduct['variants'][number];
    selections: Record<number, { snackProductVariantId: string; flavorId: string }>;
  } | null>(null);
  // Task 107 — add-ons are chosen BEFORE the item reaches the cart. Legacy
  // (non-Add-ons) Product Option Groups still get a per-choice quantity that
  // must sum to the product quantity, splitting into one cart line per
  // distinct combination on confirm (lib/pos/split-add-ons.ts).
  // Task 131 — groups matching the Add-ons naming rule (isAddOnsGroup)
  // instead use `selectedOptionIds`: a plain optional multi-select with no
  // quantity allocation, applied once per unit regardless of how many
  // legacy-group lines the product quantity gets split into.
  // Task 108 — the same dialog reopens, preloaded, to edit an existing cart
  // line's add-ons/quantity; editingIndex marks that case (vs. undefined for
  // the pre-add "create" flow) so confirm knows to replace instead of add.
  const [addOnsPrompt, setAddOnsPrompt] = useState<{
    product: PosCatalogProduct;
    variant: PosCatalogProduct['variants'][number];
    flavorId?: string;
    selectedFlavors?: { slot_index: number; snack_product_variant_id: string; flavor_id: string }[];
    quantity: number;
    assignments: AddOnAssignments;
    selectedOptionIds: AddOnSelections;
    editingIndex?: number;
  } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'gcash' | 'maya' | 'other'>('cash');
  const [discountType, setDiscountType] = useState<DiscountChoice>('none');
  const [discountIdReference, setDiscountIdReference] = useState('');
  const [promoAmount, setPromoAmount] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  // GCash, Maya, and Other all require the same thing: a photo of the
  // payment proof — no reference number/note collected (Task 139).
  const [paymentProofKey, setPaymentProofKey] = useState<string | null>(null);
  const [paymentProofType, setPaymentProofType] = useState<'live_capture' | 'gallery_upload' | null>(null);
  // Task 209.20 — a local, revocable object URL for the just-captured file,
  // kept alive only so the collapsed "attached" summary in PaymentFooter can
  // offer a "View" button without a network round-trip. Never sent anywhere
  // and never the source of truth for the actual proof (paymentProofKey is);
  // this is display-only and lost on refresh, same as ImageUpload's own
  // preview was before it unmounted.
  const [paymentProofPreviewUrl, setPaymentProofPreviewUrl] = useState<string | null>(null);
  // Task 209.5 — PWD/Senior Citizen discount compliance evidence. Optional:
  // no proof-required policy exists yet (DISCOUNT_PROOF_REQUIREMENT_POLICY_MISSING),
  // so this never blocks Charge the way paymentProofKey does above.
  const [discountProofKey, setDiscountProofKey] = useState<string | null>(null);
  const [discountProofType, setDiscountProofType] = useState<'live_capture' | 'gallery_upload' | null>(null);
  const [discountProofPreviewUrl, setDiscountProofPreviewUrl] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TransactionResponse | null>(null);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [isVoidRefundOpen, setIsVoidRefundOpen] = useState(false);

  // GCash/Maya/Other proof capture requires a live connection (see
  // createTransactionSchema's offline-must-be-cash rule) — there's no
  // offline blob queue for it (see lib/offline/db.ts), so a cashier can't
  // start or continue a non-cash sale while offline. Revert to cash
  // immediately if the connection drops mid-selection.
  useEffect(() => {
    if (!isOnline && paymentMethod !== 'cash') {
      setPaymentMethod('cash');
    }
  }, [isOnline, paymentMethod]);

  // Task 209.20 — the two proof preview object URLs above are display-only
  // and never revoked by React itself; every setter above already revokes
  // its *previous* URL on the next capture/clear, but the *last* one set
  // before an unmount (e.g. navigating away mid-sale) is never freed
  // otherwise. Refs (not the state values themselves) so this effect's
  // cleanup — which only runs once, on unmount — always reads the latest
  // URL rather than the one from whichever render registered it.
  const paymentProofPreviewUrlRef = useRef(paymentProofPreviewUrl);
  paymentProofPreviewUrlRef.current = paymentProofPreviewUrl;
  const discountProofPreviewUrlRef = useRef(discountProofPreviewUrl);
  discountProofPreviewUrlRef.current = discountProofPreviewUrl;
  useEffect(() => {
    return () => {
      if (paymentProofPreviewUrlRef.current) URL.revokeObjectURL(paymentProofPreviewUrlRef.current);
      if (discountProofPreviewUrlRef.current) URL.revokeObjectURL(discountProofPreviewUrlRef.current);
    };
  }, []);

  // Single clean cashier workflow: Clock In -> Ready to Sell, both inside
  // this page. The shift itself is auto-managed (opened transparently on
  // clock-in — see attendanceService.clockIn / shiftGuard), so there is no
  // separate "open a shift" step and no redirect to another route — a
  // clocked-out cashier sees the Clock In card below instead of the catalog.
  async function handleClockIn() {
    if (!operatorId || !branchId) return;
    setGpsError(null);
    setIsLocating(true);
    try {
      const coords: GpsCoords = await getCurrentPosition();
      await clockIn.mutateAsync({ employee_id: operatorId, branch_id: branchId, gps_lat: coords.lat, gps_lng: coords.lng });
    } catch (error) {
      setGpsError(error instanceof Error ? error.message : 'Unable to read your location.');
    } finally {
      setIsLocating(false);
    }
  }

  async function handleClockOut() {
    if (!operatorId || !branchId || createTransaction.isPending) return;
    setGpsError(null);
    setIsLocating(true);
    let coords: GpsCoords | null = null;
    try {
      coords = await getCurrentPosition();
    } catch {
      coords = null;
    }
    setIsLocating(false);
    await clockOut.mutateAsync({ employee_id: operatorId, branch_id: branchId, ...(coords ? { gps_lat: coords.lat, gps_lng: coords.lng } : {}) });
    // The Branch Account was never signed out of — just drop the selected
    // Employee's terminal-local state, back to STATE 1 ("Who is working?").
    // A genuine `staff` login has no activeEmployee to clear here; it has
    // nowhere else to go on Clock Out (same as before this task).
    if (isBranchAccount) {
      setActiveEmployee(null);
      setActiveEmployeeToken(null);
      clearTerminalOperator();
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
  // Task 196 (visual redesign) — category filter unchanged; a search term
  // (product or variant name, case-insensitive) narrows the same list
  // further. Display-only: never touches `catalog`, ordering, or what's
  // sent anywhere.
  const visibleProducts = useMemo(() => {
    const byCategory = activeCategory === 'all' ? catalog : catalog.filter((p) => p.category === activeCategory);
    const term = productSearch.trim().toLowerCase();
    if (!term) return byCategory;
    return byCategory.filter(
      (p) => p.name.toLowerCase().includes(term) || p.variants.some((v) => v.name.toLowerCase().includes(term)),
    );
  }, [catalog, activeCategory, productSearch]);

  const variantIndex = useMemo(() => {
    const map = new Map<string, { product: PosCatalogProduct; variant: PosCatalogProduct['variants'][number] }>();
    for (const product of catalog) {
      for (const variant of product.variants) map.set(variant.id, { product, variant });
    }
    return map;
  }, [catalog]);

  // Opens the Add-ons dialog for a product about to be added to the cart —
  // called only after any flavor/slot choice is already resolved. Returns
  // true when the dialog was opened (caller must not addItem directly).
  // useCallback'd (empty deps — every dependency below is itself a stable
  // setState setter) so it stays a stable prop wherever it's forwarded,
  // most notably into handleProductTap below and ultimately ProductCard's
  // memoized onTap.
  const maybeOpenAddOnsPrompt = useCallback(
    (
      product: PosCatalogProduct,
      variant: PosCatalogProduct['variants'][number],
      extra: { flavorId?: string; selectedFlavors?: { slot_index: number; snack_product_variant_id: string; flavor_id: string }[] },
    ): boolean => {
      const groups = activeOptionGroups(variant);
      if (groups.length === 0) return false;
      setAddOnsPrompt({ product, variant, ...extra, quantity: 1, assignments: {}, selectedOptionIds: {} });
      return true;
    },
    [],
  );

  // Task 194A — useCallback'd so ProductCard (React.memo) can treat onTap as
  // a stable prop: every dependency here (maybeOpenAddOnsPrompt, addItem,
  // the setState setters) is itself stable, so this never changes identity
  // across renders, including ones triggered by unrelated state like
  // Cash Tendered or an in-progress cart edit.
  const handleProductTap = useCallback(
    (product: PosCatalogProduct, variant: PosCatalogProduct['variants'][number]) => {
      if (!variant.live_ready) return;
      if (variant.flavor_slots.length > 0) {
        setSlotPrompt({ product, variant, selections: {} });
        return;
      }
      if (variant.flavors.length > 0) {
        setFlavorPrompt({ product, variant });
        return;
      }
      if (maybeOpenAddOnsPrompt(product, variant, {})) return;
      addItem({ product_id: product.id, product_variant_id: variant.id, quantity: 1 });
    },
    [maybeOpenAddOnsPrompt, addItem],
  );

  function handleAddOnsAssignmentChange(groupId: string, choiceKey: string, quantity: number) {
    setAddOnsPrompt((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        assignments: { ...prev.assignments, [groupId]: { ...prev.assignments[groupId], [choiceKey]: quantity } },
      };
    });
  }

  // Task 131 — toggles one option within a simplified Add-ons group's
  // selection; selecting any option implicitly clears "No Add-ons" (an empty
  // array), never a separate flag to keep in sync.
  function handleToggleAddOnOption(groupId: string, optionId: string) {
    setAddOnsPrompt((prev) => {
      if (!prev) return prev;
      const current = prev.selectedOptionIds[groupId] ?? [];
      const next = current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId];
      return { ...prev, selectedOptionIds: { ...prev.selectedOptionIds, [groupId]: next } };
    });
  }

  // Task 131 — "No Add-ons" for a simplified group always clears that
  // group's selection outright (not a toggle) — the cashier must never be
  // blocked from selling the product without an add-on.
  function handleClearAddOnGroup(groupId: string) {
    setAddOnsPrompt((prev) => (prev ? { ...prev, selectedOptionIds: { ...prev.selectedOptionIds, [groupId]: [] } } : prev));
  }

  // Task 182 — a required SINGLE-selection group (e.g. Flavor) behaves like
  // a radio group: picking an option replaces whatever was selected before,
  // never adds to it.
  function handleSelectSingleOption(groupId: string, optionId: string) {
    setAddOnsPrompt((prev) => (prev ? { ...prev, selectedOptionIds: { ...prev.selectedOptionIds, [groupId]: [optionId] } } : prev));
  }

  // Splits the product quantity into independent cart lines — one per
  // distinct combination of legacy-group add-on choices
  // (lib/pos/split-add-ons.ts). Never creates a single line carrying
  // per-option quantities.
  //
  // Task 131 — simplified (Add-ons) group selections are chosen once for the
  // whole prompt, not per unit: they're appended onto every resulting line
  // untouched by legacy splitting, so each selected add-on's price/deduction
  // scales with that line's own quantity exactly like any other option.
  //
  // Task 108 — in edit mode (editingIndex set) this replaces that one cart
  // line with the freshly-split line(s) instead of appending new lines; the
  // store's replaceItem then folds in any resulting duplicate against
  // another existing line using the same identity rules addItem uses.
  function handleAddOnsConfirm() {
    if (!addOnsPrompt) return;
    const { product, variant, flavorId, selectedFlavors, quantity, assignments, selectedOptionIds, editingIndex } = addOnsPrompt;
    const groups = dialogGroupsFor(variant);
    // Task 182 — only MULTIPLE-selection groups still go through the
    // per-unit quantity-allocator split; simplified (Add-ons) groups and
    // required SINGLE-selection groups (e.g. Flavor) are both chosen once
    // for the whole line via selectedOptionIds.
    const legacyGroups = groups.filter((group) => !group.simplified && group.selectionType === 'MULTIPLE');
    const flatGroups = groups.filter((group) => group.simplified || group.selectionType === 'SINGLE');

    // Task 193B — splitAddOnLines zips choices across groups by unit index
    // using one shared quantity, which only has a coherent meaning when a
    // single MULTIPLE group is being split across the line's units. Two or
    // more required MULTIPLE groups can carry different target counts (e.g.
    // a 2-pick Flavor group alongside a 1-pick Sauce group); forcing them
    // through one shared (max) quantity fails splitAddOnLines's per-group
    // length check for the smaller group and silently returns zero lines,
    // even though isValid already confirmed every group independently met
    // its own target. When more than one MULTIPLE group is present, fold
    // every group's picks directly onto a single line instead — the same
    // "chosen once for the whole line" treatment flatGroups already gets.
    const splittableGroup = legacyGroups.length === 1 ? legacyGroups[0] : undefined;
    const flatMultiGroups = splittableGroup ? [] : legacyGroups;

    const addOnSelectedOptions: PosCartSelectedOption[] = [
      ...flatGroups.flatMap((group) =>
        (selectedOptionIds[group.id] ?? []).flatMap((optionId) => {
          const option = group.options.find((o) => o.id === optionId);
          if (!option) return [];
          return [
            {
              option_group_id: group.id,
              option_group_name: group.name,
              option_id: option.id,
              option_name: option.name,
              price_adjustment: option.price_adjustment,
            },
          ];
        }),
      ),
      ...flatMultiGroups.flatMap((group) => {
        const groupAssignment = assignments[group.id] ?? {};
        return group.options.flatMap((option) =>
          Array.from({ length: groupAssignment[option.id] ?? 0 }, () => ({
            option_group_id: group.id,
            option_group_name: group.name,
            option_id: option.id,
            option_name: option.name,
            price_adjustment: option.price_adjustment,
          })),
        );
      }),
    ];

    // Task 182 — a genuine multi-slot (MULTIPLE) group's allocator is sized
    // to the group's own required count, not the cart line's quantity; that
    // required count now drives how many lines/units this add produces.
    const baseLines = splittableGroup
      ? splitAddOnLines([splittableGroup], assignments, multiGroupTarget(splittableGroup))
      : [{ quantity, selected_options: [] as PosCartSelectedOption[] }];

    const newItems = baseLines.map((line) => {
      const selected_options = [...line.selected_options, ...addOnSelectedOptions];
      return {
        product_id: product.id,
        product_variant_id: variant.id,
        ...(flavorId ? { flavor_id: flavorId } : {}),
        ...(selectedFlavors ? { selected_flavors: selectedFlavors } : {}),
        ...(selected_options.length > 0 ? { selected_options } : {}),
        quantity: line.quantity,
      };
    });
    if (editingIndex !== undefined) {
      replaceItem(editingIndex, newItems);
    } else {
      for (const item of newItems) addItem(item);
    }
    setAddOnsPrompt(null);
  }

  // Task 108 — "Edit" on a cart line reopens the same Add-ons dialog used
  // pre-add, preloaded with that line's product/variant/flavor, quantity,
  // and current option choices. Only offered for lines whose variant
  // currently has assignable option groups; there is nothing for this
  // dialog to edit otherwise.
  //
  // Task 131 — simplified (Add-ons) groups preload every matching selected
  // option id into selectedOptionIds (a line can carry several, not just
  // one).
  // Task 182 — required SINGLE-selection groups (e.g. Flavor) preload the
  // same way — a line only ever carries one. Only genuine MULTIPLE
  // (multi-slot) groups still preload into per-choice assignments (the
  // inverse of splitAddOnLines), tallying how many times each option
  // appears rather than assuming a single choice.
  // Task 194A — useCallback'd (deps: items, variantIndex) so CartLineItem
  // (React.memo) can treat onEdit as a stable prop across renders that
  // don't touch the cart itself.
  const handleEditLine = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      const info = variantIndex.get(item.product_variant_id);
      if (!info) return;
      const { product, variant } = info;
      const groups = dialogGroupsFor(variant);
      if (groups.length === 0) return;
      const assignments: AddOnAssignments = {};
      const selectedOptionIds: AddOnSelections = {};
      for (const group of groups) {
        const selectedForGroup = (item.selected_options ?? []).filter((option) => option.option_group_id === group.id);
        if (group.simplified || group.selectionType === 'SINGLE') {
          selectedOptionIds[group.id] = selectedForGroup.map((option) => option.option_id);
          continue;
        }
        if (selectedForGroup.length > 0) {
          const counts: Record<string, number> = {};
          for (const option of selectedForGroup) counts[option.option_id] = (counts[option.option_id] ?? 0) + 1;
          assignments[group.id] = counts;
        } else if (group.allowNoAddOn) {
          assignments[group.id] = { [NO_ADD_ON_KEY]: multiGroupTarget(group) };
        }
      }
      setAddOnsPrompt({
        product,
        variant,
        ...(item.flavor_id ? { flavorId: item.flavor_id } : {}),
        ...(item.selected_flavors ? { selectedFlavors: item.selected_flavors } : {}),
        quantity: item.quantity,
        assignments,
        selectedOptionIds,
        editingIndex: index,
      });
    },
    [items, variantIndex],
  );

  function handleFlavorPick(flavorId: string) {
    if (!flavorPrompt) return;
    const { product, variant } = flavorPrompt;
    setFlavorPrompt(null);
    if (maybeOpenAddOnsPrompt(product, variant, { flavorId })) return;
    addItem({
      product_id: product.id,
      product_variant_id: variant.id,
      flavor_id: flavorId,
      quantity: 1,
    });
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
    const { product, variant } = slotPrompt;
    setSlotPrompt(null);
    if (maybeOpenAddOnsPrompt(product, variant, { selectedFlavors })) return;
    addItem({
      product_id: product.id,
      product_variant_id: variant.id,
      selected_flavors: selectedFlavors,
      quantity: 1,
    });
  }

  // Memoized so it only recomputes when the cart or catalog actually change —
  // without this, every keystroke in an unrelated field (cash tendered,
  // discount ID, payment reference) re-derived every cart line from scratch.
  const cartLines = useMemo<CartLine[]>(
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
          hasOptionGroups: info ? activeOptionGroups(info.variant).length > 0 : false,
        };
      }),
    [items, variantIndex],
  );

  // Memoized alongside cartLines/previewAmounts below — same reasoning: this
  // used to recompute on every render (e.g. every Cash Tendered keystroke)
  // even though its only real inputs are cartLines, which are already memoized.
  const subtotal = useMemo(() => round2(cartLines.reduce((sum, line) => sum + line.lineTotal, 0)), [cartLines]);
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
    } else {
      if (!paymentProofKey) return 'Upload payment proof before continuing.';
    }
    return null;
  })();

  const canCharge = Boolean(branchId) && chargeDisabledReason === null;

  const openVoidRefund = useCallback(() => setIsVoidRefundOpen(true), []);

  // Task 209.25 — Checkout button entry point, shared by the desktop inline
  // cart panel and the mobile cart Sheet. Closes the mobile Sheet (Part O:
  // "transition into the dedicated full-screen/step checkout" instead of
  // squeezing payment UI into the bottom sheet) — a no-op on desktop, where
  // the Sheet is never rendered.
  const openCheckout = useCallback(() => {
    setIsCheckoutOpen(true);
    setIsCartSheetOpen(false);
  }, []);

  // Async and re-throwing (rather than a fire-and-forget `.then()`) so
  // ImageUpload can await this, show "Upload Failed"/Retry on rejection, and
  // keep the captured file for a retry — cart, payment method, and cash
  // tendered all live in separate state above and are never touched here.
  async function handleProofSelected(file: File, type: ImageProofType) {
    if (!branchId) return;
    const result = await uploadPaymentProof.mutateAsync({ branchId, shiftId: shift?.id, type, file });
    setPaymentProofKey(result.payment_proof_key);
    setPaymentProofType(result.payment_proof_type);
    setPaymentProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  function handleClearProof() {
    setPaymentProofKey(null);
    setPaymentProofType(null);
    setPaymentProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  /** Same async/re-throw contract as handleProofSelected above — ImageUpload shows "Upload Failed"/Retry Upload on rejection and keeps the captured file. */
  async function handleDiscountProofSelected(file: File, type: ImageProofType) {
    if (!branchId) return;
    const result = await uploadDiscountProof.mutateAsync({ branchId, shiftId: shift?.id, type, file });
    setDiscountProofKey(result.discount_proof_key);
    setDiscountProofType(result.discount_proof_type);
    setDiscountProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  function handleClearDiscountProof() {
    setDiscountProofKey(null);
    setDiscountProofType(null);
    setDiscountProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  function resetPaymentFields() {
    setDiscountType('none');
    setDiscountIdReference('');
    setPromoAmount('');
    setCashTendered('');
    setPaymentProofKey(null);
    setPaymentProofType(null);
    setDiscountProofKey(null);
    setDiscountProofType(null);
    setPaymentProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setDiscountProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
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
      payment_proof_key: paymentMethod !== 'cash' ? (paymentProofKey ?? undefined) : undefined,
      payment_proof_type: paymentMethod !== 'cash' ? (paymentProofType ?? undefined) : undefined,
      discount_proof_key:
        discountType === 'pwd' || discountType === 'senior_citizen' ? (discountProofKey ?? undefined) : undefined,
      discount_proof_type:
        discountType === 'pwd' || discountType === 'senior_citizen' ? (discountProofType ?? undefined) : undefined,
      is_offline_transaction: !isOnline,
    };

    if (!isOnline) {
      // Real BIR receipt numbers are only ever assigned by the server at
      // sync time — this provisional id just needs to be locally unique.
      const provisionalId = await enqueueOfflineTransaction(branchId.slice(0, 8), payload);
      clearCart();
      resetPaymentFields();
      // Task 209.25 — close the workspace on a confirmed outcome (queued
      // offline or, below, a successful sync online): the cart it was
      // reviewing no longer exists. Left open on failure (the catch branch
      // below never calls this) so the cashier lands back in Payment with
      // the cart and every field exactly as entered, ready to retry.
      setIsCheckoutOpen(false);
      setQueuedNotice(provisionalId);
      return;
    }

    try {
      const transaction = await createTransaction.mutateAsync(payload);
      clearCart();
      resetPaymentFields();
      setIsCheckoutOpen(false);
      setReceipt(transaction);
    } catch (error) {
      setChargeError(error instanceof Error ? error.message : 'Failed to record transaction');
    }
  }

  // Task 209.54 — same reasoning as the branch dashboard: `user` (and so
  // `branchId`) is briefly null on every reload while useAuth's silent
  // refresh is in flight (the access token is memory-only). Without this
  // gate, a correctly-staffed cashier saw "No branch assigned" flash before
  // the terminal itself ever appeared.
  if (isAuthLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned.</p>;
  }

  // STATE 1 — no Employee selected yet. Branch Employee Authorization:
  // rendered right here inline (never a separate route/navigation), so the
  // Branch shell (sidebar/header) never unmounts and the authenticated user
  // never changes. Once activeEmployee is set, this falls through to
  // STATE 2/3 below without the Branch Account ever losing its own session.
  //
  // Task 209.27 — while useTerminalOperator is still validating a persisted
  // operator hint against live attendance, show the same loading skeleton
  // STATE 2 already uses below instead of this picker, so a still
  // clocked-in Employee is never flashed "Who's working?" on remount.
  if (isBranchAccount && !activeEmployee) {
    if (isRestoringOperator) {
      return (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl app-section app-section-gap overflow-y-auto p-6">
        <div>
          <h1 className="app-title font-bold">Who&apos;s working?</h1>
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

  // Task 196 (visual redesign) — cart lines + checkout panel rendered from
  // one shared source. Desktop keeps it inline (unchanged layout); below
  // `lg` it renders once inside a Sheet instead — never both at once, so
  // there's exactly one Cash Tendered input / Charge button / cart line list
  // in the DOM at a time, same as before the redesign.
  const cartLinesList =
    cartLines.length === 0 ? (
      <EmptyState compact icon={ShoppingCart} title="Cart is empty" description="Tap a product to start a sale." />
    ) : (
      <div className="space-y-3">
        {cartLines.map((line, i) => (
          <CartLineItem
            key={line.index}
            line={line}
            showDivider={i > 0}
            onEdit={handleEditLine}
            onRemove={removeItem}
            onQuantityChange={updateItemQuantity}
          />
        ))}
      </div>
    );

  // Task 209.25 — the permanent cart's own footer: compact subtotal + the
  // Checkout button that opens the dedicated workspace below. Never renders
  // payment method, discount, proof, Cash Tendered, or the final Charge
  // control — see checkoutWorkspaceElement for those. Disabled purely on an
  // empty cart; the deeper per-payment-method validation
  // (chargeDisabledReason) only ever gates the workspace's own Confirm
  // button, not this entry point.
  const checkoutBarElement = (
    <div className="app-pos-footer shrink-0 border-t bg-card">
      <div className="app-pos-total-row flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Subtotal</span>
        <span className="tabular-nums text-base font-semibold">{formatPeso(subtotal)}</span>
      </div>
      {/* The one validation rule that actually blocks *reaching* checkout
          (an empty cart) surfaces here, next to the control it disables.
          Every payment-method/discount-specific reason below that still
          gates the workspace's own Confirm button (chargeDisabledReason)
          only makes sense once the cashier is inside the workspace, so it
          stays there instead of duplicating here. */}
      {cartLines.length === 0 && (
        <Alert className="border-none bg-muted px-3 py-1.5" role="status" aria-live="polite">
          <AlertDescription className="app-pos-helper-text font-medium text-foreground">Add items to the cart to start a sale.</AlertDescription>
        </Alert>
      )}
      <Button variant="pos" className="w-full" disabled={cartLines.length === 0} onClick={openCheckout}>
        Checkout {formatPeso(totalAmount)}
      </Button>
    </div>
  );

  // Task 209.25 — consumes the same cart/payment/discount/proof state and
  // totals/validation/charge-handler as before (no duplicated pricing or
  // transaction logic); only which pane is visible responsively is new.
  const checkoutWorkspaceElement = (
    <CheckoutWorkspace
      open={isCheckoutOpen}
      onOpenChange={setIsCheckoutOpen}
      layout={isDesktop ? 'two-pane' : 'stepped'}
      cartLines={cartLines}
      onEditLine={handleEditLine}
      onRemoveLine={removeItem}
      onQuantityChange={updateItemQuantity}
      subtotal={subtotal}
      vatAmount={vatAmount}
      discountAmount={discountAmount}
      totalAmount={totalAmount}
      discountType={discountType}
      onDiscountTypeChange={setDiscountType}
      discountIdReference={discountIdReference}
      onDiscountIdReferenceChange={setDiscountIdReference}
      discountProofKey={discountProofKey}
      discountProofPreviewUrl={discountProofPreviewUrl}
      onDiscountProofSelected={handleDiscountProofSelected}
      onClearDiscountProof={handleClearDiscountProof}
      promoAmount={promoAmount}
      onPromoAmountChange={setPromoAmount}
      paymentMethod={paymentMethod}
      onPaymentMethodChange={setPaymentMethod}
      isOnline={isOnline}
      cashTendered={cashTendered}
      onCashTenderedChange={setCashTendered}
      change={change}
      paymentProofKey={paymentProofKey}
      paymentProofPreviewUrl={paymentProofPreviewUrl}
      onProofSelected={handleProofSelected}
      onClearProof={handleClearProof}
      chargeError={chargeError}
      chargeDisabledReason={chargeDisabledReason}
      canCharge={canCharge}
      isChargePending={createTransaction.isPending}
      onCharge={() => void handleCharge()}
    />
  );

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-background">
      {!isOnline && (
        <div className="bg-warning px-4 py-1 text-center text-xs font-medium text-warning-foreground">
          Offline — sales will be queued and synced automatically once you reconnect.
        </div>
      )}

      {/* Cashier attendance strip — Clock In happens above (the whole selling UI is hidden until then); this is Clock Out only. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="active">Clocked In</Badge>
          <span className="font-medium">{operatorName}</span>
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

      {/* Task 209.20 — `lg:min-h-0` on this row (and the two panels below) is
          the actual fix for controls only reachable after excessive
          scrolling: a flex item's default min-height is `auto` (its content
          size), which lets it grow past the row's real available height
          instead of clipping to it — the row/panel/scroll-region trio must
          all opt out of that via min-h-0 for the *inner* overflow-y-auto
          regions (product grid, cart items) to actually be what scrolls,
          rather than the whole page. */}
      <div className="flex flex-1 flex-col overflow-y-auto lg:min-h-0 lg:flex-row lg:overflow-hidden">
      {/* LEFT PANEL — product catalog. ~66% width on desktop (lg:w-2/3), independent scroll region below the toolbar. */}
      <div className="relative flex flex-col lg:min-h-0 lg:w-2/3 lg:flex-none lg:overflow-hidden lg:border-r">
        <div className="space-y-2 border-b bg-card p-3">
          <h1 className="sr-only">POS Terminal — product catalog</h1>
          <SearchInput
            value={productSearch}
            onChange={setProductSearch}
            placeholder="Search products…"
            className="max-w-md"
            inputClassName="app-control"
          />
          {/* Category pills — only ever built from categories actually present on the catalog (no fabricated categories). TabsList already scrolls horizontally on narrow screens.
              Task 209.8B — height is density-aware via `.app-control` (36-40px on compact/standard laptops, 44px on touch/comfortable, matching --app-control-height) instead of a fixed h-9,
              and triggers stretch to fill it (`h-full`) so the clickable area always matches the visible chip. */}
          <Tabs value={activeCategory} onValueChange={setActiveCategory}>
            <TabsList aria-label="Filter by category" className="app-control w-full items-stretch justify-start overflow-x-auto sm:w-auto">
              <TabsTrigger value="all" className="h-full">All</TabsTrigger>
              {categories.map((category) => (
                <TabsTrigger key={category} value={category} className="h-full">
                  {category}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="lg:flex-1 lg:overflow-y-auto">
          {isCatalogLoading && catalog.length === 0 ? (
            <div className={productGridClasses(densityMode)} aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <Skeleton key={i} className="app-pos-card rounded-xl" />
              ))}
            </div>
          ) : isCatalogError && catalog.length === 0 ? (
            <ErrorState
              title="Failed to load the product catalog"
              description="Check your connection and try again."
              retry={() => void refetchCatalog()}
            />
          ) : visibleProducts.length === 0 ? (
            <EmptyState
              compact
              icon={ShoppingCart}
              title={productSearch || activeCategory !== 'all' ? 'No matching products' : 'No products available'}
              description={
                productSearch
                  ? `No products match "${productSearch}".`
                  : activeCategory !== 'all'
                    ? 'No products in this category yet.'
                    : 'This branch has no catalog items yet.'
              }
              action={
                productSearch ? (
                  <Button variant="outline" size="sm" onClick={() => setProductSearch('')}>
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className={productGridClasses(densityMode)}>
              {visibleProducts.map((product) =>
                product.variants.map((variant) => (
                  <ProductCard key={variant.id} product={product} variant={variant} message={readinessMessage(variant)} onTap={handleProductTap} />
                )),
              )}
            </div>
          )}
        </div>

        {flavorPrompt && (
          <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <Card className="max-h-[calc(100vh-2rem)] w-full max-w-sm overflow-y-auto">
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
          <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <Card className="max-h-[calc(100vh-2rem)] w-full max-w-sm overflow-y-auto">
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

        {addOnsPrompt && (
          <AddOnsDialog
            productName={addOnsPrompt.product.name}
            variantName={addOnsPrompt.variant.name}
            groups={dialogGroupsFor(addOnsPrompt.variant)}
            quantity={addOnsPrompt.quantity}
            assignments={addOnsPrompt.assignments}
            onAssignmentChange={handleAddOnsAssignmentChange}
            selectedOptionIds={addOnsPrompt.selectedOptionIds}
            onToggleOption={handleToggleAddOnOption}
            onSelectOption={handleSelectSingleOption}
            onClearGroup={handleClearAddOnGroup}
            onCancel={() => setAddOnsPrompt(null)}
            onConfirm={handleAddOnsConfirm}
            isEditMode={addOnsPrompt.editingIndex !== undefined}
          />
        )}
      </div>

      {/* RIGHT PANEL — compact order-building cart only (Task 209.25): cart
          lines, a compact subtotal, and the Checkout button. Payment method,
          discount, proof, Cash Tendered, and the final Charge control all
          moved to CheckoutWorkspace (rendered once, below, alongside
          ReceiptModal/VoidRefundSaleDialog) — never rendered permanently
          here regardless of payment method, discount type, or proof/camera
          state. Width is density-aware via --app-pos-cart-width (Task
          209.20: ~28% fine-pointer, 32% compact-touch for bigger touch
          targets), independent scroll region. Below `lg`, this panel is
          replaced by a sticky "View Cart" bar + Sheet (rendered further
          down) so the product catalog is what a cashier sees first on a
          phone.
          Task 209.20 — `min-h-0`/`lg:min-h-0` on this panel and its scroll
          region (below) so only the cart-items list scrolls internally; the
          compact header (`.app-pos-cart-header`) and the checkout footer
          (`checkoutBarElement`) stay `flex-shrink-0` so Checkout is never
          pushed offscreen by a long cart. */}
      {isDesktop && (
        <div className="app-pos-cart-width hidden min-h-0 flex-col border-t lg:flex lg:min-h-0 lg:flex-none lg:overflow-hidden lg:border-t-0">
          <div className="app-pos-cart-header flex shrink-0 items-center justify-between gap-2 border-b bg-card px-3">
            <h2 className="text-sm font-semibold">Cart</h2>
            <span className="flex shrink-0 items-center gap-2">
              {cartLines.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {cartLines.reduce((sum, l) => sum + l.quantity, 0)} item{cartLines.reduce((sum, l) => sum + l.quantity, 0) === 1 ? '' : 's'}
                </span>
              )}
              {/* Task 209.25 (Part M) — Void/Refund is sale-level
                  functionality on a *previous* sale, independent of the
                  current cart, so it stays reachable here rather than inside
                  CheckoutWorkspace (which an empty cart can't even open). */}
              {canManageVoidRefund && (
                <Button type="button" variant="ghost" className="app-control px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={openVoidRefund}>
                  Void / Refund Sale
                </Button>
              )}
            </span>
          </div>
          <div className="min-h-0 p-3 lg:flex-1 lg:overflow-y-auto">
            {cartLinesList}
          </div>
          {checkoutBarElement}
        </div>
      )}
      </div>

      {/* Mobile cart access — sticky bar + Sheet, only below `lg`. isDesktop defaults true (see shouldShowInlineCart / useHasRoomForInlineCart), so this branch never mounts in a non-browser/test environment.
          Task 209.25 (Part O) — the Sheet stays cart-review-only (lines +
          compact subtotal + Checkout), same as the desktop panel; Checkout
          closes the Sheet and opens the full-screen/step CheckoutWorkspace
          instead of squeezing payment UI into the bottom sheet. */}
      {!isDesktop && (
        <>
          <div className="sticky bottom-0 z-20 border-t bg-card p-3 lg:hidden">
            <Button
              variant="pos"
              className="touch-target w-full justify-between px-5"
              onClick={() => setIsCartSheetOpen(true)}
            >
              <span className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" aria-hidden="true" />
                View Cart{cartLines.length > 0 ? ` · ${cartLines.reduce((sum, l) => sum + l.quantity, 0)}` : ''}
              </span>
              <span className="tabular-nums">{formatPeso(totalAmount)}</span>
            </Button>
          </div>

          <Sheet open={isCartSheetOpen} onOpenChange={setIsCartSheetOpen}>
            {/* Task 209.29 — `dvh` instead of `vh`: a fixed `vh` is measured
                against the viewport with mobile browser chrome (URL bar/nav)
                collapsed, so once that chrome is showing, `92vh` can extend
                past what's actually visible and push `checkoutBarElement`'s
                Checkout button below the fold. `dvh` tracks the browser's
                actual visible viewport as chrome shows/hides. */}
            <SheetContent side="bottom" className="flex h-[92dvh] flex-col gap-0 p-0">
              <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b p-3 text-left">
                <SheetTitle>Cart</SheetTitle>
                {canManageVoidRefund && (
                  <Button type="button" variant="ghost" className="app-control shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={openVoidRefund}>
                    Void / Refund Sale
                  </Button>
                )}
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-3">{cartLinesList}</div>
              {checkoutBarElement}
            </SheetContent>
          </Sheet>
        </>
      )}

      {checkoutWorkspaceElement}

      <ReceiptModal transaction={receipt} onClose={() => setReceipt(null)} />

      {canManageVoidRefund && (
        <VoidRefundSaleDialog branchId={branchId} open={isVoidRefundOpen} onOpenChange={setIsVoidRefundOpen} />
      )}

      {queuedNotice && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
          <Card className="max-h-[calc(100vh-2rem)] w-full max-w-sm overflow-y-auto">
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
