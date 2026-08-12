import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TerminalPage from './page';
import type { PosCatalogProduct, CreateTransactionInput } from '@potato-corner/shared';
import { useAuthStore } from '@/stores/auth.store';
import { useTerminalOperatorStore } from '@/stores/terminal-operator.store';

const {
  mockAddItem,
  mockReplaceItem,
  mockUseCatalog,
  mockUseMyActiveShift,
  mockUseIsClockedIn,
  mockClockInMutateAsync,
  mockClockOutMutateAsync,
  mockUseAuth,
  mockSelectEmployee,
  mockUseEmployees,
  mockCreateTransactionMutateAsync,
  mockUseClockIn,
  mockUseClockOut,
  mockUseCreateTransaction,
  mockUploadPaymentProofMutateAsync,
  mockUploadDiscountProofMutateAsync,
  mockCreateTransactionIsPending,
  mockClearCart,
} = vi.hoisted(() => ({
  mockAddItem: vi.fn(),
  mockReplaceItem: vi.fn(),
  mockUseCatalog: vi.fn(),
  mockCreateTransactionMutateAsync: vi.fn().mockResolvedValue({}),
  mockUseMyActiveShift: vi.fn(() => ({ shift: { id: 'shift-1' } as { id: string } | null, isLoading: false })),
  mockUseIsClockedIn: vi.fn(() => ({
    isClockedIn: true,
    record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' } as { clock_in_server_time: string } | null,
    isLoading: false,
  })),
  mockClockInMutateAsync: vi.fn(),
  mockClockOutMutateAsync: vi.fn(),
  mockUseAuth: vi.fn(),
  mockSelectEmployee: vi.fn(),
  mockUseEmployees: vi.fn(),
  // Task 120: these wrap the mutation hooks so tests can inspect what
  // accessTokenOverride terminal/page.tsx actually threaded through — the
  // whole point of the fix is that this is the selected Employee's token,
  // never the Branch Account's.
  mockUseClockIn: vi.fn(),
  mockUseClockOut: vi.fn(),
  mockUseCreateTransaction: vi.fn(),
  mockUploadPaymentProofMutateAsync: vi
    .fn()
    .mockResolvedValue({ payment_proof_key: 'branch-1/shift-1/user-1-123.webp', payment_proof_type: 'gallery_upload' }),
  // Task 209.5
  mockUploadDiscountProofMutateAsync: vi
    .fn()
    .mockResolvedValue({ discount_proof_key: 'branch-1/shift-1/user-1-456.webp', discount_proof_type: 'gallery_upload' }),
  // Task 209.3 — defaults to false (matching every existing test's
  // assumption that the mutation is never mid-flight), overridable per test
  // via mockCreateTransactionIsPending.mockReturnValue(true) to exercise the
  // Charge button's disabled/"Processing…" state without needing a real
  // useMutation instance.
  mockCreateTransactionIsPending: vi.fn(() => false),
  mockClearCart: vi.fn(),
}));

// jsdom implements neither createImageBitmap nor canvas 2D drawing/encoding —
// ImageUpload's compression pipeline needs both to drive a real gallery
// upload interaction in "payment proof still works" tests below.
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width: 10, height: 10 }) as never;
}
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() }) as never;
HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
  callback(new Blob(['fake-image'], { type: 'image/jpeg' }));
};

/** Real Radix Select needs pointer-event interactions jsdom can't drive without @testing-library/user-event — swap in a plain, click-responsive stand-in (same pattern as reports/page.test.tsx). */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});
  function Select({ onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
}));

const STAFF_USER = { id: 'user-1', role: 'staff' as const, branchIds: ['branch-1'], firstName: 'Jamie', lastName: 'Cruz', email: 'jamie@example.com' };
const BRANCH_USER = { id: 'branch-account-1', role: 'branch' as const, branchIds: ['branch-1'], firstName: 'Branch', lastName: 'Owner', email: 'owner@example.com' };

vi.mock('@/lib/geolocation', () => ({
  getCurrentPosition: vi.fn().mockResolvedValue({ lat: 14.5, lng: 121.0 }),
}));

const { mockCartItems } = vi.hoisted(() => ({ mockCartItems: vi.fn(() => [] as unknown[]) }));

vi.mock('@/hooks/use-cart', () => ({
  useCart: () => ({
    items: mockCartItems(),
    addItem: mockAddItem,
    removeItem: vi.fn(),
    updateItemQuantity: vi.fn(),
    replaceItem: mockReplaceItem,
    clearCart: mockClearCart,
  }),
}));

vi.mock('@/hooks/use-offline', () => ({
  useOffline: () => ({ isOnline: true }),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useCatalog: mockUseCatalog,
  useCatalogRealtimeSync: () => undefined,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useMyActiveShift: mockUseMyActiveShift,
  useShiftsRealtimeSync: () => undefined,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useIsClockedIn: mockUseIsClockedIn,
  useClockIn: (accessTokenOverride?: string) => {
    mockUseClockIn(accessTokenOverride);
    return { mutateAsync: mockClockInMutateAsync, isPending: false };
  },
  useClockOut: (accessTokenOverride?: string) => {
    mockUseClockOut(accessTokenOverride);
    return { mutateAsync: mockClockOutMutateAsync, isPending: false };
  },
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useCreateTransaction: (accessTokenOverride?: string) => {
    mockUseCreateTransaction(accessTokenOverride);
    return { mutateAsync: mockCreateTransactionMutateAsync, isPending: mockCreateTransactionIsPending() };
  },
  useUploadPaymentProof: () => ({ mutateAsync: mockUploadPaymentProofMutateAsync }),
  useUploadDiscountProof: () => ({ mutateAsync: mockUploadDiscountProofMutateAsync }),
}));

vi.mock('@/lib/offline/cache', () => ({
  cacheProductCatalog: vi.fn(),
  getCachedProductCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/offline/sync-queue', () => ({
  enqueueOfflineTransaction: vi.fn(),
}));

vi.mock('@/components/pos/receipt-modal', () => ({ ReceiptModal: () => null }));

