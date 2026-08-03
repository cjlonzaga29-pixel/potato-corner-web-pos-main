import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryItemUnitConversionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { ItemConversionDialog } from './item-conversion-dialog';

const { mockUseCreateInventoryItemConversion, mockUseUpdateInventoryItemConversion, mockCreateMutate, mockUpdateMutate } = vi.hoisted(() => ({
  mockUseCreateInventoryItemConversion: vi.fn(),
  mockUseUpdateInventoryItemConversion: vi.fn(),
  mockCreateMutate: vi.fn(),
  mockUpdateMutate: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useCreateInventoryItemConversion: mockUseCreateInventoryItemConversion,
  useUpdateInventoryItemConversion: mockUseUpdateInventoryItemConversion,
}));

/** Flat, always-rendered list — same approach as create-option-dialog.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    return <SelectContext.Provider value={{ value, onValueChange }}>{children}</SelectContext.Provider>;
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
      <button type="button" data-selected={ctx.value === value} onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

// from_unit_id/to_unit_id must be real UUIDs — the form schema mirrors the backend's z.uuid() contract.
const UNIT_TBSP = randomUUID();
const UNIT_G = randomUUID();

const UNITS: UnitOfMeasureResponse[] = [
  {
    id: UNIT_TBSP,
    code: 'tbsp',
    name: 'Tablespoon',
    dimension: 'VOLUME',
    is_base_unit: true,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: UNIT_G,
    code: 'g',
    name: 'Gram',
    dimension: 'WEIGHT',
    is_base_unit: true,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

/** Indexed array access is `T | undefined` under noUncheckedIndexedAccess; the mocked flat Select list guarantees these indices exist. */
function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}`);
  return item;
}

function conversion(overrides: Partial<InventoryItemUnitConversionResponse> = {}): InventoryItemUnitConversionResponse {
  return {
    id: 'conv-1',
    inventory_item_id: 'item-1',
    from_unit_id: UNIT_TBSP,
    from_unit_code: 'tbsp',
    from_unit_name: 'Tablespoon',
    to_unit_id: UNIT_G,
    to_unit_code: 'g',
    to_unit_name: 'Gram',
    factor: 7,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ItemConversionDialog — create mode', () => {
  it('submits the create payload with selected units and factor', async () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });
    const onOpenChange = vi.fn();

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={onOpenChange} />);

    // The From and To selects share the same unit list (mocked as a flat, always-rendered
    // button list), so "Tablespoon (tbsp)" / "Gram (g)" each appear twice — From's copy first
    // in DOM order, then To's (last, since To filters out whichever unit From currently holds).
    fireEvent.click(nth(screen.getAllByText('Tablespoon (tbsp)'), 0));
    fireEvent.change(screen.getByLabelText(/Factor/i), { target: { value: '7' } });
    const gramButtons = screen.getAllByText('Gram (g)');
    fireEvent.click(nth(gramButtons, gramButtons.length - 1));
    fireEvent.click(screen.getByRole('button', { name: /add conversion/i }));

    await waitFor(() =>
      expect(mockCreateMutate).toHaveBeenCalledWith({ from_unit_id: UNIT_TBSP, to_unit_id: UNIT_G, factor: 7 }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('excludes the selected From Unit from the To Unit choices (same-unit selection blocked)', () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={vi.fn()} />);

    fireEvent.click(nth(screen.getAllByText('Tablespoon (tbsp)'), 0));

    // Only From's own copy remains — the To-unit list no longer offers the unit already selected as From.
    expect(screen.getAllByText('Tablespoon (tbsp)')).toHaveLength(1);
    expect(screen.getAllByText('Gram (g)')).toHaveLength(2);
  });

  it('shows a live preview once both units and a positive factor are set', () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={vi.fn()} />);

    fireEvent.click(nth(screen.getAllByText('Tablespoon (tbsp)'), 0));
    fireEvent.change(screen.getByLabelText(/Factor/i), { target: { value: '7' } });
    const gramButtons = screen.getAllByText('Gram (g)');
    fireEvent.click(nth(gramButtons, gramButtons.length - 1));

    expect(screen.getByText('1 tbsp = 7 g')).toBeInTheDocument();
  });

  it('does not call the create hook when Cancel is clicked', () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });
    const onOpenChange = vi.fn();

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ItemConversionDialog — edit mode', () => {
  it('preloads the factor and locks From/To Unit', () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={vi.fn()} conversion={conversion()} />);

    expect(screen.getByDisplayValue('Tablespoon (tbsp)')).toBeDisabled();
    expect(screen.getByDisplayValue('Gram (g)')).toBeDisabled();
    expect(screen.getByLabelText(/Factor/i)).toHaveValue(7);
  });

  it('submits only the updated factor', async () => {
    mockUseCreateInventoryItemConversion.mockReturnValue({ mutateAsync: mockCreateMutate, isPending: false });
    mockUseUpdateInventoryItemConversion.mockReturnValue({ mutateAsync: mockUpdateMutate, isPending: false });

    render(<ItemConversionDialog itemId="item-1" units={UNITS} open onOpenChange={vi.fn()} conversion={conversion()} />);

    fireEvent.change(screen.getByLabelText(/Factor/i), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateMutate).toHaveBeenCalledWith({ factor: 9 }));
    expect(mockUseUpdateInventoryItemConversion).toHaveBeenCalledWith('item-1', 'conv-1');
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });
});
