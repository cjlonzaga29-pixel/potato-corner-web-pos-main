import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryAdjustForm } from './inventory-adjust-form';

const { mockPush, mockUseBranchStore, mockUseBranchInventoryStock, mockUseAdjustInventoryStock, mockUseUploadMovementProof } = vi.hoisted(
  () => ({
    mockPush: vi.fn(),
    mockUseBranchStore: vi.fn(),
    mockUseBranchInventoryStock: vi.fn(),
    mockUseAdjustInventoryStock: vi.fn(),
    mockUseUploadMovementProof: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStock: mockUseBranchInventoryStock,
  useAdjustInventoryStock: mockUseAdjustInventoryStock,
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
  function SelectTrigger() {
    return null;
  }
  function SelectValue() {
    return null;
  }
  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    let options: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === SelectContent) {
        options = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return (
      <select value={value ?? ''} onChange={(e) => onValueChange?.(e.target.value)}>
        <option value="" />
        {options}
      </select>
    );
  }
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';
const ITEM_ID = '223e4567-e89b-12d3-a456-426614174000';

function jpegFile(name = 'proof.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function fillAndSubmit() {
  const [itemSelect] = screen.getAllByRole('combobox');
  if (!itemSelect) throw new Error('item select not found');
  fireEvent.change(itemSelect, { target: { value: ITEM_ID } });

  const quantityInput = screen.getByRole('spinbutton');
  fireEvent.change(quantityInput, { target: { value: '-5' } });

  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  fireEvent.change(fileInput, { target: { files: [jpegFile()] } });

  fireEvent.click(screen.getByRole('button', { name: 'Record Adjustment' }));

  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Adjust Stock' }));
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseBranchInventoryStock.mockReturnValue({
    data: { items: [{ inventory_item_id: ITEM_ID, name: 'Cheese Flavor Powder', base_unit_code: 'g', quantity_on_hand: 100 }] },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InventoryAdjustForm — proof upload failure recovery', () => {
  it('does not re-run the adjustment mutation on retry after the movement was already recorded', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-123' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValueOnce(new Error('Failed to upload the proof image')).mockResolvedValueOnce({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText('Stock adjustment was recorded, but the proof photo could not be uploaded.')).toBeInTheDocument(),
    );
    expect(adjustMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ movementId: 'movement-123' }));

    fireEvent.click(screen.getByRole('button', { name: 'Retry Photo Upload' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));

    // The core regression: retrying the photo must never re-apply the adjustment.
    expect(adjustMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(2);
    expect(uploadProofMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ movementId: 'movement-123' }));
  });

  it('"Continue Without Photo" navigates away without re-applying the adjustment or retrying the upload', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-456' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValue(new Error('Failed to upload the proof image'));
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText('Stock adjustment was recorded, but the proof photo could not be uploaded.')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without Photo' }));

    expect(mockPush).toHaveBeenCalledWith('/branch/inventory');
    expect(adjustMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('navigates away directly when both the adjustment and the proof upload succeed', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-789' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockResolvedValue({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));
    expect(adjustMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('records the adjustment without ever calling the upload mutation when no photo was attached', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-999' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });
    const uploadProofMutateAsync = vi.fn();
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/branch" />);

    const [itemSelect] = screen.getAllByRole('combobox');
    if (!itemSelect) throw new Error('item select not found');
    fireEvent.change(itemSelect, { target: { value: ITEM_ID } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record Adjustment' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adjust Stock' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));
    expect(adjustMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).not.toHaveBeenCalled();
  });
});
