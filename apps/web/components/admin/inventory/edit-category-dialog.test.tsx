import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import { EditCategoryDialog } from './edit-category-dialog';

const { mockUseUpdateInventoryCategory, mockMutateAsync } = vi.hoisted(() => ({
  mockUseUpdateInventoryCategory: vi.fn(),
  mockMutateAsync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
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

describe('EditCategoryDialog', () => {
  it('pre-fills the form with the current category values', () => {
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });

    render(<EditCategoryDialog category={category()} onOpenChange={vi.fn()} />);

    expect(screen.getByDisplayValue('Raw Ingredients')).toBeInTheDocument();
    expect(screen.getByDisplayValue('RAW')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Base stock items')).toBeInTheDocument();
  });

  it('calls the update hook with the category id and edited fields on save', async () => {
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    const onOpenChange = vi.fn();

    render(<EditCategoryDialog category={category()} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByDisplayValue('Raw Ingredients'), { target: { value: 'Raw Materials' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith({
      name: 'Raw Materials',
      code: 'RAW',
      description: 'Base stock items',
      is_active: true,
    }));
    expect(mockUseUpdateInventoryCategory).toHaveBeenCalledWith('cat-1');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('does not call the update hook when Cancel is clicked', () => {
    mockUseUpdateInventoryCategory.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    const onOpenChange = vi.fn();

    render(<EditCategoryDialog category={category()} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
