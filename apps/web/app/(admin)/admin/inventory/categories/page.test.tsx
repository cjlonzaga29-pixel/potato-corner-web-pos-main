import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import InventoryCategoriesPage from './page';

const { mockUseInventoryCategories, mockUseCreateInventoryCategory, mockUseUpdateInventoryCategory, mockCreateMutateAsync, mockUpdateMutateAsync } =
  vi.hoisted(() => ({
    mockUseInventoryCategories: vi.fn(),
    mockUseCreateInventoryCategory: vi.fn(),
    mockUseUpdateInventoryCategory: vi.fn(),
    mockCreateMutateAsync: vi.fn(),
    mockUpdateMutateAsync: vi.fn(),
  }));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCategories: mockUseInventoryCategories,
  useCreateInventoryCategory: mockUseCreateInventoryCategory,
  useUpdateInventoryCategory: mockUseUpdateInventoryCategory,
}));

function category(overrides: Partial<InventoryCategoryResponse> = {}): InventoryCategoryResponse {
  return {
    id: 'cat-1',
    name: 'Raw Ingredients',
    code: 'RAW',
    description: 'Base stock items',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryCategoriesPage', () => {
  it('renders an Edit button for every category row', () => {
    mockUseInventoryCategories.mockReturnValue({
      data: [category(), category({ id: 'cat-2', name: 'Packaging', code: 'PKG' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseCreateInventoryCategory.mockReturnValue({ mutateAsync: mockCreateMutateAsync, isPending: false });
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockUpdateMutateAsync, isPending: false });

    render(<InventoryCategoriesPage />);

    const table = screen.getByRole('table');
    expect(within(table).getByRole('button', { name: 'Edit Raw Ingredients' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Edit Packaging' })).toBeInTheDocument();
  });

  it('opens the edit dialog pre-filled with the row values when Edit is clicked', () => {
    mockUseInventoryCategories.mockReturnValue({ data: [category()], isLoading: false, isError: false, refetch: vi.fn() });
    mockUseCreateInventoryCategory.mockReturnValue({ mutateAsync: mockCreateMutateAsync, isPending: false });
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockUpdateMutateAsync, isPending: false });

    render(<InventoryCategoriesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Raw Ingredients' }));

    expect(screen.getByRole('heading', { name: 'Edit Inventory Category' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Raw Ingredients')).toBeInTheDocument();
    expect(screen.getByDisplayValue('RAW')).toBeInTheDocument();
  });

  it('the existing Create Category flow still works', () => {
    mockUseInventoryCategories.mockReturnValue({ data: [category()], isLoading: false, isError: false, refetch: vi.fn() });
    mockUseCreateInventoryCategory.mockReturnValue({ mutateAsync: mockCreateMutateAsync, isPending: false });
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockUpdateMutateAsync, isPending: false });

    render(<InventoryCategoriesPage />);

    fireEvent.click(screen.getByRole('button', { name: /create category/i }));

    expect(screen.getByRole('heading', { name: 'Create Inventory Category' })).toBeInTheDocument();
  });

  it('renders the empty state when there are no categories', () => {
    mockUseInventoryCategories.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    mockUseCreateInventoryCategory.mockReturnValue({ mutateAsync: mockCreateMutateAsync, isPending: false });
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockUpdateMutateAsync, isPending: false });

    render(<InventoryCategoriesPage />);

    expect(screen.getByText('No categories yet')).toBeInTheDocument();
  });
});
