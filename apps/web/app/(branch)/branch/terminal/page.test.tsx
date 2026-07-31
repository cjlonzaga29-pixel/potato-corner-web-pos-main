import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TerminalPage from './page';
import type { PosCatalogProduct } from '@potato-corner/shared';

const { mockAddItem, mockUseCatalog, mockUseMyActiveShift, mockUseIsClockedIn, mockClockInMutateAsync, mockClockOutMutateAsync } = vi.hoisted(() => ({
  mockAddItem: vi.fn(),
  mockUseCatalog: vi.fn(),
  mockUseMyActiveShift: vi.fn(() => ({ shift: { id: 'shift-1' } as { id: string } | null, isLoading: false })),
  mockUseIsClockedIn: vi.fn(() => ({
    isClockedIn: true,
    record: { clock_in_server_time: '2026-01-01T08:00:00.000Z' } as { clock_in_server_time: string } | null,
    isLoading: false,
  })),
  mockClockInMutateAsync: vi.fn(),
  mockClockOutMutateAsync: vi.fn(),
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
  useAuth: () => ({ user: { id: 'user-1', branchIds: ['branch-1'], firstName: 'Jamie', lastName: 'Cruz', email: 'jamie@example.com' } }),
}));

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
  useCreateTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
