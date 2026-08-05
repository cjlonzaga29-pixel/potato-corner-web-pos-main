'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Fingerprint, Loader2, LogOut, MapPin, Pencil, Receipt, ShoppingCart, Trash2, User } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import type { CreateTransactionInput, PosCatalogProduct, TransactionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { AddOnsDialog, multiGroupTarget, type AddOnsDialogGroup, type AddOnSelections } from '@/components/pos/add-ons-dialog';
import { splitAddOnLines, isAddOnsGroup, NO_ADD_ON_KEY, type AddOnAssignments } from '@/lib/pos/split-add-ons';
import type { PosCartSelectedOption } from '@/stores/cart.store';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { SearchInput } from '@/components/shared/forms/search-input';
import { useAuth } from '@/hooks/use-auth';
import { useCart } from '@/hooks/use-cart';
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
import { VoidRefundSaleDialog } from '@/components/pos/void-refund-sale-dialog';

// Task 140 — the same allowed-roles set ViewTransactionDetailDialog itself
// gates Void/Refund actions on (view-transaction-detail-dialog.tsx); kept
// here only to decide whether the POS entry point is worth showing at all.
const VOID_REFUND_ENTRY_ROLES: readonly string[] = [ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.BRANCH];

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
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectingEmployeeId, setSelectingEmployeeId] = useState<string | null>(null);
  const [selectEmployeeError, setSelectEmployeeError] = useState<string | null>(null);
  const [activeEmployee, setActiveEmployee] = useState<{ id: string; firstName: string; lastName: string; role: string } | null>(null);
  const [activeEmployeeToken, setActiveEmployeeToken] = useState<string | null>(null);

  // The operator actually running this terminal session — the selected
  // Employee when a Branch Account picked one, otherwise the authenticated
  // user itself (a genuine `staff` login). Drives attendance/checkout calls
  // below; never the authenticated-user identity shown in the shell chrome.
  const operatorId = isBranchAccount ? activeEmployee?.id : user?.id;
  const operatorToken = isBranchAccount ? (activeEmployeeToken ?? undefined) : undefined;
  const operatorName = isBranchAccount && activeEmployee ? `${activeEmployee.firstName} ${activeEmployee.lastName}`.trim() : `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || user?.email;

  const { items, addItem, removeItem, updateItemQuantity, replaceItem, clearCart } = useCart();
  const { data: liveCatalog, isLoading: isCatalogLoading } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);
  const { isClockedIn, record: attendanceRecord, isLoading: isAttendanceLoading } = useIsClockedIn(operatorId);
  // Informational only below (payment-proof storage path fallback) — never
  // gates the Charge button. The API resolves and auto-opens the cashier's
  // own active shift server-side via shiftGuard, so checkout is never
  // blocked on this client-side lookup being loaded or fresh.
  const { shift } = useMyActiveShift(branchId);
  useShiftsRealtimeSync();
  const { isOnline } = useOffline();
  const createTransaction = useCreateTransaction(operatorToken);
  const uploadPaymentProof = useUploadPaymentProof(operatorToken);
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
    { enabled: isBranchAccount && !activeEmployee },
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

  // Task 107 — only groups with at least one active option are cashier-
  // facing; a group left with zero active options is invisible at the POS.
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

  // Opens the Add-ons dialog for a product about to be added to the cart —
  // called only after any flavor/slot choice is already resolved. Returns
  // true when the dialog was opened (caller must not addItem directly).
  function maybeOpenAddOnsPrompt(
    product: PosCatalogProduct,
    variant: PosCatalogProduct['variants'][number],
    extra: { flavorId?: string; selectedFlavors?: { slot_index: number; snack_product_variant_id: string; flavor_id: string }[] },
  ): boolean {
    const groups = activeOptionGroups(variant);
    if (groups.length === 0) return false;
    setAddOnsPrompt({ product, variant, ...extra, quantity: 1, assignments: {}, selectedOptionIds: {} });
    return true;
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
    if (maybeOpenAddOnsPrompt(product, variant, {})) return;
    addItem({ product_id: product.id, product_variant_id: variant.id, quantity: 1 });
  }

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

  function handleRemoveLine(index: number) {
    removeItem(index);
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
  function handleEditLine(index: number) {
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
  }

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
          hasOptionGroups: info ? activeOptionGroups(info.variant).length > 0 : false,
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
    } else {
      if (!paymentProofKey) return 'Upload payment proof before continuing.';
    }
    return null;
  })();

  const canCharge = Boolean(branchId) && chargeDisabledReason === null;

  function resetPaymentFields() {
    setDiscountType('none');
    setDiscountIdReference('');
    setPromoAmount('');
    setCashTendered('');
    setPaymentProofKey(null);
    setPaymentProofType(null);
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
  // rendered right here inline (never a separate route/navigation), so the
  // Branch shell (sidebar/header) never unmounts and the authenticated user
  // never changes. Once activeEmployee is set, this falls through to
  // STATE 2/3 below without the Branch Account ever losing its own session.
  if (isBranchAccount && !activeEmployee) {
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

      <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* LEFT PANEL — product catalog */}
      <div className="relative flex flex-col lg:w-2/3 lg:flex-none lg:overflow-hidden lg:border-r">
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

        <div className="grid grid-cols-2 content-start gap-2 p-4 sm:grid-cols-2 md:grid-cols-3 lg:flex-1 lg:grid-cols-4 lg:overflow-y-auto xl:grid-cols-5 2xl:grid-cols-6">
          {visibleProducts.map((product) =>
            product.variants.map((variant) => {
              const message = readinessMessage(variant);
              return (
                <Card
                  key={variant.id}
                  role="button"
                  tabIndex={variant.live_ready ? 0 : -1}
                  aria-disabled={!variant.live_ready}
                  className={`flex h-full min-h-[92px] flex-col rounded-lg border shadow-none outline-none transition-colors touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    variant.live_ready
                      ? 'cursor-pointer hover:border-primary hover:bg-muted'
                      : 'cursor-not-allowed opacity-60'
                  }`}
                  onClick={() => handleProductTap(product, variant)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleProductTap(product, variant);
                    }
                  }}
                >
                  <CardContent className="flex h-full flex-col gap-0.5 p-3">
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

      {/* RIGHT PANEL — cart + payment */}
      <div className="flex flex-col border-t lg:w-1/3 lg:flex-none lg:overflow-hidden lg:border-t-0">
        <div className="p-4 pb-32 lg:flex-1 lg:overflow-y-auto lg:pb-4">
          {cartLines.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <ShoppingCart className="h-8 w-8" />
              <p className="text-sm font-medium text-foreground">Your cart is empty</p>
              <p className="text-xs">Tap a product to start a sale.</p>
            </div>
          )}
          <div className="space-y-4">
            {cartLines.map((line, i) => (
              <div key={line.index}>
                {i > 0 && <Separator className="mb-4" />}
                <div className="space-y-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 min-w-0 flex-1 font-medium leading-snug">
                      {line.productName}
                      {line.flavorName ? ` — ${line.flavorName}` : ''}
                    </p>
                    <div className="flex shrink-0 items-center gap-1">
                      {line.hasOptionGroups && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="touch-target"
                          onClick={() => handleEditLine(line.index)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="touch-target text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => handleRemoveLine(line.index)}
                        aria-label={`Remove ${line.productName} from cart`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {line.variantName} · {formatPeso(line.unitPrice)} each
                  </p>
                  {line.slotSelections.map((sel, si) => (
                    <p key={si} className="text-xs text-muted-foreground">
                      {sel.label}: {sel.snackName} — {sel.flavorName}
                    </p>
                  ))}
                  {line.optionSelections.map((opt) => (
                    <p key={opt.option_id} className="text-xs text-muted-foreground">
                      {opt.option_group_name}: {opt.option_name}
                      {opt.price_adjustment !== 0 ? formatAdjustment(opt.price_adjustment) : ''}
                    </p>
                  ))}
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="touch-target"
                        aria-label={`Decrease ${line.productName} quantity`}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateItemQuantity(line.index, line.item.quantity - 1);
                        }}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{line.item.quantity}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="touch-target"
                        aria-label={`Increase ${line.productName} quantity`}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateItemQuantity(line.index, line.item.quantity + 1);
                        }}
                      >
                        +
                      </Button>
                    </div>
                    <p className="text-right font-semibold tabular-nums">{formatPeso(line.lineTotal)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 z-10 space-y-4 border-t bg-card p-4 lg:static">
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
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
            <Separator className="my-2" />
            <div className="flex items-baseline justify-between">
              <span className="text-base font-semibold">Total</span>
              <span className="flex items-center gap-1.5 text-2xl font-bold tabular-nums">
                <Receipt className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                {formatPeso(totalAmount)}
              </span>
            </div>
          </div>

          {canManageVoidRefund && (
            <Button
              type="button"
              variant="outline"
              className="touch-target w-full border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setIsVoidRefundOpen(true)}
            >
              Void / Refund Sale
            </Button>
          )}

          <Select value={discountType} onValueChange={(v) => setDiscountType(v as DiscountChoice)}>
            <SelectTrigger className="touch-target">
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
              className="touch-target"
              placeholder="PWD / Senior Citizen ID number"
              value={discountIdReference}
              onChange={(e) => setDiscountIdReference(e.target.value)}
            />
          )}
          {discountType === 'promotional' && (
            <Input
              className="touch-target"
              type="number"
              min={0}
              placeholder="Promo discount amount"
              value={promoAmount}
              onChange={(e) => setPromoAmount(e.target.value)}
            />
          )}

          <Tabs value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'cash' | 'gcash' | 'maya' | 'other')}>
            <TabsList className="h-11 w-full">
              <TabsTrigger value="cash" className="h-9 flex-1">
                Cash
              </TabsTrigger>
              <TabsTrigger value="gcash" className="h-9 flex-1" disabled={!isOnline}>
                GCash
              </TabsTrigger>
              <TabsTrigger value="maya" className="h-9 flex-1" disabled={!isOnline}>
                Maya
              </TabsTrigger>
              <TabsTrigger value="other" className="h-9 flex-1" disabled={!isOnline}>
                Other
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!isOnline && paymentMethod === 'cash' && (
            <p className="text-xs text-muted-foreground">GCash, Maya, and Other are unavailable offline — payment proof can only be captured while connected.</p>
          )}

          {paymentMethod === 'cash' && (
            <div className="space-y-1">
              <Input
                className="touch-target"
                type="number"
                min={0}
                placeholder="Cash tendered"
                value={cashTendered}
                onChange={(e) => setCashTendered(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Change: {formatPeso(change)}</p>
            </div>
          )}

          {(paymentMethod === 'gcash' || paymentMethod === 'maya' || paymentMethod === 'other') && (
            <Card className="rounded-lg shadow-none">
              <CardContent className="space-y-3 p-3">
                {paymentProofKey ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-success bg-success/10 px-3 py-2 text-xs text-success">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Payment proof attached
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto shrink-0 p-0 text-xs underline"
                      onClick={() => {
                        setPaymentProofKey(null);
                        setPaymentProofType(null);
                      }}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <ImageUpload
                    label="Payment Proof"
                    description="Upload a clear screenshot or photo of the successful payment."
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
              </CardContent>
            </Card>
          )}

          {chargeError && (
            <Alert variant="destructive" className="px-3 py-2">
              <AlertDescription className="text-xs">{chargeError}</AlertDescription>
            </Alert>
          )}

          {chargeDisabledReason && (
            <Alert className="border-none bg-muted px-3 py-2">
              <AlertDescription className="text-sm font-medium text-foreground">{chargeDisabledReason}</AlertDescription>
            </Alert>
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
