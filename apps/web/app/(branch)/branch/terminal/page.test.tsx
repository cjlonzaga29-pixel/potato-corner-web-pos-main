import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TerminalPage from './page';
import type { PosCatalogProduct, CreateTransactionInput } from '@potato-corner/shared';
import { useAuthStore } from '@/stores/auth.store';

const {
  mockAddItem,
  mockUseCatalog,
  mockUseMyActiveShift,
  mockUseIsClockedIn,
  mockClockInMutateAsync,
  mockClockOutMutateAsync,
  mockUseAuth,
  mockSelectEmployee,
  mockUseEmployees,
  mockCreateTransactionMutateAsync,
} = vi.hoisted(() => ({
  mockAddItem: vi.fn(),
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
  useClockIn: () => ({ mutateAsync: mockClockInMutateAsync, isPending: false }),
  useClockOut: () => ({ mutateAsync: mockClockOutMutateAsync, isPending: false }),
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useCreateTransaction: () => ({ mutateAsync: mockCreateTransactionMutateAsync, isPending: false }),
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
    products: [{ id: 'product-1', name: 'Mega Mix Fries', category: 'Snacks', image_url: null, variants }],
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

describe('TerminalPage — product option groups (CR-008)', () => {
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

  it('opens the selector for a required SINGLE option group and enforces a selection before Add to Cart', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Large (+₱20.00)')).toBeInTheDocument();
    expect(mockAddItem).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add to Cart' })).toBeDisabled();
  });

  it('enables Add to Cart once the required option is picked and submits the option_group_id/option_id selection', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([optionVariant()]), isLoading: false });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Large (+₱20.00)'));
    const addButton = screen.getByRole('button', { name: 'Add to Cart' });
    expect(addButton).not.toBeDisabled();
    fireEvent.click(addButton);

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
      ],
      quantity: 1,
    });
  });

  it('completes a required SINGLE group and an optional MULTIPLE group together, in order', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [
            optionGroup(),
            {
              id: 'group-2',
              name: 'Add-ons',
              pos_button_label: null,
              selection_type: 'MULTIPLE',
              min_selections: 0,
              max_selections: null,
              required: false,
              options: [
                { id: 'opt-3', name: 'Extra Cheese', price_adjustment: 15, sort_order: 1, is_active: true },
                { id: 'opt-4', name: 'Bacon Bits', price_adjustment: 10, sort_order: 2, is_active: true },
              ],
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Small'));
    fireEvent.click(screen.getByText('Extra Cheese (+₱15.00)'));
    fireEvent.click(screen.getByText('Bacon Bits (+₱10.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cart' }));

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'group-1', option_group_name: 'Size', option_id: 'opt-1', option_name: 'Small', price_adjustment: 0 },
        { option_group_id: 'group-2', option_group_name: 'Add-ons', option_id: 'opt-3', option_name: 'Extra Cheese', price_adjustment: 15 },
        { option_group_id: 'group-2', option_group_name: 'Add-ons', option_id: 'opt-4', option_name: 'Bacon Bits', price_adjustment: 10 },
      ],
      quantity: 1,
    });
  });

  it('skips groups whose options are all inactive — the dialog never opens and the product adds normally', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [
            {
              id: 'group-3',
              name: 'Empty Group',
              pos_button_label: null,
              selection_type: 'SINGLE',
              min_selections: 0,
              max_selections: 1,
              required: false,
              options: [{ id: 'opt-9', name: 'Inactive', price_adjustment: 0, sort_order: 1, is_active: false }],
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.queryByText('Empty Group')).not.toBeInTheDocument();
    expect(mockAddItem).toHaveBeenCalledWith({ product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 });
  });

  it('shows the selected option name and price adjustment in the cart, and folds the adjustment into the cart line total', () => {
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

    // Base variant price is 80 — tendering exactly that (ignoring the +20
    // option adjustment) must still come up short by the adjustment amount,
    // proving the adjustment is folded into the line/charge total.
    fireEvent.change(screen.getByPlaceholderText('Cash tendered'), { target: { value: '80' } });
    expect(screen.getByText('Cash tendered is ₱20.00 short.')).toBeInTheDocument();
  });
});