// VoidRefundSaleDialog has its own full test coverage
// (void-refund-sale-dialog.test.tsx) — stubbed here to isolate the
// terminal's entry point (button visibility + open state) from that
// dialog's own transactions/branch/employee query chain.
vi.mock('@/components/pos/void-refund-sale-dialog', () => ({
  VoidRefundSaleDialog: ({ open }: { branchId: string; open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div data-testid="void-refund-sale-dialog">Void or Refund Sale</div> : null,
}));

type SnackOption = PosCatalogProduct['variants'][number]['flavor_slots'][number]['snack_options'][number];

function slotVariant(overrides: Partial<PosCatalogProduct['variants'][number]> = {}): PosCatalogProduct['variants'][number] {
  return {
    id: 'variant-1',
    name: 'Mega Mix',
    size_label: 'Large',
    price: 100,
    vatable_cap_amount: null,
    live_ready: true,
    readiness_code: 'READY',
    missing_flavor_ids: [],
    readiness_status: 'READY',
    completion_percentage: 100,
    blocking_issues: [],
    readiness_warnings: [],
    flavors: [
      { flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 },
      { flavor_id: 'flavor-2', name: 'BBQ', color_hex: null, price_premium: 0 },
    ],
    flavor_slots: [
      {
        slot_index: 1,
        label: 'Snack 1 Flavor',
        required: true,
        snack_options: [
          {
            product_variant_id: 'snack-1a',
            product_name: 'Flavored Fries',
            variant_name: 'Small',
            flavors: [{ flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 }],
          },
        ],
      },
      {
        slot_index: 2,
        label: 'Snack 2 Flavor',
        required: true,
        snack_options: [
          {
            product_variant_id: 'snack-2a',
            product_name: 'Potato Twister',
            variant_name: 'Small',
            flavors: [{ flavor_id: 'flavor-2', name: 'BBQ', color_hex: null, price_premium: 0 }],
          },
        ],
      },
    ],
    option_groups: [],
    ...overrides,
  };
}

function catalogWith(variants: PosCatalogProduct['variants'][number][]): { products: PosCatalogProduct[] } {
  return {
    products: [{ id: 'product-1', name: 'Mega Mix Fries', category: 'Snacks', has_image: false, image_url: null, variants }],
  };
}

beforeEach(() => {
  mockUseAuth.mockReturnValue({ user: STAFF_USER, selectEmployee: mockSelectEmployee });
  mockUseEmployees.mockReturnValue({ data: { employees: [] }, isLoading: false, isError: false, refetch: vi.fn() });
});

// Task 209.25 (checkout workspace architecture) — payment method, discount,
// proof, Cash Tendered, Void/Refund, and the final Charge control all moved
// out of the permanent cart into a dedicated CheckoutWorkspace opened by the
// compact cart's own "Checkout ₱XXX.XX" button. Every test in this file
// still runs at the default (desktop, fine-pointer) density — see
// useDensityMode/useHasRoomForInlineCart's documented `true`/`'standard'`
// defaults — so the workspace always opens in its two-pane layout, with
// Order Review and Payment visible together and no separate "Continue to
// Payment" step. Call this once before interacting with anything that used
// to render directly in the sidebar footer.
function openCheckout() {
  fireEvent.click(screen.getByRole('button', { name: /^Checkout/ }));
}

describe('TerminalPage — live POS readiness', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('disables the card and shows "Inventory setup incomplete." when missing a base mapping, blocking add-to-cart', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({ flavors: [], flavor_slots: [], live_ready: false, readiness_code: 'MISSING_BASE_MAPPING', missing_flavor_ids: [] }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);

    expect(screen.getByText('Inventory setup incomplete.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('shows "Flavor inventory mapping incomplete." when the readiness code is MISSING_FLAVOR_MAPPING, blocking add-to-cart', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({
          flavors: [],
          flavor_slots: [],
          live_ready: false,
          readiness_code: 'MISSING_FLAVOR_MAPPING',
          missing_flavor_ids: ['flavor-1'],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);

    expect(screen.getByText('Flavor inventory mapping incomplete.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('shows the missing flavor name (not internal ids) when blocking_issues carries flavor_name', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({
          flavors: [],
          flavor_slots: [],
          live_ready: false,
          readiness_code: 'MISSING_FLAVOR_MAPPING',
          missing_flavor_ids: ['flavor-1'],
          blocking_issues: [
            {
              code: 'FLAVOR_INVENTORY_MAPPING_MISSING',
              severity: 'blocking',
              message: 'Flavor inventory mapping missing for flavor-1.',
              flavor_name: 'Cheese',
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);

    expect(screen.getByText('Not ready: missing setup for Cheese.')).toBeInTheDocument();
    expect(screen.queryByText(/flavor-1/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('shows no readiness message and allows add-to-cart when live_ready is true', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([slotVariant({ flavors: [], flavor_slots: [], live_ready: true, readiness_code: 'READY', missing_flavor_ids: [] })]),
      isLoading: false,
    });
    render(<TerminalPage />);

    expect(screen.queryByText('Inventory setup incomplete.')).not.toBeInTheDocument();
    expect(screen.queryByText('Flavor inventory mapping incomplete.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });
});

describe('TerminalPage — flavor slot selection', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('renders two selectors for a two-slot variant with correct labels', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(screen.getByText('Snack 1 Flavor')).toBeInTheDocument();
    expect(screen.getByText('Snack 2 Flavor')).toBeInTheDocument();
  });

  it('renders three selectors for a three-slot variant', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({
          flavor_slots: [
            { slot_index: 1, label: 'Slot 1', required: true, snack_options: [] as SnackOption[] },
            { slot_index: 2, label: 'Slot 2', required: true, snack_options: [] as SnackOption[] },
            { slot_index: 3, label: 'Slot 3', required: true, snack_options: [] as SnackOption[] },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(screen.getByText('Slot 1')).toBeInTheDocument();
    expect(screen.getByText('Slot 2')).toBeInTheDocument();
    expect(screen.getByText('Slot 3')).toBeInTheDocument();
  });

  it('shows flavor options only for the snack chosen in that slot, and changes them when the snack changes', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({
          flavor_slots: [
            {
              slot_index: 1,
              label: 'Snack 1 Flavor',
              required: true,
              snack_options: [
                {
                  product_variant_id: 'snack-1a',
                  product_name: 'Flavored Fries',
                  variant_name: 'Small',
                  flavors: [{ flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 }],
                },
                {
                  product_variant_id: 'snack-1b',
                  product_name: 'Potato Twister',
                  variant_name: 'Small',
                  flavors: [{ flavor_id: 'flavor-3', name: 'Sour Cream', color_hex: null, price_premium: 0 }],
                },
              ],
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Flavored Fries (Small)'));
    expect(screen.getByText('Cheese')).toBeInTheDocument();
    expect(screen.queryByText('Sour Cream')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Potato Twister (Small)'));
    expect(screen.queryByText('Cheese')).not.toBeInTheDocument();
    expect(screen.getByText('Sour Cream')).toBeInTheDocument();
  });

  it('disables Add to Cart until every slot has both a snack and a flavor selected', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(screen.getByRole('button', { name: 'Add to Cart' })).toBeDisabled();

    fireEvent.click(screen.getByText('Flavored Fries (Small)'));
    fireEvent.click(screen.getByText('Cheese'));
    expect(screen.getByRole('button', { name: 'Add to Cart' })).toBeDisabled();
  });

  it('enables Add to Cart once every slot is selected and submits slot_index/snack_product_variant_id/flavor_id mappings', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Flavored Fries (Small)'));
    fireEvent.click(screen.getByText('Cheese'));
    fireEvent.click(screen.getByText('Potato Twister (Small)'));
    fireEvent.click(screen.getByText('BBQ'));

    const addButton = screen.getByRole('button', { name: 'Add to Cart' });
    expect(addButton).not.toBeDisabled();
    fireEvent.click(addButton);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [
        { slot_index: 1, snack_product_variant_id: 'snack-1a', flavor_id: 'flavor-1' },
        { slot_index: 2, snack_product_variant_id: 'snack-2a', flavor_id: 'flavor-2' },
      ],
      quantity: 1,
    });
  });

  it('clears the previously chosen flavor for a slot when the snack for that slot changes', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        slotVariant({
          flavor_slots: [
            {
              slot_index: 1,
              label: 'Snack 1 Flavor',
              required: true,
              snack_options: [
                {
                  product_variant_id: 'snack-1a',
                  product_name: 'Flavored Fries',
                  variant_name: 'Small',
                  flavors: [{ flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 }],
                },
                {
                  product_variant_id: 'snack-1b',
                  product_name: 'Potato Twister',
                  variant_name: 'Small',
                  flavors: [{ flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 }],
                },
              ],
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Flavored Fries (Small)'));
    fireEvent.click(screen.getByText('Cheese'));
    fireEvent.click(screen.getByText('Potato Twister (Small)'));

    // The snack changed, so the prior flavor selection for this slot no longer applies.
    expect(screen.getByRole('button', { name: 'Add to Cart' })).toBeDisabled();
  });

  it('shows zero flavor selectors for a zero-flavor variant and allows normal add', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('preserves the existing single-flavor flow for a variant with no slots', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([slotVariant({ flavor_slots: [] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(screen.getByText('Cheese')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cheese'));
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      flavor_id: 'flavor-1',
      quantity: 1,
    });
  });

  it('displays each selected slot/snack/flavor mapping in the cart summary', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_flavors: [
          { slot_index: 1, snack_product_variant_id: 'snack-1a', flavor_id: 'flavor-1' },
          { slot_index: 2, snack_product_variant_id: 'snack-2a', flavor_id: 'flavor-2' },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);
    expect(screen.getByText('Snack 1 Flavor: Flavored Fries (Small) — Cheese')).toBeInTheDocument();
    expect(screen.getByText('Snack 2 Flavor: Potato Twister (Small) — BBQ')).toBeInTheDocument();
  });
});

// CR-008 Product Option Groups (Task 21) — generic Option Group/Option
// selector, distinct from the legacy standalone Flavor system exercised
// above.
type OptionGroup = PosCatalogProduct['variants'][number]['option_groups'][number];

function optionGroup(overrides: Partial<OptionGroup> = {}): OptionGroup {
  return {
    id: 'group-1',
    name: 'Size',
    pos_button_label: null,
    selection_type: 'SINGLE',
    min_selections: 1,
    max_selections: 1,
    required: true,
    options: [
      { id: 'opt-1', name: 'Small', price_adjustment: 0, sort_order: 1, is_active: true },
      { id: 'opt-2', name: 'Large', price_adjustment: 20, sort_order: 2, is_active: true },
    ],
    ...overrides,
  };
}

function optionVariant(overrides: Partial<PosCatalogProduct['variants'][number]> = {}): PosCatalogProduct['variants'][number] {
  return {
    id: 'variant-1',
    name: 'Regular',
    size_label: 'Regular',
    price: 80,
    vatable_cap_amount: null,
    live_ready: true,
    readiness_code: 'READY',
    missing_flavor_ids: [],
    readiness_status: 'READY',
    completion_percentage: 100,
    blocking_issues: [],
    readiness_warnings: [],
    flavors: [],
    flavor_slots: [],
    option_groups: [optionGroup()],
    ...overrides,
  };
}

// Task 107 — add-ons are chosen BEFORE the item reaches the cart. Tapping a
// product with assigned Product Option Groups opens the Add-ons dialog
// instead of adding immediately; the product quantity is split into
// independent cart lines, one per distinct add-on combination.
describe('TerminalPage — Add-ons dialog splits into cart lines before adding (Task 107)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('adds normally with no dialog when the variant has no option groups', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('opens the Add-ons dialog instead of adding to the cart when the variant has option groups assigned', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Large (+₱20.00)')).toBeInTheDocument();
  });

  it('keeps Add disabled until the required Flavor/Size group has a selection', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(screen.getByText('Small'));
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
  });

  // Task 182 — the top-level product Quantity control (and the per-choice
  // minus/zero/plus allocator it drove) is gone for a required
  // SINGLE-selection group; each option renders as one checkbox-style row.
  it('renders a required SINGLE-selection group as checkbox rows with no Quantity control and no per-option allocator', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.queryByText('Quantity')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Increase quantity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decrease quantity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Increase Small quantity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decrease Small quantity' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Small/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Large/ })).toBeInTheDocument();
  });

  it('selecting the required Flavor/Size option adds the product to the cart at quantity 1', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Small'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 }],
      quantity: 1,
    });
  });

  it('selecting another Flavor/Size option replaces the previous selection — never both at once', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Small'));
    fireEvent.click(screen.getByText('Large (+₱20.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 }],
      quantity: 1,
    });
  });

  it('an optional (non-required) Flavor/Size group leaves Add enabled with no selection', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ min_selections: 0, required: false })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('does not show a No Add-ons choice for a required group', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.queryByText('No Add-ons')).not.toBeInTheDocument();
  });

  it('cancelling the dialog adds nothing to the cart', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('uses the configured pos_button_label as the group heading instead of the internal name', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Fries Add-ons')).toBeInTheDocument();
    expect(screen.queryByText('Flavor Fries')).not.toBeInTheDocument();
  });

  it('shows the selected option name and price adjustment in the cart, and folds the adjustment into the line total', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);

    expect(screen.getByText('Size: Large (+₱20.00)')).toBeInTheDocument();
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '80' } });
    expect(screen.getByText('Cash tendered is ₱20.00 short.')).toBeInTheDocument();
  });

  it('never shows a post-cart Add-ons editor button on an existing cart line', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);

    expect(screen.queryByRole('button', { name: /^Size/ })).not.toBeInTheDocument();
  });
});

