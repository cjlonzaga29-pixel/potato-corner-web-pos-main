import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminRecipesPage from './page';

const { mockUseProducts } = vi.hoisted(() => ({ mockUseProducts: vi.fn() }));

vi.mock('@/hooks/queries/use-products', () => ({
  useProducts: mockUseProducts,
  useProduct: vi.fn(),
}));
vi.mock('@/hooks/queries/use-recipes', () => ({
  useRecipesList: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
}));

describe('AdminRecipesPage', () => {
  it('renders the product picker list once products load', () => {
    mockUseProducts.mockReturnValue({
      data: { products: [{ id: 'p1', name: 'Classic BBQ', category: 'Fries', active_variant_count: 2, updated_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<AdminRecipesPage />);

    expect(screen.getByRole('heading', { name: /master recipes/i })).toBeInTheDocument();
    expect(screen.getByText('Classic BBQ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view recipes/i })).toBeInTheDocument();
  });

  it('shows an error state with retry when the product list fails to load', () => {
    mockUseProducts.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });

    render(<AdminRecipesPage />);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
