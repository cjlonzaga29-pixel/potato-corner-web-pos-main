import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductCategoryResponse } from '@potato-corner/shared';
import { CreateProductDialog } from './create-product-dialog';

const { mockUseCreateProduct, mockUseBranches, mockUseProductCategories, mockPush } = vi.hoisted(() => ({
  mockUseCreateProduct: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseProductCategories: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useCreateProduct: mockUseCreateProduct,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-product-categories', () => ({
  useProductCategories: mockUseProductCategories,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

/** Flat, always-rendered list — same approach as recipe-component-form-dialog.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

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
    return <SelectContext.Provider value={{ value, onValueChange: disabled ? undefined : onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue({ placeholder }: { placeholder?: string }) {
    return <>{placeholder}</>;
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

const CATEGORIES: ProductCategoryResponse[] = [
  {
    id: 'category-1',
    code: 'fries',
    name: 'Fries',
    description: null,
    is_active: true,
    sort_order: 1,
    product_count: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'category-2',
    code: 'drinks',
    name: 'Drinks',
    description: null,
    is_active: true,
    sort_order: 2,
    product_count: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(categories: ProductCategoryResponse[] = CATEGORIES, categoriesLoading = false) {
  mockUseBranches.mockReturnValue({ data: { branches: [] }, isLoading: false });
  mockUseProductCategories.mockReturnValue({ data: { categories, total: categories.length, page: 1, limit: 100 }, isLoading: categoriesLoading });
  const mutateAsync = vi.fn().mockResolvedValue({ id: 'product-1' });
  mockUseCreateProduct.mockReturnValue({ mutateAsync, isPending: false });
  render(<CreateProductDialog open onOpenChange={vi.fn()} />);
  return { mutateAsync };
}

describe('CreateProductDialog — Category field', () => {
  it('renders the category field as a Select, not a free-text input', () => {
    setup();

    expect(screen.queryByPlaceholderText('Fries')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /category/i })).not.toBeInTheDocument();
  });

  it('displays active Product Categories loaded from useProductCategories', () => {
    setup();

    expect(mockUseProductCategories).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    expect(screen.getByText('Fries')).toBeInTheDocument();
    expect(screen.getByText('Drinks')).toBeInTheDocument();
  });

  it('sends the selected category as category_id in the create payload, leaving other fields unchanged', async () => {
    const { mutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    fireEvent.click(screen.getByText('Drinks'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const [payload] = mutateAsync.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toEqual(
      expect.objectContaining({
        name: 'Cheese Fries',
        category_id: 'category-2',
        status: 'draft',
        is_seasonal: false,
        branch_exclusive: false,
      }),
    );
    expect(payload.category).toBeUndefined();
  });

  it('shows a clear empty state and disables selection when no active categories exist', () => {
    setup([]);

    expect(screen.getByText('No active categories')).toBeInTheDocument();
    expect(screen.queryByText('Fries')).not.toBeInTheDocument();
  });

  it('does not allow arbitrary typed category text to be submitted', async () => {
    const { mutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    // No free-text category input exists to type into; only Select options are selectable.
    expect(screen.queryByPlaceholderText('Fries')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const [payload] = mutateAsync.mock.calls[0] as [Record<string, unknown>];
    expect(payload.category_id).toBeUndefined();
    expect(payload.category).toBeUndefined();
  });
});
