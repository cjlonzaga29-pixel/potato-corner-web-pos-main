import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryItemUnitConversionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { ItemUnitConversionsSection } from './item-unit-conversions-section';

const {
  mockUseInventoryItemConversions,
  mockUseUnitsOfMeasure,
  mockUseDeleteInventoryItemConversion,
  mockDeleteMutate,
  mockItemConversionDialog,
} = vi.hoisted(() => ({
  mockUseInventoryItemConversions: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
  mockUseDeleteInventoryItemConversion: vi.fn(),
  mockDeleteMutate: vi.fn(),
  mockItemConversionDialog: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryItemConversions: mockUseInventoryItemConversions,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
  useDeleteInventoryItemConversion: mockUseDeleteInventoryItemConversion,
}));

vi.mock('./item-conversion-dialog', () => ({
  ItemConversionDialog: (props: { open: boolean; conversion: InventoryItemUnitConversionResponse | null }) => {
    mockItemConversionDialog(props);
    return null;
  },
}));

const UNITS: UnitOfMeasureResponse[] = [];

function conversion(overrides: Partial<InventoryItemUnitConversionResponse> = {}): InventoryItemUnitConversionResponse {
  return {
    id: 'conv-1',
    inventory_item_id: 'item-1',
    from_unit_id: 'unit-tbsp',
    from_unit_code: 'tbsp',
    from_unit_name: 'Tablespoon',
    to_unit_id: 'unit-g',
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

describe('ItemUnitConversionsSection', () => {
  it('lists existing conversions', () => {
    mockUseInventoryItemConversions.mockReturnValue({ data: [conversion()], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
    mockUseDeleteInventoryItemConversion.mockReturnValue({ mutateAsync: mockDeleteMutate, isPending: false });

    render(<ItemUnitConversionsSection itemId="item-1" />);

    expect(screen.getByText(/1 tbsp = 7 g/)).toBeInTheDocument();
  });

  it('opens the Add Conversion dialog in create mode', () => {
    mockUseInventoryItemConversions.mockReturnValue({ data: [], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
    mockUseDeleteInventoryItemConversion.mockReturnValue({ mutateAsync: mockDeleteMutate, isPending: false });

    render(<ItemUnitConversionsSection itemId="item-1" />);
    fireEvent.click(screen.getByRole('button', { name: /add conversion/i }));

    expect(mockItemConversionDialog).toHaveBeenCalledWith(expect.objectContaining({ open: true, conversion: null }));
  });

  it('opens the dialog in edit mode preloaded with the selected conversion', () => {
    mockUseInventoryItemConversions.mockReturnValue({ data: [conversion()], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
    mockUseDeleteInventoryItemConversion.mockReturnValue({ mutateAsync: mockDeleteMutate, isPending: false });

    render(<ItemUnitConversionsSection itemId="item-1" />);
    fireEvent.click(screen.getByLabelText('Edit conversion'));

    expect(mockItemConversionDialog).toHaveBeenCalledWith(expect.objectContaining({ open: true, conversion: conversion() }));
  });

  it('shows a delete confirmation naming the conversion and calls delete on confirm', async () => {
    mockUseInventoryItemConversions.mockReturnValue({ data: [conversion()], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
    mockUseDeleteInventoryItemConversion.mockReturnValue({ mutateAsync: mockDeleteMutate, isPending: false });

    render(<ItemUnitConversionsSection itemId="item-1" />);
    fireEvent.click(screen.getByLabelText('Delete conversion'));

    expect(screen.getByText('Delete conversion "1 tbsp = 7 g"?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDeleteMutate).toHaveBeenCalledTimes(1));
    expect(mockUseDeleteInventoryItemConversion).toHaveBeenCalledWith('item-1', 'conv-1');
  });
});
