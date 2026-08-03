import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TerminalPage from './page';
import type { PosCatalogProduct, CreateTransactionInput } from '@potato-corner/shared';
import { useAuthStore } from '@/stores/auth.store';

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
}));

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
    clearCart: vi.fn(),
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
    return { mutateAsync: mockCreateTransactionMutateAsync, isPending: false };
  },
  useUploadPaymentProof: () => ({ mutateAsync: vi.fn() }),
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
    products: [{ id: 'product-1', name: 'Mega Mix Fries', category: 'Snacks', variants }],
  };
}

beforeEach(() => {
  mockUseAuth.mockReturnValue({ user: STAFF_USER, selectEmployee: mockSelectEmployee });
  mockUseEmployees.mockReturnValue({ data: { employees: [] }, isLoading: false, isError: false, refetch: vi.fn() });
});

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
  function bump(label: string, times = 1) {
    for (let i = 0; i < times; i++) fireEvent.click(screen.getByRole('button', { name: `Increase ${label} quantity` }));
  }

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

  it('keeps Add disabled until the required group is fully assigned for the current quantity', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    bump('Small');
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
  });

  it('Qty 3, Cheese x3 (single choice for the whole quantity) creates one cart line of Qty 3', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    bump('Small', 3);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 }],
      quantity: 3,
    });
  });

  it('Qty 3, Small x2 + Large x1 creates two independent cart lines — never one line with per-option quantities', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    bump('Small', 2);
    bump('Large', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(2);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 }],
      quantity: 2,
    });
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 }],
      quantity: 1,
    });
  });

  it('Qty 3, Small x2 + No Add-ons x1 (optional group) creates two cart lines, one carrying no selected_options', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ min_selections: 0, required: false })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    bump('Small', 2);
    bump('No Add-ons', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockAddItem).toHaveBeenCalledTimes(2);
    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [{ option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 }],
      quantity: 2,
    });
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

  it('preloads the dialog with the cart line current quantity and option selection, and labels the confirm button Save', () => {
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

    // Preloaded assignment (Large x2) already sums to the preloaded quantity (2) — Save starts enabled.
    expect(screen.getByText('Assigned 2 / 2')).toBeInTheDocument();
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

  it('raising the quantity during edit (Qty2 Small -> Qty3, Small x2 + No Add-ons x1) replaces the line with two lines', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ min_selections: 0, required: false })] })]),
      isLoading: false,
    });
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
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase No Add-ons quantity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockReplaceItem).toHaveBeenCalledTimes(1);
    expect(mockReplaceItem).toHaveBeenCalledWith(0, [
      { product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 },
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

  it('a variant with both a legacy Size group and an Add-ons group keeps the Size quantity allocator while the Add-ons group stays a simplified multi-select', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup(), addOnsGroup()] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    // Product Quantity control still present (Size still needs it) — Add
    // starts disabled until Size is assigned, unaffected by Add-ons.
    expect(screen.getByRole('button', { name: 'Increase quantity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Increase Small quantity' }));
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

// Simple Operational Audit §5 — Maya and Other must be reachable and usable
// from the same terminal Charge flow as cash/GCash, not dead-end tabs.
describe('TerminalPage — Maya and Other payment methods', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    mockUseCatalog.mockReturnValue({ data: catalogWith([slotVariant({ flavors: [], flavor_slots: [] })]), isLoading: false });
  });

  afterEach(() => cleanup());

  it('shows a Maya reference field and proof capture, mirroring GCash, and keeps Charge disabled until reference/verification/proof are all present', () => {
    render(<TerminalPage />);
    // Radix TabsTrigger activates on mousedown, not click — fireEvent.click
    // alone never fires it (see fireEvent.click's lack of a mousedown step).
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Maya' }));

    expect(screen.getByPlaceholderText('Maya reference number')).toBeInTheDocument();
    expect(screen.getByText('I manually verified this Maya payment')).toBeInTheDocument();
    // No proof captured yet — Charge must stay disabled regardless of reference/verification.
    fireEvent.change(screen.getByPlaceholderText('Maya reference number'), { target: { value: '1234567890' } });
    fireEvent.click(screen.getByText('I manually verified this Maya payment'));
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('shows a short reference/note field for Other with no proof-capture UI, and gates Charge on the note alone', () => {
    render(<TerminalPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Other' }));

    expect(screen.getByPlaceholderText('Payment reference or note (e.g. bank transfer, voucher)')).toBeInTheDocument();
    expect(screen.queryByText(/manually verified/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Payment reference or note (e.g. bank transfer, voucher)'), {
      target: { value: 'Bank transfer #445' },
    });
    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
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

  it('disables Charge with "Add items to the cart to start a sale." for an empty cart', () => {
    mockCartItems.mockReturnValue([]);
    render(<TerminalPage />);

    expect(screen.getByText('Add items to the cart to start a sale.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('disables Charge with "Enter cash tendered." when cash is selected and tendered is blank', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 13 }]);
    render(<TerminalPage />);

    expect(screen.getByText('Enter cash tendered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
  });

  it('disables Charge and shows the shortfall when cash tendered is below the total', () => {
    // 13 x price 100 = 1300 total (no VAT-cap flavors involved here).
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 13 }]);
    render(<TerminalPage />);

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '1000' } });

    expect(screen.getByRole('button', { name: /Charge/ })).toBeDisabled();
    expect(screen.getByText(/short\.$/)).toBeInTheDocument();
  });

  it('enables Charge and shows change once cash tendered covers the total exactly', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });

    expect(screen.getByRole('button', { name: /Charge/ })).not.toBeDisabled();
    expect(screen.getByText('Change: ₱0.00')).toBeInTheDocument();
  });

  it('enables Charge and computes change when cash tendered exceeds the total', () => {
    mockCartItems.mockReturnValue([{ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 }]);
    render(<TerminalPage />);

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

    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));

    await waitFor(() => expect(mockCreateTransactionMutateAsync).toHaveBeenCalledTimes(1));
    const payload = firstCallArg(mockCreateTransactionMutateAsync);
    expect(firstOf(payload.items)).toEqual(
      expect.objectContaining({ product_id: 'product-1', product_variant_id: 'variant-1', flavor_id: 'flavor-1' }),
    );
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