// Task 108 — editing a cart line reopens the SAME Add-ons dialog used before
// adding, preloaded with that line's product/variant/flavor, quantity, and
// option choices; saving replaces only that one cart line (never appends or
// duplicates), and still runs the existing merge-if-identical logic after.
describe('TerminalPage — Edit reuses the Add-ons dialog to change a cart line (Task 108)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockReplaceItem.mockClear();
  });

  afterEach(() => cleanup());

  it('shows an Edit button on a cart line whose variant has assignable option groups', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('does not show an Edit button on a cart line whose variant has no option groups', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [] })]), isLoading: false });
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('preloads the dialog with the cart line current option selection (not quantity), and labels the confirm button Save', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 2,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Preloaded selection (Large) already satisfies the required group — Save starts enabled. No quantity control to preload/show (Task 182).
    expect(screen.getByRole('checkbox', { name: /Large/ })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Increase quantity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('Save with no changes replaces the one cart line via replaceItem, never addItem', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        ],
        quantity: 2,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(mockReplaceItem).toHaveBeenCalledTimes(1);
    expect(mockReplaceItem).toHaveBeenCalledWith(0, [
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        ],
        quantity: 2,
      },
    ]);
  });

  // Task 182 — quantity is never touched by this dialog; changing the
  // required Flavor/Size selection during Edit must replace the option
  // while leaving the cart line's existing quantity exactly as it was.
  it('editing the Flavor/Size selection preserves the existing cart line quantity', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        ],
        quantity: 2,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('Large (+₱20.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockReplaceItem).toHaveBeenCalledTimes(1);
    expect(mockReplaceItem).toHaveBeenCalledWith(0, [
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 2,
      },
    ]);
  });

  it('Cancel from edit mode leaves the cart untouched', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        ],
        quantity: 2,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(mockReplaceItem).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('Delete on a cart line still removes it (unchanged by the Edit addition)', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        ],
        quantity: 2,
      },
    ]);
    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: /Remove Mega Mix Fries from cart/ })).toBeInTheDocument();
  });
});

// Task 131 — a Product Option Group matching the Add-ons naming rule
// (name/pos_button_label containing "Add-on") gets a simplified optional
// multi-select in the Add-ons dialog instead of the legacy per-choice
// quantity allocator exercised above by the "Size" group: no Product
// Quantity control, no Assigned N/N text, Add enabled with zero selections,
// and any number of options selectable together on one product line.
function addOnsGroup(overrides: Partial<OptionGroup> = {}): OptionGroup {
  return optionGroup({
    id: 'addons-group',
    name: 'Add-ons',
    pos_button_label: null,
    selection_type: 'MULTIPLE',
    min_selections: 0,
    max_selections: null,
    required: false,
    options: [
      { id: 'cheese', name: 'Cheese', price_adjustment: 10, sort_order: 1, is_active: true },
      { id: 'bbq', name: 'BBQ', price_adjustment: 10, sort_order: 2, is_active: true },
      { id: 'sour-cream', name: 'Sour Cream', price_adjustment: 0, sort_order: 3, is_active: true },
    ],
    ...overrides,
  });
}

describe('TerminalPage — Add-ons group simplified optional multi-select (Task 131)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockReplaceItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('renders no Product Quantity control and no Assigned N/N text for a variant with only an Add-ons group', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.queryByRole('button', { name: 'Increase quantity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decrease quantity' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Assigned \d+ \/ \d+/)).not.toBeInTheDocument();
  });

  it('Add is enabled with zero add-ons selected — the product can be sold with No Add-ons', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('one selected add-on is added once on the product line', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
      ],
      quantity: 1,
    });
  });

  it('multiple add-ons can be selected together on one product line — never split into separate lines', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByText('BBQ (+₱10.00)'));
    fireEvent.click(screen.getByText('Sour Cream'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'bbq', option_name: 'BBQ', price_adjustment: 10 },
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'sour-cream', option_name: 'Sour Cream', price_adjustment: 0 },
      ],
      quantity: 1,
    });
  });

  it('selecting No Add-ons after choosing options clears the selection', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByText('No Add-ons'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('selecting an add-on after No Add-ons results in only that add-on being applied', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('No Add-ons'));
    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
      ],
      quantity: 1,
    });
  });

  it('quantity 3 with one selected add-on scales the line total ×3 in the cart preview', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
        ],
        quantity: 3,
      },
    ]);
    render(<TerminalPage />);

    // unit price 80 + 10 = 90; ×3 = 270, short ₱20 of a ₱250 cash tender.
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '250' } });
    expect(screen.getByText('Cash tendered is ₱20.00 short.')).toBeInTheDocument();
  });

  it('Edit preloads every selected add-on for the group', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
          { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'bbq', option_name: 'BBQ', price_adjustment: 10 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Re-toggling Cheese off, then Save, must leave only BBQ selected.
    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockReplaceItem).toHaveBeenCalledWith(0, [
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'bbq', option_name: 'BBQ', price_adjustment: 10 },
        ],
        quantity: 1,
      },
    ]);
  });

  it('Edit can clear all add-ons via No Add-ons', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [addOnsGroup()] })]), isLoading: false });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByText('No Add-ons'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockReplaceItem).toHaveBeenCalledWith(0, [{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
  });

  it('a required, SINGLE-selection Add-ons-named group is still treated as optional (No Add-ons shown, Add enabled with zero selections)', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({ option_groups: [addOnsGroup({ selection_type: 'SINGLE', min_selections: 1, max_selections: 1, required: true })] }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('No Add-ons')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
  });

  it('a variant with both a required Size group and an Add-ons group keeps Size as a required checkbox selection while the Add-ons group stays a simplified multi-select', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup(), addOnsGroup()] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    // No top-level product Quantity control (Task 182) — Size (required)
    // still gates Add via its own checkbox selection, unaffected by Add-ons.
    expect(screen.queryByRole('button', { name: 'Increase quantity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(screen.getByText('Small'));
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();

    fireEvent.click(screen.getByText('Cheese (+₱10.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        { option_group_id: 'addons-group', option_group_name: 'Add-ons', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 10 },
      ],
      quantity: 1,
    });
  });
});

