import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryTransferForm } from './inventory-transfer-form';

const {
  mockPush,
  mockUseBranchStore,
  mockUseBranchInventoryStock,
  mockUseTransferDestinationBranches,
  mockUseTransferInventoryStock,
  mockUseUploadMovementProof,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseBranchInventoryStock: vi.fn(),
  mockUseTransferDestinationBranches: vi.fn(),
  mockUseTransferInventoryStock: vi.fn(),
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
  useTransferDestinationBranches: mockUseTransferDestinationBranches,
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

/** cmdk/Popover-based combobox has no jsdom-friendly interaction path without user-event's pointer emulation — stand it up as a plain native <select>, same reasoning as the Select mock above. */
vi.mock('@/components/shared/branch-combobox', () => ({
  BranchCombobox: ({
    branches,
    value,
    onChange,
  }: {
    branches: { id: string; name: string }[];
    value?: string;
    onChange: (id: string) => void;
  }) => (
    <select aria-label="Destination Branch" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  ),
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';
const ITEM_ID = '223e4567-e89b-12d3-a456-426614174000';
const DEST_BRANCH_ID = '423e4567-e89b-12d3-a456-426614174000';

function jpegFile(name = 'proof.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function fillAndSubmit() {
  const [itemSelect] = screen.getAllByRole('combobox');
  if (!itemSelect) throw new Error('item select not found');
  fireEvent.change(itemSelect, { target: { value: ITEM_ID } });

  fireEvent.change(screen.getByLabelText('Destination Branch'), { target: { value: DEST_BRANCH_ID } });

  const quantityInput = screen.getByRole('spinbutton');
  fireEvent.change(quantityInput, { target: { value: '5' } });

  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  fireEvent.change(fileInput, { target: { files: [jpegFile()] } });

  fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));

  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer Stock' }));
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseBranchInventoryStock.mockReturnValue({
    data: { items: [{ inventory_item_id: ITEM_ID, name: 'Cheese Flavor Powder', base_unit_code: 'g', quantity_on_hand: 100 }] },
  });
  mockUseTransferDestinationBranches.mockReturnValue({ data: [{ id: DEST_BRANCH_ID, name: 'SM North', code: 'SMN' }] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InventoryTransferForm — proof upload failure recovery', () => {
  it('does not re-run the transfer mutation on retry after both legs were already recorded', async () => {
    const transferMutateAsync = vi.fn().mockResolvedValue({
      transfer_out: { id: 'transfer-out-123' },
      transfer_in: { id: 'transfer-in-123' },
    });
    mockUseTransferInventoryStock.mockReturnValue({ mutateAsync: transferMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValueOnce(new Error('Failed to upload the proof image')).mockResolvedValueOnce({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryTransferForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText('Transfer completed, but proof photo could not be uploaded.')).toBeInTheDocument());
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
    // Proof belongs to the transfer business event — always uploaded against transfer_out.id, never transfer_in.id.
    expect(uploadProofMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ movementId: 'transfer-out-123' }));

    fireEvent.click(screen.getByRole('button', { name: 'Retry Photo Upload' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));

    // The core regression: retrying the photo must never move stock a second time.
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(2);
    expect(uploadProofMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ movementId: 'transfer-out-123' }));
  });

  it('"Continue Without Photo" navigates away without re-running the transfer or retrying the upload', async () => {
    const transferMutateAsync = vi.fn().mockResolvedValue({
      transfer_out: { id: 'transfer-out-456' },
      transfer_in: { id: 'transfer-in-456' },
    });
    mockUseTransferInventoryStock.mockReturnValue({ mutateAsync: transferMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockRejectedValue(new Error('Failed to upload the proof image'));
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryTransferForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText('Transfer completed, but proof photo could not be uploaded.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without Photo' }));

    expect(mockPush).toHaveBeenCalledWith('/branch/inventory');
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('navigates away directly when both the transfer and the proof upload succeed', async () => {
    const transferMutateAsync = vi.fn().mockResolvedValue({
      transfer_out: { id: 'transfer-out-789' },
      transfer_in: { id: 'transfer-in-789' },
    });
    mockUseTransferInventoryStock.mockReturnValue({ mutateAsync: transferMutateAsync, isPending: false });

    const uploadProofMutateAsync = vi.fn().mockResolvedValue({});
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryTransferForm basePath="/branch" />);
    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('records the transfer without ever calling the upload mutation when no photo was attached', async () => {
    const transferMutateAsync = vi.fn().mockResolvedValue({
      transfer_out: { id: 'transfer-out-999' },
      transfer_in: { id: 'transfer-in-999' },
    });
    mockUseTransferInventoryStock.mockReturnValue({ mutateAsync: transferMutateAsync, isPending: false });
    const uploadProofMutateAsync = vi.fn();
    mockUseUploadMovementProof.mockReturnValue({ mutateAsync: uploadProofMutateAsync, isPending: false });

    render(<InventoryTransferForm basePath="/branch" />);

    const [itemSelect] = screen.getAllByRole('combobox');
    if (!itemSelect) throw new Error('item select not found');
    fireEvent.change(itemSelect, { target: { value: ITEM_ID } });
    fireEvent.change(screen.getByLabelText('Destination Branch'), { target: { value: DEST_BRANCH_ID } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Stock' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer Stock' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory'));
    expect(transferMutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadProofMutateAsync).not.toHaveBeenCalled();
  });
});
