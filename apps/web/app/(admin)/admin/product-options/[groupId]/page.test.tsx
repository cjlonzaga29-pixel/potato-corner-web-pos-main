import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProductOptionGroupDetailResponse } from '@potato-corner/shared';
import ProductOptionGroupDetailPage from './page';

const { mockUseProductOptionGroup, mockUseUpdateProductOptionGroup } = vi.hoisted(() => ({
  mockUseProductOptionGroup: vi.fn(),
  mockUseUpdateProductOptionGroup: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useProductOptionGroup: mockUseProductOptionGroup,
  useUpdateProductOptionGroup: mockUseUpdateProductOptionGroup,
  useProductOptionDeductionStatus: () => ({ status: 'not_configured', configuredCount: 0, totalCount: 0, isLoading: false }),
  useUpdateProductOption: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/components/admin/product-options/create-option-dialog', () => ({
  CreateOptionDialog: () => null,
}));

vi.mock('@/components/admin/product-options/edit-option-dialog', () => ({
  EditOptionDialog: () => null,
}));

vi.mock('@/components/admin/product-options/manage-option-deduction-dialog', () => ({
  ManageOptionDeductionDialog: () => null,
}));

function group(overrides: Partial<ProductOptionGroupDetailResponse> = {}): ProductOptionGroupDetailResponse {
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
    option_count: 0,
    options: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** React's `use()` only unwraps synchronously if the thenable is already flagged fulfilled — mirrors Next.js's cached params promise. */
function resolvedParams(groupId: string): Promise<{ groupId: string }> {
  const promise = Promise.resolve({ groupId }) as Promise<{ groupId: string }> & { status?: string; value?: { groupId: string } };
  promise.status = 'fulfilled';
  promise.value = { groupId };
  return promise;
}

describe('ProductOptionGroupDetailPage — POS Button Label edit', () => {
  it('pre-fills an empty POS Button Label field when the group has none saved', () => {
    mockUseProductOptionGroup.mockReturnValue({ data: group(), isLoading: false });
    mockUseUpdateProductOptionGroup.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ProductOptionGroupDetailPage params={resolvedParams('group-1')} />);

    expect(screen.getByLabelText('POS Button Label')).toHaveValue('');
  });

  it('pre-fills the saved POS Button Label value', () => {
    mockUseProductOptionGroup.mockReturnValue({ data: group({ pos_button_label: 'Fries Add-ons' }), isLoading: false });
    mockUseUpdateProductOptionGroup.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ProductOptionGroupDetailPage params={resolvedParams('group-1')} />);

    expect(screen.getByLabelText('POS Button Label')).toHaveValue('Fries Add-ons');
  });

  it('sends the changed value, trimmed, on save', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseProductOptionGroup.mockReturnValue({ data: group({ pos_button_label: 'Fries Add-ons' }), isLoading: false });
    mockUseUpdateProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });

    render(<ProductOptionGroupDetailPage params={resolvedParams('group-1')} />);

    fireEvent.change(screen.getByLabelText('POS Button Label'), { target: { value: '  SnackBites Add-ons  ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ pos_button_label: 'SnackBites Add-ons' }));
  });

  it('clears the POS Button Label back to null on save', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseProductOptionGroup.mockReturnValue({ data: group({ pos_button_label: 'Fries Add-ons' }), isLoading: false });
    mockUseUpdateProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });

    render(<ProductOptionGroupDetailPage params={resolvedParams('group-1')} />);

    fireEvent.change(screen.getByLabelText('POS Button Label'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ pos_button_label: null }));
  });
});