// Task 182 — fixes the POS product-option popup: removes the duplicate
// top-level product Quantity control (quantity now only ever changes from
// the cart), converts a required SINGLE-selection group (e.g. Flavor) to
// checkbox-style single-select, and preserves the allocator for a genuine
// multi-slot (MULTIPLE, required) group.
function multiSlotGroup(overrides: Partial<OptionGroup> = {}): OptionGroup {
  return optionGroup({
    id: 'toppings-group',
    name: 'Toppings',
    pos_button_label: null,
    selection_type: 'MULTIPLE',
    min_selections: 2,
    max_selections: 2,
    required: true,
    options: [
      { id: 'top-a', name: 'Topping A', price_adjustment: 5, sort_order: 1, is_active: true },
      { id: 'top-b', name: 'Topping B', price_adjustment: 5, sort_order: 2, is_active: true },
    ],
    ...overrides,
  });
}

describe('TerminalPage — POS product-option popup fixes (Task 182)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('a genuine multi-slot (MULTIPLE, required) group retains the per-choice quantity allocator instead of checkbox rows', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant({ option_groups: [multiSlotGroup()] })]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Increase Topping A quantity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Topping B quantity' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Topping A/ })).not.toBeInTheDocument();
    expect(screen.getByText('Assigned 0 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Increase Topping A quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Topping B quantity' }));
    expect(screen.getByText('Assigned 2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(2);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'toppings-group', option_group_name: 'Toppings', option_id: 'top-a', option_name: 'Topping A', price_adjustment: 5 },
      ],
      quantity: 1,
    });
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'toppings-group', option_group_name: 'Toppings', option_id: 'top-b', option_name: 'Topping B', price_adjustment: 5 },
      ],
      quantity: 1,
    });
  });

  it('the Add-ons dialog uses viewport-safe responsive sizing classes', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('w-[calc(100vw-2rem)]');
    expect(dialog.className).toContain('max-w-md');
    expect(dialog.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(dialog.className).toContain('overflow-y-auto');
  });

  // Task 193B — a variant carrying two independent required MULTIPLE groups
  // (e.g. a real Mega-size Flavor group needing 2 picks alongside a separate
  // required Sauce group needing 1) satisfies isValid per-group, but
  // handleAddOnsConfirm forced every legacy group through splitAddOnLines
  // using one shared quantity (the max target across groups). Any group
  // whose own assigned total falls short of that shared max fails
  // splitAddOnLines's internal per-group length check, silently returning no
  // lines at all — the item never reaches the cart despite a fully valid,
  // Add-enabled selection.
  it('two required MULTIPLE groups with different targets still add the item to the cart', () => {
    const flavorGroup = multiSlotGroup({
      id: 'flavor-group',
      name: 'Flavor',
      min_selections: 2,
      max_selections: 2,
      options: [
        { id: 'flavor-a', name: 'Cheese', price_adjustment: 0, sort_order: 1, is_active: true },
        { id: 'flavor-b', name: 'Sour Cream', price_adjustment: 0, sort_order: 2, is_active: true },
      ],
    });
    const sauceGroup = multiSlotGroup({
      id: 'sauce-group',
      name: 'Sauce',
      min_selections: 1,
      max_selections: 1,
      options: [{ id: 'sauce-a', name: 'Ketchup', price_adjustment: 0, sort_order: 1, is_active: true }],
    });
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [flavorGroup, sauceGroup] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByRole('button', { name: 'Increase Cheese quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Sour Cream quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Ketchup quantity' }));

    expect(screen.getByText('Assigned 2 / 2')).toBeInTheDocument();
    expect(screen.getByText('Assigned 1 / 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalled();
  });
});

