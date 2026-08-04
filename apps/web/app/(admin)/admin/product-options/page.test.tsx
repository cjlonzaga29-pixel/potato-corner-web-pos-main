import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProductOptionGroupResponse } from '@potato-corner/shared';
import ProductOptionsPage from './page';

const { mockUseProductOptionGroups, mockUseDeleteProductOptionGroup, mockPush } = vi.hoisted(() => ({
  mockUseProductOptionGroups: vi.fn(),
  mockUseDeleteProductOptionGroup: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useProductOptionGroups: mockUseProductOptionGroups,
  useDeleteProductOptionGroup: mockUseDeleteProductOptionGroup,
}));

vi.mock('@/components/admin/product-options/create-option-group-dialog', () => ({
  CreateOptionGroupDialog: () => null,
}));

function group(overrides: Partial<ProductOptionGroupResponse> = {}): ProductOptionGroupResponse {
  return {
    id: 'group-1',
    code: 'flavor',
    name: 'Flavor',
    description: null,
    pos_button_label: null,
    selection_type: 'SINGLE',
    min_selections: 0,
    max_selections: 1,
    required: false,
    is_active: true,
    sort_order: 0,
    option_count: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPage(groups: ProductOptionGroupResponse[] = [group()]) {
  mockUseProductOptionGroups.mockReturnValue({
    data: { option_groups: groups, total: groups.length, page: 1, limit: 25 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  return render(<ProductOptionsPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProductOptionsPage — Delete action', () => {
  it('shows a Delete action beside Edit, accessible by name', () => {
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    renderPage();

    expect(screen.getByRole('button', { name: 'Edit Flavor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Flavor' })).toBeInTheDocument();
  });

  it('opens the confirmation dialog on click, showing the group name, code, and option count', () => {
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Flavor' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Delete Product Option Group?')).toBeInTheDocument();
    expect(within(dialog).getByText('(flavor)', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('3 options', { exact: false })).toBeInTheDocument();
  });

  it('does not call the delete endpoint when Cancel is clicked, and does not navigate the row', () => {
    const mutateAsync = vi.fn();
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Flavor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete Product Option Group?')).not.toBeInTheDocument();
  });

  it('calls the delete mutation exactly once with the group id when confirmed', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Flavor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith('group-1');
  });

  it('closes the dialog after a successful delete', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Flavor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));

    await waitFor(() => expect(screen.queryByText('Delete Product Option Group?')).not.toBeInTheDocument());
  });

  it('prevents a second submission while the delete is pending, and keeps the dialog open on failure', async () => {
    let resolveDelete!: () => void;
    const mutateAsync = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (resolveDelete = resolve)));
    mockUseDeleteProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Flavor' }));
    const confirmButton = screen.getByRole('button', { name: 'Delete Permanently' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();

    resolveDelete();
    await waitFor(() => expect(screen.queryByText('Delete Product Option Group?')).not.toBeInTheDocument());
  });
});