// Task 70 — pos_button_label is the cashier-facing override for an Option
// Group's internal admin name. Resolution rule: configured label wins, null
// falls back to name, blank/whitespace falls back to name too.
describe('TerminalPage — option group pos_button_label resolution (Task 70)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('displays the configured pos_button_label instead of the internal name', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({ option_groups: [optionGroup({ name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' })] }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Fries Add-ons')).toBeInTheDocument();
    expect(screen.queryByText('Flavor Fries')).not.toBeInTheDocument();
  });

  it('falls back to the internal name when pos_button_label is null', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ name: 'Flavor Fries', pos_button_label: null })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Flavor Fries')).toBeInTheDocument();
  });

  it('falls back to the internal name when pos_button_label is blank/whitespace', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ name: 'Flavor Fries', pos_button_label: '   ' })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Flavor Fries')).toBeInTheDocument();
  });

  it('resolves each group to its own label when multiple groups are shown together', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [
            optionGroup({ id: 'group-1', name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' }),
            {
              id: 'group-2',
              name: 'Drink Size',
              pos_button_label: null,
              selection_type: 'SINGLE',
              min_selections: 1,
              max_selections: 1,
              required: true,
              options: [{ id: 'opt-5', name: 'Regular', price_adjustment: 0, sort_order: 1, is_active: true }],
            },
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Fries Add-ons')).toBeInTheDocument();
    expect(screen.queryByText('Flavor Fries')).not.toBeInTheDocument();
    expect(screen.getByText('Drink Size')).toBeInTheDocument();
  });

  it('submits the correct group/option IDs unaffected by the display label', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({ option_groups: [optionGroup({ id: 'group-1', name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' })] }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));
    fireEvent.click(screen.getByText('Large (+₱20.00)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cart' }));

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [
        { option_group_id: 'group-1', option_group_name: 'Fries Add-ons', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
      ],
      quantity: 1,
    });
  });

  it('shows the resolved label (not the internal name) in the cart summary', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({ option_groups: [optionGroup({ id: 'group-1', name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' })] }),
      ]),
      isLoading: false,
    });
    mockCartItems.mockReturnValue([
      {
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Fries Add-ons', option_id: 'opt-2', option_name: 'Large', price_adjustment: 20 },
        ],
        quantity: 1,
      },
    ]);
    render(<TerminalPage />);

    expect(screen.getByText('Fries Add-ons: Large (+₱20.00)')).toBeInTheDocument();
  });

  it('leaves min/max enforcement and pricing behavior unchanged when a custom label is set', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({ option_groups: [optionGroup({ id: 'group-1', name: 'Flavor Fries', pos_button_label: 'Fries Add-ons' })] }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByRole('button', { name: 'Add to Cart' })).toBeDisabled();
    fireEvent.click(screen.getByText('Small'));
    expect(screen.getByRole('button', { name: 'Add to Cart' })).not.toBeDisabled();
  });
});