// Task 139 — GCash, Maya, and Other are unified onto one photo-proof-only
// flow: no reference number or note field for any of them, matching cash's
// simplicity of "one input, then Charge".
describe('TerminalPage — GCash, Maya, and Other payment methods (proof-only, Task 139)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockUploadPaymentProofMutateAsync.mockClear();
    mockCreateTransactionMutateAsync.mockClear();
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
  });

  afterEach(() => cleanup());

  // Radix TabsTrigger activates on mousedown, not click — fireEvent.click
  // alone never fires it (see fireEvent.click's lack of a mousedown step).
  function selectTab(name: string) {
    fireEvent.mouseDown(screen.getByRole('tab', { name }));
  }

  it('shows GCash with only a Payment Proof upload — no reference number field', () => {
    render(<TerminalPage />);
    openCheckout();
    selectTab('GCash');

    expect(screen.getByText('Payment Proof')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take photo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload from gallery/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/reference number/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/manually verified/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('shows Maya with only a Payment Proof upload — no reference number field', () => {
    render(<TerminalPage />);
    openCheckout();
    selectTab('Maya');

    expect(screen.getByText('Payment Proof')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/reference number/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/manually verified/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('shows Other with only a Payment Proof upload — no reference/note field, same as GCash/Maya', () => {
    render(<TerminalPage />);
    openCheckout();
    selectTab('Other');

    expect(screen.getByText('Payment Proof')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take photo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload from gallery/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/reference or note/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('keeps Charge disabled for GCash/Maya/Other until payment proof is captured, with cash unaffected', () => {
    render(<TerminalPage />);
    openCheckout();
    // Cash is unchanged — still gated on cash tendered alone.
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();

    selectTab('Other');
    expect(screen.getByText('Upload payment proof before continuing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('uploads a gallery photo as payment proof for Other and enables Charge, sending payment_proof_key/type with no reference fields', async () => {
    render(<TerminalPage />);
    openCheckout();
    selectTab('Other');

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mockUploadPaymentProofMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync) as CreateTransactionInput;
    expect(payload.payment_method).toBe('other');
    expect(payload.payment_proof_key).toBe('branch-1/shift-1/user-1-123.webp');
    expect(payload.payment_proof_type).toBe('gallery_upload');
    expect(payload).not.toHaveProperty('gcash_reference_number');
    expect(payload).not.toHaveProperty('other_reference_note');
    expect(payload).not.toHaveProperty('gcash_manually_verified');
  });

  it('preserves cart and payment method when the proof upload fails, and allows retry without recapturing', async () => {
    mockUploadPaymentProofMutateAsync.mockRejectedValueOnce(new Error('Network error'));
    render(<TerminalPage />);
    openCheckout();
    selectTab('Other');

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
    // Cart and payment method tab are untouched by the failed upload —
    // nothing was lost, and the selected photo is still attached for retry.
    expect(screen.getByRole('tab', { name: 'Other' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
    expect(screen.getByAltText('Preview')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry Upload' }));
    await waitFor(() => expect(mockUploadPaymentProofMutateAsync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled());
  });

  it('preserves cash tendered when switching to an online method and back', () => {
    render(<TerminalPage />);
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });

    selectTab('Other');
    expect(screen.queryByPlaceholderText('Cash tendered')).not.toBeInTheDocument();

    selectTab('Cash');
    expect(screen.getByPlaceholderText('Cash tendered')).toHaveValue(100);
  });

  it('never requires payment proof for cash — cash charge is unaffected by the proof-capture flow', () => {
    render(<TerminalPage />);
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });

    expect(screen.queryByText('Payment Proof')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(mockUploadPaymentProofMutateAsync).not.toHaveBeenCalled();
  });
});

// Task 209.5 — PWD/Senior Citizen discount-proof capture, reusing the same
// ImageUpload component and Confirm/Retry flow as the payment-proof tests
// above. Proof is optional (no proof-required policy exists yet — see
// DISCOUNT_PROOF_REQUIREMENT_POLICY_MISSING), so Charge must never be
// gated on it.
describe('TerminalPage — PWD/Senior Citizen discount-proof capture (Task 209.5)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockUploadDiscountProofMutateAsync.mockClear();
    mockCreateTransactionMutateAsync.mockClear();
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
  });

  afterEach(() => cleanup());

  function selectDiscount(label: string) {
    fireEvent.click(screen.getByRole('button', { name: label }));
  }

  it('shows the PWD/Senior ID input and an optional Discount ID Proof upload once PWD is selected', () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('PWD (20%)');

    expect(screen.getByPlaceholderText('PWD / Senior Citizen ID number')).toBeInTheDocument();
    expect(screen.getByText('Discount ID Proof')).toBeInTheDocument();
    expect(screen.getByText(/Optional/i)).toBeInTheDocument();
  });

  it('never shows the discount ID input or proof upload for a non-PWD/Senior discount (e.g. Employee)', () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('Employee (20%)');

    expect(screen.queryByPlaceholderText('PWD / Senior Citizen ID number')).not.toBeInTheDocument();
    expect(screen.queryByText('Discount ID Proof')).not.toBeInTheDocument();
  });

  it('enables Charge for a PWD discount once the ID number and cash tendered are filled, with no proof attached — proof is optional', () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('PWD (20%)');
    fireEvent.change(screen.getByPlaceholderText('PWD / Senior Citizen ID number'), { target: { value: 'PWD-000123' } });
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(mockUploadDiscountProofMutateAsync).not.toHaveBeenCalled();
  });

  it('still blocks Charge on a missing PWD/Senior ID number even when no proof is required', () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('Senior Citizen (20%)');
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('uploads a gallery photo as discount proof and sends discount_proof_key/type alongside discount_type/discount_id_reference', async () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('Senior Citizen (20%)');
    fireEvent.change(screen.getByPlaceholderText('PWD / Senior Citizen ID number'), { target: { value: 'SC-000456' } });
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mockUploadDiscountProofMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Discount ID proof attached')).toBeInTheDocument());
    // Optional proof never blocks Charge either before or after capture.
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync) as CreateTransactionInput;
    expect(payload.discount_type).toBe('senior_citizen');
    expect(payload.discount_id_reference).toBe('SC-000456');
    expect(payload.discount_proof_key).toBe('branch-1/shift-1/user-1-456.webp');
    expect(payload.discount_proof_type).toBe('gallery_upload');
  });

  it('preserves the discount selection and cart when the discount-proof upload fails, and allows retry without recapturing', async () => {
    mockUploadDiscountProofMutateAsync.mockRejectedValueOnce(new Error('Network error'));
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('PWD (20%)');
    fireEvent.change(screen.getByPlaceholderText('PWD / Senior Citizen ID number'), { target: { value: 'PWD-000123' } });
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
    // Discount selection, ID number, and cart are untouched by the failed
    // upload — same as payment proof's failure-preservation behavior.
    expect(screen.getByPlaceholderText('PWD / Senior Citizen ID number')).toHaveValue('PWD-000123');
    expect(screen.queryByText('Discount ID proof attached')).not.toBeInTheDocument();
    // Charge stays enabled throughout — a failed optional-proof upload must
    // never block an otherwise-valid PWD/Senior sale.
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry Upload' }));
    await waitFor(() => expect(mockUploadDiscountProofMutateAsync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Discount ID proof attached')).toBeInTheDocument());
  });

  it('Replace clears the attached proof and shows the upload control again', async () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('PWD (20%)');
    fireEvent.change(screen.getByPlaceholderText('PWD / Senior Citizen ID number'), { target: { value: 'PWD-000123' } });

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('Discount ID proof attached')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    expect(screen.queryByText('Discount ID proof attached')).not.toBeInTheDocument();
    expect(screen.getByText('Discount ID Proof')).toBeInTheDocument();
  });

  it('never sends discount_proof_key/type when the discount type is switched away from PWD/Senior, even if a proof was already attached', async () => {
    render(<TerminalPage />);
    openCheckout();
    selectDiscount('PWD (20%)');
    fireEvent.change(screen.getByPlaceholderText('PWD / Senior Citizen ID number'), { target: { value: 'PWD-000123' } });

    const file = new File(['fake-image'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockUploadDiscountProofMutateAsync).toHaveBeenCalledTimes(1));

    selectDiscount('No discount');
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync) as CreateTransactionInput;
    expect(payload.discount_type).toBeUndefined();
    expect(payload.discount_proof_key).toBeUndefined();
    expect(payload.discount_proof_type).toBeUndefined();
  });

  it('never requires discount proof for a cash sale with no discount at all', () => {
    render(<TerminalPage />);
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    expect(screen.queryByText('Discount ID Proof')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(mockUploadDiscountProofMutateAsync).not.toHaveBeenCalled();
  });
});

// Single clean cashier workflow (Phase 4-9, finalized): Clock In -> Ready to
// Sell, entirely inside POS Terminal — no separate Clock In page/redirect,
// and no shift/shift-ownership requirement. The API auto-manages the shift
// server-side (shiftGuard), so a not-yet-loaded client-side shift lookup
// must never block Charge.
describe('TerminalPage — attendance guard and inline Clock In', () => {
  beforeEach(() => {
    mockCartItems.mockReturnValue([]);
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
  });

  afterEach(() => cleanup());

  it('shows an inline Clock In card (not the catalog) when the cashier has no active attendance record', () => {
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });

    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: 'Clock In' })).toBeInTheDocument();
    expect(screen.queryByText('Mega Mix Fries')).not.toBeInTheDocument();
  });

  it('clocks in from inside POS and never navigates to a separate page', async () => {
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });
    render(<TerminalPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Clock In' }));
    await vi.waitFor(() => expect(mockClockInMutateAsync).toHaveBeenCalledWith({ employee_id: 'user-1', branch_id: 'branch-1', gps_lat: 14.5, gps_lng: 121.0 }));
  });

  it('loads the catalog and a Clock Out action when the cashier is clocked in', () => {
    render(<TerminalPage />);

    expect(screen.getByText('Mega Mix Fries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clock Out/ })).toBeInTheDocument();
  });

  it('never blocks Charge on the active-shift lookup — the API auto-manages the shift server-side', () => {
    mockUseMyActiveShift.mockReturnValue({ shift: null, isLoading: false });
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);

    render(<TerminalPage />);
    openCheckout();
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });

    expect(screen.getAllByText('Mega Mix Fries').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
  });

  it('shows a loading state instead of the catalog or the Clock In card while attendance status is still resolving', () => {
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: true });

    render(<TerminalPage />);

    expect(screen.queryByText('Mega Mix Fries')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock In' })).not.toBeInTheDocument();
  });
});

// Section 1 of the production fix: the Charge button must never be
// silently disabled — a clear, specific reason always renders above it.
describe('TerminalPage — Charge disabled-reason messaging (cash)', () => {
  beforeEach(() => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
  });

  afterEach(() => cleanup());

  it('disables Checkout with "Add items to the cart to start a sale." for an empty cart, never reaching the workspace\'s Charge control', () => {
    mockCartItems.mockReturnValue([]);
    render(<TerminalPage />);

    expect(screen.getByText('Add items to the cart to start a sale.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Checkout/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Charge/ })).not.toBeInTheDocument();
  });

  it('disables Charge with "Enter cash tendered." when cash is selected and tendered is blank', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 13 }]);
    render(<TerminalPage />);
    openCheckout();

    expect(screen.getByText('Enter cash tendered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('disables Charge and shows the shortfall when cash tendered is below the total', () => {
    // 13 x price 100 = 1300 total (no VAT-cap flavors involved here).
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 13 }]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
    expect(screen.getByText(/short\.$/)).toBeInTheDocument();
  });

  it('enables Charge and shows change once cash tendered covers the total exactly', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });

    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(screen.getByText('Change: ₱0.00')).toBeInTheDocument();
  });

  it('enables Charge and computes change when cash tendered exceeds the total', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '150' } });

    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(screen.getByText('Change: ₱50.00')).toBeInTheDocument();
  });
});

