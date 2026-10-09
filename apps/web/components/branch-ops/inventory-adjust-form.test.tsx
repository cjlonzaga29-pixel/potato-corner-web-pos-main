import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryAdjustForm } from './inventory-adjust-form';

const {
  mockPush,
  mockUseBranchStore,
  mockUseAuthStore,
  mockUseBranchInventoryStock,
  mockUseAdjustInventoryStock,
  mockUseInventoryStockMovements,
  mockUseUploadInventoryEvidence,
  mockUseVerifyStaffPin,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseAuthStore: vi.fn(),
  mockUseBranchInventoryStock: vi.fn(),
  mockUseAdjustInventoryStock: vi.fn(),
  mockUseInventoryStockMovements: vi.fn(),
  mockUseUploadInventoryEvidence: vi.fn(),
  mockUseVerifyStaffPin: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStock: mockUseBranchInventoryStock,
  useAdjustInventoryStock: mockUseAdjustInventoryStock,
  // Backs InventoryAdjustmentHistory, rendered below the form itself.
  useInventoryStockMovements: mockUseInventoryStockMovements,
  useUploadInventoryEvidence: mockUseUploadInventoryEvidence,
}));

// POS-PERF-P29 — PIN verification is a separate module now.
vi.mock('@/hooks/queries/use-staff-pin', () => ({
  useVerifyStaffPin: mockUseVerifyStaffPin,
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

/** Drives the mandatory evidence-upload + PIN-verify steps now required before submit can enable. */
async function completeEvidenceAndPin() {
  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('file input not found');
  fireEvent.change(fileInput, { target: { files: [jpegFile()] } });
  await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument());

  fireEvent.change(screen.getByPlaceholderText('Enter 4-6 digit PIN'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(screen.getByText('Jenny Santos')).toBeInTheDocument());
}

async function fillAndSubmit(confirmLabel = 'Submit for Review') {
  const [itemSelect] = screen.getAllByRole('combobox');
  if (!itemSelect) throw new Error('item select not found');
  fireEvent.change(itemSelect, { target: { value: ITEM_ID } });

  const quantityInput = screen.getByRole('spinbutton');
  fireEvent.change(quantityInput, { target: { value: '-5' } });

  await completeEvidenceAndPin();

  fireEvent.click(screen.getByRole('button', { name: confirmLabel }));

  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseAuthStore.mockImplementation((selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: 'branch' } }),
  );
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
  mockUseVerifyStaffPin.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ staff_name: 'Jenny Santos', verification_token: 'tok-1', expires_at: new Date().toISOString() }),
    isPending: false,
    isError: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InventoryAdjustForm — branch submission (Pending Review)', () => {
  it('keeps submit disabled until both evidence and PIN verification complete, then submits with the token/key', async () => {
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'request-123', status: 'PENDING' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/branch" />);

    const [itemSelect] = screen.getAllByRole('combobox');
    if (!itemSelect) throw new Error('item select not found');
    fireEvent.change(itemSelect, { target: { value: ITEM_ID } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-5' } });

    expect(screen.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory/approvals'));
    expect(adjustMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ quantity_delta: -5, verification_token: 'tok-1', evidence_key: 'evidence-1' }),
    );
  });
});

describe('InventoryAdjustForm — supervisor direct record', () => {
  it('labels the action "Save Adjustment" and navigates to the stock list, not the approval queue', async () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { role: string } | null }) => unknown) =>
      selector({ user: { role: 'supervisor' } }),
    );
    const adjustMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-999', movement_type: 'ADJUSTMENT_OUT' });
    mockUseAdjustInventoryStock.mockReturnValue({ mutateAsync: adjustMutateAsync, isPending: false });

    render(<InventoryAdjustForm basePath="/supervisor" />);
    await fillAndSubmit('Save Adjustment');

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/supervisor/inventory'));
  });
});
