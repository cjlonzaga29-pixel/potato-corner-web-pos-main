import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryStockInForm } from './inventory-stock-in-form';

const {
  mockPush,
  mockUseBranchStore,
  mockUseBranchInventoryStock,
  mockUseInventoryItemConversions,
  mockUseReceiveInventoryStock,
  mockUseUploadMovementProof,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseBranchInventoryStock: vi.fn(),
  mockUseInventoryItemConversions: vi.fn(),
  mockUseReceiveInventoryStock: vi.fn(),
  mockUseUploadMovementProof: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStock: mockUseBranchInventoryStock,
  useInventoryItemConversions: mockUseInventoryItemConversions,
  useReceiveInventoryStock: mockUseReceiveInventoryStock,
  useUploadMovementProof: mockUseUploadMovementProof,
}));

/**
 * Real Radix Select has no jsdom-friendly interaction path without
 * @testing-library/user-event's pointer-event emulation (same reasoning as
 * other page tests' Tabs mock) — stand it up as a plain native <select> that
 * keeps the same value/onValueChange contract the form relies on. Queried by
 * role ('combobox') rather than label, since the id/aria wiring FormControl
 * normally injects targets the (here-unused) SelectTrigger, not this select.
 */
vi.mock('@/components/ui/select', () => {
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return <option value={value}>{children}</option>;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectTrigger() {
    return null;
  }
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

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';
const ITEM_ID = '223e4567-e89b-12d3-a456-426614174000';
const UNIT_ID = '323e4567-e89b-12d3-a456-426614174000';

function jpegFile(name = 'receipt.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function selectItemAndFillForm() {
  const [itemSelect] = screen.getAllByRole('combobox');
  if (!itemSelect) throw new Error('item select not found');
  fireEvent.change(itemSelect, { target: { value: ITEM_ID } });

  const [quantityInput, totalCostInput] = screen.getAllByRole('spinbutton');
  if (!quantityInput || !totalCostInput) throw new Error('quantity/total cost inputs not found');
  fireEvent.change(quantityInput, { target: { value: '10' } });
  fireEvent.change(totalCostInput, { target: { value: '500' } });

  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  fireEvent.change(fileInput, { target: { files: [jpegFile()] } });
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseBranchInventoryStock.mockReturnValue({
    data: {
      items: [
        {
          inventory_item_id: ITEM_ID,
          name: 'Cheese Flavor Powder',
          base_unit_id: UNIT_ID,
          base_unit_code: 'g',
          quantity_on_hand: 100,
        },
      ],
    },
  });
  mockUseInventoryItemConversions.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InventoryStockInForm — proof upload failure recovery', () => {
  it('does not re-run the receiving mutation on retry after the movement was already created', async () => {
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-123' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValueOnce(new Error('Failed to upload the proof image')).mockResolvedValueOnce({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/branch" />);
    selectItemAndFillForm();

    fireEvent.click(screen.getByRole('button', { name: 'Record Receiving' }));

    await waitFor(() =>
      expect(screen.getByText('Receiving was recorded, but the receipt photo could not be uploaded.')).toBeInTheDocument(),
    );
    expect(stockInMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ movementId: 'movement-123' }));

    fireEvent.click(screen.getByRole('button', { name: 'Retry Photo Upload' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));

    // The core regression: retrying the photo must never re-create the movement.
    expect(stockInMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(2);
    expect(uploadProofMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ movementId: 'movement-123' }));
  });

  it('"Continue Without Photo" navigates away without creating a second movement or retrying the upload', async () => {
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-456' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValue(new Error('Failed to upload the proof image'));
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/branch" />);
    selectItemAndFillForm();

    fireEvent.click(screen.getByRole('button', { name: 'Record Receiving' }));

    await waitFor(() =>
      expect(screen.getByText('Receiving was recorded, but the receipt photo could not be uploaded.')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without Photo' }));

    expect(mockPush).toHaveBeenCalledWith('/branch/inventory');
    expect(stockInMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('navigates away directly when both the movement and the proof upload succeed', async () => {
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-789' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockResolvedValue({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/branch" />);
    selectItemAndFillForm();

    fireEvent.click(screen.getByRole('button', { name: 'Record Receiving' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));
    expect(stockInMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Receiving was recorded, but the receipt photo could not be uploaded.')).not.toBeInTheDocument();
  });
});