// Task 26 — selected Product Option IDs are transported from the POS cart to
// the checkout payload as selected_option_ids, ID-only (display metadata
// stays frontend-only, per Task 21's cart.store.ts comment).
/** Convention shared with apps/api's test suite: a throwing helper instead of `!` under noUncheckedIndexedAccess. */
function firstOf<T>(arr: readonly T[]): T {
  const [head] = arr;
  if (head === undefined) throw new Error('expected a non-empty array');
  return head;
}

/** First argument of a mock's first call — combines two firstOf lookups (call, then arg). */
function firstCallArg(mockFn: { mock: { calls: unknown[][] } }): CreateTransactionInput {
  return firstOf(firstOf(mockFn.mock.calls)) as CreateTransactionInput;
}

describe('TerminalPage — checkout payload selected_option_ids (Task 26)', () => {
  beforeEach(() => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    mockCreateTransactionMutateAsync.mockClear();
  });

  afterEach(() => cleanup());

  it('includes selected_option_ids (IDs only) for a cart item carrying selected_options', async () => {
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync);
    expect(payload.items).toEqual([
      expect.objectContaining({
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_option_ids: ['opt-2'],
      }),
    ]);
    // Display metadata/price adjustments must never be forwarded as trusted fields.
    const item = firstOf(payload.items);
    expect(item).not.toHaveProperty('selected_options');
    expect(item).not.toHaveProperty('option_name');
    expect(item).not.toHaveProperty('price_adjustment');
  });

  it('omits selected_option_ids for a cart item with no options selected', async () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync);
    expect(firstOf(payload.items)).not.toHaveProperty('selected_option_ids');
  });

  it('leaves the existing selected_flavors payload behavior unchanged', async () => {
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        flavor_id: 'flavor-1',
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync);
    expect(firstOf(payload.items)).toEqual(
      expect.objectContaining({ product_id: 'product-1', product_variant_id: 'variant-1', flavor_id: 'flavor-1' }),
    );
  });
});

// Task 209.3 — Charge reliability: the cart/payment selections a cashier
// already entered must never be silently thrown away on a failed charge
// (auth failure, network failure, or a server-side rejection all surface as
// a rejected mutateAsync the same way — see api-client.ts's error mapping),
// and a confirmed success must clear the cart exactly once. Processing state
// must disable Charge and make a second submit impossible.
describe('TerminalPage — Charge reliability and cart preservation (Task 209.3)', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: STAFF_USER, selectEmployee: mockSelectEmployee });
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'staff-token', isAuthenticated: true, isLoading: false });
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    mockCreateTransactionMutateAsync.mockClear();
    mockClearCart.mockClear();
    mockCreateTransactionIsPending.mockReturnValue(false);
  });

  // Reset the pending-flag override back to the file-wide default (false)
  // after every test in this block — otherwise the "Processing…" test's
  // override leaks into later describe blocks that assume Charge always
  // reads "Charge" (mocks are module-scoped, not reset automatically
  // between describes without this).
  afterEach(() => {
    mockCreateTransactionIsPending.mockReturnValue(false);
    cleanup();
  });

  it('keeps the cart intact and shows a human-readable error when the charge is rejected (session expired)', async () => {
    mockCreateTransactionMutateAsync.mockRejectedValueOnce(new Error('Session expired. Please sign in again.'));
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Session expired. Please sign in again.')).toBeInTheDocument());

    // Cart must not be cleared on a failed charge — the cashier still has the
    // same line items and can retry (or, for a session-expired failure,
    // re-login and manually press Charge again — never auto-resubmitted).
    expect(mockClearCart).not.toHaveBeenCalled();
    // No raw JWT/backend internals in the surfaced message.
    expect(screen.queryByText(/jwt|token|prisma|stack/i)).not.toBeInTheDocument();
  });

  it('keeps the cart intact when the charge fails on a network error', async () => {
    mockCreateTransactionMutateAsync.mockRejectedValueOnce(new Error('Could not reach the server. Please check your connection before trying again.'));
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument());
    expect(mockClearCart).not.toHaveBeenCalled();
  });

  it('clears the cart exactly once, only after a confirmed successful charge', async () => {
    mockCreateTransactionMutateAsync.mockResolvedValueOnce({ id: 'txn-1', receipt_number: 'BR-001' });
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockClearCart).toHaveBeenCalledTimes(1));
  });

  it('disables Charge and shows "Processing…" while the mutation is pending, so a second click cannot submit again', () => {
    mockCreateTransactionIsPending.mockReturnValue(true);
    render(<TerminalPage />);
    openCheckout();

    const chargeButton = screen.getByRole('button', { name: /Processing/ });
    expect(chargeButton).toBeDisabled();

    fireEvent.click(chargeButton);
    fireEvent.click(chargeButton);
    expect(mockCreateTransactionMutateAsync).not.toHaveBeenCalled();
  });

  // Task 209.55A — regression test for a real double-submit reproduced via
  // rapid double-click/double-tap: useMutation()'s `isPending` is a snapshot
  // from the render that bound the current onClick, so it does NOT update
  // synchronously between two click events fired back-to-back in the same
  // tick, before React re-renders with mockCreateTransactionIsPending's next
  // value. Both `fireEvent.click` calls below run before either awaited
  // handleCharge() resolves, exactly reproducing that window — this test
  // fails without the isChargingRef synchronous guard in handleCharge.
  it('calls the charge mutation only once when the Charge button is clicked twice in rapid succession', () => {
    let resolveMutate: (value: unknown) => void = () => {};
    mockCreateTransactionMutateAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMutate = resolve;
      }),
    );
    render(<TerminalPage />);
    openCheckout();

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    const chargeButton = screen.getByRole('button', { name: /^Charge/ });
    fireEvent.click(chargeButton);
    fireEvent.click(chargeButton);

    expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1);
    resolveMutate({ id: 'txn-1', receipt_number: 'BR-001' });
  });
});

