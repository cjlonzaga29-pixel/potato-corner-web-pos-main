import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryTransferForm } from './inventory-transfer-form';

const {
  mockPush,
  searchParams,
  mockUseBranches,
  mockUseBranchInventoryStock,
  mockUseTransferInventoryStock,
  mockUseUploadMovementProof,
  MockTransferStockError,
} = vi.hoisted(() => {
  class MockTransferStockError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
    get outcomeUnknown() {
      return this.code === 'NETWORK_ERROR' || this.code === 'UNREADABLE_RESPONSE';
    }
  }
  return {
    mockPush: vi.fn(),
    searchParams: { value: new URLSearchParams() },
    mockUseBranches: vi.fn(),
    mockUseBranchInventoryStock: vi.fn(),
    mockUseTransferInventoryStock: vi.fn(),
    mockUseUploadMovementProof: vi.fn(),
    MockTransferStockError,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
  useSearchParams: () => searchParams.value,
}));

vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: mockUseBranches }));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  TransferStockError: MockTransferStockError,
  useBranchInventoryStock: mockUseBranchInventoryStock,
  useInventoryStockRealtimeSync: vi.fn(),
  useTransferInventoryStock: mockUseTransferInventoryStock,
  useUploadMovementProof: mockUseUploadMovementProof,
}));

