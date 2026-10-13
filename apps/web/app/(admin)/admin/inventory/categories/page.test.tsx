import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import InventoryCategoriesPage from './page';

const { mockUseInventoryCategories } = vi.hoisted(() => ({
  mockUseInventoryCategories: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCategories: mockUseInventoryCategories,
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

// POS-PERF-P35 — Inventory Categories management moved to Supervisor;
// this page is read-only reporting for Admin now (no Create/Edit controls).
describe('InventoryCategoriesPage — Admin read-only (POS-PERF-P35)', () => {
  it('shows the managed-elsewhere banner and no Create/Edit controls', () => {
    mockUseInventoryCategories.mockReturnValue({
      data: [category(), category({ id: 'cat-2', name: 'Packaging', code: 'PKG' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryCategoriesPage />);

    expect(screen.getByText(/managed by Supervisor now/i)).toBeInTheDocument();
    expect(screen.getByText('Raw Ingredients')).toBeInTheDocument();
    expect(screen.getByText('Packaging')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no categories', () => {
    mockUseInventoryCategories.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryCategoriesPage />);

    expect(screen.getByText('No categories yet')).toBeInTheDocument();
  });
});