// Task 120: a `branch` (Branch Account) session sees "Who is working?"
// right inside POS Terminal — no separate /branch/select-employee route/
// redirect — and selecting an Employee there never authenticates as anyone
// else: it only sets terminal-local "active employee" state. The Branch
// Account's own session (useAuthStore) is never touched by any of this. A
// `staff` session (already bound to one Employee) never sees this at all,
// covered by the STAFF_USER default in the top-level beforeEach above.
describe('TerminalPage — embedded "Who is working?" (Branch Account sessions)', () => {
  function employee(overrides: Record<string, unknown> = {}) {
    return { id: 'employee-1', first_name: 'Jane', last_name: 'Doe', position: 'Cashier', ...overrides };
  }

  function selectEmployeeResult(overrides: Record<string, unknown> = {}) {
    return {
      user: { id: 'employee-1', role: 'staff' as const, email: null, firstName: 'Jane', lastName: 'Doe', branchIds: ['branch-1'] },
      accessToken: 'employee-token',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: BRANCH_USER, selectEmployee: mockSelectEmployee });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });
    useAuthStore.setState({ user: BRANCH_USER, accessToken: 'branch-token', isAuthenticated: true, isLoading: false });
    mockUseClockIn.mockClear();
    mockUseClockOut.mockClear();
    mockUseCreateTransaction.mockClear();
  });

  afterEach(() => cleanup());

  it('shows "Who\'s working?" and active employees instead of the catalog or Clock In card', () => {
    mockUseEmployees.mockReturnValue({ data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<TerminalPage />);

    expect(screen.getByText("Who's working?")).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Cashier')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock In' })).not.toBeInTheDocument();
  });

  it('selects an employee inline (no navigation) and shows a specific error if selection fails', async () => {
    mockUseEmployees.mockReturnValue({ data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() });
    mockSelectEmployee.mockRejectedValueOnce(new Error('This employee is not active'));

    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Jane Doe'));

    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));
    expect(await screen.findByText('This employee is not active')).toBeInTheDocument();
    // Still on the same page/component — no router navigation exists to assert against.
    expect(screen.getByText("Who's working?")).toBeInTheDocument();
    // A failed selection must not have touched the Branch Account's session either.
    expect(useAuthStore.getState().user).toEqual(BRANCH_USER);
  });

  it('shows an empty state when no active employees are assigned to the branch', () => {
    mockUseEmployees.mockReturnValue({ data: { employees: [] }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<TerminalPage />);

    expect(screen.getByText('No active employees')).toBeInTheDocument();
  });

  it('never authenticates as the selected Employee — the Branch Account session is untouched before, during, and after selection', async () => {
    mockUseEmployees.mockReturnValue({ data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseCatalog.mockReturnValue({ data: catalogWith([]), isLoading: false });
    mockCartItems.mockReturnValue([]);
    mockSelectEmployee.mockResolvedValue(selectEmployeeResult());

    render(<TerminalPage />);
    expect(useAuthStore.getState().user).toEqual(BRANCH_USER);

    fireEvent.click(screen.getByText('Jane Doe'));
    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));

    // Employee selected -> falls straight into STATE 2 (Clock In), inline, no navigation.
    expect(await screen.findByText('Clock In to Start Selling')).toBeInTheDocument();
    // useIsClockedIn is now checked for the selected Employee, not the Branch Account.
    expect(mockUseIsClockedIn).toHaveBeenLastCalledWith('employee-1');
    // The authenticated user (global store) never changed.
    expect(useAuthStore.getState().user).toEqual(BRANCH_USER);
    expect(useAuthStore.getState().accessToken).toBe('branch-token');
  });

  it('clocks in and checks out using the selected Employee\'s token, never the Branch Account\'s', async () => {
    const employees = { data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() };
    mockUseEmployees.mockReturnValue(employees);
    mockUseCatalog.mockReturnValue({ data: catalogWith([]), isLoading: false });
    mockCartItems.mockReturnValue([]);
    mockSelectEmployee.mockResolvedValue(selectEmployeeResult());
    mockClockInMutateAsync.mockResolvedValue({ id: 'attendance-1' });
    mockClockOutMutateAsync.mockResolvedValue({ id: 'attendance-1' });

    const { rerender } = render(<TerminalPage />);

    fireEvent.click(screen.getByText('Jane Doe'));
    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));

    // Clock In: attendance is recorded for the selected Employee, authorized with that Employee's token.
    fireEvent.click(await screen.findByRole('button', { name: 'Clock In' }));
    await waitFor(() => expect(mockClockInMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ employee_id: 'employee-1', branch_id: 'branch-1' })));
    expect(mockUseClockIn).toHaveBeenLastCalledWith('employee-token');

    // Once clocked in, the POS/checkout hooks are wired to the same Employee token too.
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    rerender(<TerminalPage />);
    expect(mockUseCreateTransaction).toHaveBeenLastCalledWith('employee-token');
    // The active cashier shown in the attendance strip is the selected Employee, not the Branch Account.
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();

    // Clock Out: same Employee token. Wait for the whole async handler (not
    // just the mutateAsync call) to finish, since the selected-Employee
    // state only clears after it resolves — STATE 1 reappearing is proof
    // that finished, regardless of what the still-static isClockedIn mock
    // says (its guard runs before the isClockedIn check in the component).
    fireEvent.click(screen.getByRole('button', { name: /Clock Out/ }));
    expect(await screen.findByText("Who's working?")).toBeInTheDocument();
    expect(mockClockOutMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ employee_id: 'employee-1', branch_id: 'branch-1' }));
    // useClockOut was wired to the Employee's token while the sale/clock-out
    // was active — checked via the full call history, not the last call,
    // since STATE 1 reappearing re-renders with no active employee and no
    // token at all (the terminal-local state was correctly cleared).
    expect(mockUseClockOut).toHaveBeenCalledWith('employee-token');

    // Branch Account was never signed out of at any point in this flow.
    expect(useAuthStore.getState().user).toEqual(BRANCH_USER);
    expect(useAuthStore.getState().accessToken).toBe('branch-token');
  });
});

// Task 209.27 — a still clocked-in Employee must survive navigating away from
// and back to /branch/terminal (and a refresh) without "Who's working?"
// reappearing. Each test below unmounts and re-renders TerminalPage to
// simulate the route remount a real navigation causes, relying on the
// sessionStorage-backed terminal-operator store (unlike component state,
// this survives across separate render() calls the same way it survives
// across a real unmount/remount).
describe('TerminalPage — active operator restoration across navigation (Task 209.27)', () => {
  function employee(overrides: Record<string, unknown> = {}) {
    return { id: 'employee-1', first_name: 'Jane', last_name: 'Doe', position: 'Cashier', ...overrides };
  }

  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: BRANCH_USER, selectEmployee: mockSelectEmployee });
    useAuthStore.setState({ user: BRANCH_USER, accessToken: 'branch-token', isAuthenticated: true, isLoading: false });
    useTerminalOperatorStore.setState({
      branchId: null,
      employeeId: null,
      employeeToken: null,
      firstName: undefined,
      lastName: undefined,
      role: undefined,
      hasHydrated: true,
    });
    mockUseCatalog.mockReturnValue({ data: catalogWith([]), isLoading: false });
    mockCartItems.mockReturnValue([]);
    mockUseEmployees.mockReturnValue({ data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });
    mockUseClockIn.mockClear();
    mockUseClockOut.mockClear();
    mockUseCreateTransaction.mockClear();
  });

  afterEach(() => cleanup());

  async function clockInAsJane() {
    mockSelectEmployee.mockResolvedValue({
      user: { id: 'employee-1', role: 'staff' as const, email: null, firstName: 'Jane', lastName: 'Doe', branchIds: ['branch-1'] },
      accessToken: 'employee-token',
    });
    mockClockInMutateAsync.mockResolvedValue({ id: 'attendance-1' });

    const { rerender } = render(<TerminalPage />);
    fireEvent.click(screen.getByText('Jane Doe'));
    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Clock In' }));
    await waitFor(() => expect(mockClockInMutateAsync).toHaveBeenCalled());
    // The mutation resolving flips attendance to clocked-in (mirroring the
    // real query invalidation/refetch) — re-render so the terminal-operator
    // hook's own effect observes it and syncs the sessionStorage-backed
    // store before this simulated "navigate away" unmount.
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    rerender(<TerminalPage />);
    await waitFor(() => expect(useTerminalOperatorStore.getState().employeeId).toBe('employee-1'));
    cleanup();
  }

  it('2. an active (clocked-in) operator is restored on a fresh terminal mount', async () => {
    await clockInAsJane();

    render(<TerminalPage />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText("Who's working?")).not.toBeInTheDocument();
  });

  it('3. survives multiple route round-trips (Dashboard -> Inventory -> Sales -> POS)', async () => {
    await clockInAsJane();

    // Each render()/cleanup() pair simulates leaving to another route and
    // TerminalPage fully unmounting; only sessionStorage carries state across.
    render(<TerminalPage />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    cleanup();

    render(<TerminalPage />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText("Who's working?")).not.toBeInTheDocument();
    cleanup();

    render(<TerminalPage />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText("Who's working?")).not.toBeInTheDocument();
  });

  it('4. a full refresh (fresh module state, only sessionStorage persists) still restores the operator', async () => {
    await clockInAsJane();

    // Simulate a hard refresh: local component/query state is gone, but the
    // persisted store rehydrates from sessionStorage exactly like a real reload.
    useTerminalOperatorStore.persist.rehydrate();
    render(<TerminalPage />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText("Who's working?")).not.toBeInTheDocument();
  });

  it('5. a direct visit to /branch/terminal restores the operator the same as a navigated return', async () => {
    await clockInAsJane();

    // No different from any other fresh mount from this component's point of
    // view — there is no separate "direct URL" code path to exercise.
    render(<TerminalPage />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('6/7. Clock Out clears the persisted operator so it is never resurrected on refresh or return', async () => {
    await clockInAsJane();

    render(<TerminalPage />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();

    mockClockOutMutateAsync.mockResolvedValue({ id: 'attendance-1' });
    fireEvent.click(screen.getByRole('button', { name: /Clock Out/ }));
    expect(await screen.findByText("Who's working?")).toBeInTheDocument();
    expect(useTerminalOperatorStore.getState().employeeId).toBeNull();

    // Clocked out — attendance now says so for anyone who mounts next.
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });
    cleanup();

    render(<TerminalPage />);
    // Back to STATE 1 (Who's working?) — never straight back into the
    // catalog/cart, and no lingering Clock Out button for the old operator.
    expect(await screen.findByText("Who's working?")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clock Out/ })).not.toBeInTheDocument();
  });

  it('9. a persisted operator scoped to a different branch is never restored', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-2',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });

    render(<TerminalPage />);

    expect(await screen.findByText("Who's working?")).toBeInTheDocument();
    expect(useTerminalOperatorStore.getState().employeeId).toBeNull();
  });

  it('10. never flashes "Who\'s working?" while a persisted operator is still being validated', () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    // Attendance query still in flight for the persisted candidate.
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: true });

    render(<TerminalPage />);

    expect(screen.queryByText("Who's working?")).not.toBeInTheDocument();
  });
});

