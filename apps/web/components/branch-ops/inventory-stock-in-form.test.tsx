import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { InventoryStockInForm } from './inventory-stock-in-form';

const {
  mockPush,
  mockUseBranchStore,
  mockUseAuthStore,
  mockUseBranchInventoryStock,
  mockUseInventoryItemConversions,
  mockUseReceiveInventoryStock,
  mockUseUploadInventoryEvidence,
  mockUseVerifyStaffPin,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseAuthStore: vi.fn(),
  mockUseBranchInventoryStock: vi.fn(),
  mockUseInventoryItemConversions: vi.fn(),
  mockUseReceiveInventoryStock: vi.fn(),
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
  useInventoryItemConversions: mockUseInventoryItemConversions,
  useReceiveInventoryStock: mockUseReceiveInventoryStock,
  useUploadInventoryEvidence: mockUseUploadInventoryEvidence,
}));

// POS-PERF-P29 — PIN verification is a separate module now.
vi.mock('@/hooks/queries/use-staff-pin', () => ({
  useVerifyStaffPin: mockUseVerifyStaffPin,
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

  const [quantityInput] = screen.getAllByRole('spinbutton');
  if (!quantityInput) throw new Error('quantity input not found');
  fireEvent.change(quantityInput, { target: { value: '10' } });
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

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseAuthStore.mockImplementation((selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: 'branch' } }),
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

describe('InventoryStockInForm — branch submission (Pending Review)', () => {
  it('keeps submit disabled until both evidence and PIN verification complete, then submits with the token/key', async () => {
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'request-123', status: 'PENDING' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/branch" />);
    selectItemAndFillForm();

    expect(screen.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();

    await completeEvidenceAndPin();

    expect(screen.getByRole('button', { name: 'Submit for Review' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/inventory/approvals'));
    expect(stockInMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 10, verification_token: 'tok-1', evidence_key: 'evidence-1' }),
    );
  });
});

describe('InventoryStockInForm — supervisor direct record', () => {
  it('labels the action "Save Stock In" and navigates to the stock list, not the approval queue', async () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { role: string } | null }) => unknown) =>
      selector({ user: { role: 'supervisor' } }),
    );
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'movement-999', movement_type: 'RECEIVING' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/supervisor" />);
    selectItemAndFillForm();
    await completeEvidenceAndPin();

    fireEvent.click(screen.getByRole('button', { name: 'Save Stock In' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/supervisor/inventory'));
  });
});

describe('InventoryStockInForm — P1 cost UI retirement', () => {
  it('submits the same quantity as before with no total_cost field in the payload', async () => {
    const stockInMutateAsync = vi.fn().mockResolvedValue({ id: 'request-999', status: 'PENDING' });
    mockUseReceiveInventoryStock.mockReturnValue({ mutateAsync: stockInMutateAsync, isPending: false });

    render(<InventoryStockInForm basePath="/branch" />);

    expect(screen.queryByText('Total Purchase Cost')).not.toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);

    selectItemAndFillForm();
    await completeEvidenceAndPin();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }));

    await waitFor(() => expect(stockInMutateAsync).toHaveBeenCalledTimes(1));
    const payload = stockInMutateAsync.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ quantity: 10 });
    expect(payload).not.toHaveProperty('total_cost');
  });
});
