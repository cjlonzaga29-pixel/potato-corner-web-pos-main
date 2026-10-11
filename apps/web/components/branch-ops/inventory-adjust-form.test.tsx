import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryAdjustForm } from './inventory-adjust-form';

const { mockPush, mockUseBranchStore, mockUseBranchInventoryStock, mockUseAdjustInventoryStock, mockUseInventoryStockMovements, mockUseUploadInventoryEvidence } =
  vi.hoisted(() => ({
    mockPush: vi.fn(),
    mockUseBranchStore: vi.fn(),
    mockUseBranchInventoryStock: vi.fn(),
    mockUseAdjustInventoryStock: vi.fn(),
    mockUseInventoryStockMovements: vi.fn(),
    mockUseUploadInventoryEvidence: vi.fn(),
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
  useAdjustInventoryStock: mockUseAdjustInventoryStock,
  // Backs InventoryAdjustmentHistory, rendered below the form itself.
  useInventoryStockMovements: mockUseInventoryStockMovements,
  useUploadInventoryEvidence: mockUseUploadInventoryEvidence,
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

/** POS-PERF-P33 — PIN verification was removed; only the evidence-upload step gates submit now. */
async function completeEvidence() {
  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  fireEvent.change(fileInput, { target: { files: [jpegFile()] } });
  await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument());
}

async function fillAndSubmit() {
  const [itemSelect] = screen.getAllByRole('combobox');
  if (!itemSelect) throw new Error('item select not found');
  fireEvent.change(itemSelect, { target: { value: ITEM_ID } });

  const quantityInput = screen.getByRole('spinbutton');
  fireEvent.change(quantityInput, { target: { value: '-5' } });

  await completeEvidence();

  fireEvent.click(screen.getByRole('button', { name: 'Save Adjustment' }));

  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Adjustment' }));
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
  mockUseBranchInventoryStock.mockReturnValue({
    data: { items: [{ inventory_item_id: ITEM_ID, name: 'Cheese Flavor Powder', base_unit_code: 'g', quantity_on_hand: 100 }] },
  });
  mockUseInventoryStockMovements.mockReturnValue({
    data: { movements: [], total: 0, page: 1, limit: 10 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseUploadInventoryEvidence.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ evidence_key: 'evidence-1', expires_at: new Date().toISOString() }),
    isPending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InventoryAdjustForm — supervisor/admin direct record (POS-PERF-P33: no PIN)', () => {
  it('keeps submit disabled until evidence is uploaded, then saves immediately with no verification_token', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-999', movement_type: 'ADJUSTMENT_OUT' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/supervisor" />);

    const [itemSelect] = screen.getAllByRole('combobox');
    if (!itemSelect) throw new Error('item select not found');
    fireEvent.change(itemSelect, { target: { value: ITEM_ID } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-5' } });

    expect(screen.getByRole('button', { name: 'Save Adjustment' })).toBeDisabled();

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/supervisor/inventory'));
    const call = adjustMutateAsync.mock.calls[0]?.[0];
    expect(call).toMatchObject({ quantity_delta: -5, evidence_key: 'evidence-1' });
    expect(call).not.toHaveProperty('verification_token');
  });

  it('includes an optional staff_involved_name in the submission when filled in', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-999', movement_type: 'ADJUSTMENT_OUT' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/supervisor" />);

    const [itemSelect] = screen.getAllByRole('combobox');
    if (!itemSelect) throw new Error('item select not found');
    fireEvent.change(itemSelect, { target: { value: ITEM_ID } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText(/Staff Involved/), { target: { value: 'Juan Dela Cruz' } });

    await completeEvidence();
    fireEvent.click(screen.getByRole('button', { name: 'Save Adjustment' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Adjustment' }));

    await waitFor(() => expect(adjustMutateAsync).toHaveBeenCalled());
    expect(adjustMutateAsync.mock.calls[0]?.[0]).toMatchObject({ staff_involved_name: 'Juan Dela Cruz' });
  });
});