// Task 140 — POS Terminal entry point onto the existing Void/Refund workflow.
// Uses a SUPERVISOR session (authorized, and not the `branch` role) so the
// terminal renders directly without the "Who's working?" employee-selection
// step a `branch` account would hit first — that step is orthogonal to
// button visibility, which is covered by role alone.
describe('TerminalPage — Void / Refund Sale entry point (Task 140)', () => {
  const SUPERVISOR_USER = { id: 'user-2', role: 'supervisor' as const, branchIds: ['branch-1'], firstName: 'Sam', lastName: 'Reyes', email: 'sam@example.com' };

  beforeEach(() => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('shows the Void / Refund Sale button for an authorized role (supervisor)', () => {
    mockUseAuth.mockReturnValue({ user: SUPERVISOR_USER, selectEmployee: mockSelectEmployee });
    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: 'Void / Refund Sale' })).toBeInTheDocument();
  });

  it('hides the Void / Refund Sale button for STAFF', () => {
    mockUseAuth.mockReturnValue({ user: STAFF_USER, selectEmployee: mockSelectEmployee });
    render(<TerminalPage />);

    expect(screen.queryByRole('button', { name: 'Void / Refund Sale' })).not.toBeInTheDocument();
  });

  it('opens the Void or Refund Sale dialog when the button is clicked', () => {
    mockUseAuth.mockReturnValue({ user: SUPERVISOR_USER, selectEmployee: mockSelectEmployee });
    render(<TerminalPage />);

    expect(screen.queryByTestId('void-refund-sale-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Void / Refund Sale' }));
    expect(screen.getByTestId('void-refund-sale-dialog')).toBeInTheDocument();
  });
});

// Task 196 (visual redesign) / Task 200 (adaptive density engine) — below
// the `lg` breakpoint (or on a `mobile`-density viewport), the cart/checkout
// panel moves into a Sheet opened from a sticky "View Cart" button instead
// of rendering inline (desktop keeps the exact previous inline layout,
// covered by every test above, all of which run under the default/no-op
// matchMedia — see useDensityMode's and useHasRoomForInlineCart's comments
// in page.tsx). These tests simulate real matchMedia results, keyed by query
// string, to exercise the narrow-viewport/touch branches, which are
// otherwise never reached by this suite.
describe('TerminalPage — mobile cart Sheet (Task 196 visual redesign, Task 200 density engine)', () => {
  const originalMatchMedia = window.matchMedia;

  // Each of the density engine's 4 queries (plus the page's own
  // >=1024px "room for inline panel" check) defaults to not-matching unless
  // explicitly overridden — mirrors how a real browser only ever reports
  // `true` for the query describing its actual current state.
  function mockMatchMedia(overrides: Record<string, boolean>) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: overrides[query] ?? false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
    mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isLoading: false });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
  });

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('keeps the inline cart panel (no View Cart button) on a desktop-width, fine-pointer viewport (standard density)', () => {
    mockMatchMedia({ '(min-width: 1024px)': true, '(min-width: 1024px) and (min-height: 640px)': true });
    render(<TerminalPage />);

    expect(screen.queryByRole('button', { name: /View Cart/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Checkout/ })).toBeInTheDocument();
  });

  it('shows a sticky View Cart button instead of the inline panel on a mobile-density viewport, and opens the cart in a Sheet on tap', () => {
    mockMatchMedia({ '(max-width: 767px)': true });
    render(<TerminalPage />);

    const viewCartButton = screen.getByRole('button', { name: /View Cart/ });
    expect(viewCartButton).toBeInTheDocument();
    // Single source of truth for the cart content — not duplicated in the
    // DOM: the compact cart's own Checkout button only exists once the
    // Sheet is opened.
    expect(screen.queryByRole('button', { name: /^Checkout/ })).not.toBeInTheDocument();

    fireEvent.click(viewCartButton);
    expect(screen.getByRole('button', { name: /^Checkout/ })).toBeInTheDocument();
  });

  it('falls back to the Sheet on a narrow compact-touch viewport (touch tablet, no room for the inline panel)', () => {
    mockMatchMedia({ '(pointer: coarse), (hover: none)': true });
    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: /View Cart/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Checkout/ })).not.toBeInTheDocument();
  });

  it('keeps the inline panel on a wide, tall compact-touch viewport (touch laptop/2-in-1 with room for the panel)', () => {
    mockMatchMedia({ '(pointer: coarse), (hover: none)': true, '(min-width: 1024px) and (min-height: 640px)': true });
    render(<TerminalPage />);

    expect(screen.queryByRole('button', { name: /View Cart/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Checkout/ })).toBeInTheDocument();
  });

  // Task 209.29 (Part F) — the "room for the inline panel" check used to be
  // width-only, so a coarse-pointer tablet that's wide enough (>=1024px) but
  // too short (a constrained/split-screen landscape) was wrongly classified
  // as having room and got the two-pane Checkout Workspace squeezed into it.
  // Guards that the room check itself now queries width AND height together
  // (not just width) — a mock that only satisfies the old width-only string
  // must NOT be enough to unlock the inline panel/two-pane layout.
  it('does not treat width alone as "room for the inline panel" — the room check requires height too (Part F)', () => {
    mockMatchMedia({ '(pointer: coarse), (hover: none)': true, '(min-width: 1024px)': true });
    render(<TerminalPage />);

    expect(screen.getByRole('button', { name: /View Cart/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Checkout/ })).not.toBeInTheDocument();

    const queriedMinHeight = (window.matchMedia as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('min-width: 1024px') && call[0].includes('min-height'),
    );
    expect(queriedMinHeight).toBe(true);
  });

  // Task 209.20 — a flex item's default min-height is `auto` (its content
  // size), which lets it grow past its row's real available height instead
  // of clipping to it — the actual mechanism behind "controls only reachable
  // after excessive scrolling." This pins that the row/panel/scroll-region
  // all opt out via min-h-0, and that the cart header uses the new
  // density-aware `.app-pos-cart-header` token instead of a fixed py-2.
  it('gives the inline desktop cart panel a min-h-0 flex column and a density-aware compact header', () => {
    mockMatchMedia({ '(min-width: 1024px)': true, '(min-width: 1024px) and (min-height: 640px)': true });
    render(<TerminalPage />);

    const cartHeading = screen.getByRole('heading', { name: 'Cart' });
    const header = cartHeading.parentElement;
    expect(header).toHaveClass('app-pos-cart-header');
    expect(header).toHaveClass('shrink-0');

    const cartPanel = header?.parentElement;
    expect(cartPanel).toHaveClass('app-pos-cart-width');
    expect(cartPanel).toHaveClass('min-h-0');
  });

  // Task 209.23 — the owner-reported "cart items barely visible, checkout
  // eats too much height" complaint. Guards the actual flex contract: the
  // cart-items list is the ONE region marked flex-1/min-h-0/overflow-y-auto
  // (so it's what actually shrinks/scrolls under pressure), while the
  // checkout footer stays shrink-0 (content-sized only, never competing for
  // the flexible space) — no arbitrary fixed/percentage height split between
  // the two.
  it('gives the cart items region flex-1/min-h-0/overflow-y-auto and keeps the checkout footer shrink-0 (content-sized only)', () => {
    mockMatchMedia({ '(min-width: 1024px)': true, '(min-width: 1024px) and (min-height: 640px)': true });
    render(<TerminalPage />);

    const cartHeading = screen.getByRole('heading', { name: 'Cart' });
    const header = cartHeading.parentElement;
    const itemsRegion = header?.nextElementSibling;
    expect(itemsRegion).toHaveClass('min-h-0');
    expect(itemsRegion).toHaveClass('lg:flex-1');
    expect(itemsRegion).toHaveClass('lg:overflow-y-auto');

    const footer = itemsRegion?.nextElementSibling;
    expect(footer).toHaveClass('app-pos-footer');
    expect(footer).toHaveClass('shrink-0');
  });
});