// Task 71 — clearer "no add-on" wording for optional SINGLE option groups.
// Replaces the generic "None" radio label with "No {resolved group label}"
// (falling back to "No Add-ons" for awkward cases). UI text only — selection
// state, min/max enforcement, pricing, and payload shape are unchanged.
describe('TerminalPage — optional SINGLE option group "no add-on" wording (Task 71)', () => {
  beforeEach(() => {
    mockAddItem.mockClear();
    mockCartItems.mockReturnValue([]);
  });

  afterEach(() => cleanup());

  it('shows "No {resolved label}" for an optional SINGLE group using its configured pos_button_label', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [
            optionGroup({ name: 'Flavor Fries', pos_button_label: 'Fries Add-ons', min_selections: 0, required: false }),
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('No Fries Add-ons')).toBeInTheDocument();
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it('falls back to "No Add-ons" when the resolved label already starts with "Add-ons"', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [optionGroup({ name: 'Add-ons', pos_button_label: null, min_selections: 0, required: false })],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('No Add-ons')).toBeInTheDocument();
    expect(screen.queryByText('No Add-ons Add-ons')).not.toBeInTheDocument();
  });

  it('does not show a no-add-on choice for a required SINGLE group', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([optionVariant({ option_groups: [optionGroup({ name: 'Size' })] })]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.queryByText('No Size')).not.toBeInTheDocument();
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it('clears the selection when the no-add-on choice is picked, letting the product add without an option — no premium, no option ID sent', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([
        optionVariant({
          option_groups: [
            optionGroup({ name: 'Flavor Fries', pos_button_label: 'Fries Add-ons', min_selections: 0, required: false }),
          ],
        }),
      ]),
      isLoading: false,
    });
    render(<TerminalPage />);
    fireEvent.click(screen.getByText('Mega Mix Fries'));

    fireEvent.click(screen.getByText('Large (+₱20.00)'));
    fireEvent.click(screen.getByText('No Fries Add-ons'));
    const addButton = screen.getByRole('button', { name: 'Add to Cart' });
    expect(addButton).not.toBeDisabled();
    fireEvent.click(addButton);

    expect(mockAddItem).toHaveBeenCalledWith({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_options: [],
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

// Branch Employee Authorization, embedded (Section 3 of the routing fix):
// a `branch` (Branch Account) session sees "Who is working?" right inside
// POS Terminal — no separate /branch/select-employee route/redirect. A
// `staff` session (already bound to one Employee) never sees this at all,
// covered by the STAFF_USER default in the top-level beforeEach above.
describe('TerminalPage — embedded "Who is working?" (Branch Account sessions)', () => {
  function employee(overrides: Record<string, unknown> = {}) {
    return { id: 'employee-1', first_name: 'Jane', last_name: 'Doe', position: 'Cashier', ...overrides };
  }

  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: BRANCH_USER, selectEmployee: mockSelectEmployee });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, record: null, isLoading: false });
    useAuthStore.setState({ user: BRANCH_USER, accessToken: 'branch-token', isAuthenticated: true, isLoading: false });
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
  });

  it('shows an empty state when no active employees are assigned to the branch', () => {
    mockUseEmployees.mockReturnValue({ data: { employees: [] }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<TerminalPage />);

    expect(screen.getByText('No active employees')).toBeInTheDocument();
  });

  it('restores the Branch Account session on Clock Out, returning the panel to "Who is working?"', async () => {
    const employees = { data: { employees: [employee()] }, isLoading: false, isError: false, refetch: vi.fn() };
    mockUseEmployees.mockReturnValue(employees);
    mockUseCatalog.mockReturnValue({ data: catalogWith([]), isLoading: false });
    mockCartItems.mockReturnValue([]);
    mockSelectEmployee.mockResolvedValue({ id: 'employee-1' });
    mockClockOutMutateAsync.mockResolvedValue({ id: 'attendance-1' });

    const { rerender } = render(<TerminalPage />);

    // STATE 1 -> employee selected, snapshotting the Branch Account session first.
    fireEvent.click(screen.getByText('Jane Doe'));
    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));

    // Selection swaps the session client-side — simulate that by re-rendering as the now-active staff employee (STATE 3: already clocked in).
    mockUseAuth.mockReturnValue({ user: STAFF_USER, selectEmployee: mockSelectEmployee });
    mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' }, isLoading: false });
    useAuthStore.setState({ user: STAFF_USER, accessToken: 'staff-token', isAuthenticated: true, isLoading: false });
    rerender(<TerminalPage />);

    fireEvent.click(screen.getByRole('button', { name: /Clock Out/ }));
    await waitFor(() => expect(mockClockOutMutateAsync).toHaveBeenCalled());

    // The Branch Account snapshot taken before hand-off is restored — same session that selected Jane Doe.
    await waitFor(() => expect(useAuthStore.getState().user).toEqual(BRANCH_USER));
    expect(useAuthStore.getState().accessToken).toBe('branch-token');
  });
});