/** Same jsdom-friendly native-<select> stand-in as inventory-stock-in-form.test.tsx. */
vi.mock('@/components/ui/select', () => {
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return <option value={value}>{children}</option>;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  const SelectTrigger = React.forwardRef<HTMLButtonElement>(function SelectTrigger() {
    return null;
  });
  function SelectValue() {
    return null;
  }
  function Select({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) {
    let options: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === SelectContent) {
        options = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return (
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onValueChange?.(e.target.value)}>
        <option value="" />
        {options}
      </select>
    );
  }
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

const MAIN = '11111111-1111-4111-8111-111111111111';
const NORTH = '22222222-2222-4222-8222-222222222222';
const SOUTH = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const CHEESE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUPS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SAUCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function row(id: string, name: string, unit: string, available: number, status: 'healthy' | 'low' | 'critical', low: number | null = 10, critical: number | null = 2) {
  return {
    inventory_item_id: id,
    name,
    sku: null,
    category_name: null,
    base_unit_id: '00000000-0000-4000-8000-000000000000',
    base_unit_code: unit,
    quantity_on_hand: available,
    quantity_reserved: 0,
    quantity_available: available,
    low_stock_threshold: low,
    critical_threshold: critical,
    status,
    avg_unit_cost: null,
    inventory_value: null,
    consumed_today: 0,
  };
}

let stockByBranch: Record<string, ReturnType<typeof row>[]>;
/** Lets a test answer a branch's query with another branch's payload (a stale cache entry). */
let responseBranchOverride: Record<string, string>;

function setup() {
  mockUseBranches.mockReturnValue({
    data: {
      branches: [
        { id: MAIN, name: 'Main' },
        { id: NORTH, name: 'North' },
        { id: SOUTH, name: 'South' },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseBranchInventoryStock.mockImplementation((branchId: string | null) => {
    if (!branchId) return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    const answeredFor = responseBranchOverride[branchId] ?? branchId;
    const items = stockByBranch[answeredFor];
    return { data: items ? { branch_id: answeredFor, items } : undefined, isLoading: !items, isError: false, refetch: vi.fn() };
  });
}

function combos() {
  const [destination, item, source] = screen.getAllByRole('combobox') as HTMLSelectElement[];
  if (!destination || !item || !source) throw new Error('selects not found');
  return { destination, item, source };
}

function needsList() {
  return screen.getByRole('list', { name: /Stock needs at/ });
}

let transferMutateAsync: ReturnType<typeof vi.fn>;
let uploadProofMutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  searchParams.value = new URLSearchParams();
  stockByBranch = {
    [MAIN]: [row(CHEESE, 'Cheese Powder', 'g', 1, 'critical'), row(OIL, 'Oil', 'ml', 8, 'low'), row(CUPS, 'Cups', 'pc', 500, 'healthy')],
    [NORTH]: [row(CHEESE, 'Cheese Powder', 'g', 40, 'healthy'), row(OIL, 'Oil', 'ml', 300, 'healthy')],
    [SOUTH]: [row(SAUCE, 'Sauce', 'ml', 0, 'critical')],
  };
  responseBranchOverride = {};
  setup();
  transferMutateAsync = vi.fn().mockResolvedValue({
    inventory_item_id: CHEESE,
    to_branch_id: MAIN,
    quantity: 9,
    transfer_out: { id: 'transfer-out-1', quantity_after: 31, unit_code: 'g', inventory_item_name: 'Cheese Powder' },
    transfer_in: { id: 'transfer-in-1', quantity_after: 10, unit_code: 'g', inventory_item_name: 'Cheese Powder' },
  });
  mockUseTransferInventoryStock.mockReturnValue({ mutateAsync: transferMutateAsync, isPending: false });
  uploadProofMutateAsync = vi.fn().mockResolvedValue({});
  mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer Stock' }));
}

function prepareCheeseFromNorth(quantity = '9') {
  searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}&inventory_item_id=${CHEESE}`);
  render(<InventoryTransferForm basePath="/supervisor" />);
  fireEvent.change(combos().source, { target: { value: NORTH } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: quantity } });
}

describe('InventoryTransferForm — stock needs', () => {
  it('lists only the destination’s low and critical items, critical first, with unit, availability and threshold', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    const items = within(needsList()).getAllByRole('button');
    expect(items.map((b) => b.getAttribute('data-need-item'))).toEqual([CHEESE, OIL]);
    expect(items[0]).toHaveTextContent('1 g available');
    expect(items[0]).toHaveTextContent('Critical at 2 g');
    expect(items[1]).toHaveTextContent('Low at 10 ml');
    expect(within(needsList()).queryByText('Cups')).not.toBeInTheDocument();
  });

  it('shows "Out of stock" for a need with nothing available', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${SOUTH}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    expect(within(needsList()).getByText('Out of stock')).toBeInTheDocument();
  });

  it('selecting a need row fills the item for that destination without touching quantity or submitting', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    fireEvent.click(within(needsList()).getByText('Oil'));
    expect(combos().destination.value).toBe(MAIN);
    expect(combos().item.value).toBe(OIL);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('');
    expect(transferMutateAsync).not.toHaveBeenCalled();
  });

  it('never shows a previous branch’s needs while the new branch loads', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    responseBranchOverride[SOUTH] = MAIN; // cache still holds Main's payload
    fireEvent.change(combos().destination, { target: { value: SOUTH } });
    expect(screen.queryByText('Cheese Powder', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading stock needs')).toBeInTheDocument();
  });

  it('shows the empty state when the destination has no needs', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${NORTH}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    expect(screen.getByText('No stock needs')).toBeInTheDocument();
  });
});

describe('InventoryTransferForm — source/destination reconciliation', () => {
  it('never offers the destination as a source', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    const sourceValues = Array.from(combos().source.options).map((o) => o.value);
    expect(sourceValues).toEqual(['', NORTH, SOUTH]);
  });

  it('changing the destination clears the item and quantity, and drops a source that became the destination', () => {
    prepareCheeseFromNorth();
    fireEvent.change(combos().destination, { target: { value: NORTH } });
    expect(combos().item.value).toBe('');
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('');
    expect(combos().source.value).toBe('');
    expect(screen.getByText('Item and quantity were cleared because the destination changed.')).toBeInTheDocument();
    expect(screen.getByText('North is now the destination, so it was removed as the source.')).toBeInTheDocument();
  });

  it('drops a link branch that is not one of the user’s active branches and never loads its stock', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${FOREIGN}&inventory_item_id=${CHEESE}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    expect(screen.getByText(/destination in the link is not one of your active branches/)).toBeInTheDocument();
    expect(combos().destination.value).toBe('');
    expect(mockUseBranchInventoryStock.mock.calls.some(([id]) => id === FOREIGN)).toBe(false);
  });

  it('explains an item the source branch does not stock and blocks the transfer', async () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}&inventory_item_id=${CHEESE}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    fireEvent.change(combos().source, { target: { value: SOUTH } });
    expect(screen.getByTestId('source-availability')).toHaveTextContent('Cheese Powder is not assigned to South');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));
    expect(await screen.findByText('This item is not assigned to South, so it cannot be sent from there.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(transferMutateAsync).not.toHaveBeenCalled();
  });

  it('keeps a linked item when the select reports an empty value before its options load', () => {
    searchParams.value = new URLSearchParams(`to_branch_id=${MAIN}&inventory_item_id=${CHEESE}`);
    render(<InventoryTransferForm basePath="/supervisor" />);
    fireEvent.change(combos().item, { target: { value: '' } });
    fireEvent.change(combos().destination, { target: { value: '' } });
    expect(combos().item.value).toBe(CHEESE);
    expect(combos().destination.value).toBe(MAIN);
  });

  it('shows source availability and unit', () => {
    prepareCheeseFromNorth();
    expect(screen.getByTestId('source-availability')).toHaveTextContent('Available at North: 40 g');
  });
});

describe('InventoryTransferForm — quantity', () => {
  it('offers a threshold-based suggestion that only fills the field when chosen', () => {
    prepareCheeseFromNorth('');
    expect(screen.getByText(/brings available stock \(1\) up to the low-stock threshold \(10\)/)).toBeInTheDocument();
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Use 9 g' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('9');
    expect(transferMutateAsync).not.toHaveBeenCalled();
  });

  it('refuses more than the source has available before asking for confirmation', async () => {
    prepareCheeseFromNorth('41');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));
    expect(await screen.findByText('Only 40 g available at North.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('InventoryTransferForm — submission', () => {
  it('records once, shows the completed state with both balances, and attaches proof to transfer_out', async () => {
    prepareCheeseFromNorth();
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array(10)], 'proof.jpg', { type: 'image/jpeg' })] } });
    await confirm();

    expect(await screen.findByRole('heading', { name: 'Transfer completed' })).toBeInTheDocument();
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(transferMutateAsync).toHaveBeenCalledWith({ inventory_item_id: CHEESE, to_branch_id: MAIN, quantity: 9, notes: undefined });
    expect(mockUseTransferInventoryStock).toHaveBeenLastCalledWith(NORTH);
    expect(uploadProofMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ movementId: 'transfer-out-1' }));
    expect(screen.getByText('North now has').nextSibling).toHaveTextContent('31 g on hand');
    expect(screen.getByText('Main now has').nextSibling).toHaveTextContent('10 g on hand');
    expect(screen.getByText('Attached')).toBeInTheDocument();
  });

  it('keeps every entry and shows the server’s reason when the transfer is refused', async () => {
    transferMutateAsync.mockRejectedValueOnce(
      new MockTransferStockError('Transfer quantity exceeds available stock at the source branch (some stock is reserved for pending sales)', 'INSUFFICIENT_STOCK'),
    );
    prepareCheeseFromNorth();
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'for weekend' } });
    await confirm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Transfer not recorded');
    expect(alert).toHaveTextContent('exceeds available stock');
    expect(combos().destination.value).toBe(MAIN);
    expect(combos().source.value).toBe(NORTH);
    expect(combos().item.value).toBe(CHEESE);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('for weekend');
  });

  it('says the outcome is unknown, not failed, when the response never arrived', async () => {
    transferMutateAsync.mockRejectedValueOnce(new MockTransferStockError('Could not reach the server.', 'NETWORK_ERROR'));
    prepareCheeseFromNorth();
    await confirm();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Transfer status unknown');
    expect(alert).toHaveTextContent('Check the destination’s stock movements before submitting again');
  });

  it('a double click on confirm sends one transfer', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    transferMutateAsync.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    prepareCheeseFromNorth();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Transfer Stock' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    resolve({
      quantity: 9,
      transfer_out: { id: 'o', quantity_after: 31, unit_code: 'g', inventory_item_name: 'Cheese Powder' },
      transfer_in: { id: 'i', quantity_after: 10, unit_code: 'g', inventory_item_name: 'Cheese Powder' },
    });
    await screen.findByRole('heading', { name: 'Transfer completed' });
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('InventoryTransferForm — proof upload failure recovery', () => {
  it('does not re-run the transfer mutation on retry after both legs were already recorded', async () => {
    uploadProofMutateAsync.mockReset().mockRejectedValueOnce(new Error('Failed to upload the proof image')).mockResolvedValueOnce({});
    prepareCheeseFromNorth();
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array(10)], 'proof.jpg', { type: 'image/jpeg' })] } });
    await confirm();

    await waitFor(() => expect(screen.getByText('Transfer completed, but proof photo could not be uploaded.')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry Photo Upload' }));
    expect(await screen.findByRole('heading', { name: 'Transfer completed' })).toBeInTheDocument();
    expect(screen.getByText('Attached')).toBeInTheDocument();
    // The core regression: retrying the photo must never move stock a second time.
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(2);
    expect(uploadProofMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ movementId: 'transfer-out-1' }));
  });

  it('"Continue Without Photo" shows the completed transfer without re-running it', async () => {
    uploadProofMutateAsync.mockReset().mockRejectedValue(new Error('Failed to upload the proof image'));
    prepareCheeseFromNorth();
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array(10)], 'proof.jpg', { type: 'image/jpeg' })] } });
    await confirm();
    await screen.findByText('Transfer completed, but proof photo could not be uploaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue Without Photo' }));
    expect(await screen.findByRole('heading', { name: 'Transfer completed' })).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('records the transfer without calling the upload mutation when no photo was attached', async () => {
    prepareCheeseFromNorth();
    await confirm();
    await screen.findByRole('heading', { name: 'Transfer completed' });
    expect(uploadProofMutateAsync).not.toHaveBeenCalled();
  });
});
