import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { InventoryItemDetailResponse } from '@potato-corner/shared';
import InventoryItemDetailPage from './page';

const {
  mockUseParams,
  mockUseInventoryItem,
  mockUseBranches,
  mockUseAssignInventoryItemToBranches,
  mockItemUnitConversionsSection,
} = vi.hoisted(() => ({
  mockUseParams: vi.fn(),
  mockUseInventoryItem: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseAssignInventoryItemToBranches: vi.fn(),
  mockItemUnitConversionsSection: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: mockUseParams }));

vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: mockUseBranches }));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryItem: mockUseInventoryItem,
  useAssignInventoryItemToBranches: mockUseAssignInventoryItemToBranches,
}));

vi.mock('@/components/admin/inventory/item-unit-conversions-section', () => ({
  ItemUnitConversionsSection: (props: { itemId: string }) => {
    mockItemUnitConversionsSection(props);
    return <div data-testid="item-unit-conversions-section" />;
  },
}));

function item(overrides: Partial<InventoryItemDetailResponse> = {}): InventoryItemDetailResponse {
  return {
    id: 'item-1',
    name: 'BBQ Flavor Powder',
    sku: null,
    barcode: null,
    category_id: null,
    category_name: null,
    base_unit_id: 'unit-tbsp',
    base_unit_code: 'tbsp',
    track_inventory: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    assigned_branches: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryItemDetailPage', () => {
  it('still renders the item header and Assigned Branches section (unchanged by TASK 121)', () => {
    mockUseParams.mockReturnValue({ itemId: 'item-1' });
    mockUseInventoryItem.mockReturnValue({ data: item(), isLoading: false });
    mockUseBranches.mockReturnValue({ data: { branches: [] } });
    mockUseAssignInventoryItemToBranches.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryItemDetailPage />);

    expect(screen.getByText('BBQ Flavor Powder')).toBeInTheDocument();
    expect(screen.getByText('Assigned Branches')).toBeInTheDocument();
  });

  it('renders the item-specific unit conversions section for the current item', () => {
    mockUseParams.mockReturnValue({ itemId: 'item-1' });
    mockUseInventoryItem.mockReturnValue({ data: item(), isLoading: false });
    mockUseBranches.mockReturnValue({ data: { branches: [] } });
    mockUseAssignInventoryItemToBranches.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryItemDetailPage />);

    expect(screen.getByTestId('item-unit-conversions-section')).toBeInTheDocument();
    expect(mockItemUnitConversionsSection).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-1' }));
  });
});
